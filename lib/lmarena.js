import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createCursor } from 'ghost-cursor';
import fs from 'fs';
import path from 'path';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { spawn } from 'child_process';


const stealth = StealthPlugin();
//stealth.enabledEvasions.delete('user-agent-override');
stealth.enabledEvasions.delete('iframe.contentWindow');
puppeteer.use(stealth);

// --- 配置常量 ---
const USER_DATA_DIR = path.join(process.cwd(), 'data', 'chromeUserData');
const TARGET_URL = 'https://lmarena.ai/c/new?mode=direct&chat-modality=image';
const TEMP_DIR = path.join(process.cwd(), 'data', 'temp');

// --- 自动化开关 ---
const isLoginMode = process.argv.includes('-login');
const ENABLE_AUTOMATION_MODE = !isLoginMode;

if (isLoginMode) {
    console.log('>>> [Mode] 检测到登录模式 (-login)，自动化已禁用。请手动完成登录。');
}

// 全局状态跟踪
let globalChromeProcess = null;
let globalBrowser = null;
let globalProxyUrl = null;

// 资源清理与进程退出处理
async function cleanup() {
    console.log('>>> [System] 正在清理资源...');

    // Level 1: 通过 Puppeteer 协议优雅关闭，释放锁并保存 Profile
    if (globalBrowser) {
        try {
            console.log('>>> [System] 正在关闭 Puppeteer 连接...');
            await globalBrowser.close();
            globalBrowser = null;
        } catch (e) {
            console.warn('>>> [Warn] Puppeteer 关闭失败 (可能已断开):', e.message);
        }
    }

    // Level 2 & 3: 处理残留进程
    if (globalChromeProcess && !globalChromeProcess.killed) {
        console.log('>>> [System] 正在终止 Chrome 进程...');
        try {
            // Level 2: 发送 SIGTERM (软杀)
            globalChromeProcess.kill('SIGTERM');

            // 等待进程退出
            const start = Date.now();
            while (Date.now() - start < 2000) {
                try {
                    process.kill(globalChromeProcess.pid, 0);
                    await new Promise(r => setTimeout(r, 200));
                } catch (e) {
                    break;
                }
            }
        } catch (e) { }

        // Level 3: 强制查杀 (SIGKILL)
        try {
            process.kill(globalChromeProcess.pid, 0);
            console.log('>>> [System] 进程无响应，执行强制查杀 (SIGKILL)...');
            process.kill(-globalChromeProcess.pid, 'SIGKILL');
        } catch (e) { }

        globalChromeProcess = null;
        console.log('>>> [System] Chrome 进程已终止。');
    }

    // 清理代理
    if (globalProxyUrl) {
        try {
            await closeAnonymizedProxy(globalProxyUrl, true);
            console.log('>>> [System] 代理桥接已关闭。');
        } catch (e) {
            console.error('>>> [Error] 关闭代理桥接失败:', e);
        }
        globalProxyUrl = null;
    }
}

// 注册进程退出信号
process.on('exit', () => {
    if (globalChromeProcess) globalChromeProcess.kill();
});
process.on('SIGINT', async () => {
    await cleanup();
    process.exit();
});
process.on('SIGTERM', async () => {
    await cleanup();
    process.exit();
});

// 确保临时目录存在
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// --- 辅助工具 ---

/**
 * 生成指定范围内的随机数
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number} 随机数
 */
const random = (min, max) => Math.random() * (max - min) + min;

/**
 * 随机休眠一段时间
 * @param {number} min 最小毫秒数
 * @param {number} max 最大毫秒数
 */
const sleep = (min, max) => new Promise(r => setTimeout(r, Math.floor(random(min, max))));

/**
 * 根据文件扩展名获取 MIME 类型
 * @param {string} filePath 文件路径
 * @returns {string} MIME 类型
 */
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    return map[ext] || 'application/octet-stream';
}


/**
 * [Security Enhanced] 无痕获取当前页面实时视口
 * 使用纯净的匿名函数执行，不污染 Global Scope，不留指纹
 */
async function getRealViewport(page) {
    try {
        return await page.evaluate(() => {
            // 仅读取标准属性，不进行任何写入操作
            const w = window.innerWidth;
            const h = window.innerHeight;
            return {
                width: w,
                height: h,
                // 预留 20px 缓冲，防止鼠标移到滚动条上或贴边触发浏览器原生手势
                safeWidth: w - 20,
                safeHeight: h
            };
        });
    } catch (e) {
        // Fallback: 如果上下文丢失，返回安全保守值
        return { width: 1280, height: 720, safeWidth: 1260, safeHeight: 720 };
    }
}

/**
 * [Safety] 坐标钳位函数
 * 强制将坐标限制在合法视口范围内，杜绝 "Node is not visible" 报错
 */
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * 安全点击元素（包含拟人化移动和点击）
 * @param {object} page Puppeteer 页面对象
 * @param {string} selector CSS 选择器
 */
async function safeClick(page, selector) {
    try {
        const el = await page.$(selector);
        if (!el) throw new Error(`未找到: ${selector}`);

        // 使用 ghost-cursor 点击
        if (page.cursor) {
            await page.cursor.click(el);
            return;
        }

        // 降级逻辑
        await el.click();
    } catch (err) {
        throw err;
    }
}

/**
 * 模拟人类键盘输入
 * @param {object} page Puppeteer 页面对象
 * @param {string} selector 输入框选择器
 * @param {string} text 要输入的文本
 */
async function humanType(page, selector, text) {
    const el = await page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    // 智能输入策略
    if (text.length < 50) {
        // 短文本：保持拟人化逐字输入
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            // 模拟错字 (5% 概率)
            if (Math.random() < 0.05) {
                await el.type('x', { delay: random(50, 150) });
                await sleep(100, 300);
                await page.keyboard.press('Backspace', { delay: random(50, 100) });
            }
            await el.type(char);
            // 随机击键间隔
            await sleep(30, 100);
        }
    } else {
        // 长文本：假装打字 -> 停顿 -> 粘贴
        const fakeCount = Math.floor(random(3, 8));
        const fakeText = text.substring(0, fakeCount);

        // 1. 假装打字几个字符
        for (let i = 0; i < fakeText.length; i++) {
            await el.type(fakeText[i], { delay: random(30, 100) });
        }

        // 2. 停顿思考 (0.5 - 1秒)
        await sleep(500, 1000);

        // 3. 全选删除 (模拟 Ctrl+A -> Backspace)
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await sleep(100, 300);
        await page.keyboard.press('Backspace');
        await sleep(100, 300);

        // 4. 瞬间粘贴全部文本 (模拟 Ctrl+V)
        await page.evaluate((sel, content) => {
            const input = document.querySelector(sel);
            input.focus();
            document.execCommand('insertText', false, content);
        }, selector, text);
    }
}

/**
 * 粘贴图片到输入框
 * @param {object} page Puppeteer 页面对象
 * @param {string} selector 输入框选择器
 * @param {string[]} filePaths 图片文件路径数组
 */
async function pasteImages(page, selector, filePaths) {
    if (!filePaths || filePaths.length === 0) return;
    console.log(`>>> [粘贴] 上传 ${filePaths.length} 张图片...`);

    // 读取图片文件并转换为 Base64
    const filesData = filePaths.map(p => {
        const clean = p.replace(/['"]/g, '').trim();
        if (!fs.existsSync(clean)) return null;
        return {
            base64: fs.readFileSync(clean).toString('base64'),
            mime: getMimeType(clean),
            filename: path.basename(clean)
        };
    }).filter(f => f);

    if (filesData.length === 0) return;

    // 点击输入框以获取焦点
    await safeClick(page, selector);
    await sleep(500, 800);

    // 使用 Clipboard API 模拟粘贴事件
    await page.evaluate(async (sel, files) => {
        const target = document.querySelector(sel);
        const dt = new DataTransfer();
        for (const f of files) {
            const bin = atob(f.base64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            dt.items.add(new File([arr], f.filename, { type: f.mime }));
        }
        target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
    }, selector, filesData);

    console.log('>>> [粘贴] 完成，等待缩略图...');
    // 等待图片上传和缩略图生成
    await sleep(2500, 4000);
}

/**
 * 从响应文本中提取图片 URL
 * @param {string} text 响应文本
 * @returns {string|null} 图片 URL 或 null
 */
function extractImage(text) {
    if (!text) return null;
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.startsWith('a2:')) {
            try {
                const data = JSON.parse(line.substring(3));
                if (data?.[0]?.image) return data[0].image;
            } catch (e) { }
        }
    }
    return null;
}
/**
 * 初始化浏览器
 * @param {object} config 配置对象 (包含 chrome 配置)
 * @returns {Promise<{browser: object, page: object, client: object}>}
 */
async function initBrowser(config) {
    console.log(`>>> [Browser] 开始初始化浏览器 (LMArena - 分离模式) | 自动化模式: ${ENABLE_AUTOMATION_MODE ? '开启' : '关闭'}`);

    const chromeConfig = config?.chrome || {};
    const remoteDebuggingPort = 9222;

    // Chrome 启动参数
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        `--user-data-dir=${USER_DATA_DIR}`,
        '--no-first-run'
    ];

    // Headless 模式配置
    let headlessMode = false;
    if (chromeConfig.headless && !isLoginMode) {
        headlessMode = 'new';
        // 无头模式锁死分辨率
        args.push('--headless=new');
        args.push('--window-size=1280,690');
        console.log('>>> [Browser] Headless 模式: 启用 (1280x690)');
    } else {
        if (isLoginMode && chromeConfig.headless) {
            console.log('>>> [Mode] 登录模式下强制禁用 Headless 模式。');
        }
        // 有头模式：最大化窗口以适配屏幕
        args.push('--start-maximized');
        console.log('>>> [Browser] Headless 模式: 禁用 (最大化窗口)');
    }

    // GPU 配置
    if (chromeConfig.gpu === false) {
        args.push(
            '--disable-gpu',
            '--use-gl=swiftshader',
            '--disable-accelerated-2d-canvas',
            '--animation-duration-scale=0',
            '--disable-smooth-scrolling',
            '--animation-duration-scale=0'
        );
        console.log('>>> [Browser] GPU 加速: 禁用');
    } else {
        console.log('>>> [Browser] GPU 加速: 启用');
    }

    // 代理配置
    let proxyUrlForChrome = null;
    if (chromeConfig.proxy && chromeConfig.proxy.enable) {
        const { type, host, port, user, passwd } = chromeConfig.proxy;

        // 特殊处理 SOCKS5 + Auth (Chrome 原生不支持)
        if (type === 'socks5' && user && passwd) {
            try {
                const upstreamUrl = `socks5://${user}:${passwd}@${host}:${port}`;
                console.log(`>>> [Browser] 检测到 SOCKS5 认证代理，正在创建本地桥接...`);
                // 创建本地中间代理 (无认证 -> 有认证)
                proxyUrlForChrome = await anonymizeProxy(upstreamUrl);
                globalProxyUrl = proxyUrlForChrome; // 记录全局代理
                console.log(`>>> [Browser] 本地桥接已建立: ${proxyUrlForChrome} -> ${host}:${port}`);

                args.push(`--proxy-server=${proxyUrlForChrome}`);
                args.push('--disable-quic');
            } catch (e) {
                console.error('>>> [Error] 代理桥接创建失败:', e);
                throw e;
            }
        } else {
            // 常规 HTTP 代理或无认证 SOCKS5
            const proxyUrl = type === 'socks5' ? `socks5://${host}:${port}` : `${host}:${port}`;
            args.push(`--proxy-server=${proxyUrl}`);
            args.push('--disable-quic');
            console.log(`>>> [Browser] 代理配置: ${type}://${host}:${port}`);
        }
    }

    const chromePath = chromeConfig.path;

    // --- 模式分支 ---

    if (!ENABLE_AUTOMATION_MODE) {
        // 仅启动浏览器
        console.log(`>>> [Browser] 正在以手动模式启动 Chrome (无远程调试)...`);
        console.log(`>>> [Browser] 启动路径: ${chromePath}`);

        // 在手动模式下自动打开目标页面
        args.push(TARGET_URL);

        const chromeProcess = spawn(chromePath, args, {
            detached: false,
            stdio: 'ignore'
        });
        globalChromeProcess = chromeProcess;

        console.log('>>> [Success] Chrome 已启动。脚本将持续运行直到浏览器关闭...');

        await new Promise((resolve) => {
            chromeProcess.on('close', async (code) => {
                console.log(`>>> [Browser] Chrome 已关闭 (退出码: ${code})`);
                await cleanup();
                resolve();
            });
        });

        console.log('>>> [Info] 浏览器已关闭，脚本退出。');
        process.exit(0);
        return null;
    }

    // --- 自动化模式 ---

    let browserWSEndpoint = null;
    try {
        const res = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.webSocketDebuggerUrl) {
                console.log('>>> [Browser] 检测到已运行的 Chrome 实例，准备连接...');
                browserWSEndpoint = data.webSocketDebuggerUrl;
            }
        }
    } catch (e) {
        console.log('>>> [Browser] 未检测到运行中的 Chrome，正在启动新实例...');
    }

    if (!browserWSEndpoint) {
        const automationArgs = [...args, `--remote-debugging-port=${remoteDebuggingPort}`];
        console.log(`>>> [Browser] 启动 Chrome (自动化模式): ${chromePath}`);

        const chromeProcess = spawn(chromePath, automationArgs, {
            detached: true,
            stdio: 'ignore'
        });
        chromeProcess.unref();
        globalChromeProcess = chromeProcess;

        console.log('>>> [Browser] Chrome 已启动，等待调试端口就绪...');

        for (let i = 0; i < 20; i++) {
            await sleep(1000, 1500);
            try {
                const res = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.webSocketDebuggerUrl) {
                        browserWSEndpoint = data.webSocketDebuggerUrl;
                        console.log('>>> [Browser] Chrome 调试接口已就绪。');
                        break;
                    }
                }
            } catch (e) { }
        }

        if (!browserWSEndpoint) {
            throw new Error('无法连接到 Chrome 远程调试端口，请检查 Chrome 是否成功启动。');
        }
    }

    // 连接 Puppeteer
    const browser = await puppeteer.connect({
        browserWSEndpoint: browserWSEndpoint,
        defaultViewport: null
    });

    globalBrowser = browser; // [新增] 保存实例引用供 cleanup 使用

    console.log('>>> [Browser] Puppeteer 已连接到 Chrome 实例。');

    browser.on('disconnected', async () => {
        console.log('>>> [Browser] 浏览器已断开连接 (可能已被关闭)。');
        await cleanup();
        process.exit(0);
    });

    // 获取页面
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('lmarena.ai'));
    if (!page) {
        page = await browser.newPage();
    } else {
        console.log('>>> [Browser] 复用已有标签页。');
    }

    // 初始化 ghost-cursor
    page.cursor = createCursor(page);

    // 代理认证 (仅当未使用 proxy-chain 桥接时)
    if (chromeConfig.proxy && chromeConfig.proxy.enable && chromeConfig.proxy.user && !proxyUrlForChrome) {
        await page.authenticate({
            username: chromeConfig.proxy.user,
            password: chromeConfig.proxy.passwd
        });
        console.log('>>> [Browser] 代理认证: 已设置 (HTTP Basic Auth)');
    }

    // 创建 CDP 会话
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    // 注册清理钩子
    if (proxyUrlForChrome) {
        console.log('>>> [Warn] 使用了本地代理桥接。请保持此脚本运行，否则 Chrome 将失去代理连接。');
    }

    // --- 行为预热建立人机检测信任 ---
    if (!page.url().includes('lmarena.ai')) {
        console.log('>>> [Browser] 正在连接 LMArena...');
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    } else {
        console.log('>>> [Browser] 页面已在 LMArena，跳过跳转。');
    }

    console.log('>>> [Warmup] 正在随机浏览页面以建立信任...');

    // 计算屏幕中心点 (动态获取视口大小)
    const vp = await getRealViewport(page);

    // 计算动态中心点
    const centerX = vp.width / 2;
    const centerY = vp.height / 2;

    // 第一次移动：从左上角移动到中心附近
    if (page.cursor) {
        // 使用 clamp 确保随机偏移后仍在屏幕内
        const targetX = clamp(centerX + random(-200, 200), 10, vp.safeWidth);
        const targetY = clamp(centerY + random(-200, 200), 10, vp.safeHeight);

        // 重置 cursor 内部状态 (可选，增加拟人化)
        await page.cursor.moveTo({ x: targetX, y: targetY });
    }
    await sleep(500, 1000);

    // 模拟滚动行为
    try {
        await page.mouse.wheel({ deltaY: random(100, 300) });
        await sleep(800, 1500);
        await page.mouse.wheel({ deltaY: -random(50, 100) });
    } catch (e) { }

    // 等待输入框出现
    const textareaSelector = 'textarea';
    await page.waitForSelector(textareaSelector, { timeout: 60000 });

    // 移动鼠标到输入框
    const box = await (await page.$(textareaSelector)).boundingBox();
    if (box) {
        if (page.cursor) {
            await page.cursor.moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        }
        await sleep(500, 1000);
    }

    console.log('>>> [Browser] 浏览器初始化完成，系统就绪');
    console.log('>>> [Browser] 当程序有任务运行时请勿随意调节窗口大小，以免鼠标轨迹错位！');

    return { browser, page, client };
}

/**
 * 执行生图任务
 * @param {object} context 浏览器上下文 {page, client}
 * @param {string} prompt 提示词
 * @param {string[]} imgPaths 图片路径数组
 * @param {string|null} modelId 模型 UUID (可选)
 * @returns {Promise<{image?: string, text?: string, error?: string}>}
 */
async function generateImage(context, prompt, imgPaths, modelId) {
    const { page, client } = context;
    const textareaSelector = 'textarea';
    let fetchPausedHandler = null;

    try {
        // 1. 强制开启新会话 (通过URL跳转)
        console.log('>>> [Task] 开启新会话...');
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

        // 等待输入框出现
        await page.waitForSelector(textareaSelector, { timeout: 30000 });
        await sleep(1500, 2500); // 等页面稳一点

        // 2. 粘贴图片
        if (imgPaths && imgPaths.length > 0) {
            await pasteImages(page, textareaSelector, imgPaths);
            // 如果没有图片，也点击一下输入框获取焦点
            await safeClick(page, textareaSelector);
        }

        // 3. 输入 Prompt
        console.log('>>> [Input] 正在输入提示词...');
        await humanType(page, textareaSelector, prompt);
        await sleep(800, 1500);

        // 注入 CDP Fetch 拦截器 
        if (modelId) {
            // 1. 启用 Fetch 域拦截，仅拦截特定 URL
            await client.send('Fetch.enable', {
                patterns: [{
                    urlPattern: '*nextjs-api/stream*',
                    requestStage: 'Request'
                }]
            });

            // 2. 定义拦截处理函数
            fetchPausedHandler = async (event) => {
                const { requestId, request } = event;

                if (request.method === 'POST' && request.postData) {
                    try {
                        // 尝试解码可能是 base64 编码的postData
                        let rawBody = request.postData;
                        // 尝试解析 JSON
                        let data;
                        try {
                            data = JSON.parse(rawBody);
                        } catch (e) {
                            // 尝试 Base64 解码
                            try {
                                rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
                                data = JSON.parse(rawBody);
                            } catch (e2) {
                                // 无法解析，跳过
                            }
                        }

                        if (data && data.modelAId) {
                            console.log(`>>> [CDP] 正在拦截请求。原始 modelAId: ${data.modelAId}`);

                            // 修改 modelAId
                            data.modelAId = modelId;

                            // 重新序列化并转为 Base64 (Fetch.continueRequest 需要 base64)
                            const newBody = JSON.stringify(data);
                            const newBodyBase64 = Buffer.from(newBody).toString('base64');

                            console.log(`>>> [CDP] 请求已修改。新 modelAId: ${data.modelAId}`);

                            await client.send('Fetch.continueRequest', {
                                requestId,
                                postData: newBodyBase64
                            });
                            return;
                        }
                    } catch (e) {
                        console.error('>>> [CDP] 拦截处理出错:', e);
                    }
                }

                // 如果不匹配或出错，直接放行
                try {
                    await client.send('Fetch.continueRequest', { requestId });
                } catch (e) { }
            };

            // 3. 监听拦截事件
            client.on('Fetch.requestPaused', fetchPausedHandler);
            console.log(`>>> [Test] 已启用 CDP Fetch 拦截，目标模型: ${modelId}`);
        }

        // 4. 发送
        const btnSelector = 'button[type="submit"]';
        await safeClick(page, btnSelector);

        console.log('>>> [Wait] 等待生成中...');

        // 5. 监听网络响应
        let targetRequestId = null;
        const result = await new Promise((resolve) => {
            const cleanup = () => {
                client.off('Network.responseReceived', onRes);
                client.off('Network.loadingFinished', onLoad);
            };
            const onRes = (e) => {
                // 监听流式响应接口
                if (e.response.url.includes('/nextjs-api/stream/')) targetRequestId = e.requestId;
            };
            const onLoad = async (e) => {
                if (e.requestId === targetRequestId) {
                    try {
                        const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId: targetRequestId });
                        const content = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;

                        // 检查是否包含 reCAPTCHA 错误
                        if (content.includes('recaptcha validation failed')) {
                            cleanup();
                            resolve({ error: 'recaptcha validation failed' });
                            return;
                        }

                        const img = extractImage(content);
                        if (img) {
                            console.log('>>> [Success] 生图成功');
                            cleanup();
                            resolve({ image: img });
                        } else {
                            console.log('>>> [Task] AI 返回文本回复:', content.substring(0, 150) + '...');
                            cleanup();
                            resolve({ text: content });
                        }
                    } catch (err) {
                        cleanup();
                        resolve({ error: err.message });
                    }
                }
            };
            client.on('Network.responseReceived', onRes);
            client.on('Network.loadingFinished', onLoad);

            // 超时保护 (120秒)
            setTimeout(() => {
                cleanup();
                resolve({ error: 'Timeout' });
            }, 120000);
        });

        // 任务结束，基于当前窗口比例智能移开鼠标
        if (page.cursor) {
            // 1. 再次获取最新视口 (用户可能在生成过程中改变了窗口大小)
            const currentVp = await getRealViewport(page);

            // 2. 计算相对坐标：停靠在屏幕右侧 85% ~ 95% 的位置
            const relativeX = currentVp.safeWidth * random(0.85, 0.95);
            const relativeY = currentVp.height * random(0.3, 0.7); // 高度居中随机

            // 3. 再次检查
            const finalX = clamp(relativeX, 0, currentVp.safeWidth);
            const finalY = clamp(relativeY, 0, currentVp.safeHeight);
            await page.cursor.moveTo({ x: finalX, y: finalY });
        }

        return result;

    } catch (err) {
        console.error('>>> [Error] 生成任务失败:', err.message);
        return { error: err.message };
    } finally {
        if (fetchPausedHandler) {
            client.off('Fetch.requestPaused', fetchPausedHandler);
            try {
                await client.send('Fetch.disable');
            } catch (e) { }
        }
    }
}

export { initBrowser, generateImage, TEMP_DIR };

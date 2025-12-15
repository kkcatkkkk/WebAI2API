/**
 * @fileoverview 资源下载模块
 * @description 图片下载与 Base64 转换
 */

/**
 * 下载图片并转换为 Base64
 * @param {string} url - 图片 URL
 * @param {object} context - 上下文对象，包含 proxyConfig 和 userDataDir
 * @returns {Promise<{ image?: string, error?: string }>} 下载结果
 */
export async function downloadImage(url, context = {}) {
    // 动态导入依赖
    const { gotScraping } = await import('got-scraping');
    const fs = await import('fs');
    const path = await import('path');
    const { getHttpProxy } = await import('../../utils/proxy.js');

    const { proxyConfig = null, userDataDir } = context;

    try {
        // 读取指纹文件获取浏览器信息
        let fingerprintPath = userDataDir
            ? path.join(userDataDir, 'fingerprint.json')
            : path.join(process.cwd(), 'data', 'camoufoxUserData', 'fingerprint.json');

        let browserName = 'firefox';
        let browserMinVersion = 100;
        let os = 'windows';
        let locale = 'en-US';

        if (fs.existsSync(fingerprintPath)) {
            try {
                const fingerprint = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
                if (fingerprint.navigator?.userAgent) {
                    const versionMatch = fingerprint.navigator.userAgent.match(/Firefox\/(\d+)/i);
                    if (versionMatch) {
                        browserMinVersion = parseInt(versionMatch[1], 10);
                    }
                }
                if (fingerprint.navigator?.platform) {
                    const platform = fingerprint.navigator.platform.toLowerCase();
                    if (platform.includes('win')) os = 'windows';
                    else if (platform.includes('mac')) os = 'macos';
                    else if (platform.includes('linux')) os = 'linux';
                }
                if (fingerprint.navigator?.language) {
                    locale = fingerprint.navigator.language;
                }
            } catch (e) {
                // 解析失败使用默认值
            }
        }

        const proxyUrl = await getHttpProxy(proxyConfig);

        const options = {
            url,
            responseType: 'buffer',
            http2: true,
            headerGeneratorOptions: {
                browsers: [{ name: browserName, minVersion: browserMinVersion }],
                devices: ['desktop'],
                locales: [locale],
                operatingSystems: [os],
            }
        };

        if (proxyUrl) {
            options.proxyUrl = proxyUrl;
        }

        const response = await gotScraping(options);
        const base64 = response.body.toString('base64');
        const contentType = response.headers['content-type'] || 'image/png';
        const mimeType = contentType.split(';')[0].trim();
        return { image: `data:${mimeType};base64,${base64}` };
    } catch (e) {
        return { error: `已获取结果，但图片下载时遇到错误: ${e.message}` };
    }
}

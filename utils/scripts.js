import fs from 'fs';
import log from './logger.js';

export function loadFile(filePath) {
    try {
        const proxies = fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        return proxies;
    } catch (error) {
        log.error(`Failed to read file ${filePath}`);
        process.exit(0);
    }
}

export function loadProxies(filePath) {
    try {
        const proxies = fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(proxy => {
                // Check if proxy is in SOCKS5 format (socks5://user:pass@host:port)
                if (proxy.startsWith('socks5://')) {
                    return { type: 'socks5', url: proxy };
                }
                // Default to HTTP/HTTPS proxy
                return { type: 'http', url: proxy.startsWith('http') ? proxy : `http://${proxy}` };
            });
        return proxies;
    } catch (error) {
        log.error(`Failed to read proxies running Without proxies...`);
        return [];
    }
}

export function generateDeviceId() {
    const hexChars = '0123456789abcdef';
    let deviceId = '';
    for (let i = 0; i < 32; i++) {
        deviceId += hexChars[Math.floor(Math.random() * hexChars.length)];
    }
    return deviceId;
}
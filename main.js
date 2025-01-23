import { generateDeviceId, loadProxies, loadFile } from './utils/scripts.js';
import { Gateway } from './utils/gateway.js';
import log from './utils/logger.js';
import banner from './utils/banner.js';
import fetch from 'node-fetch';
import { newAgent } from './utils/scripts.js';

// Consolidate headers
const headers = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9,vi;q=0.8",
    "content-type": "application/json",
    "dnt": 1,
    "origin": "chrome-extension://fgamijdhamopilihagheoalbifagafka/",
    "referer": "chrome-extension://fgamijdhamopilihagheoalbifagafka/",
    "priority": "u=1, i",
    "sec-ch-ua": '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "Windows",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};

//
const PROXIES_FILE = 'proxies.txt'
const USERS_FILE = 'userIds.txt'
const SERVER = "gw0.streamapp365.com";
const MAX_GATEWAYS = 32;

async function dispatch(dev, user, proxy) {
    const agent = newAgent(proxy);
    try {
        const response = await fetch('https://dist.streamapp365.com/dispatch', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                dev,
                user,
            }),
            agent: agent,
        });

        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const data = await response.json();
        return data;
    } catch (error) {
        return null;
    }
}

async function setupGatewaysForUser(user, proxy) {

    const numberGateway = proxies.length > MAX_GATEWAYS ? MAX_GATEWAYS : proxies.length;
    const userGateways = [];

    for (let i = 0; i < numberGateway; i++) {

        try {
            const deviceId = generateDeviceId();
            log.info(`Connecting to Gateway ${i + 1} for User ${user} using Device ID: ${deviceId} via Proxy: ${proxy}`);

            const gateway = new Gateway(SERVER, user, deviceId, proxy);
            setInterval(() => dispatch(deviceId, user, proxy), 1000 * 60 * 1);
            userGateways.push(gateway);

            await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (err) {
            log.error(`Failed to connect Gateway ${i + 1} for User ${user}: ${err.message}`);
        }
    }
    return userGateways;
}

async function main() {
    log.info(banner);
    const USERS = loadFile(USERS_FILE)
    try {
        log.info("Setting up gateways for all users...");

        const results = await Promise.allSettled(
            USERS.map((user) => setupGatewaysForUser(user.userId, user.proxyUrl))
        );

        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                log.info(`User ${USERS[index]}: Successfully set up ${result.value.length} gateways.`);
            } else {
                log.error(`User ${USERS[index]}: Failed to set up gateways. Reason: ${result.reason}`);
            }
        });

        log.info("All user gateway setups attempted.");

        process.on('SIGINT', () => {
            log.info("Cleaning up gateways...");
            results
                .filter(result => result.status === "fulfilled")
                .flatMap(result => result.value)
                .forEach((gateway, index) => {
                    if (gateway.ws) {
                        log.info(`Closing Gateway ${index + 1}`);
                        gateway.ws.close();
                    }
                });
            process.exit();
        });

    } catch (error) {
        log.error("Unexpected error during gateway setup:", error);
    }
}

// Run
main().catch((error) => log.error("Unexpected error:", error));
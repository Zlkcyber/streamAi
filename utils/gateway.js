import fetch from 'node-fetch';
import WebSocket from 'ws';
import log from './logger.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

class Task {
    constructor(taskid, method, url, headers, body, script, debug, timeout, gateway, proxy = null) {
        this.taskid = taskid;
        this.controller = new AbortController();
        this.born = Date.now();
        this.timeout = timeout;
        this.gateway = gateway;

        const fetchOptions = {
            signal: this.controller.signal,
            method,
            headers,
        };

        if (proxy) {
            fetchOptions.agent = proxy.type === 'socks5' 
                ? new SocksProxyAgent(proxy.url)
                : new HttpsProxyAgent(proxy.url);
        }

        if (body && method === "POST") {
            fetchOptions.body = body;
        }

        let statusCode = -1;

        this.task = fetch(url, fetchOptions)
            .then(async (response) => {
                const responseText = await response.text();
                log.info(`Response: ${responseText}`);

                let parsedResult = "";
                if (script && script.length > 0) {
                    parsedResult = await GlobalExecutor.execute(script, responseText, this.timeout);
                }

                statusCode = response.status;

                if (response.ok) {
                    this.gateway.transferResult(taskid, parsedResult, responseText, statusCode);
                } else {
                    throw new CustomError(ERROR_CODES.NETWORK_ERROR, responseText);
                }
            })
            .catch((error) => {
                log.error(`Task ${taskid} failed: ${error.message}`);
                this.gateway.transferError(taskid, error.message, error.code || DEFAULT_ERROR_CODE, statusCode);
            })
            .finally(() => {
                log.info(`Task ${taskid} completed`);
            });
    }

    cancel() {
        this.controller.abort();
    }
}


class CustomError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const MAX_CONNECTIONS = 32;
const PING_INTERVAL = 20 * 1000;
const CLEAR_INTERVAL = 30 * 1000;
const CONNECTION_TIMEOUT = 300 * 1000;

const ERROR_CODES = {
    NETWORK_ERROR: 50000,
    PARSE_SCRIPT_ERROR: 50001,
    PARSE_SCRIPT_TIMEOUT: 50002,
    PARSE_SCRIPT_RESULT_EMPTY: 50003,
};
const DEFAULT_ERROR_CODE = ERROR_CODES.NETWORK_ERROR;

class Gateway {
    constructor(server, user, dev, proxy = null) {
        this.server = server;
        this.user = user;
        this.dev = dev;
        this.proxy = proxy;
        this.isConnected = false;
        this.conns = new Map();
        this.wsOptions = {};

        if (this.proxy) {
            this.wsOptions.agent = this.proxy.type === 'socks5'
                ? new SocksProxyAgent(this.proxy.url)
                : new HttpsProxyAgent(this.proxy.url);
        }

        this.ws = new WebSocket(`wss://${server}/connect`, this.wsOptions);
        this._setupWebSocket();
    }

    _setupWebSocket() {
        this.ws.on("open", () => {
            log.info("Gateway connected.");
            this.isConnected = true;
            this._startPingInterval();
            this.sendMessage(
                JSON.stringify({
                    type: "register",
                    user: this.user,
                    dev: this.dev,
                })
            );
        });

        this.clearTimerId = setInterval(() => {
            const now = Date.now();
            for (const [taskid, conn] of this.conns.entries()) {
                if (conn.born + CONNECTION_TIMEOUT < now) {
                    conn.cancel();
                    log.info(`Task ${taskid} expired (born: ${conn.born}, now: ${now})`);
                }
            }
        }, CLEAR_INTERVAL);

        this.ws.on("message", (data) => {
            let messageString;
            if (Buffer.isBuffer(data)) {
                messageString = data.toString('utf8');
            } else {
                messageString = data;
            }

            if (messageString === "pong") {
                log.info(`Device ID: [ \x1b[36m${this.dev}\x1b[0m ] Message: [ \x1b[36m${messageString}\x1b[0m ]`);
                return;
            } else {
                log.info(`Received message: ${messageString}`);
            }

            try {
                const message = JSON.parse(messageString);
                this._handleMessage(message);
            } catch (error) {
                log.error(`Error handling message: ${error.message}`);
            }
        });

        this.ws.on("close", () => {
            log.info("Gateway disconnected.");
            this.isConnected = false;
            this._clearPingInterval();
            this._reconnect();
        });

        this.ws.on("error", (error) => {
            log.error(`WebSocket error: ${error.message}`);
        });
    }

    sendMessage(message) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(message);
        } else {
            setTimeout(() => this.sendMessage(message), 1000);
        }
    }

    _startPingInterval() {
        if (!this.isConnected) return;
        this.timerId = setInterval(() => {
            try {
                if (this.isConnected) {
                    this.sendMessage(JSON.stringify({ type: "ping" }));
                }
            } catch (error) {
                log.error(`Failed to send ping: ${error.message}`);
            }
        }, PING_INTERVAL);
    }

    _clearPingInterval() {
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    _handleMessage(message) {
        switch (message.type) {
            case "request":
                this._handleRequest(message);
                break;
            case "cancel":
                this._handleCancel(message.taskid);
                break;
            case "show":
                this._handleShow();
                break;
            default:
                log.info(`Unexpected message type: ${message.type}`);
        }
    }

    _handleRequest(message) {
        const { taskid, data } = message;

        if (this.conns.size >= MAX_CONNECTIONS) {
            throw new Error("Connection limit exceeded.");
        }

        if (this.conns.has(taskid)) {
            throw new Error(`Duplicate connection for task ${taskid}`);
        }

        const { method = "GET", url = "", headers = {}, body = "", timeout = 30000, script = "" } = data;

        if (!url) {
            throw new Error("Request missing URL.");
        }

        if (!taskid) {
            throw new Error("Request missing task ID.");
        }

        log.info(`Handling task ${taskid}, URL: ${url}`);
        this.conns.set(
            taskid,
            new Task(taskid, method, url, headers, body, script, data.debug, timeout, this, this.proxy)
        );
    }

    _handleCancel(taskid) {
        const connection = this.conns.get(taskid);
        if (connection) {
            connection.cancel();
            this.conns.delete(taskid);
        }
    }

    _handleShow() {
        log.info("Active tasks:", Array.from(this.conns.keys()));
    }

    _reconnect() {
        setTimeout(() => {
            log.info("Reconnecting to gateway...");
            this.ws = new WebSocket(`wss://${this.server}/connect`, this.wsOptions);
            this._setupWebSocket();
        }, 3000);
    }

    transferResult(taskid, parsed, html, rawStatus) {
        const encodedHtmlContent = encodeURIComponent(html);
        const base64Encoded = btoa(encodedHtmlContent);
        const result = {
            type: "response",
            taskid,
            result: { parsed, html: base64Encoded, rawStatus },
        };
        log.info(`Sending result: ${JSON.stringify(result)}`);
        this.sendMessage(JSON.stringify(result));
        this.conns.delete(taskid);
    }

    transferError(taskid, error, errorCode, rawStatus) {
        const errorResponse = {
            type: "error",
            taskid,
            error,
            errorCode,
            rawStatus,
        };
        log.error(`Sending error: ${JSON.stringify(errorResponse)}`);
        this.sendMessage(JSON.stringify(errorResponse));
        this.conns.delete(taskid);
    }
}

export { Gateway, Task, CustomError };

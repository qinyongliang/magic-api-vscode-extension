"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteLspClient = void 0;
const vscode = __importStar(require("vscode"));
const node_1 = require("vscode-languageclient/node");
const serverManager_1 = require("./serverManager");
const net = __importStar(require("net"));
class RemoteLspClient {
    constructor() {
        this.client = null;
        this.isStarted = false;
        // 监听服务器变化
        const serverManager = serverManager_1.ServerManager.getInstance();
        serverManager.onServerChanged(this.onServerChanged.bind(this));
    }
    static getInstance() {
        if (!RemoteLspClient.instance) {
            RemoteLspClient.instance = new RemoteLspClient();
        }
        return RemoteLspClient.instance;
    }
    // 服务器变化处理
    async onServerChanged(serverId) {
        await this.stop();
        if (serverId) {
            await this.start();
        }
    }
    // 启动 LSP 客户端
    async start() {
        try {
            const serverManager = serverManager_1.ServerManager.getInstance();
            const currentServer = serverManager.getCurrentServer();
            if (!currentServer) {
                vscode.window.showWarningMessage('请先选择一个 Magic API 服务器');
                return;
            }
            const lspUrl = serverManager.getLspUrl(currentServer.id);
            if (!lspUrl) {
                vscode.window.showErrorMessage('无法获取 LSP 服务器地址');
                return;
            }
            // 解析 LSP 服务器地址
            const url = new URL(lspUrl);
            const host = url.hostname;
            const port = parseInt(url.port) || 8081;
            // 创建服务器选项
            const serverOptions = () => {
                return new Promise((resolve, reject) => {
                    const socket = net.createConnection({ port, host }, () => {
                        resolve({
                            reader: socket,
                            writer: socket
                        });
                    });
                    socket.on('error', reject);
                });
            };
            // 客户端选项
            const clientOptions = {
                documentSelector: [
                    { scheme: 'file', language: 'magic-script' },
                    { scheme: 'magic-api', language: 'magic-script' }
                ],
                synchronize: {
                    fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ms')
                }
            };
            // 创建语言客户端
            this.client = new node_1.LanguageClient('magic-api-lsp', 'Magic API Language Server', serverOptions, clientOptions);
            // 启动客户端
            await this.client.start();
            this.isStarted = true;
            vscode.window.showInformationMessage('Magic API 语言服务器已启动');
        }
        catch (error) {
            vscode.window.showErrorMessage(`启动 LSP 客户端失败: ${error}`);
        }
    }
    // 停止 LSP 客户端
    async stop() {
        if (this.client && this.isStarted) {
            try {
                await this.client.stop();
                vscode.window.showInformationMessage('Magic API LSP 已断开连接');
            }
            catch (error) {
                console.error('停止 LSP 客户端失败:', error);
            }
        }
        this.client = null;
        this.isStarted = false;
    }
    // 重启 LSP 客户端
    async restart() {
        await this.stop();
        await this.start();
    }
    // 获取客户端状态
    isRunning() {
        return this.isStarted && this.client !== null;
    }
    // 获取客户端实例
    getClient() {
        return this.client;
    }
    // 发送自定义请求
    async sendRequest(method, params) {
        if (!this.client || !this.isStarted) {
            return null;
        }
        try {
            return await this.client.sendRequest(method, params);
        }
        catch (error) {
            console.error(`发送请求 ${method} 失败:`, error);
            return null;
        }
    }
    // 发送自定义通知
    async sendNotification(method, params) {
        if (!this.client || !this.isStarted) {
            return;
        }
        try {
            await this.client.sendNotification(method, params);
        }
        catch (error) {
            console.error(`发送通知 ${method} 失败:`, error);
        }
    }
    // 销毁
    async dispose() {
        await this.stop();
    }
}
exports.RemoteLspClient = RemoteLspClient;
//# sourceMappingURL=remoteLspClient.js.map
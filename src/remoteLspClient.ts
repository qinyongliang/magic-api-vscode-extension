import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { ServerManager } from './serverManager';
import * as net from 'net';

export class RemoteLspClient {
    private static instance: RemoteLspClient;
    private client: LanguageClient | null = null;
    private isStarted = false;

    private constructor() {
        // 监听服务器变化
        const serverManager = ServerManager.getInstance();
        serverManager.onServerChanged(this.onServerChanged.bind(this));
    }

    public static getInstance(): RemoteLspClient {
        if (!RemoteLspClient.instance) {
            RemoteLspClient.instance = new RemoteLspClient();
        }
        return RemoteLspClient.instance;
    }

    // 服务器变化处理
    private async onServerChanged(serverId: string | null): Promise<void> {
        await this.stop();
        
        if (serverId) {
            await this.start();
        }
    }

    // 启动 LSP 客户端
    async start(): Promise<void> {
        try {
            const serverManager = ServerManager.getInstance();
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
            const port = parseInt(url.port) || 8080;

            // 创建服务器选项
            const serverOptions: ServerOptions = () => {
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
            const clientOptions: LanguageClientOptions = {
                documentSelector: [
                    { scheme: 'file', language: 'magic-script' },
                    { scheme: 'magic-api', language: 'magic-script' }
                ],
                synchronize: {
                    fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ms')
                }
            };

            // 创建语言客户端
            this.client = new LanguageClient(
                'magic-api-lsp',
                'Magic API Language Server',
                serverOptions,
                clientOptions
            );

            // 启动客户端
            await this.client.start();
            this.isStarted = true;
            
            vscode.window.showInformationMessage('Magic API 语言服务器已启动');
            
        } catch (error) {
            vscode.window.showErrorMessage(`启动 LSP 客户端失败: ${error}`);
        }
    }

    // 停止 LSP 客户端
    public async stop(): Promise<void> {
        if (this.client && this.isStarted) {
            try {
                await this.client.stop();
                vscode.window.showInformationMessage('Magic API LSP 已断开连接');
            } catch (error) {
                console.error('停止 LSP 客户端失败:', error);
            }
        }

        this.client = null;
        this.isStarted = false;
    }

    // 重启 LSP 客户端
    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    // 获取客户端状态
    public isRunning(): boolean {
        return this.isStarted && this.client !== null;
    }

    // 获取客户端实例
    public getClient(): LanguageClient | null {
        return this.client;
    }

    // 发送自定义请求
    public async sendRequest<P, R>(method: string, params?: P): Promise<R | null> {
        if (!this.client || !this.isStarted) {
            return null;
        }

        try {
            return await this.client.sendRequest(method, params);
        } catch (error) {
            console.error(`发送请求 ${method} 失败:`, error);
            return null;
        }
    }

    // 发送自定义通知
    public async sendNotification<P>(method: string, params?: P): Promise<void> {
        if (!this.client || !this.isStarted) {
            return;
        }

        try {
            await this.client.sendNotification(method, params);
        } catch (error) {
            console.error(`发送通知 ${method} 失败:`, error);
        }
    }

    // 销毁
    public async dispose(): Promise<void> {
        await this.stop();
    }
}
import * as vscode from 'vscode';
import { MagicApiClient, MagicServerConfig } from './magicApiClient';
import { debug } from './logger';

export class ServerManager {
    private static instance: ServerManager;
    private servers: Map<string, MagicServerConfig> = new Map();
    private clients: Map<string, MagicApiClient> = new Map();
    private currentServerId: string | null = null;
    private _onServerChanged = new vscode.EventEmitter<string | null>();

    public readonly onServerChanged = this._onServerChanged.event;

    private constructor() {
        this.loadServers();
    }

    public static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }

    // 加载服务器配置
    private loadServers(): void {
        const config = vscode.workspace.getConfiguration('magicApi');
        const servers = config.get<MagicServerConfig[]>('servers', []);
        
        this.servers.clear();
        this.clients.clear();
        
        for (const server of servers) {
            this.servers.set(server.id, server);
            this.clients.set(server.id, new MagicApiClient(server));
        }

        // 恢复当前选中的服务器
        this.currentServerId = config.get<string>('currentServer') || null;
        if (this.currentServerId && !this.servers.has(this.currentServerId)) {
            this.currentServerId = null;
        }
    }

    // 保存服务器配置
    private async saveServers(): Promise<void> {
        const config = vscode.workspace.getConfiguration('magicApi');
        const servers = Array.from(this.servers.values());
        
        await config.update('servers', servers, vscode.ConfigurationTarget.Global);
        await config.update('currentServer', this.currentServerId, vscode.ConfigurationTarget.Global);
    }

    // 获取所有服务器
    getServers(): MagicServerConfig[] {
        return Array.from(this.servers.values());
    }

    // 获取当前服务器
    getCurrentServer(): MagicServerConfig | null {
        return this.currentServerId ? this.servers.get(this.currentServerId) || null : null;
    }

    // 获取当前客户端
    getCurrentClient(): MagicApiClient | null {
        return this.currentServerId ? this.clients.get(this.currentServerId) || null : null;
    }

    // 获取 LSP 服务器地址
    async getLspUrl(serverId: string): Promise<string | null> {
        const client = this.clients.get(serverId);
        if (!client) return null;
        // 直接返回远端 WebSocket 地址
        return client.getLspServerUrl();
    }

    // 获取调试服务器地址
    async getDebugUrl(serverId: string): Promise<string | null> {
        const client = this.clients.get(serverId);
        if (!client) return null;
        // 直接返回远端 WebSocket 地址（原生 JSON-RPC over WS）
        return client.getDebugServerUrl();
    }

    // 设置当前服务器
    async setCurrentServer(serverId: string | null): Promise<void> {
        if (serverId && !this.servers.has(serverId)) {
            throw new Error(`服务器 ${serverId} 不存在`);
        }
        this.currentServerId = serverId;
        await this.saveServers();
        this._onServerChanged.fire(serverId);
    }

    // 添加服务器
    async addServer(server: MagicServerConfig): Promise<void> {
        // 验证服务器连接
        const client = new MagicApiClient(server);
        this.servers.set(server.id, server);
        this.clients.set(server.id, client);
        await this.saveServers();
    }

    // 更新服务器
    async updateServer(server: MagicServerConfig): Promise<void> {
        if (!this.servers.has(server.id)) {
            throw new Error(`服务器 ${server.id} 不存在`);
        }

        // 验证服务器连接
        const client = new MagicApiClient(server);
        this.servers.set(server.id, server);
        this.clients.set(server.id, client);
        await this.saveServers();

        // 如果更新的是当前服务器，触发变更事件
        if (this.currentServerId === server.id) {
            this._onServerChanged.fire(server.id);
        }
    }

    // 删除服务器
    async removeServer(serverId: string): Promise<void> {
        if (!this.servers.has(serverId)) {
            throw new Error(`服务器 ${serverId} 不存在`);
        }

        this.servers.delete(serverId);
        this.clients.delete(serverId);
        // 无需处理桥接资源

        // 如果删除的是当前服务器，清空当前选择
        if (this.currentServerId === serverId) {
            this.currentServerId = null;
            this._onServerChanged.fire(null);
        }

        await this.saveServers();
    }

    // 已移除桥接逻辑
    // 显示服务器选择器
    async showServerPicker(): Promise<string | null> {
        const servers = this.getServers();
        
        if (servers.length === 0) {
            const action = await vscode.window.showInformationMessage(
                '没有配置的 Magic API 服务器',
                '添加服务器'
            );
            
            if (action === '添加服务器') {
                await this.showAddServerDialog();
            }
            return null;
        }

        const items = servers.map(server => ({
            label: server.name,
            description: server.url,
            detail: server.id === this.currentServerId ? '当前选中' : '',
            serverId: server.id
        }));

        items.unshift({
            label: '$(add) 添加新服务器',
            description: '',
            detail: '',
            serverId: '__add__'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择 Magic API 服务器'
        });

        if (!selected) {
            return null;
        }

        if (selected.serverId === '__add__') {
            return await this.showAddServerDialog();
        }

        await this.setCurrentServer(selected.serverId);
        return selected.serverId;
    }

    // 显示添加服务器对话框
    async showAddServerDialog(): Promise<string | null> {
        const name = await vscode.window.showInputBox({
            prompt: '输入服务器名称',
            placeHolder: '例如: 开发环境'
        });

        if (!name) {
            return null;
        }

        const url = await vscode.window.showInputBox({
            prompt: '输入服务器地址',
            placeHolder: '例如: http://localhost:8080'
        });

        if (!url) {
            return null;
        }

        const authType = await vscode.window.showQuickPick([
            { label: '无认证', value: 'none' },
            { label: '用户名密码', value: 'basic' },
            { label: 'Token', value: 'token' }
        ], {
            placeHolder: '选择认证方式'
        });

        if (!authType) {
            return null;
        }

        let username: string | undefined;
        let password: string | undefined;
        let token: string | undefined;

        if (authType.value === 'basic') {
            username = await vscode.window.showInputBox({
                prompt: '输入用户名'
            });

            if (!username) {
                return null;
            }

            password = await vscode.window.showInputBox({
                prompt: '输入密码',
                password: true
            });

            if (!password) {
                return null;
            }
        } else if (authType.value === 'token') {
            token = await vscode.window.showInputBox({
                prompt: '输入访问令牌',
                password: true
            });

            if (!token) {
                return null;
            }
        }

        const server: MagicServerConfig = {
            id: `server_${Date.now()}`,
            name,
            url,
            username,
            password,
            token
        };

        try {
            await this.addServer(server);
            await this.setCurrentServer(server.id);
            vscode.window.showInformationMessage(`服务器 "${name}" 添加成功`);
            return server.id;
        } catch (error) {
            vscode.window.showErrorMessage(`添加服务器失败: ${error}`);
            return null;
        }
    }

    // 显示编辑服务器对话框
    async showEditServerDialog(serverId: string): Promise<void> {
        const server = this.servers.get(serverId);
        if (!server) {
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: '输入服务器名称',
            value: server.name
        });

        if (!name) {
            return;
        }

        const url = await vscode.window.showInputBox({
            prompt: '输入服务器地址',
            value: server.url
        });

        if (!url) {
            return;
        }

        const updatedServer: MagicServerConfig = {
            ...server,
            name,
            url
        };

        try {
            await this.updateServer(updatedServer);
            vscode.window.showInformationMessage(`服务器 "${name}" 更新成功`);
        } catch (error) {
            vscode.window.showErrorMessage(`更新服务器失败: ${error}`);
        }
    }
}
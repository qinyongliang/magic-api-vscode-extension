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
exports.ServerManager = void 0;
const vscode = __importStar(require("vscode"));
const magicApiClient_1 = require("./magicApiClient");
class ServerManager {
    constructor() {
        this.servers = new Map();
        this.clients = new Map();
        this.currentServerId = null;
        this._onServerChanged = new vscode.EventEmitter();
        this.onServerChanged = this._onServerChanged.event;
        this.loadServers();
    }
    static getInstance() {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }
    // 加载服务器配置
    loadServers() {
        const config = vscode.workspace.getConfiguration('magicApi');
        const servers = config.get('servers', []);
        this.servers.clear();
        this.clients.clear();
        for (const server of servers) {
            this.servers.set(server.id, server);
            this.clients.set(server.id, new magicApiClient_1.MagicApiClient(server));
        }
        // 恢复当前选中的服务器
        this.currentServerId = config.get('currentServer') || null;
        if (this.currentServerId && !this.servers.has(this.currentServerId)) {
            this.currentServerId = null;
        }
    }
    // 保存服务器配置
    async saveServers() {
        const config = vscode.workspace.getConfiguration('magicApi');
        const servers = Array.from(this.servers.values());
        await config.update('servers', servers, vscode.ConfigurationTarget.Global);
        await config.update('currentServer', this.currentServerId, vscode.ConfigurationTarget.Global);
    }
    // 获取所有服务器
    getServers() {
        return Array.from(this.servers.values());
    }
    // 获取当前服务器
    getCurrentServer() {
        return this.currentServerId ? this.servers.get(this.currentServerId) || null : null;
    }
    // 获取当前客户端
    getCurrentClient() {
        return this.currentServerId ? this.clients.get(this.currentServerId) || null : null;
    }
    // 获取 LSP 服务器地址
    getLspUrl(serverId) {
        const client = this.clients.get(serverId);
        return client ? client.getLspServerUrl() : null;
    }
    // 获取调试服务器地址
    getDebugUrl(serverId) {
        const client = this.clients.get(serverId);
        return client ? client.getDebugServerUrl() : null;
    }
    // 设置当前服务器
    async setCurrentServer(serverId) {
        if (serverId && !this.servers.has(serverId)) {
            throw new Error(`服务器 ${serverId} 不存在`);
        }
        this.currentServerId = serverId;
        await this.saveServers();
        this._onServerChanged.fire(serverId);
    }
    // 添加服务器
    async addServer(server) {
        // 验证服务器连接
        const client = new magicApiClient_1.MagicApiClient(server);
        const isConnected = await client.testConnection();
        if (!isConnected) {
            throw new Error(`无法连接到服务器 ${server.url}`);
        }
        this.servers.set(server.id, server);
        this.clients.set(server.id, client);
        await this.saveServers();
    }
    // 更新服务器
    async updateServer(server) {
        if (!this.servers.has(server.id)) {
            throw new Error(`服务器 ${server.id} 不存在`);
        }
        // 验证服务器连接
        const client = new magicApiClient_1.MagicApiClient(server);
        const isConnected = await client.testConnection();
        if (!isConnected) {
            throw new Error(`无法连接到服务器 ${server.url}`);
        }
        this.servers.set(server.id, server);
        this.clients.set(server.id, client);
        await this.saveServers();
        // 如果更新的是当前服务器，触发变更事件
        if (this.currentServerId === server.id) {
            this._onServerChanged.fire(server.id);
        }
    }
    // 删除服务器
    async removeServer(serverId) {
        if (!this.servers.has(serverId)) {
            throw new Error(`服务器 ${serverId} 不存在`);
        }
        this.servers.delete(serverId);
        this.clients.delete(serverId);
        // 如果删除的是当前服务器，清空当前选择
        if (this.currentServerId === serverId) {
            this.currentServerId = null;
            this._onServerChanged.fire(null);
        }
        await this.saveServers();
    }
    // 测试服务器连接
    async testServer(serverId) {
        const client = this.clients.get(serverId);
        if (!client) {
            return false;
        }
        return await client.testConnection();
    }
    // 显示服务器选择器
    async showServerPicker() {
        const servers = this.getServers();
        if (servers.length === 0) {
            const action = await vscode.window.showInformationMessage('没有配置的 Magic API 服务器', '添加服务器');
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
    async showAddServerDialog() {
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
        let username;
        let password;
        let token;
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
        }
        else if (authType.value === 'token') {
            token = await vscode.window.showInputBox({
                prompt: '输入访问令牌',
                password: true
            });
            if (!token) {
                return null;
            }
        }
        const server = {
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
        }
        catch (error) {
            vscode.window.showErrorMessage(`添加服务器失败: ${error}`);
            return null;
        }
    }
    // 显示编辑服务器对话框
    async showEditServerDialog(serverId) {
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
        const updatedServer = {
            ...server,
            name,
            url
        };
        try {
            await this.updateServer(updatedServer);
            vscode.window.showInformationMessage(`服务器 "${name}" 更新成功`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`更新服务器失败: ${error}`);
        }
    }
}
exports.ServerManager = ServerManager;
//# sourceMappingURL=serverManager.js.map
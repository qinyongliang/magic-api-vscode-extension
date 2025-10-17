import * as vscode from 'vscode';
import { MagicFileInfo } from './magicFileSystemProvider';
import { ServerManager } from './serverManager';

export class StatusBarManager {
    private static instance: StatusBarManager;
    private serverStatusItem: vscode.StatusBarItem;
    private fileInfoItems: vscode.StatusBarItem[] = [];
    private currentFileInfo: MagicFileInfo | null = null;

    private constructor() {
        // 创建服务器状态项
        this.serverStatusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 
            100
        );
        this.serverStatusItem.command = 'magicApi.selectServer';
        this.serverStatusItem.tooltip = '点击选择 Magic API 服务器';
        this.serverStatusItem.show();

        // 监听服务器变化
        const serverManager = ServerManager.getInstance();
        serverManager.onServerChanged(this.updateServerStatus.bind(this));
        this.updateServerStatus(serverManager.getCurrentServer()?.id || null);

        // 监听活动编辑器变化
        vscode.window.onDidChangeActiveTextEditor(this.onActiveEditorChanged.bind(this));
        this.onActiveEditorChanged(vscode.window.activeTextEditor);
    }

    public static getInstance(): StatusBarManager {
        if (!StatusBarManager.instance) {
            StatusBarManager.instance = new StatusBarManager();
        }
        return StatusBarManager.instance;
    }

    // 更新服务器状态
    private updateServerStatus(serverId: string | null): void {
        const serverManager = ServerManager.getInstance();
        const server = serverManager.getCurrentServer();

        if (server) {
            this.serverStatusItem.text = `$(server) ${server.name}`;
            this.serverStatusItem.backgroundColor = undefined;
        } else {
            this.serverStatusItem.text = '$(server) 未连接';
            this.serverStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    // 监听活动编辑器变化
    private async onActiveEditorChanged(editor: vscode.TextEditor | undefined): Promise<void> {
        // 清除之前的文件信息
        this.clearFileInfo();

        if (!editor || !editor.document.uri.scheme.startsWith('magic-api')) {
            return;
        }

        // 获取文件信息
        const fileInfo = await this.getFileInfoFromUri(editor.document.uri);
        if (fileInfo) {
            this.showFileInfo(fileInfo);
        }
    }

    // 从 URI 获取文件信息
    private async getFileInfoFromUri(uri: vscode.Uri): Promise<MagicFileInfo | null> {
        const serverManager = ServerManager.getInstance();
        const client = serverManager.getCurrentClient();
        
        if (!client) {
            return null;
        }

        // 从路径解析文件ID
        const pathParts = uri.path.split('/').filter(p => p);
        if (pathParts.length < 2 || !pathParts[pathParts.length - 1].endsWith('.ms')) {
            return null;
        }

        const fileName = pathParts[pathParts.length - 1].replace('.ms', '');
        
        // 这里需要通过客户端查找文件
        // 实际实现中可能需要更复杂的路径解析逻辑
        const fileId = client.getFileIdByPath(uri.path.replace(/^\/+/, ''));
        if (fileId) {
            return await client.getFile(fileId);
        }

        return null;
    }

    // 显示文件信息
    private showFileInfo(fileInfo: MagicFileInfo): void {
        this.currentFileInfo = fileInfo;
        this.clearFileInfo();

        const items: Array<{ text: string; tooltip: string; priority: number }> = [];

        // 文件类型
        items.push({
            text: `$(file-code) ${fileInfo.type.toUpperCase()}`,
            tooltip: `文件类型: ${fileInfo.type}`,
            priority: 90
        });

        // API 特有信息
        if (fileInfo.type === 'api' && fileInfo.method && fileInfo.requestMapping) {
            items.push({
                text: `$(globe) ${fileInfo.method} ${fileInfo.requestMapping}`,
                tooltip: `请求方法: ${fileInfo.method}\n请求路径: ${fileInfo.requestMapping}`,
                priority: 89
            });
        }

        // 分组路径
        if (fileInfo.groupPath) {
            items.push({
                text: `$(folder) ${fileInfo.groupPath}`,
                tooltip: `分组路径: ${fileInfo.groupPath}`,
                priority: 88
            });
        }

        // 创建时间
        if (fileInfo.createTime) {
            const createTime = new Date(fileInfo.createTime).toLocaleString();
            items.push({
                text: `$(clock) ${createTime}`,
                tooltip: `创建时间: ${createTime}`,
                priority: 87
            });
        }

        // 更新时间
        if (fileInfo.updateTime) {
            const updateTime = new Date(fileInfo.updateTime).toLocaleString();
            items.push({
                text: `$(history) ${updateTime}`,
                tooltip: `更新时间: ${updateTime}`,
                priority: 86
            });
        }

        // 创建者
        if (fileInfo.createBy) {
            items.push({
                text: `$(person) ${fileInfo.createBy}`,
                tooltip: `创建者: ${fileInfo.createBy}`,
                priority: 85
            });
        }

        // 锁定状态
        if (fileInfo.locked) {
            items.push({
                text: `$(lock) 已锁定`,
                tooltip: '文件已被锁定',
                priority: 84
            });
        }

        // 描述
        if (fileInfo.description) {
            items.push({
                text: `$(info) ${fileInfo.description}`,
                tooltip: `描述: ${fileInfo.description}`,
                priority: 83
            });
        }

        // 创建状态栏项
        for (const item of items) {
            const statusBarItem = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Left,
                item.priority
            );
            statusBarItem.text = item.text;
            statusBarItem.tooltip = item.tooltip;
            statusBarItem.show();
            this.fileInfoItems.push(statusBarItem);
        }
    }

    // 清除文件信息
    private clearFileInfo(): void {
        for (const item of this.fileInfoItems) {
            item.dispose();
        }
        this.fileInfoItems = [];
        this.currentFileInfo = null;
    }

    // 更新当前文件信息
    public async refreshCurrentFileInfo(): Promise<void> {
        if (!this.currentFileInfo) {
            return;
        }

        const serverManager = ServerManager.getInstance();
        const client = serverManager.getCurrentClient();
        
        if (!client) {
            return;
        }

        const updatedFileInfo = await client.getFile(this.currentFileInfo.id);
        if (updatedFileInfo) {
            this.showFileInfo(updatedFileInfo);
        }
    }

    // 获取当前文件信息
    public getCurrentFileInfo(): MagicFileInfo | null {
        return this.currentFileInfo;
    }

    // 销毁
    public dispose(): void {
        this.serverStatusItem.dispose();
        this.clearFileInfo();
    }
}
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
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const serverManager_1 = require("./serverManager");
const magicFileSystemProvider_1 = require("./magicFileSystemProvider");
const logger_1 = require("./logger");
const statusBarManager_1 = require("./statusBarManager");
const remoteLspClient_1 = require("./remoteLspClient");
const debugAdapterFactory_1 = require("./debugAdapterFactory");
function activate(context) {
    console.log('Magic API extension is now active!');
    (0, logger_1.info)('Magic API extension activated');
    // 初始化管理器
    const serverManager = serverManager_1.ServerManager.getInstance();
    const statusBarManager = statusBarManager_1.StatusBarManager.getInstance();
    const remoteLspClient = remoteLspClient_1.RemoteLspClient.getInstance();
    // 注册虚拟文件系统
    const fileSystemProvider = new magicFileSystemProvider_1.MagicFileSystemProvider(serverManager.getCurrentClient());
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('magic-api', fileSystemProvider, {
        isCaseSensitive: true,
        isReadonly: false
    }));
    // 监听服务器变化，更新文件系统提供者
    serverManager.onServerChanged((serverId) => {
        const client = serverManager.getCurrentClient();
        if (client) {
            // 更新文件系统提供者的客户端
            fileSystemProvider.client = client;
        }
    });
    // 注册命令
    registerCommands(context, serverManager, statusBarManager, remoteLspClient);
    // 注册调试适配器
    const debugAdapterFactory = new debugAdapterFactory_1.MagicApiDebugAdapterDescriptorFactory();
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('magic-api', debugAdapterFactory));
    // 配置 magic-script 语言
    vscode.languages.setLanguageConfiguration('magic-script', {
        comments: {
            lineComment: '//',
            blockComment: ['/*', '*/']
        },
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')']
        ],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
        ]
    });
    // 自动启动 LSP（如果有当前服务器）
    if (serverManager.getCurrentServer()) {
        remoteLspClient.start();
    }
}
exports.activate = activate;
function deactivate() {
    const remoteLspClient = remoteLspClient_1.RemoteLspClient.getInstance();
    const statusBarManager = statusBarManager_1.StatusBarManager.getInstance();
    statusBarManager.dispose();
    return remoteLspClient.dispose();
}
exports.deactivate = deactivate;
function registerCommands(context, serverManager, statusBarManager, remoteLspClient) {
    // 选择服务器
    const selectServerCommand = vscode.commands.registerCommand('magicApi.selectServer', async () => {
        await serverManager.showServerPicker();
    });
    // 添加服务器
    const addServerCommand = vscode.commands.registerCommand('magicApi.addServer', async () => {
        await serverManager.showAddServerDialog();
    });
    // 刷新文件信息
    const refreshFileInfoCommand = vscode.commands.registerCommand('magicApi.refreshFileInfo', async () => {
        await statusBarManager.refreshCurrentFileInfo();
    });
    // 重启 LSP
    const restartLspCommand = vscode.commands.registerCommand('magicApi.restartLanguageServer', async () => {
        await remoteLspClient.restart();
    });
    // 连接到工作区
    const connectWorkspaceCommand = vscode.commands.registerCommand('magicApi.connectWorkspace', async () => {
        const serverId = await serverManager.showServerPicker();
        if (serverId) {
            // 打开虚拟文件系统工作区
            const uri = vscode.Uri.parse('magic-api:/');
            await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
        }
    });
    // 创建新文件
    const createFileCommand = vscode.commands.registerCommand('magicApi.createFile', async (uri) => {
        if (!uri || uri.scheme !== 'magic-api') {
            vscode.window.showErrorMessage('请在 Magic API 工作区中执行此操作');
            return;
        }
        const fileName = await vscode.window.showInputBox({
            prompt: '输入文件名',
            placeHolder: '例如: getUserInfo'
        });
        if (!fileName) {
            return;
        }
        const newFileUri = vscode.Uri.parse(`${uri.toString()}/${fileName}.ms`);
        await vscode.workspace.fs.writeFile(newFileUri, Buffer.from('// Magic Script\n', 'utf8'));
        await vscode.window.showTextDocument(newFileUri);
    });
    // 创建新分组
    const createGroupCommand = vscode.commands.registerCommand('magicApi.createGroup', async (uri) => {
        if (!uri || uri.scheme !== 'magic-api') {
            vscode.window.showErrorMessage('请在 Magic API 工作区中执行此操作');
            return;
        }
        const groupName = await vscode.window.showInputBox({
            prompt: '输入分组名',
            placeHolder: '例如: user'
        });
        if (!groupName) {
            return;
        }
        const newGroupUri = vscode.Uri.parse(`${uri.toString()}/${groupName}`);
        await vscode.workspace.fs.createDirectory(newGroupUri);
    });
    // 测试 API
    const testApiCommand = vscode.commands.registerCommand('magicApi.testApi', async () => {
        const fileInfo = statusBarManager.getCurrentFileInfo();
        if (!fileInfo || fileInfo.type !== 'api') {
            vscode.window.showErrorMessage('请在 API 文件中执行此操作');
            return;
        }
        if (!fileInfo.method || !fileInfo.requestMapping) {
            vscode.window.showErrorMessage('API 文件缺少请求方法或路径信息');
            return;
        }
        const serverManager = serverManager_1.ServerManager.getInstance();
        const server = serverManager.getCurrentServer();
        if (!server) {
            vscode.window.showErrorMessage('请先选择服务器');
            return;
        }
        const testUrl = `${server.url}${fileInfo.requestMapping}`;
        vscode.env.openExternal(vscode.Uri.parse(testUrl));
    });
    // 注册所有命令
    context.subscriptions.push(selectServerCommand, addServerCommand, refreshFileInfoCommand, restartLspCommand, connectWorkspaceCommand, createFileCommand, createGroupCommand, testApiCommand);
}
//# sourceMappingURL=extension.js.map
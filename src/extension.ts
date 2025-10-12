import * as vscode from 'vscode';
import { ServerManager } from './serverManager';
import { MagicFileSystemProvider } from './magicFileSystemProvider';
import { StatusBarManager } from './statusBarManager';
import { RemoteLspClient } from './remoteLspClient';
import { MagicApiDebugAdapterDescriptorFactory } from './debugAdapterFactory';

export function activate(context: vscode.ExtensionContext) {
	console.log('Magic API extension is now active!');

	// 初始化管理器
	const serverManager = ServerManager.getInstance();
	const statusBarManager = StatusBarManager.getInstance();
	const remoteLspClient = RemoteLspClient.getInstance();

	// 注册虚拟文件系统
	const fileSystemProvider = new MagicFileSystemProvider(serverManager.getCurrentClient()!);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('magic-api', fileSystemProvider, {
			isCaseSensitive: true,
			isReadonly: false
		})
	);

	// 监听服务器变化，更新文件系统提供者
	serverManager.onServerChanged((serverId) => {
		const client = serverManager.getCurrentClient();
		if (client) {
			// 更新文件系统提供者的客户端
			(fileSystemProvider as any).client = client;
		}
	});

	// 注册命令
	registerCommands(context, serverManager, statusBarManager, remoteLspClient);

	// 注册调试适配器
	const debugAdapterFactory = new MagicApiDebugAdapterDescriptorFactory();
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('magic-api', debugAdapterFactory)
	);

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

export function deactivate(): Thenable<void> | undefined {
	const remoteLspClient = RemoteLspClient.getInstance();
	const statusBarManager = StatusBarManager.getInstance();
	
	statusBarManager.dispose();
	return remoteLspClient.dispose();
}

function registerCommands(
	context: vscode.ExtensionContext,
	serverManager: ServerManager,
	statusBarManager: StatusBarManager,
	remoteLspClient: RemoteLspClient
) {
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
	const createFileCommand = vscode.commands.registerCommand('magicApi.createFile', async (uri?: vscode.Uri) => {
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
	const createGroupCommand = vscode.commands.registerCommand('magicApi.createGroup', async (uri?: vscode.Uri) => {
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

		const serverManager = ServerManager.getInstance();
		const server = serverManager.getCurrentServer();
		if (!server) {
			vscode.window.showErrorMessage('请先选择服务器');
			return;
		}

		const testUrl = `${server.url}${fileInfo.requestMapping}`;
		vscode.env.openExternal(vscode.Uri.parse(testUrl));
	});

	// 注册所有命令
	context.subscriptions.push(
		selectServerCommand,
		addServerCommand,
		refreshFileInfoCommand,
		restartLspCommand,
		connectWorkspaceCommand,
		createFileCommand,
		createGroupCommand,
		testApiCommand
	);
}
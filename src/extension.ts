import * as vscode from 'vscode';
import { ServerManager } from './serverManager';
import { MagicFileSystemProvider, MagicFileInfo } from './magicFileSystemProvider';
import { info } from './logger';
import { StatusBarManager } from './statusBarManager';
import { RemoteLspClient } from './remoteLspClient';
import { MagicApiDebugAdapterDescriptorFactory } from './debugAdapterFactory';
import { MirrorWorkspaceManager } from './mirrorWorkspaceManager';
import { MagicApiClient, MagicServerConfig } from './magicApiClient';
import { registerLocalLanguageFeatures } from './localLanguageFeatures';

class MagicApiDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    async provideDebugConfigurations(folder?: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration[]> {
        const serverManager = ServerManager.getInstance();
        const server = serverManager.getCurrentServer();
        const common = { type: 'magic-api', request: 'launch', stopOnEntry: false, trace: false };
        const configs: vscode.DebugConfiguration[] = [
            {
                ...common,
                name: '调试 Magic API (当前服务器)',
                serverId: server?.id
            },
            {
                ...common,
                name: '调试 Magic API (自定义)',
                host: 'localhost',
                port: 8082
            }
        ];
        return configs;
    }

    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null | undefined> {
        // Ensure type/request
        config.type = config.type ?? 'magic-api';
        config.request = config.request ?? 'launch';
        // 默认不在入口暂停，避免启动卡住提示；用户可在自定义配置中开启
        config.stopOnEntry = config.stopOnEntry ?? false;
        config.trace = config.trace ?? false;

        const serverManager = ServerManager.getInstance();
        const mirrorManager = MirrorWorkspaceManager.getInstance();
        // If no serverId/host set, prefer current server
        if (!config.serverId && !config.host) {
            const server = serverManager.getCurrentServer();
            if (server) {
                config.serverId = server.id;
            }
        }

        // 兜底设置 cwd 为镜像根目录（如果可解析）
        if (!(config as any).cwd) {
            const active = vscode.window.activeTextEditor;
            if (active?.document?.uri?.scheme === 'file') {
                const mroot = await mirrorManager.findMirrorRootForUri(active.document.uri);
                if (mroot) (config as any).cwd = mroot.fsPath;
            } else if (config.serverId) {
                const srv = serverManager.getServers().find(s => s.id === config.serverId);
                if (srv) {
                    const mrootByConn = await mirrorManager.findMirrorRootByConnection({
                        url: srv.url,
                        token: srv.token,
                        username: srv.username,
                        password: srv.password,
                        lspPort: (srv as any).lspPort,
                        debugPort: (srv as any).debugPort,
                    });
                    if (mrootByConn) (config as any).cwd = mrootByConn.fsPath;
                }
            }
        }

        // If opened an .ms file, derive file metadata to improve debugging UX
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.scheme === 'magic-api' && editor.document.uri.path.endsWith('.ms')) {
            const fileInfo = StatusBarManager.getInstance().getCurrentFileInfo();
            let infoToUse: MagicFileInfo | null = fileInfo;
            if (!infoToUse) {
                const client = serverManager.getCurrentClient();
                if (client) {
                    const fileKey = editor.document.uri.path.replace(/^\//, '');
                    const fid = client.getFileIdByPath(fileKey);
                    if (fid) {
                        const fetched = await client.getFile(fid);
                        if (fetched) infoToUse = fetched as MagicFileInfo;
                    }
                }
            }

            if (infoToUse) {
                const fileKey = `${infoToUse.groupPath}/${infoToUse.name}.ms`;
                config.program = config.program ?? infoToUse.id;
                config.fileKey = config.fileKey ?? fileKey;
                config.resourceType = config.resourceType ?? infoToUse.type;
                config.method = config.method ?? infoToUse.method;
                config.requestMapping = config.requestMapping ?? infoToUse.requestMapping;
            }
        }

        return config;
    }
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Magic API extension is now active!');
    info('Magic API extension activated');

	// 初始化管理器
	const serverManager = ServerManager.getInstance();
	const statusBarManager = StatusBarManager.getInstance();
	const remoteLspClient = RemoteLspClient.getInstance();
    const mirrorManager = MirrorWorkspaceManager.getInstance(context);

    // 注册本地语言功能（远程 LSP 不可用时提供补全/导航/Hover）
    registerLocalLanguageFeatures(context, remoteLspClient);

	// 注册虚拟文件系统
    const fileSystemProvider = new MagicFileSystemProvider(serverManager.getCurrentClient()!, context.globalStorageUri);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('magic-api', fileSystemProvider, {
            isCaseSensitive: true,
            isReadonly: false
        })
    );

    // 监听服务器变化，更新文件系统提供者
    serverManager.onServerChanged(async (serverId) => {
        const client = serverManager.getCurrentClient();
        if (client) {
            // 更新文件系统提供者的客户端
            (fileSystemProvider as any).client = client;

            // 若当前不是镜像工作区，提示用户创建镜像工作区（按连接信息）
            try {
                const cfg = serverId ? serverManager.getServers().find(s => s.id === serverId) : undefined;
                if (cfg) {
                    await mirrorManager.promptCreateMirrorWorkspaceIfNeeded(client, cfg);
                }
            } catch {}
        }
    });

	// 注册命令
	registerCommands(context, serverManager, statusBarManager, remoteLspClient);

	// 注册调试适配器
	const debugAdapterFactory = new MagicApiDebugAdapterDescriptorFactory();
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('magic-api', debugAdapterFactory)
	);

	// 注册调试配置提供者，确保选择调试器时有响应
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('magic-api', new MagicApiDebugConfigurationProvider())
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

	// 确保 magic-api 虚拟文档使用正确的语言模式
	const ensureMagicScriptLanguage = async (doc: vscode.TextDocument) => {
		try {
			const isMagicApi = doc.uri.scheme === 'magic-api';
			const isMagicScriptFile = doc.uri.path.endsWith('.ms') || doc.uri.path.endsWith('.magic');
			if (isMagicApi && isMagicScriptFile && doc.languageId !== 'magic-script') {
				await vscode.languages.setTextDocumentLanguage(doc, 'magic-script');
			}
		} catch (e) {
			// 忽略语言切换错误，避免打扰用户
		}
	};

	// 对当前已打开的文档进行一次修正
	vscode.workspace.textDocuments.forEach((doc) => { ensureMagicScriptLanguage(doc); });

	// 当用户打开 .magic-api-mirror.json 文件时，在未连接且仅首次点击时提示连接
	const maybePromptConnectForMagicFile = async (doc: vscode.TextDocument) => {
		try {
			if (doc.uri.scheme !== 'file') return;
			const name = doc.fileName.replace(/^.*[\\/]/, '');
			if (name !== '.magic-api-mirror.json') return;
			const root = vscode.Uri.joinPath(doc.uri, '..');

			// 若该镜像根已连接，则不提示
			if ((mirrorManager as any).isMirrorRootConnected?.(root)) return;

			// 本窗口只提示一次
			const shownKey = `magicApi.promptedMirrorRoot:${root.fsPath}`;
			const hasShown = !!context.workspaceState.get<boolean>(shownKey);
			if (hasShown) return;

			const meta = await mirrorManager.readMirrorMeta(root);
			const action = await vscode.window.showInformationMessage(
				'检测到镜像标记文件，是否连接该镜像工作区以启用同步？',
				'连接', '取消'
			);
			await context.workspaceState.update(shownKey, true);
			if (action !== '连接') return;

			let clientForMirror: MagicApiClient | undefined;
			if (meta?.url) {
				const fromManager = serverManager.getServers().find(s => s.url === meta.url);
				const cfg: MagicServerConfig = fromManager ?? {
					id: `mirror_${meta.url.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}`,
					name: `Mirror: ${new URL(meta.url).host}`,
					url: meta.url!,
					token: (meta as any).token,
					username: (meta as any).username,
					password: (meta as any).password,
					lspPort: (meta as any).lspPort,
					debugPort: (meta as any).debugPort,
				} as MagicServerConfig;
				clientForMirror = new MagicApiClient(cfg);
			} else {
				clientForMirror = serverManager.getCurrentClient() || undefined;
			}
			if (!clientForMirror) {
				vscode.window.showWarningMessage('无法获取连接信息，已取消连接该镜像工作区。');
				return;
			}
			const disposables = mirrorManager.startMirrorListeners(clientForMirror, root);
			context.subscriptions.push(...disposables);
			try {
				await (mirrorManager as any).compareAndSyncOnLoad?.(clientForMirror, root);
			} catch {}
		} catch {}
	};

	// 文档打开时修正语言模式，并在打开 .magic-api-mirror.json 文件时提示连接镜像
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(async (doc) => {
			await ensureMagicScriptLanguage(doc);
			await maybePromptConnectForMagicFile(doc);
		})
	);

	// 编辑器切换时修正语言模式
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) { ensureMagicScriptLanguage(editor.document); }
		})
	);

    // 如果当前打开的是非镜像工作区且已选择服务器，主动提示创建镜像工作区
    (async () => {
        try {
            const currentServer = serverManager.getCurrentServer();
            const currentClient = serverManager.getCurrentClient();
            const folders = vscode.workspace.workspaceFolders;
            const currentFolder = folders && folders.length > 0 ? folders[0].uri : null;
            if (currentServer && currentClient && currentFolder) {
                const isMirror = await mirrorManager.isMirrorWorkspace(currentFolder);
                if (!isMirror) {
                    await mirrorManager.promptCreateMirrorWorkspaceIfNeeded(currentClient, currentServer);
                    remoteLspClient.start();
                }
            }
        } catch {}
    })();

    // 如果当前打开的是镜像工作区，则绑定服务器并启动监听
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        (async () => {
            const root = folders[0].uri;
            const isMirror = await mirrorManager.isMirrorWorkspace(root);
            if (isMirror) {
                const meta = await mirrorManager.readMirrorMeta(root);
                // 优先使用镜像元数据中的连接信息，其次使用当前服务器
                let clientForRoot: MagicApiClient | undefined;
                if (meta?.url) {
                    const cfgFromManager = serverManager.getServers().find(s => s.url === meta.url);
                    const cfg: MagicServerConfig = cfgFromManager ?? {
                        id: `mirror_${meta.url.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}`,
                        name: `Mirror: ${new URL(meta.url).host}`,
                        url: meta.url!,
                        token: (meta as any).token,
                        username: (meta as any).username,
                        password: (meta as any).password,
                        lspPort: (meta as any).lspPort,
                        debugPort: (meta as any).debugPort,
                    } as MagicServerConfig;
                    clientForRoot = new MagicApiClient(cfg);
                } else {
                    const cur = serverManager.getCurrentClient();
                    clientForRoot = cur || undefined;
                }

                if (clientForRoot) {
                    // 连接提示：是否连接该镜像工作区（可记住选择）
                    const pref = await (mirrorManager as any).getMirrorConnectPreference?.(root);
                    let allowConnect = pref === 'yes';
                    let remembered = !!pref;
                    if (!remembered) {
                        const pick = await vscode.window.showInformationMessage(
                            `检测到镜像工作区（${root.fsPath}），是否连接该服务器以启用同步？`,
                            '是', '否', '是（记住）', '否（记住）'
                        );
                        if (!pick) {
                            allowConnect = false;
                        } else if (pick.startsWith('是')) {
                            allowConnect = true;
                            if (pick.includes('记住')) await (mirrorManager as any).setMirrorConnectPreference?.(root, 'yes');
                        } else {
                            allowConnect = false;
                            if (pick.includes('记住')) await (mirrorManager as any).setMirrorConnectPreference?.(root, 'no');
                        }
                    }

                    if (allowConnect) {
                        const disposables = mirrorManager.startMirrorListeners(clientForRoot, root);
                        context.subscriptions.push(...disposables);
                        // 加载时执行一次双向同步提示与处理（根据用户选择）
                        try {
                            await (mirrorManager as any).compareAndSyncOnLoad?.(clientForRoot, root);
                        } catch {}
                    }
                }
            }

            // 扫描工作区中的子目录镜像，不改变全局当前服务器
            try {
                const roots = await mirrorManager.findAllMirrorRootsInWorkspace();
                for (const r of roots) {
                    // 避免对工作区根重复处理
                    if (r.fsPath === root.fsPath) continue;
                    const meta = await mirrorManager.readMirrorMeta(r);
                    if (!meta?.url) {
                        vscode.window.showWarningMessage(`发现镜像工作区(${r.fsPath})，但缺少连接信息，无法绑定服务器。请在 .magic-api-mirror.json 中配置 url 或在扩展设置中添加该服务器。`);
                        continue;
                    }
                    // 优先从 ServerManager 配置中获取完整连接信息
                    const fromManager = serverManager.getServers().find(s => s.url === meta.url);
                    const cfg: MagicServerConfig = fromManager ?? {
                        id: `mirror_${meta.url.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}`,
                        name: `Mirror: ${new URL(meta.url).host}`,
                        url: meta.url!,
                        token: (meta as any).token,
                        username: (meta as any).username,
                        password: (meta as any).password,
                        lspPort: (meta as any).lspPort,
                        debugPort: (meta as any).debugPort,
                    } as MagicServerConfig;
                    const clientForMirror = new MagicApiClient(cfg);
                    // 连接提示（子目录镜像）：是否连接该镜像工作区（可记住选择）
                    const pref = await (mirrorManager as any).getMirrorConnectPreference?.(r);
                    let allowConnect = pref === 'yes';
                    let remembered = !!pref;
                    if (!remembered) {
                        const pick = await vscode.window.showInformationMessage(
                            `检测到镜像子目录（${r.fsPath}），是否连接该服务器以启用同步？`,
                            '是', '否', '是（记住）', '否（记住）'
                        );
                        if (!pick) {
                            allowConnect = false;
                        } else if (pick.startsWith('是')) {
                            allowConnect = true;
                            if (pick.includes('记住')) await (mirrorManager as any).setMirrorConnectPreference?.(r, 'yes');
                        } else {
                            allowConnect = false;
                            if (pick.includes('记住')) await (mirrorManager as any).setMirrorConnectPreference?.(r, 'no');
                        }
                    }

                    if (allowConnect) {
                        const disposables = mirrorManager.startMirrorListeners(clientForMirror, r);
                        context.subscriptions.push(...disposables);
                        try {
                            await (mirrorManager as any).compareAndSyncOnLoad?.(clientForMirror, r);
                        } catch {}
                    }
                }
            } catch {}
        })();
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
    // Mirror manager（用于镜像工作区路径解析与元数据读写）
    const mirrorManager = MirrorWorkspaceManager.getInstance(context);
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
            // 打开本地镜像工作区（选择一个本地目录进行同步）
            const client = serverManager.getCurrentClient();
            if (!client) {
                vscode.window.showErrorMessage('无法获取当前服务器客户端');
                return;
            }
            const serverCfg = serverManager.getCurrentServer();
            const defaultUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri : undefined;
            const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择镜像工作区根目录', defaultUri });
            const folder = picked && picked[0];
            if (!folder) return;
            if (folder.scheme !== 'file') {
                vscode.window.showErrorMessage('请选择本地文件系统目录作为镜像工作区根目录');
                return;
            }
            await MirrorWorkspaceManager.getInstance(context).openMirrorWorkspace(client, folder, serverCfg!);
        }
    });

	// 连接镜像根（右键 .magic-api-mirror.json）
	const connectMirrorRootCommand = vscode.commands.registerCommand('magicApi.connectMirrorRoot', async (uri?: vscode.Uri) => {
		try {
			let root: vscode.Uri | null = null;
			if (uri && uri.scheme === 'file') {
				const baseName = uri.fsPath.replace(/^.*[\\\/]/, '');
				if (baseName === '.magic-api-mirror.json') {
					root = vscode.Uri.joinPath(uri, '..');
				} else {
					root = await mirrorManager.findMirrorRootForUri(uri);
				}
			}
			if (!root) {
				vscode.window.showErrorMessage('未能定位镜像工作区根目录');
				return;
			}
			if (mirrorManager.isMirrorRootConnected(root)) {
				vscode.window.showInformationMessage('该镜像工作区已连接');
				return;
			}
			const meta = await mirrorManager.readMirrorMeta(root);
			let clientForMirror: MagicApiClient | undefined;
			if (meta?.url) {
				const fromManager = serverManager.getServers().find(s => s.url === meta.url);
				const cfg: MagicServerConfig = fromManager ?? {
					id: `mirror_${meta.url.replace(/^[a-zA-Z]+:\/\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}`,
					name: `Mirror: ${new URL(meta.url).host}`,
					url: meta.url!,
					token: (meta as any).token,
					username: (meta as any).username,
					password: (meta as any).password,
					lspPort: (meta as any).lspPort,
					debugPort: (meta as any).debugPort,
				} as MagicServerConfig;
				clientForMirror = new MagicApiClient(cfg);
			} else {
				clientForMirror = serverManager.getCurrentClient() || undefined;
			}
			if (!clientForMirror) {
				vscode.window.showWarningMessage('无法获取连接信息，已取消连接该镜像工作区。');
				return;
			}
			await mirrorManager.connectMirrorRoot(clientForMirror, root);
			vscode.window.showInformationMessage('镜像工作区已连接');
		} catch {
			vscode.window.showErrorMessage('连接镜像工作区失败');
		}
	});

	// 断开镜像根（右键 .magic-api-mirror.json）
	const disconnectMirrorRootCommand = vscode.commands.registerCommand('magicApi.disconnectMirrorRoot', async (uri?: vscode.Uri) => {
		try {
			let root: vscode.Uri | null = null;
			if (uri && uri.scheme === 'file') {
				const baseName = uri.fsPath.replace(/^.*[\\\/]/, '');
				if (baseName === '.magic-api-mirror.json') {
					root = vscode.Uri.joinPath(uri, '..');
				} else {
					root = await mirrorManager.findMirrorRootForUri(uri);
				}
			}
			if (!root) {
				vscode.window.showErrorMessage('未能定位镜像工作区根目录');
				return;
			}
			if (!mirrorManager.isMirrorRootConnected(root)) {
				vscode.window.showInformationMessage('该镜像工作区尚未连接');
				return;
			}
			mirrorManager.disconnectMirrorRoot(root);
			vscode.window.showInformationMessage('已断开镜像工作区连接');
		} catch {
			vscode.window.showErrorMessage('断开镜像工作区失败');
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

	// 运行当前脚本（不调试）
    const runScriptCommand = vscode.commands.registerCommand('magicApi.runScript', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.uri.path.endsWith('.ms')) {
            vscode.window.showErrorMessage('请在 Magic Script (.ms) 文件中执行');
            return;
        }

        const serverManager = ServerManager.getInstance();
        const server = serverManager.getCurrentServer();
        if (!server) {
            vscode.window.showErrorMessage('请先选择服务器');
            return;
        }

        const client = serverManager.getCurrentClient();
        if (!client) {
            vscode.window.showErrorMessage('无法获取当前服务器客户端');
            return;
        }

        // 支持 magic-api 与镜像工作区文件
        let typedPath: string | null = null;
        let programId: string | undefined;
        let finfo: MagicFileInfo | null = null;

        if (editor.document.uri.scheme === 'magic-api') {
            const fileInfo = statusBarManager.getCurrentFileInfo();
            finfo = fileInfo;
            if (!finfo) {
                const fileKey = editor.document.uri.path.replace(/^\//, '');
                const fid = client.getFileIdByPath(fileKey);
                if (!fid) {
                    vscode.window.showErrorMessage('无法解析当前脚本的文件ID');
                    return;
                }
                const fetched = await client.getFile(fid);
                if (!fetched) {
                    vscode.window.showErrorMessage('无法获取当前脚本的文件信息');
                    return;
                }
                finfo = fetched as MagicFileInfo;
            }
            const fullDir = (() => {
                const type = finfo!.type || 'api';
                const gpRaw = (finfo!.groupPath || '').replace(/^\/+/, '');
                const gp = gpRaw ? gpRaw : '';
                if (!gp) return `${type}`;
                return gp.startsWith(`${type}/`) ? gp : `${type}/${gp}`;
            })();
            typedPath = `${fullDir}/${finfo!.name}.ms`;
            programId = finfo!.id;
        } else if (editor.document.uri.scheme === 'file') {
            const mirrorRoot = await mirrorManager.findMirrorRootForUri(editor.document.uri);
            if (!mirrorRoot) {
                vscode.window.showErrorMessage('当前文件不在镜像工作区中');
                return;
            }
            const parsed = mirrorManager.parseMirrorFile(mirrorRoot, editor.document.uri);
            if (!parsed.type || !parsed.fileName || !parsed.typedPath) {
                vscode.window.showErrorMessage('无法解析镜像文件路径');
                return;
            }
            typedPath = parsed.typedPath;
            const fid = client.getFileIdByPath(typedPath);
            if (!fid) {
                vscode.window.showWarningMessage('服务器上尚不存在此脚本，已使用本地脚本。请先同步到服务器以获得更好的调试体验。');
            } else {
                programId = fid;
            }
        } else {
            vscode.window.showErrorMessage('不支持的文件类型');
            return;
        }

        const config: vscode.DebugConfiguration = {
            type: 'magic-api',
            request: 'launch',
            name: `运行 ${typedPath}`,
            stopOnEntry: false,
            trace: false,
            noDebug: true,
            program: programId || typedPath!,
            fileKey: typedPath!,
            // 额外路径字段，兼容服务端不同的参数命名
            target: `magic-api:/${typedPath!}`,
            path: `magic-api:/${typedPath!}`,
            programPath: `magic-api:/${typedPath!}`,
            serverId: server.id
        };

        // 设置 cwd 为镜像根目录（如果可用）并在文件镜像场景下使用镜像的连接信息
        if (editor.document.uri.scheme === 'file') {
            const mirrorRoot = await mirrorManager.findMirrorRootForUri(editor.document.uri);
            if (mirrorRoot) {
                (config as any).cwd = mirrorRoot.fsPath;
                const meta = await mirrorManager.readMirrorMeta(mirrorRoot);
                if (meta?.url) {
                    // 运行使用镜像连接信息（仅 ms 与 meta），不影响非镜像文件夹操作
                    delete (config as any).serverId;
                    const u = new URL(meta.url);
                    (config as any).host = u.hostname;
                    const defaultPort = u.protocol === 'https:' ? 443 : 80;
                    const parsedPort = u.port ? Number(u.port) : defaultPort;
                    (config as any).port = (meta as any).debugPort ?? parsedPort;
                    (config as any).useWss = (u.protocol === 'https:');
                    (config as any).pathBase = (u.pathname || '').replace(/\/$/, '');
                    // 注入认证信息（优先 token，其次 basic）
                    if ((meta as any).token) (config as any).token = (meta as any).token;
                    if ((meta as any).username) (config as any).username = (meta as any).username;
                    if ((meta as any).password) (config as any).password = (meta as any).password;
                }
            }
        } else {
            const mrootByConn = await mirrorManager.findMirrorRootByConnection({
                url: server.url,
                token: server.token,
                username: server.username,
                password: server.password,
                lspPort: (server as any).lspPort,
                debugPort: (server as any).debugPort,
            });
            if (mrootByConn) {
                (config as any).cwd = mrootByConn.fsPath;
            }
        }

        await vscode.debug.startDebugging(undefined, config);
    });

	// 调试当前脚本（可断点）
    const debugScriptCommand = vscode.commands.registerCommand('magicApi.debugScript', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.uri.path.endsWith('.ms')) {
            vscode.window.showErrorMessage('请在 Magic Script (.ms) 文件中执行');
            return;
        }

        const serverManager = ServerManager.getInstance();
        const server = serverManager.getCurrentServer();
        if (!server) {
            vscode.window.showErrorMessage('请先选择服务器');
            return;
        }

        const client = serverManager.getCurrentClient();
        if (!client) {
            vscode.window.showErrorMessage('无法获取当前服务器客户端');
            return;
        }

        let typedPath2: string | null = null;
        let programId2: string | undefined;
        if (editor.document.uri.scheme === 'magic-api') {
            const fileInfo2 = statusBarManager.getCurrentFileInfo();
            let infoToUse2: MagicFileInfo | null = fileInfo2;
            if (!infoToUse2) {
                const fileKey2 = editor.document.uri.path.replace(/^\//, '');
                const fid2 = client.getFileIdByPath(fileKey2);
                if (!fid2) {
                    vscode.window.showErrorMessage('无法解析当前脚本的文件ID');
                    return;
                }
                const fetched2 = await client.getFile(fid2);
                if (!fetched2) {
                    vscode.window.showErrorMessage('无法获取当前脚本的文件信息');
                    return;
                }
                infoToUse2 = fetched2 as MagicFileInfo;
            }
            const finfo2 = infoToUse2!;
            const fullDir2 = (() => {
                const type = finfo2.type || 'api';
                const gpRaw = (finfo2.groupPath || '').replace(/^\/+/, '');
                const gp = gpRaw ? gpRaw : '';
                if (!gp) return `${type}`;
                return gp.startsWith(`${type}/`) ? gp : `${type}/${gp}`;
            })();
            typedPath2 = `${fullDir2}/${finfo2.name}.ms`;
            programId2 = finfo2.id;
        } else if (editor.document.uri.scheme === 'file') {
            const mirrorRoot = await mirrorManager.findMirrorRootForUri(editor.document.uri);
            if (!mirrorRoot) {
                vscode.window.showErrorMessage('当前文件不在镜像工作区中');
                return;
            }
            const parsed2 = mirrorManager.parseMirrorFile(mirrorRoot, editor.document.uri);
            if (!parsed2.type || !parsed2.fileName || !parsed2.typedPath) {
                vscode.window.showErrorMessage('无法解析镜像文件路径');
                return;
            }
            typedPath2 = parsed2.typedPath;
            const fid2 = client.getFileIdByPath(typedPath2);
            if (!fid2) {
                vscode.window.showWarningMessage('服务器上尚不存在此脚本，已使用本地脚本。请先同步到服务器以进行断点调试。');
            } else {
                programId2 = fid2;
            }
        } else {
            vscode.window.showErrorMessage('不支持的文件类型');
            return;
        }

        const config: vscode.DebugConfiguration = {
            type: 'magic-api',
            request: 'launch',
            name: `调试 ${typedPath2}`,
            stopOnEntry: true,
            trace: false,
            program: programId2 || typedPath2!,
            fileKey: typedPath2!,
            // 额外路径字段，兼容服务端不同的参数命名
            target: `magic-api:/${typedPath2!}`,
            path: `magic-api:/${typedPath2!}`,
            programPath: `magic-api:/${typedPath2!}`,
            serverId: server.id
        };

        // 设置 cwd 为镜像根目录（如果可用）并在文件镜像场景下使用镜像的连接信息
        if (editor.document.uri.scheme === 'file') {
            const mirrorRoot = await mirrorManager.findMirrorRootForUri(editor.document.uri);
            if (mirrorRoot) {
                (config as any).cwd = mirrorRoot.fsPath;
                const meta = await mirrorManager.readMirrorMeta(mirrorRoot);
                if (meta?.url) {
                    // 调试使用镜像连接信息（仅 ms 与 meta），不影响非镜像文件夹操作
                    delete (config as any).serverId;
                    const u = new URL(meta.url);
                    (config as any).host = u.hostname;
                    const defaultPort = u.protocol === 'https:' ? 443 : 80;
                    const parsedPort = u.port ? Number(u.port) : defaultPort;
                    (config as any).port = (meta as any).debugPort ?? parsedPort;
                    (config as any).useWss = (u.protocol === 'https:');
                    (config as any).pathBase = (u.pathname || '').replace(/\/$/, '');
                    // 注入认证信息（优先 token，其次 basic）
                    if ((meta as any).token) (config as any).token = (meta as any).token;
                    if ((meta as any).username) (config as any).username = (meta as any).username;
                    if ((meta as any).password) (config as any).password = (meta as any).password;
                }
            }
        } else {
            const mrootByConn2 = await mirrorManager.findMirrorRootByConnection({
                url: server.url,
                token: server.token,
                username: server.username,
                password: server.password,
                lspPort: (server as any).lspPort,
                debugPort: (server as any).debugPort,
            });
            if (mrootByConn2) {
                (config as any).cwd = mrootByConn2.fsPath;
            }
        }

        await vscode.debug.startDebugging(undefined, config);
    });

	// 注册所有命令
	context.subscriptions.push(
		selectServerCommand,
		addServerCommand,
		refreshFileInfoCommand,
		restartLspCommand,
		connectWorkspaceCommand,
		connectMirrorRootCommand,
		disconnectMirrorRootCommand,
		createFileCommand,
		createGroupCommand,
		runScriptCommand,
		debugScriptCommand
	);
}
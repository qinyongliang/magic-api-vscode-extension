import * as vscode from 'vscode';
import * as path from 'path';
import { MagicApiClient } from './magicApiClient';
import { getAgentsManual } from './agentsManual';
import { MAGIC_RESOURCE_TYPES, MagicResourceType } from './types';

interface MirrorMeta {
    serverId: string;
    createdAt: number;
}

export class MirrorWorkspaceManager {
    private static instance: MirrorWorkspaceManager;
    private context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public static getInstance(context?: vscode.ExtensionContext): MirrorWorkspaceManager {
        if (!MirrorWorkspaceManager.instance) {
            if (!context) {
                throw new Error('MirrorWorkspaceManager requires an ExtensionContext for initialization');
            }
            MirrorWorkspaceManager.instance = new MirrorWorkspaceManager(context);
        }
        return MirrorWorkspaceManager.instance;
    }

    // 获取镜像根目录
    public getMirrorRoot(serverId: string): vscode.Uri {
        const base = vscode.Uri.joinPath(this.context.globalStorageUri, 'magic-api-mirror', serverId);
        return base;
    }

    // 判断当前工作区是否为镜像工作区
    public async isMirrorWorkspace(folder: vscode.Uri): Promise<boolean> {
        try {
            const metaUri = vscode.Uri.joinPath(folder, '.magic-api-mirror.json');
            await vscode.workspace.fs.stat(metaUri);
            return true;
        } catch {
            return false;
        }
    }

    public async readMirrorMeta(folder: vscode.Uri): Promise<MirrorMeta | null> {
        try {
            const metaUri = vscode.Uri.joinPath(folder, '.magic-api-mirror.json');
            const buf = await vscode.workspace.fs.readFile(metaUri);
            const text = Buffer.from(buf).toString('utf8');
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private async writeMirrorMeta(root: vscode.Uri, meta: MirrorMeta): Promise<void> {
        const dirUri = root;
        await this.ensureDir(dirUri);
        const metaUri = vscode.Uri.joinPath(root, '.magic-api-mirror.json');
        await vscode.workspace.fs.writeFile(metaUri, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    }

    private async ensureDir(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            await vscode.workspace.fs.createDirectory(uri);
        }
    }

    private toPosix(rel: string): string {
        return rel.replace(/\\/g, '/');
    }

    // 将服务端的虚拟FS全量同步到本地镜像
    public async syncFromServer(client: MagicApiClient, serverId: string): Promise<void> {
        const root = this.getMirrorRoot(serverId);
        await this.ensureDir(root);

        // 顶层类型目录
        for (const t of MAGIC_RESOURCE_TYPES) {
            const tDir = vscode.Uri.joinPath(root, t);
            await this.ensureDir(tDir);
        }

        // 创建/更新 AGENTS.md（在镜像根）
        const agentsUri = vscode.Uri.joinPath(root, 'AGENTS.md');
        try {
            await vscode.workspace.fs.stat(agentsUri);
        } catch {
            const content = getAgentsManual();
            await vscode.workspace.fs.writeFile(agentsUri, Buffer.from(content, 'utf8'));
        }

        // 目录与文件全量拉取
        const dirs = await client.getResourceDirs();
        for (const dir of dirs) {
            const dirUri = vscode.Uri.joinPath(root, ...dir.split('/'));
            await this.ensureDir(dirUri);

            const files = await client.getResourceFiles(dir);
            for (const f of files) {
                const fileUri = vscode.Uri.joinPath(dirUri, `${f.name}.ms`);
                const full = await client.getFile(f.id);
                const script = full?.script || f.script || '';
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(script, 'utf8'));
            }
        }

        // 写入镜像元数据
        await this.writeMirrorMeta(root, { serverId, createdAt: Date.now() });
    }

    // 打开镜像工作区（会进行一次全量同步）
    public async openMirrorWorkspace(client: MagicApiClient, serverId: string): Promise<void> {
        const root = this.getMirrorRoot(serverId);
        await this.syncFromServer(client, serverId);
        await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
    }

    // 启动镜像工作区监听：保存/创建/删除/重命名 -> 推送到服务端
    public startMirrorListeners(client: MagicApiClient, mirrorRoot: vscode.Uri): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        const isUnderMirror = (uri: vscode.Uri) => {
            if (uri.scheme !== 'file') return false;
            const mirrorFs = mirrorRoot.fsPath;
            const fsPath = uri.fsPath;
            // 处理大小写与分隔符
            const norm = (p: string) => path.resolve(p);
            return norm(fsPath).toLowerCase().startsWith(norm(mirrorFs).toLowerCase());
        };

        const parseRel = (uri: vscode.Uri) => {
            const rel = this.toPosix(path.relative(mirrorRoot.fsPath, uri.fsPath));
            const parts = rel.split('/').filter(Boolean);
            const isFile = parts.length > 0 && parts[parts.length - 1].endsWith('.ms');
            const type = parts[0] as MagicResourceType;
            const groupPathSub = isFile ? parts.slice(1, -1).join('/') : parts.slice(1).join('/');
            const fileName = isFile ? parts[parts.length - 1].replace(/\.ms$/, '') : undefined;
            const dir = isFile ? `${type}${groupPathSub ? '/' + groupPathSub : ''}` : `${type}${groupPathSub ? '/' + groupPathSub : ''}`;
            return { type, groupPathSub, fileName, dir, isFile };
        };

        const ensureGroups = async (type: MagicResourceType, groupPathSub: string): Promise<void> => {
            if (!groupPathSub) return;
            const segments = groupPathSub.split('/').filter(Boolean);
            await client.getResourceDirs();
            let parentId: string | null = null;
            let acc: string[] = [];
            for (const seg of segments) {
                acc.push(seg);
                const pathKey = `${type}/${acc.join('/')}`;
                const gid = client.getGroupIdByPath(pathKey);
                if (!gid) {
                    const newId: string | null = await client.createGroup({ name: seg, parentId, type });
                    // 刷新缓存以填充新建分组路径
                    await client.getResourceDirs();
                    parentId = newId;
                } else {
                    // 获取该分组的 ID 用作下一层的 parentId
                    parentId = gid;
                }
            }
        };

        // 文档保存 -> 推送脚本到服务端
        disposables.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            try {
                if (doc.uri.scheme !== 'file' || !isUnderMirror(doc.uri)) return;
                const { type, groupPathSub, fileName, dir, isFile } = parseRel(doc.uri);
                if (!isFile || !fileName || !MAGIC_RESOURCE_TYPES.includes(type)) return;
                const script = doc.getText();
                // 先尝试更新
                await client.getResourceFiles(dir);
                const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                if (fid) {
                    const info = await client.getFile(fid);
                    if (info) {
                        await client.saveFile({ ...info, script });
                    }
                } else {
                    // 确保目录存在后创建
                    await ensureGroups(type, groupPathSub);
                    await client.createFile({
                        name: fileName,
                        script,
                        type,
                        groupPath: groupPathSub ? `${type}/${groupPathSub}` : `${type}`
                    });
                }
            } catch (e) {
                vscode.window.showErrorMessage(`推送保存失败: ${String(e)}`);
            }
        }));

        // 文件创建事件（用于空文件的立即建档）
        disposables.push(vscode.workspace.onDidCreateFiles(async (e) => {
            for (const uri of e.files) {
                try {
                    if (uri.scheme !== 'file' || !isUnderMirror(uri)) continue;
                    const { type, groupPathSub, fileName, dir, isFile } = parseRel(uri);
                    if (!isFile || !fileName || !MAGIC_RESOURCE_TYPES.includes(type)) continue;
                    await ensureGroups(type, groupPathSub);
                    // 若缓存存在则略过，等待保存时写入脚本
                    await client.getResourceFiles(dir);
                    const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                    if (!fid) {
                        await client.createFile({
                            name: fileName,
                            script: '',
                            type,
                            groupPath: groupPathSub ? `${type}/${groupPathSub}` : `${type}`
                        });
                    }
                } catch (e2) {
                    vscode.window.showErrorMessage(`创建文件推送失败: ${String(e2)}`);
                }
            }
        }));

        // 文件删除事件
        disposables.push(vscode.workspace.onDidDeleteFiles(async (e) => {
            for (const uri of e.files) {
                try {
                    if (uri.scheme !== 'file' || !isUnderMirror(uri)) continue;
                    const { type, groupPathSub, fileName, dir, isFile } = parseRel(uri);
                    if (isFile && fileName && MAGIC_RESOURCE_TYPES.includes(type)) {
                        await client.getResourceFiles(dir);
                        const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                        if (fid) {
                            await client.deleteFile(fid);
                        }
                    }
                } catch (e3) {
                    vscode.window.showErrorMessage(`删除文件推送失败: ${String(e3)}`);
                }
            }
        }));

        // 重命名事件（文件或目录）
        disposables.push(vscode.workspace.onDidRenameFiles(async (e) => {
            for (const { oldUri, newUri } of e.files) {
                try {
                    if (!isUnderMirror(oldUri) || !isUnderMirror(newUri)) continue;
                    const oldRel = parseRel(oldUri);
                    const newRel = parseRel(newUri);
                    if (oldRel.isFile && newRel.isFile && oldRel.fileName && newRel.fileName && MAGIC_RESOURCE_TYPES.includes(oldRel.type)) {
                        const dir = oldRel.dir;
                        await client.getResourceFiles(dir);
                        const fid = client.getFileIdByPath(`${dir}/${oldRel.fileName}.ms`);
                        if (fid) {
                            const info = await client.getFile(fid);
                            if (info) {
                                await client.saveFile({ ...info, name: newRel.fileName! });
                            }
                        }
                    } else if (!oldRel.isFile && !newRel.isFile && MAGIC_RESOURCE_TYPES.includes(oldRel.type)) {
                        // 目录重命名 -> 分组重命名
                        const type = oldRel.type;
                        const oldPathSub = oldRel.groupPathSub;
                        const newSeg = newRel.groupPathSub.split('/').pop() || '';
                        await client.getGroups(type);
                        const gid = client.getGroupIdByPath(`${type}/${oldPathSub}`);
                        if (gid) {
                            const groupInfo = await client.getGroup(gid);
                            if (groupInfo) {
                                await client.saveGroup({ ...groupInfo, name: newSeg });
                            }
                        }
                    }
                } catch (e4) {
                    vscode.window.showErrorMessage(`重命名推送失败: ${String(e4)}`);
                }
            }
        }));

        return disposables;
    }
}
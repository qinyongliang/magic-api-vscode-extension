import * as vscode from 'vscode';
import * as path from 'path';
import { MagicApiClient, MagicServerConfig } from './magicApiClient';
import { getAgentsManual } from './agentsManual';
import { MAGIC_RESOURCE_TYPES, MagicResourceType } from './types';
import { Buffer } from 'buffer';
import os from 'os';

interface MirrorMeta {
    createdAt: number;
    // 持久化基础连接信息，支持镜像工作区独立直连
    url?: string; // baseUrl，例如 http://localhost:8080/app
    // 认证信息（用于镜像运行/调试直连，不依赖全局当前服务器）
    token?: string;
    username?: string;
    password?: string;
    // 端口（可选）：若服务自定义了 LSP/Debug 端口，方便直连使用
    lspPort?: number;
    debugPort?: number;
    // 本地提示补全数据（来自 /workbench/classes），在无法连接 LSP 时用于本地提示
    workbench?: {
        classes?: any;
        extensions?: any;
        functions?: any;
        lastUpdated?: number;
    };
}

// 镜像文件的本地元数据格式（参考 MagicFileInfo，但不包含脚本）
interface MirrorFileMeta {
    id?: string; // 服务器文件ID
    name: string; // 文件名（不含扩展名）
    type: MagicResourceType; // 资源类型
    groupId?: string; // 分组ID
    groupPath: string; // 目录路径（包含类型，例如 "api/user"）
    path?: string; // 资源路径（例如 API 的 mapping 或函数路径）
    method?: string; // API 方法
    requestMapping?: string; // API 映射（兼容字段）
    description?: string; // 描述
    locked?: boolean; // 锁定
    // —— 类型专属字段（根据服务器导出定义） ——
    // API：参数、请求头、内容类型、超时等
    params?: any[];
    headers?: Record<string, any> | any;
    contentType?: string;
    timeout?: number;
    // 任务：cron 表达式、是否启用、启动即执行等
    cron?: string;
    enabled?: boolean;
    executeOnStart?: boolean;
    // 其他未识别的扩展字段（完整保留服务端原始内容）
    extra?: Record<string, any>;
    createTime?: number; // 服务器创建时间
    updateTime?: number; // 服务器更新时间（上一轮从服务器拉取的时间）
    localUpdateTime?: number; // 本地最后修改时间（代码或 meta 改动时更新）
}

export class MirrorWorkspaceManager {
    private static instance: MirrorWorkspaceManager;
    private context: vscode.ExtensionContext;
    private readonly connectPrefKey = 'magicApi.mirror.connectPreference';
    // 记录每个镜像根目录的活动监听器，支持断开连接
    private activeMirrorDisposables: Map<string, vscode.Disposable[]> = new Map();

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

    // 读取/写入镜像连接偏好（按文件夹路径存储，范围：全局用户）
    public async getMirrorConnectPreference(root: vscode.Uri): Promise<'yes' | 'no' | undefined> {
        const map = this.context.globalState.get<Record<string, 'yes' | 'no'>>(this.connectPrefKey) || {};
        return map[root.fsPath];
    }

    public async setMirrorConnectPreference(root: vscode.Uri, pref: 'yes' | 'no'): Promise<void> {
        const map = this.context.globalState.get<Record<string, 'yes' | 'no'>>(this.connectPrefKey) || {};
        map[root.fsPath] = pref;
        await this.context.globalState.update(this.connectPrefKey, map);
    }

    // 获取默认镜像根目录（基于服务器 URL 生成稳定目录名）
    public getDefaultMirrorRoot(serverConfig: MagicServerConfig): vscode.Uri {
        const url = serverConfig.url || 'unknown';
        // 目录名：去除协议和末尾斜杠，替换非法字符
        const name = url.replace(/^[a-zA-Z]+:\/\//, '')
            .replace(/\/$/, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_');
        const base = vscode.Uri.joinPath(this.context.globalStorageUri, 'magic-api-mirror', name);
        return base;
    }

    // 判断当前工作区是否为镜像工作区
    public async isMirrorWorkspace(folder: vscode.Uri): Promise<boolean> {
        if("file" !== folder.scheme) {
            return false
        }
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

    // 刷新写入工作台补全数据（classes/extensions/functions）到镜像元数据
    public async refreshWorkbenchCompletionData(client: MagicApiClient, root: vscode.Uri, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        try {
            const data = await client.getWorkbenchCompletionData();
            if (!data) return;
            const meta = (await this.readMirrorMeta(root)) || { createdAt: Date.now() } as MirrorMeta;
            meta.workbench = {
                ...(meta.workbench || {}),
                classes: (data?.classes ?? data?.classMap ?? data?.classesMap ?? data?.classes) ?? undefined,
                extensions: (data?.extensions ?? data?.extensionClasses ?? data?.extensionMap) ?? undefined,
                functions: (Array.isArray(data?.functions) ? data?.functions : (data?.funcs ?? data?.functionsList)) ?? undefined,
                lastUpdated: Date.now(),
            };
            await this.writeMirrorMeta(root, meta);
            progress?.report?.({ message: '写入工作台补全数据' });
        } catch (e) {
            // 安全兜底：刷新失败不影响镜像流程
        }
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

    // 计算某个代码文件的元数据文件名/路径
    private getMetaFileUriFor(root: vscode.Uri, type: MagicResourceType, groupPathSub: string | undefined, fileName: string): vscode.Uri {
        const dirUri = vscode.Uri.joinPath(root, type, ...(groupPathSub ? groupPathSub.split('/') : []));
        const metaName = `.${fileName}.meta.json`;
        return vscode.Uri.joinPath(dirUri, metaName);
    }

    // 读取某文件对应的本地元数据
    private async readLocalMeta(root: vscode.Uri, type: MagicResourceType, groupPathSub: string | undefined, fileName: string): Promise<MirrorFileMeta | null> {
        const metaUri = this.getMetaFileUriFor(root, type, groupPathSub, fileName);
        try {
            const buf = await vscode.workspace.fs.readFile(metaUri);
            const text = Buffer.from(buf).toString('utf8');
            const obj = JSON.parse(text);
            return obj as MirrorFileMeta;
        } catch {
            return null;
        }
    }

    // 写入某文件对应的本地元数据
    private async writeLocalMeta(root: vscode.Uri, meta: MirrorFileMeta): Promise<void> {
        const segs = meta.groupPath.split('/').filter(Boolean);
        const type = segs[0] as MagicResourceType;
        const groupPathSub = segs.slice(1).join('/');
        const metaUri = this.getMetaFileUriFor(root, type, groupPathSub, meta.name);
        // 确保目录存在
        const dirUri = vscode.Uri.joinPath(root, type, ...(groupPathSub ? groupPathSub.split('/') : []));
        await this.ensureDir(dirUri);
        await vscode.workspace.fs.writeFile(metaUri, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    }

    // 从服务器文件信息生成本地元数据对象
    private toMirrorMetaFromServer(info: any): MirrorFileMeta {
        const segs = String(info.groupPath || '').split('/').filter(Boolean);
        const type = (segs[0] || info.type) as MagicResourceType;
        const groupPath = String(info.groupPath || segs.join('/')) || type;
        const name = String(info.name || '').replace(/\.ms$/, '');
        const meta: MirrorFileMeta = {
            id: String(info.id || ''),
            name,
            type,
            groupId: info.groupId ? String(info.groupId) : undefined,
            groupPath,
            path: info.path || undefined,
            method: info.method || undefined,
            requestMapping: info.requestMapping || undefined,
            description: info.description || undefined,
            locked: info.locked || undefined,
            createTime: info.createTime,
            updateTime: info.updateTime,
        };

        // 注入类型专属字段（API/任务等），并保留服务端原始扩展字段
        const raw = (info as any).extra ?? info;
        if (type === 'api') {
            meta.params = raw.params ?? raw.parameters ?? undefined;
            meta.headers = raw.headers ?? undefined;
            meta.contentType = raw.contentType ?? undefined;
            // 兼容不同命名的超时字段
            meta.timeout = typeof raw.timeout === 'number' ? raw.timeout
                : (typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined);
        } else if (type === 'task') {
            meta.cron = raw.cron ?? raw.cronExpression ?? undefined;
            meta.enabled = (typeof raw.enabled !== 'undefined') ? !!raw.enabled
                : ((typeof raw.enable !== 'undefined') ? !!raw.enable : undefined);
            meta.executeOnStart = (typeof raw.executeOnStart !== 'undefined') ? !!raw.executeOnStart
                : ((typeof raw.runOnStart !== 'undefined') ? !!raw.runOnStart : undefined);
        }

        try {
            const extraCopy: Record<string, any> = { ...(raw || {}) };
            // 删除已映射或体积较大的字段，避免重复与冗余
            delete extraCopy.script;
            delete extraCopy.id;
            delete extraCopy.name;
            delete extraCopy.groupId;
            delete extraCopy.groupPath;
            delete extraCopy.type;
            delete extraCopy.createTime;
            delete extraCopy.updateTime;
            delete extraCopy.method;
            delete extraCopy.path;
            delete extraCopy.requestMapping;
            delete extraCopy.description;
            delete extraCopy.locked;
            meta.extra = extraCopy;
        } catch {}
        return meta;
    }

    // 更新本地元数据的本地修改时间
    private touchLocalMetaTime(meta: MirrorFileMeta): MirrorFileMeta {
        return { ...meta, localUpdateTime: Date.now() };
    }

    // 为差异比较清洗元数据：移除仅本地使用的字段，避免“假差异”
    private sanitizeMetaForDiff(meta: MirrorFileMeta | null): Record<string, any> | null {
        if (!meta) return null;
        const copy: Record<string, any> = { ...meta };
        // 忽略仅本地使用的时间戳
        delete copy.localUpdateTime;
        // 元数据比较不需要脚本，脚本差异单独比较
        // 保留服务端相关字段（如 updateTime、id、groupPath 等）以体现真实差异
        return copy;
    }

    // 确保服务端存在分组目录：根据 groupPathSub 逐级创建缺失的分组
    private async ensureGroups(client: MagicApiClient, type: MagicResourceType, groupPathSub: string | undefined): Promise<void> {
        if (!groupPathSub) return;
        const segments = groupPathSub.split('/').filter(Boolean);
        await client.getResourceDirs();
        let parentId: string | null = null;
        const acc: string[] = [];
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
    }

    // 将服务端的虚拟FS全量同步到指定本地镜像根目录
    public async syncFromServer(
        client: MagicApiClient,
        root: vscode.Uri,
        serverConfig?: MagicServerConfig,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
        progress?.report({ message: '初始化镜像目录结构' });
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

        // 目录与文件全量拉取（生成代码与元数据）
        progress?.report({ message: '准备同步服务器资源目录' });
        const dirs = await client.getResourceDirs();
        progress?.report({ message: `同步目录 (${dirs.length} 项)` });
        for (const dir of dirs) {
            progress?.report({ message: `同步目录 ${dir}` });
            const dirUri = vscode.Uri.joinPath(root, ...dir.split('/'));
            await this.ensureDir(dirUri);

            const files = await client.getResourceFiles(dir);
            for (const f of files) {
                progress?.report({ message: `写入脚本 ${dir}/${f.name}.ms` });
                const fileUri = vscode.Uri.joinPath(dirUri, `${f.name}.ms`);
                const full = await client.getFile(f.id);
                const script = full?.script || f.script || '';
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(script, 'utf8'));
                // 写入元数据文件
                const segs = dir.split('/').filter(Boolean);
                const type = segs[0] as MagicResourceType;
                const groupPathSub = segs.slice(1).join('/');
                const meta = this.toMirrorMetaFromServer(full || f);
                // 元数据的 groupPath 使用 dir（包含类型）
                meta.groupPath = dir;
                await this.writeLocalMeta(root, meta);
            }
        }

        // 写入镜像元数据（包含 url 与认证/端口信息）
        progress?.report({ message: '写入镜像连接信息' });
        const mirrorMeta: MirrorMeta = {
            createdAt: Date.now(),
            url: serverConfig?.url,
            token: serverConfig?.token,
            username: serverConfig?.username,
            password: serverConfig?.password,
            lspPort: (serverConfig as any)?.lspPort,
            debugPort: (serverConfig as any)?.debugPort,
        };
        await this.writeMirrorMeta(root, mirrorMeta);
    }

    // 打开镜像工作区（会进行一次全量同步）
    public async openMirrorWorkspace(client: MagicApiClient, targetFolder?: vscode.Uri, serverConfig?: MagicServerConfig): Promise<void> {
        if (!serverConfig && !targetFolder) {
            throw new Error('openMirrorWorkspace 需要提供 serverConfig 或目标文件夹');
        }
        // 若提供了目标文件夹，则优先使用该目录；否则使用默认镜像根目录（根据 URL）
        const root = targetFolder ?? (serverConfig ? this.getDefaultMirrorRoot(serverConfig) : undefined);
        if (!root) {
            throw new Error('无法确定镜像根目录');
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '创建镜像工作区',
            cancellable: false
        }, async (progress) => {
            // 写入镜像根信息标记文件
            progress.report({ message: '写入镜像元数据' });
            const baseMeta: MirrorMeta = {
                createdAt: Date.now(),
                url: serverConfig?.url,
                token: serverConfig?.token,
                username: serverConfig?.username,
                password: serverConfig?.password,
                lspPort: (serverConfig as any)?.lspPort,
                debugPort: (serverConfig as any)?.debugPort,
            };
            await this.writeMirrorMeta(root, baseMeta);
            // 刷新写入本地补全用的工作台数据
            progress.report({ message: '拉取工作台补全数据' });
            await this.refreshWorkbenchCompletionData(client, root, progress);
            // 调用已有的全量同步逻辑（同步到选定根目录）
            progress.report({ message: '同步服务器资源与脚本' });
            await this.syncFromServer(client, root, serverConfig, progress);
            // 在当前窗口切换到镜像工作区（替换工作区文件夹）
            progress.report({ message: '打开镜像工作区（当前窗口）' });
            const curFolders = vscode.workspace.workspaceFolders;
            const nameFromCfg = serverConfig?.url ? `Mirror: ${new URL(serverConfig.url).host}` : 'Magic API Mirror';
            const replaced = curFolders && curFolders.length > 0
                ? vscode.workspace.updateWorkspaceFolders(0, curFolders.length, { uri: root, name: nameFromCfg })
                : false;
            if (!replaced) {
                // 无活动工作区时，回退到 openFolder（保持不新开窗口）
                await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
            }

            // 启动镜像监听，确保当前窗口即可进行推送/同步
            try {
                const disposables = this.startMirrorListeners(client, root);
                this.context.subscriptions.push(...disposables);
            } catch {}
        });
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
            const last = parts[parts.length - 1] || '';
            const isMsFile = last.endsWith('.ms');
            const isMetaFile = last.startsWith('.') && last.endsWith('.meta.json');
            const isFile = isMsFile || isMetaFile;
            // 更稳健地定位资源类型段：在路径中寻找第一个顶层类型标识
            const typeIndex = parts.findIndex(seg => (MAGIC_RESOURCE_TYPES as readonly string[]).includes(seg));
            const type = (typeIndex >= 0 ? parts[typeIndex] : parts[0]) as MagicResourceType;
            const groupStart = typeIndex >= 0 ? typeIndex + 1 : 1;
            const groupPathSub = isFile ? parts.slice(groupStart, parts.length - 1).join('/') : parts.slice(groupStart).join('/');
            const fileName = isMsFile ? parts[parts.length - 1].replace(/\.ms$/, '')
                : isMetaFile ? parts[parts.length - 1].replace(/^\./, '').replace(/\.meta\.json$/, '')
                : undefined;
            const dir = `${type}${groupPathSub ? '/' + groupPathSub : ''}`;
            return { type, groupPathSub, fileName, dir, isFile, isMsFile, isMetaFile };
        };

        // 分组目录存在性保障（从 groupPathSub 逐级创建缺失分组）
        const ensureGroupsLocal = async (type: MagicResourceType, groupPathSub: string): Promise<void> => {
            await this.ensureGroups(client, type, groupPathSub);
        };

        // 文档保存 -> 推送脚本/元数据到服务端，并更新本地元数据时间戳（优先使用 .meta.json 的 id 关联）
        disposables.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            try {
                if (doc.uri.scheme !== 'file' || !isUnderMirror(doc.uri)) return;
                const { type, groupPathSub, fileName, dir, isFile, isMsFile, isMetaFile } = parseRel(doc.uri);
                if (!isFile || !fileName || !MAGIC_RESOURCE_TYPES.includes(type)) return;

                // 读取现有本地元数据或构建默认
                let meta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);
                if (!meta) {
                    meta = {
                        name: fileName,
                        type,
                        groupPath: dir,
                        localUpdateTime: Date.now()
                    };
                }

                // 如果保存的是 .ms 文件，拿脚本内容；如果保存的是 .meta.json，则解析 meta
                let script: string = '';
                if (isMsFile) {
                    script = doc.getText();
                    meta = this.touchLocalMetaTime(meta);
                    await this.writeLocalMeta(mirrorRoot, meta);
                } else if (isMetaFile) {
                    try {
                        const text = doc.getText();
                        const parsed = JSON.parse(text);
                        // 校验元数据
                        const check = this.validateLocalMeta({ ...meta, ...parsed }, fileName);
                        if (!check.ok) {
                            vscode.window.showErrorMessage(`元数据校验失败: ${check.errors.join('; ')}`);
                            return;
                        }
                        meta = this.touchLocalMetaTime({ ...meta, ...parsed });
                        await this.writeLocalMeta(mirrorRoot, meta);
                    } catch (e) {
                        vscode.window.showErrorMessage(`解析元数据失败: ${String(e)}`);
                        return;
                    }
                    // 读取相邻 .ms 文件脚本
                    const msUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'), `${fileName}.ms`);
                    try {
                        const buf = await vscode.workspace.fs.readFile(msUri);
                        script = Buffer.from(buf).toString('utf8');
                    } catch {
                        script = '';
                    }
                }

                // 同步到服务器：优先使用本地 meta.id 更新；缺失或无效时再按路径查找并创建
                let targetInfo: any | null = null;
                let targetId: string | undefined = meta.id;

                // 1) 有 id 时优先按 id 获取文件信息
                if (targetId) {
                    try {
                        const byId = await client.getFile(targetId);
                        if (byId) {
                            targetInfo = byId;
                        }
                    } catch {}
                }

                // 2) 无 id 或 id 无效，则按目录刷新并用路径查找 id
                if (!targetInfo) {
                    await client.getResourceFiles(dir);
                    const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                    if (fid) {
                        const byPath = await client.getFile(fid);
                        if (byPath) {
                            targetInfo = byPath;
                            targetId = fid;
                            // 若本地 meta 没有 id，则补充写入，后续保存直接走 id
                            if (!meta.id) {
                                meta.id = fid;
                                await this.writeLocalMeta(mirrorRoot, meta);
                            }
                        }
                    }
                }

                if (targetInfo && targetId) {
                    const ok = await client.saveFile({
                        ...targetInfo,
                        id: targetId,
                        name: meta.name || fileName,
                        path: meta.path || targetInfo.path || '',
                        method: meta.method || targetInfo.method,
                        requestMapping: meta.requestMapping || targetInfo.requestMapping,
                        description: meta.description || targetInfo.description,
                        script,
                        // 类型专属字段：API
                        ...(meta.type === 'api' ? {
                            params: meta.params,
                            headers: meta.headers,
                            contentType: meta.contentType,
                            timeout: meta.timeout,
                        } : {}),
                        // 类型专属字段：任务
                        ...(meta.type === 'task' ? {
                            cron: meta.cron,
                            enabled: meta.enabled,
                            executeOnStart: meta.executeOnStart,
                        } : {}),
                    } as any);
                    if (ok) {
                        const fresh = await client.getFile(targetId);
                        if (fresh) {
                            meta.updateTime = fresh.updateTime;
                            // 补齐 groupId 等字段，增强后续保存的稳定性
                            if (fresh.groupId) meta.groupId = fresh.groupId;
                            await this.writeLocalMeta(mirrorRoot, meta);
                        }
                    }
                } else {
                    // 3) 既没有 id 也无法通过路径定位，走创建流程
                    await ensureGroupsLocal(type, groupPathSub);
                    const newId = await client.createFile({
                        name: fileName,
                        script,
                        type,
                        groupPath: groupPathSub ? `${type}/${groupPathSub}` : `${type}`,
                        method: meta.method,
                        requestMapping: meta.requestMapping,
                        description: meta.description,
                        // 类型专属字段：API
                        ...(type === 'api' ? {
                            params: meta.params,
                            headers: meta.headers,
                            contentType: meta.contentType,
                            timeout: meta.timeout,
                        } : {}),
                        // 类型专属字段：任务
                        ...(type === 'task' ? {
                            cron: meta.cron,
                            enabled: meta.enabled,
                            executeOnStart: meta.executeOnStart,
                        } : {}),
                    } as any);
                    if (newId) {
                        meta.id = newId;
                        const fresh = await client.getFile(newId);
                        if (fresh?.groupId) meta.groupId = fresh.groupId;
                        meta.updateTime = fresh?.updateTime;
                        await this.writeLocalMeta(mirrorRoot, meta);
                    }
                }
            } catch (e) {
                vscode.window.showErrorMessage(`推送保存失败: ${String(e)}`);
            }
        }));

        // 针对 magic-api 虚拟文档的保存：当用户在合并视图中编辑服务器侧并保存时，将内容同步到本地镜像
        disposables.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            try {
                if (doc.uri.scheme !== 'magic-api') return;
                // 解析 magic-api:/<dir>/<fileName>.ms
                const relPath = this.toPosix(doc.uri.path.replace(/^\//, ''));
                const parts = relPath.split('/');
                const file = parts.pop() || '';
                if (!file.endsWith('.ms')) return;
                const fileName = file.replace(/\.ms$/, '');
                const dir = parts.join('/');
                const segs = dir.split('/');
                const type = segs[0] as MagicResourceType;
                const groupPathSub = segs.slice(1).join('/');
                if (!MAGIC_RESOURCE_TYPES.includes(type)) return;

                // 写入本地脚本文件
                const msDirUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'));
                await this.ensureDir(msDirUri);
                const msUri = vscode.Uri.joinPath(msDirUri, `${fileName}.ms`);
                const content = Buffer.from(doc.getText(), 'utf8');
                await vscode.workspace.fs.writeFile(msUri, content);

                // 获取服务器最新元信息并更新本地 meta
                await client.getResourceFiles(dir);
                const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                const serverInfo = fid ? await client.getFile(fid) : null;
                const serverMeta = serverInfo ? this.toMirrorMetaFromServer(serverInfo) : null;
                const existingMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);
                const finalMeta: MirrorFileMeta = this.touchLocalMetaTime({
                    ...(existingMeta || { name: fileName, type, groupPath: dir }),
                    ...(serverMeta || {}),
                    groupPath: dir,
                });
                // 补充更新服务器更新时间与分组ID
                if (serverInfo) {
                    finalMeta.updateTime = serverInfo.updateTime;
                    if ((serverInfo as any).groupId) finalMeta.groupId = (serverInfo as any).groupId;
                }
                await this.writeLocalMeta(mirrorRoot, finalMeta);
            } catch (e) {
                vscode.window.showErrorMessage(`同步服务器保存到本地镜像失败: ${String(e)}`);
            }
        }));

        // 合并临时文件保存：将合并结果同步到本地真实脚本与服务器，并清理临时文件
        disposables.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            try {
                if (doc.uri.scheme !== 'file' || !isUnderMirror(doc.uri)) return;
                const rel = this.toPosix(path.relative(mirrorRoot.fsPath, doc.uri.fsPath));
                if (!rel.startsWith('.merge/')) return;

                const parts = rel.replace(/^\.merge\//, '').split('/');
                const file = parts.pop() || '';
                if (!file.endsWith('.ms')) return;
                const fileName = file.replace(/\.ms$/, '');
                const dir = parts.join('/');
                const segs = dir.split('/');
                const type = segs[0] as MagicResourceType;
                const groupPathSub = segs.slice(1).join('/');
                if (!MAGIC_RESOURCE_TYPES.includes(type)) return;

                const finalScript = doc.getText();
                // 写入真实本地脚本
                const targetMsDir = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'));
                await this.ensureDir(targetMsDir);
                const targetMsUri = vscode.Uri.joinPath(targetMsDir, `${fileName}.ms`);
                await vscode.workspace.fs.writeFile(targetMsUri, Buffer.from(finalScript, 'utf8'));

                // 更新本地元数据并推送到服务器
                const existingMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);
                await client.getResourceFiles(dir);
                const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                const serverInfo = fid ? await client.getFile(fid) : null;
                const metaToUse: MirrorFileMeta = this.touchLocalMetaTime({
                    ...(existingMeta || { name: fileName, type, groupPath: dir }),
                    updateTime: serverInfo?.updateTime,
                    groupId: (serverInfo as any)?.groupId || existingMeta?.groupId,
                    groupPath: dir,
                });
                await this.writeLocalMeta(mirrorRoot, metaToUse);

                if (serverInfo) {
                    await client.saveFile({
                        ...serverInfo,
                        name: metaToUse.name,
                        path: metaToUse.path || serverInfo.path || '',
                        method: metaToUse.method || serverInfo.method,
                        requestMapping: metaToUse.requestMapping || serverInfo.requestMapping,
                        description: metaToUse.description || serverInfo.description,
                        script: finalScript,
                        ...(type === 'api' ? {
                            params: metaToUse.params ?? (serverInfo as any).params,
                            headers: metaToUse.headers ?? (serverInfo as any).headers,
                            contentType: metaToUse.contentType ?? (serverInfo as any).contentType,
                            timeout: metaToUse.timeout ?? (serverInfo as any).timeout,
                        } : {}),
                        ...(type === 'task' ? {
                            cron: metaToUse.cron ?? (serverInfo as any).cron,
                            enabled: metaToUse.enabled ?? (serverInfo as any).enabled,
                            executeOnStart: metaToUse.executeOnStart ?? (serverInfo as any).executeOnStart,
                        } : {}),
                    } as any);
                } else {
                    await this.ensureGroups(client, type, groupPathSub);
                    await client.createFile({
                        name: fileName,
                        script: finalScript,
                        type,
                        groupPath: dir,
                        method: metaToUse.method,
                        requestMapping: metaToUse.requestMapping,
                        description: metaToUse.description,
                        ...(type === 'api' ? {
                            params: metaToUse.params,
                            headers: metaToUse.headers,
                            contentType: metaToUse.contentType,
                            timeout: metaToUse.timeout,
                        } : {}),
                        ...(type === 'task' ? {
                            cron: metaToUse.cron,
                            enabled: metaToUse.enabled,
                            executeOnStart: metaToUse.executeOnStart,
                        } : {}),
                    } as any);
                }

                // 可选：清理合并临时文件
                try { await vscode.workspace.fs.delete(doc.uri, { useTrash: false }); } catch {}
                vscode.window.showInformationMessage(`${fileName}.ms 合并结果已同步到本地与服务器`);
            } catch (e) {
                vscode.window.showErrorMessage(`保存合并结果失败: ${String(e)}`);
            }
        }));

        // 元数据合并临时文件保存：将合并后的 .meta.json 应用到本地并同步服务器
        disposables.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            try {
                if (doc.uri.scheme !== 'file' || !isUnderMirror(doc.uri)) return;
                const rel = this.toPosix(path.relative(mirrorRoot.fsPath, doc.uri.fsPath));
                if (!rel.startsWith('.merge-meta/')) return;

                const parts = rel.replace(/^\.merge-meta\//, '').split('/');
                const file = parts.pop() || '';
                if (!file.endsWith('.meta.json')) return;
                const fileName = file.replace(/^\./, '').replace(/\.meta\.json$/, '');
                const dir = parts.join('/');
                const segs = dir.split('/');
                const type = segs[0] as MagicResourceType;
                const groupPathSub = segs.slice(1).join('/');
                if (!MAGIC_RESOURCE_TYPES.includes(type)) return;

                // 解析最终合并后的元数据
                let finalMetaObj: any;
                try { finalMetaObj = JSON.parse(doc.getText()); } catch (e) {
                    vscode.window.showErrorMessage(`无法解析合并后的元数据 JSON: ${String(e)}`);
                    return;
                }

                // 忽略本地字段：不参与最终合并
                try { delete finalMetaObj.localUpdateTime; } catch {}

                // 写入到本地 .meta.json 并更新时间戳
                const existingMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);
                const mergedMeta: MirrorFileMeta = this.touchLocalMetaTime({
                    ...(existingMeta || { name: fileName, type, groupPath: dir }),
                    ...(finalMetaObj || {}),
                    groupPath: dir,
                });
                await this.writeLocalMeta(mirrorRoot, mergedMeta);

                // 同步到服务器：保留现有脚本
                await client.getResourceFiles(dir);
                let fid = mergedMeta.id || client.getFileIdByPath(`${dir}/${fileName}.ms`);
                let serverInfo = fid ? await client.getFile(fid) : null;
                const msUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'), `${fileName}.ms`);
                let localScript = '';
                try { localScript = Buffer.from(await vscode.workspace.fs.readFile(msUri)).toString('utf8'); } catch {}

                if (!serverInfo) {
                    await this.ensureGroups(client, type, groupPathSub);
                    const newId = await client.createFile({
                        name: fileName,
                        script: localScript,
                        type,
                        groupPath: dir,
                        method: mergedMeta.method,
                        requestMapping: mergedMeta.requestMapping,
                        description: mergedMeta.description,
                        ...(type === 'api' ? {
                            params: mergedMeta.params,
                            headers: mergedMeta.headers,
                            contentType: mergedMeta.contentType,
                            timeout: mergedMeta.timeout,
                        } : {}),
                        ...(type === 'task' ? {
                            cron: mergedMeta.cron,
                            enabled: mergedMeta.enabled,
                            executeOnStart: mergedMeta.executeOnStart,
                        } : {}),
                    } as any);
                    if (newId) {
                        fid = newId;
                        serverInfo = await client.getFile(newId);
                        mergedMeta.id = newId;
                    }
                } else {
                    await client.saveFile({
                        ...serverInfo,
                        name: mergedMeta.name || fileName,
                        path: mergedMeta.path || serverInfo.path || '',
                        method: mergedMeta.method || serverInfo.method,
                        requestMapping: mergedMeta.requestMapping || serverInfo.requestMapping,
                        description: mergedMeta.description || serverInfo.description,
                        script: localScript,
                        ...(type === 'api' ? {
                            params: mergedMeta.params ?? (serverInfo as any).params,
                            headers: mergedMeta.headers ?? (serverInfo as any).headers,
                            contentType: mergedMeta.contentType ?? (serverInfo as any).contentType,
                            timeout: mergedMeta.timeout ?? (serverInfo as any).timeout,
                        } : {}),
                        ...(type === 'task' ? {
                            cron: mergedMeta.cron ?? (serverInfo as any).cron,
                            enabled: mergedMeta.enabled ?? (serverInfo as any).enabled,
                            executeOnStart: mergedMeta.executeOnStart ?? (serverInfo as any).executeOnStart,
                        } : {}),
                    } as any);
                }

                // 更新本地 meta 的服务器更新时间与分组ID
                if (fid) {
                    const fresh = await client.getFile(fid);
                    if (fresh) {
                        mergedMeta.updateTime = fresh.updateTime;
                        if ((fresh as any).groupId) mergedMeta.groupId = (fresh as any).groupId;
                        await this.writeLocalMeta(mirrorRoot, mergedMeta);
                    }
                }

                try { await vscode.workspace.fs.delete(doc.uri, { useTrash: false }); } catch {}
                vscode.window.showInformationMessage(`${fileName}.meta.json 合并结果已同步到本地与服务器`);
            } catch (e) {
                vscode.window.showErrorMessage(`保存元数据合并结果失败: ${String(e)}`);
            }
        }));

        // 文件创建事件（用于空文件的立即建档）
        disposables.push(vscode.workspace.onDidCreateFiles(async (e) => {
            for (const uri of e.files) {
                try {
                    if (uri.scheme !== 'file' || !isUnderMirror(uri)) continue;
                    const { type, groupPathSub, fileName, dir, isFile, isMsFile, isMetaFile } = parseRel(uri);
                    if (!isFile || !fileName || !MAGIC_RESOURCE_TYPES.includes(type)) continue;
                    await ensureGroupsLocal(type, groupPathSub);
                    await client.getResourceFiles(dir);
                    const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                    if (isMsFile) {
                        // 针对新建的 .ms 文件，若服务器不存在则创建文件，并创建对应的本地 meta
                        if (!fid) {
                            const newId = await client.createFile({
                                name: fileName,
                                script: '',
                                type,
                                groupPath: groupPathSub ? `${type}/${groupPathSub}` : `${type}`
                            });
                            const meta: MirrorFileMeta = {
                                id: newId || undefined,
                                name: fileName,
                                type,
                                groupPath: dir,
                                localUpdateTime: Date.now()
                            };
                            await this.writeLocalMeta(mirrorRoot, meta);
                        }
                    } else if (isMetaFile) {
                        // 新建 meta 文件：不主动推送，等待保存时解析并推送
                        // 但仍写入一个默认的初始值，确保格式正确
                        const initMeta: MirrorFileMeta = {
                            name: fileName,
                            type,
                            groupPath: dir,
                            localUpdateTime: Date.now()
                        };
                        await this.writeLocalMeta(mirrorRoot, initMeta);
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
                    const { type, groupPathSub, fileName, dir, isFile, isMsFile, isMetaFile } = parseRel(uri);
                    if (!MAGIC_RESOURCE_TYPES.includes(type)) continue;
                    if (isMsFile && fileName) {
                        await client.getResourceFiles(dir);
                        const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                        if (fid) {
                            await client.deleteFile(fid);
                        }
                        // 同步删除本地 meta 文件
                        const metaUri = this.getMetaFileUriFor(mirrorRoot, type, groupPathSub, fileName);
                        try { await vscode.workspace.fs.delete(metaUri); } catch {}
                    } else if (isMetaFile && fileName) {
                        // 删除元数据文件不直接删除服务器资源，仅忽略
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
                    if (oldRel.isMsFile && newRel.isMsFile && oldRel.fileName && newRel.fileName && MAGIC_RESOURCE_TYPES.includes(oldRel.type)) {
                        const dir = oldRel.dir;
                        await client.getResourceFiles(dir);
                        const fid = client.getFileIdByPath(`${dir}/${oldRel.fileName}.ms`);
                        if (fid) {
                            const info = await client.getFile(fid);
                            if (info) {
                                await client.saveFile({ ...info, name: newRel.fileName! });
                            }
                        }
                        // 同步重命名本地 meta 文件
                        const oldMeta = this.getMetaFileUriFor(mirrorRoot, oldRel.type, oldRel.groupPathSub, oldRel.fileName);
                        const newMeta = this.getMetaFileUriFor(mirrorRoot, newRel.type, newRel.groupPathSub, newRel.fileName);
                        try { await vscode.workspace.fs.rename(oldMeta, newMeta, { overwrite: true }); } catch {}
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

        // 文档打开事件：检查本地与服务器差异并提供合并操作
        disposables.push(vscode.workspace.onDidOpenTextDocument(async (doc) => {
            try {
                if (doc.uri.scheme !== 'file' || !isUnderMirror(doc.uri)) return;
                const { type, groupPathSub, fileName, dir, isFile, isMsFile, isMetaFile } = parseRel(doc.uri);
                if (!isFile || !fileName || !MAGIC_RESOURCE_TYPES.includes(type)) return;

                await client.getResourceFiles(dir);
                const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                const info = fid ? await client.getFile(fid) : null;
                const localMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);

                if (isMsFile) {
                    const localScript = doc.getText();
                    const serverScript = info?.script ?? '';
                    const serverTime = info?.updateTime ?? 0;
                    const localTime = localMeta?.localUpdateTime ?? 0;
                    if (localScript !== serverScript) {
                        const choice = await vscode.window.showInformationMessage(
                            `检测到 ${fileName}.ms 本地与服务器内容不一致，是否进行合并？`,
                            '打开合并', '以本地为准', '以服务器为准'
                        );
                        if (choice === '打开合并') {
                            await this.promptMergeForFile(fileName, dir, mirrorRoot);
                        } else if (choice === '以本地为准' || choice === '以服务器为准') {
                            const useLocal = choice === '以本地为准' || localTime >= serverTime;
                            const finalScript = useLocal ? localScript : serverScript;
                            const metaToUse: MirrorFileMeta = {
                                ...(localMeta || { name: fileName, type, groupPath: dir }),
                                updateTime: info?.updateTime,
                                localUpdateTime: Date.now()
                            };
                            await this.writeLocalMeta(mirrorRoot, metaToUse);
                            if (fid && info) {
                                await client.saveFile({
                                    ...info,
                                    name: metaToUse.name,
                                    path: metaToUse.path || info.path || '',
                                    method: metaToUse.method || info.method,
                                    requestMapping: metaToUse.requestMapping || info.requestMapping,
                                    description: metaToUse.description || info.description,
                                    // 类型专属字段：API
                                    ...(metaToUse.type === 'api' ? {
                                        params: metaToUse.params ?? (info as any).params,
                                        headers: metaToUse.headers ?? (info as any).headers,
                                        contentType: metaToUse.contentType ?? (info as any).contentType,
                                        timeout: metaToUse.timeout ?? (info as any).timeout,
                                    } : {}),
                                    // 类型专属字段：任务
                                    ...(metaToUse.type === 'task' ? {
                                        cron: metaToUse.cron ?? (info as any).cron,
                                        enabled: metaToUse.enabled ?? (info as any).enabled,
                                        executeOnStart: metaToUse.executeOnStart ?? (info as any).executeOnStart,
                                    } : {}),
                                    script: finalScript,
                                } as any);
                            } else {
                                await ensureGroupsLocal(type, groupPathSub);
                                await client.createFile({
                                    name: fileName,
                                    script: finalScript,
                                    type,
                                    groupPath: dir,
                                    method: metaToUse.method,
                                    requestMapping: metaToUse.requestMapping,
                                    description: metaToUse.description,
                                    // 类型专属字段：API
                                    ...(type === 'api' ? {
                                        params: metaToUse.params,
                                        headers: metaToUse.headers,
                                        contentType: metaToUse.contentType,
                                        timeout: metaToUse.timeout,
                                    } : {}),
                                    // 类型专属字段：任务
                                    ...(type === 'task' ? {
                                        cron: metaToUse.cron,
                                        enabled: metaToUse.enabled,
                                        executeOnStart: metaToUse.executeOnStart,
                                    } : {}),
                                });
                            }
                        }
                    }
                } else if (isMetaFile) {
                    // 比较元数据差异
                    let text = doc.getText();
                    let local: MirrorFileMeta | null = null;
                    try { local = JSON.parse(text); } catch { local = localMeta || null; }
                    // 元数据校验（本地）
                    if (local) {
                        const check = this.validateLocalMeta(local, fileName);
                        if (!check.ok) {
                            vscode.window.showWarningMessage(`当前元数据存在不规范项：${check.errors.join('; ')}`);
                        }
                    }
                    const serverMeta = info ? this.toMirrorMetaFromServer(info) : null;
                    if (serverMeta && local) {
                        const localJson = JSON.stringify(local, null, 2);
                        const serverJson = JSON.stringify(serverMeta, null, 2);
                        if (localJson !== serverJson) {
                            const choice = await vscode.window.showInformationMessage(
                                `检测到 ${fileName} 的元数据与服务器不一致，是否合并？`,
                                '打开合并', '以本地为准', '以服务器为准'
                            );
                            if (choice === '打开合并') {
                                await this.promptMergeForMeta(fileName, dir, mirrorRoot);
                            } else if (choice === '以本地为准' || choice === '以服务器为准') {
                                const useLocal = choice === '以本地为准';
                                const finalMeta = useLocal ? local : serverMeta;
                                if (finalMeta) {
                                    finalMeta.localUpdateTime = Date.now();
                                    await this.writeLocalMeta(mirrorRoot, finalMeta);
                                    // 合并到服务器：读取脚本并保存
                                    const msUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'), `${fileName}.ms`);
                                    let script = '';
                                    try { script = Buffer.from(await vscode.workspace.fs.readFile(msUri)).toString('utf8'); } catch {}
                                    if (fid && info) {
                                        await client.saveFile({
                                            ...info,
                                            name: finalMeta.name,
                                            path: finalMeta.path || info.path || '',
                                            method: finalMeta.method || info.method,
                                            requestMapping: finalMeta.requestMapping || info.requestMapping,
                                            description: finalMeta.description || info.description,
                                            // 类型专属字段：API
                                            ...(finalMeta.type === 'api' ? {
                                                params: finalMeta.params ?? (info as any).params,
                                                headers: finalMeta.headers ?? (info as any).headers,
                                                contentType: finalMeta.contentType ?? (info as any).contentType,
                                                timeout: finalMeta.timeout ?? (info as any).timeout,
                                            } : {}),
                                            // 类型专属字段：任务
                                            ...(finalMeta.type === 'task' ? {
                                                cron: finalMeta.cron ?? (info as any).cron,
                                                enabled: finalMeta.enabled ?? (info as any).enabled,
                                                executeOnStart: finalMeta.executeOnStart ?? (info as any).executeOnStart,
                                            } : {}),
                                            script
                                        } as any);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // 打开时合并失败不打断用户操作
            }
        }));

        // 跟踪到 active 映射，便于断开
        const key = mirrorRoot.fsPath;
        const old = this.activeMirrorDisposables.get(key);
        if (old && Array.isArray(old)) {
            try { old.forEach(d => d.dispose()); } catch {}
        }
        this.activeMirrorDisposables.set(key, disposables);
        return disposables;
    }

    // 提示创建镜像工作区（当连接到服务器但当前不是镜像时）
    public async promptCreateMirrorWorkspaceIfNeeded(client: MagicApiClient, serverConfig: MagicServerConfig): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        const currentFolder = folders && folders.length > 0 ? folders[0].uri : null;
        if (currentFolder) {
            const isMirror = await this.isMirrorWorkspace(currentFolder);
            if (isMirror) return;
        }
        const action = await vscode.window.showInformationMessage(
            '是否创建对应的本地镜像工作区以进行本地维护？',
            '创建镜像工作区', '稍后'
        );
        if (action === '创建镜像工作区') {
            //获取当前用户home目录
            const defaultUri = vscode.Uri.file(os.homedir());
            const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择镜像工作区根目录', defaultUri });
 
            // 将选定目录作为镜像根写入连接信息并同步
            try {
                const folder = picked && picked.length > 0 ? picked[0] : undefined;
                if (!folder) return;
                // 在选定目录写入镜像元数据，并以该目录作为根（而不是 globalStorage）
                const baseMeta: MirrorMeta = {
                    createdAt: Date.now(),
                    url: serverConfig?.url,
                    token: serverConfig?.token,
                    username: serverConfig?.username,
                    password: serverConfig?.password,
                    lspPort: (serverConfig as any)?.lspPort,
                    debugPort: (serverConfig as any)?.debugPort,
                };
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '创建镜像工作区',
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: '写入镜像元数据' });
                    await this.writeMirrorMeta(folder, baseMeta);
                    // 刷新写入本地补全用的工作台数据
                    progress.report({ message: '拉取工作台补全数据' });
                    await this.refreshWorkbenchCompletionData(client, folder, progress);
                    // 全量同步到选定目录
                    progress.report({ message: '同步服务器资源与脚本' });
                    await this.syncFromServer(client, folder, serverConfig, progress);
                    progress.report({ message: '打开镜像工作区（当前窗口）' });
                    const curFolders = vscode.workspace.workspaceFolders;
                    const nameFromCfg = serverConfig?.url ? `Mirror: ${new URL(serverConfig.url).host}` : 'Magic API Mirror';
                    const replaced = curFolders && curFolders.length > 0
                        ? vscode.workspace.updateWorkspaceFolders(0, curFolders.length, { uri: folder, name: nameFromCfg })
                        : false;
                    if (!replaced) {
                        // 无活动工作区时，回退到 openFolder（保持不新开窗口）
                        await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: false });
                    }

                    // 启动镜像监听，确保当前窗口即可进行推送/同步
                    try {
                        const disposables = this.startMirrorListeners(client, folder);
                        this.context.subscriptions.push(...disposables);
                    } catch {}
                });
            } catch (e) {
                vscode.window.showErrorMessage(`创建镜像工作区失败: ${String(e)}`);
            }
        }
    }

    // 加载镜像工作区时的差异比较与同步
    public async compareAndSyncOnLoad(client: MagicApiClient, mirrorRoot: vscode.Uri): Promise<void> {
        // 先进行对比，显示可取消的进度条
        let cancelled = false;
        const summary = { localOnly: 0, serverOnly: 0, changed: 0 };
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在比较本地与远程镜像…',
            cancellable: true,
        }, async (progress, token) => {
            try {
                progress.report({ message: '初始化', increment: 5 });
                // 优先刷新一次工作台补全数据，供本地提示在 LSP 不可用时使用
                try { await this.refreshWorkbenchCompletionData(client, mirrorRoot, progress); } catch {}
                const dirs = await client.getResourceDirs();
                if (token.isCancellationRequested) { cancelled = true; return; }

                const remotePaths = new Set<string>();
                const remoteUpdateMap = new Map<string, number>();

                // 扫描服务器文件
                for (const dir of dirs) {
                    if (token.isCancellationRequested) { cancelled = true; return; }
                    const files = await client.getResourceFiles(dir);
                    for (const f of files) {
                        const key = `${dir}/${f.name}.ms`;
                        remotePaths.add(key);
                        // 使用列表中的更新时间估算变化，无需逐个拉取脚本
                        const ut = (f as any)?.updateTime ?? 0;
                        remoteUpdateMap.set(key, ut);
                    }
                    progress.report({ message: `扫描服务器目录: ${dir}` });
                }

                if (token.isCancellationRequested) { cancelled = true; return; }
                progress.report({ message: '扫描本地文件', increment: 20 });

                // 扫描本地 .ms 文件
                const localItems = await this.listLocalMsFiles(mirrorRoot);
                const localPaths = new Set<string>();
                const localUpdateMap = new Map<string, number>();
                for (const item of localItems) {
                    if (token.isCancellationRequested) { cancelled = true; return; }
                    const key = `${item.dir}/${item.fileName}.ms`;
                    localPaths.add(key);
                    const meta = await this.readLocalMeta(mirrorRoot, item.type, item.groupPathSub, item.fileName);
                    localUpdateMap.set(key, meta?.localUpdateTime ?? 0);
                }

                // 汇总差异
                progress.report({ message: '分析差异', increment: 30 });
                for (const key of localPaths) {
                    if (!remotePaths.has(key)) summary.localOnly++;
                }
                for (const key of remotePaths) {
                    if (!localPaths.has(key)) summary.serverOnly++;
                }
                // 精确计算 changed：脚本或有效元数据差异（忽略本地字段）
                for (const key of remotePaths) {
                    if (!localPaths.has(key)) continue;
                    try {
                        // 解析目录与文件名
                        const parts = key.split('/');
                        const file = parts.pop() || '';
                        const fileName = file.replace(/\.ms$/, '');
                        const dir = parts.join('/');
                        const segs = dir.split('/');
                        const type = segs[0] as MagicResourceType;
                        const groupPathSub = segs.slice(1).join('/');

                        // 本地脚本与元数据
                        const msUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'), `${fileName}.ms`);
                        let localScript = '';
                        try { localScript = Buffer.from(await vscode.workspace.fs.readFile(msUri)).toString('utf8'); } catch {}
                        const localMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);

                        // 服务器脚本与元数据
                        await client.getResourceFiles(dir);
                        const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                        const serverInfo = fid ? await client.getFile(fid) : null;
                        const serverScript = serverInfo?.script ?? '';
                        const serverMeta = serverInfo ? this.toMirrorMetaFromServer(serverInfo) : null;
                        if (serverMeta) serverMeta.groupPath = dir;

                        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                        const scriptsDifferent = normalize(localScript) !== normalize(serverScript);
                        const metaDifferent = JSON.stringify(this.sanitizeMetaForDiff(localMeta) || {}) !== JSON.stringify(this.sanitizeMetaForDiff(serverMeta) || {});

                        if (scriptsDifferent || metaDifferent) summary.changed++;
                    } catch {}
                }

                progress.report({ message: '对比完成', increment: 45 });
            } catch (e) {
                // 若出现错误，交由后续统一提示；此处仅标记取消状态
                if ((e as any)?.message === 'Cancelled') cancelled = true;
            }
        });

        if (cancelled) return;
        if (summary.localOnly === 0 && summary.serverOnly === 0 && summary.changed === 0) {
            vscode.window.showInformationMessage('未发现本地与服务器之间的差异');
            return;
        }

        // 根据差异动态展示同步选项
        const pickItems: vscode.QuickPickItem[] = [];
        const skipItem: vscode.QuickPickItem = { label: '跳过', description: '暂不进行同步' };
        if (summary.localOnly > 0 && summary.serverOnly === 0 && summary.changed === 0) {
            pickItems.push({ label: '同步本地到服务器', description: `本地新增 ${summary.localOnly} 项` });
            pickItems.push(skipItem);
        } else if (summary.serverOnly > 0 && summary.localOnly === 0 && summary.changed === 0) {
            pickItems.push({ label: '同步服务器到本地', description: `服务器新增 ${summary.serverOnly} 项` });
            pickItems.push(skipItem);
        } else {
            pickItems.push({ label: '双向同步', description: `本地新增 ${summary.localOnly}、服务器新增 ${summary.serverOnly}、变化 ${summary.changed}` });
            pickItems.push({ label: '同步本地到服务器', description: `仅推送本地，含新增 ${summary.localOnly}、变化 ${summary.changed}` });
            pickItems.push({ label: '同步服务器到本地', description: `仅拉取服务器，含新增 ${summary.serverOnly}、变化 ${summary.changed}` });
            pickItems.push(skipItem);
        }

        const choice = await vscode.window.showQuickPick(pickItems, { placeHolder: '发现差异，选择同步方式（可随时取消）' });
        if (!choice || choice.label === '跳过') return;

        const twoWay = choice.label === '双向同步';
        const pushLocal = choice.label === '同步本地到服务器';
        const pullServer = choice.label === '同步服务器到本地';

        // 拉取服务器目录与文件信息
        const dirs = await client.getResourceDirs();
        // 记录本地已扫描的文件键，之后补充本地独有文件
        const seenLocalKeys = new Set<string>();

        for (const dir of dirs) {
            const segs = dir.split('/').filter(Boolean);
            const type = segs[0] as MagicResourceType;
            const groupPathSub = segs.slice(1).join('/');
            const files = await client.getResourceFiles(dir);
            for (const f of files) {
                const fileName = f.name;
                const fileKey = `${dir}/${fileName}.ms`;
                seenLocalKeys.add(fileKey);
                // 读取本地脚本与元数据
                const msUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'), `${fileName}.ms`);
                let localScript = '';
                try { localScript = Buffer.from(await vscode.workspace.fs.readFile(msUri)).toString('utf8'); } catch {}
                const localMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);

                const serverInfo = await client.getFile(f.id);
                const serverScript = serverInfo?.script ?? '';
                const serverMeta = serverInfo ? this.toMirrorMetaFromServer(serverInfo) : null;
                if (serverMeta) serverMeta.groupPath = dir;

                const localTime = localMeta?.localUpdateTime ?? 0;
                const serverTime = serverMeta?.updateTime ?? 0;

                // 统一换行符，避免 CRLF/LF 造成的“假差异”
                const normalizeScript = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                const scriptsDifferent = normalizeScript(localScript) !== normalizeScript(serverScript);
                // 仅在脚本内容不一致时才触发 diff；元数据差异（如时间戳）不触发脚本 diff
                const metaDifferent = JSON.stringify(this.sanitizeMetaForDiff(localMeta) || {}) !== JSON.stringify(this.sanitizeMetaForDiff(serverMeta) || {});

                // 决策：twoWay / pushLocal / pullServer
                let decideUseLocal = false;
                let decideUseServer = false;
                if (twoWay) {
                    if (localTime > serverTime) decideUseLocal = true;
                    else if (serverTime > localTime) decideUseServer = true;
                    else {
                        // 时间相同，若内容不同则提示合并
                        if (scriptsDifferent) {
                            await this.promptMergeForFile(fileName, dir, mirrorRoot);
                            // 用户在 diff 中自行处理，不自动覆盖
                        }
                        continue;
                    }
                } else if (pushLocal) {
                    if (localTime >= serverTime) decideUseLocal = true;
                    else if (scriptsDifferent) {
                        await this.promptMergeForFile(fileName, dir, mirrorRoot);
                        continue;
                    } else {
                        continue;
                    }
                } else if (pullServer) {
                    if (serverTime >= localTime) decideUseServer = true;
                    else if (scriptsDifferent) {
                        await this.promptMergeForFile(fileName, dir, mirrorRoot);
                        continue;
                    } else {
                        continue;
                    }
                }

                // 执行合并：以本地为准 -> 保存到服务器；以服务器为准 -> 落地到本地
                if (decideUseLocal) {
                    if (serverInfo) {
                        await client.saveFile({
                            ...serverInfo,
                            name: localMeta?.name || fileName,
                            path: localMeta?.path || serverInfo.path || '',
                            method: localMeta?.method || serverInfo.method,
                            requestMapping: localMeta?.requestMapping || serverInfo.requestMapping,
                            description: localMeta?.description || serverInfo.description,
                            // 类型专属字段：API
                            ...(type === 'api' ? {
                                params: localMeta?.params ?? (serverInfo as any).params,
                                headers: localMeta?.headers ?? (serverInfo as any).headers,
                                contentType: localMeta?.contentType ?? (serverInfo as any).contentType,
                                timeout: localMeta?.timeout ?? (serverInfo as any).timeout,
                            } : {}),
                            // 类型专属字段：任务
                            ...(type === 'task' ? {
                                cron: localMeta?.cron ?? (serverInfo as any).cron,
                                enabled: localMeta?.enabled ?? (serverInfo as any).enabled,
                                executeOnStart: localMeta?.executeOnStart ?? (serverInfo as any).executeOnStart,
                            } : {}),
                            script: localScript
                        } as any);
                    } else {
                        await client.createFile({
                            name: fileName,
                            script: localScript,
                            type,
                            groupPath: dir,
                            method: localMeta?.method,
                            requestMapping: localMeta?.requestMapping,
                            description: localMeta?.description,
                            // 类型专属字段：API
                            ...(type === 'api' ? {
                                params: localMeta?.params,
                                headers: localMeta?.headers,
                                contentType: localMeta?.contentType,
                                timeout: localMeta?.timeout,
                            } : {}),
                            // 类型专属字段：任务
                            ...(type === 'task' ? {
                                cron: localMeta?.cron,
                                enabled: localMeta?.enabled,
                                executeOnStart: localMeta?.executeOnStart,
                            } : {}),
                        });
                    }
                } else if (decideUseServer && serverMeta) {
                    // 写入本地 .ms
                    const dirUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'));
                    await this.ensureDir(dirUri);
                    await vscode.workspace.fs.writeFile(msUri, Buffer.from(serverScript, 'utf8'));
                    // 写入本地 meta（更新本地时间戳）
                    const finalMeta: MirrorFileMeta = { ...serverMeta, localUpdateTime: Date.now() };
                    await this.writeLocalMeta(mirrorRoot, finalMeta);
                }
            }
        }

        // 扫描本地独有的 .ms 文件（服务器不存在）并按策略处理
        const localOnly = await this.listLocalMsFiles(mirrorRoot);
        for (const item of localOnly) {
            const fileKey = `${item.dir}/${item.fileName}.ms`;
            if (seenLocalKeys.has(fileKey)) continue; // 已在上面处理
            await client.getResourceFiles(item.dir);
            const fid = client.getFileIdByPath(fileKey);
            if (fid) continue; // 服务器存在，忽略
            // 读取本地脚本与元数据
            const msUri = vscode.Uri.joinPath(mirrorRoot, ...item.dir.split('/'), `${item.fileName}.ms`);
            let localScript = '';
            try { localScript = Buffer.from(await vscode.workspace.fs.readFile(msUri)).toString('utf8'); } catch {}
            const localMeta = await this.readLocalMeta(mirrorRoot, item.type, item.groupPathSub, item.fileName);

            if (pushLocal || twoWay) {
                // 推送到服务器
                await this.ensureGroups(client, item.type, item.groupPathSub);
                await client.createFile({
                    name: item.fileName,
                    script: localScript,
                    type: item.type,
                    groupPath: item.dir,
                    method: localMeta?.method,
                    requestMapping: localMeta?.requestMapping,
                    description: localMeta?.description,
                    // 类型专属字段：API
                    ...(item.type === 'api' ? {
                        params: localMeta?.params,
                        headers: localMeta?.headers,
                        contentType: localMeta?.contentType,
                        timeout: localMeta?.timeout,
                    } : {}),
                    // 类型专属字段：任务
                    ...(item.type === 'task' ? {
                        cron: localMeta?.cron,
                        enabled: localMeta?.enabled,
                        executeOnStart: localMeta?.executeOnStart,
                    } : {}),
                });
            } else if (pullServer) {
                // 保留本地，不操作
                continue;
            }
        }
    }

    // 打开差异/合并：优先使用 VS Code 内置 diff 展示差异，必要时回退到 Merge Editor
    private async promptMergeForFile(fileName: string, dir: string, mirrorRoot: vscode.Uri): Promise<void> {
        // 本地与服务器脚本 URI
        const msUri = vscode.Uri.joinPath(mirrorRoot, ...dir.split('/'), `${fileName}.ms`);
        const serverUri = vscode.Uri.parse(`magic-api:/${dir}/${fileName}.ms`);

        // 优先打开差异视图，高亮具体变更位置
        try {
            const title = `${fileName}.ms (本地 ↔ 服务器)`;
            await vscode.commands.executeCommand('vscode.diff', msUri, serverUri, title);
            return;
        } catch {}

        // 回退：构建冲突文件，并尝试使用 Merge Editor 打开
        let localScript = '';
        let serverScript = '';
        try { localScript = Buffer.from(await vscode.workspace.fs.readFile(msUri)).toString('utf8'); } catch {}
        try { serverScript = Buffer.from(await vscode.workspace.fs.readFile(serverUri)).toString('utf8'); } catch {}
        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const conflict = `<<<<<<< LOCAL\n${normalize(localScript)}\n=======\n${normalize(serverScript)}\n>>>>>>> SERVER\n`;

        const tempBase = vscode.Uri.joinPath(mirrorRoot, '.merge', ...dir.split('/'));
        await this.ensureDir(tempBase);
        const tempUri = vscode.Uri.joinPath(tempBase, `${fileName}.ms`);
        await vscode.workspace.fs.writeFile(tempUri, Buffer.from(conflict, 'utf8'));
        try {
            await vscode.commands.executeCommand('vscode.openWith', tempUri, 'mergeEditor');
        } catch {
            try { await vscode.window.showTextDocument(tempUri, { preview: true }); } catch {}
        }
    }

    // 打开元数据差异/合并：优先使用内置 diff，生成忽略本地字段的对比
    private async promptMergeForMeta(fileName: string, dir: string, mirrorRoot: vscode.Uri): Promise<void> {
        const segs = dir.split('/');
        const type = segs[0] as MagicResourceType;
        const groupPathSub = segs.slice(1).join('/');
        const localMeta = await this.readLocalMeta(mirrorRoot, type, groupPathSub, fileName);

        // 取服务器元数据
        let serverMeta: MirrorFileMeta | null = null;
        try {
            const client = (await import('./serverManager')).ServerManager.getInstance().getCurrentClient();
            if (client) {
                await client.getResourceFiles(dir);
                const fid = client.getFileIdByPath(`${dir}/${fileName}.ms`);
                const info = fid ? await client.getFile(fid) : null;
                serverMeta = info ? this.toMirrorMetaFromServer(info) : null;
            }
        } catch {}

        // 构建用于 diff 的净化副本：忽略本地字段（例如 localUpdateTime）
        const sanitize = (m: MirrorFileMeta | null): any => {
            const obj = { ...(m || { name: fileName, type, groupPath: dir }) } as any;
            delete obj.localUpdateTime;
            return obj;
        };
        const left = sanitize(localMeta);
        const right = sanitize(serverMeta);

        // 写入临时 diff 文件并打开差异视图
        const tempBase = vscode.Uri.joinPath(mirrorRoot, '.merge-meta', ...dir.split('/'));
        await this.ensureDir(tempBase);
        const leftUri = vscode.Uri.joinPath(tempBase, `.${fileName}.local.meta.json`);
        const rightUri = vscode.Uri.joinPath(tempBase, `.${fileName}.server.meta.json`);
        await vscode.workspace.fs.writeFile(leftUri, Buffer.from(JSON.stringify(left, null, 2), 'utf8'));
        await vscode.workspace.fs.writeFile(rightUri, Buffer.from(JSON.stringify(right, null, 2), 'utf8'));
        try {
            const title = `${fileName}.meta.json (本地 ↔ 服务器)`;
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
            return;
        } catch {}

        // 回退：构建冲突 JSON 并尝试用 Merge Editor 打开
        const localJson = JSON.stringify(left || {}, null, 2);
        const serverJson = JSON.stringify(right || {}, null, 2);
        const conflict = `<<<<<<< LOCAL\n${localJson}\n=======\n${serverJson}\n>>>>>>> SERVER\n`;
        const tempUri = vscode.Uri.joinPath(tempBase, `.${fileName}.meta.json`);
        await vscode.workspace.fs.writeFile(tempUri, Buffer.from(conflict, 'utf8'));
        try {
            await vscode.commands.executeCommand('vscode.openWith', tempUri, 'mergeEditor');
        } catch {
            try { await vscode.window.showTextDocument(tempUri, { preview: true }); } catch {}
        }
    }

    // 列出本地所有 .ms 文件
    private async listLocalMsFiles(mirrorRoot: vscode.Uri): Promise<Array<{ type: MagicResourceType; dir: string; groupPathSub: string; fileName: string }>> {
        const result: Array<{ type: MagicResourceType; dir: string; groupPathSub: string; fileName: string }> = [];
        // 遍历顶层类型目录
        for (const t of MAGIC_RESOURCE_TYPES) {
            const tRoot = vscode.Uri.joinPath(mirrorRoot, t);
            let entries: [string, vscode.FileType][] = [];
            try { entries = await vscode.workspace.fs.readDirectory(tRoot); } catch { continue; }
            // 深度优先遍历
            const stack: { base: vscode.Uri; segs: string[] }[] = [{ base: tRoot, segs: [] }];
            while (stack.length) {
                const cur = stack.pop()!;
                let items: [string, vscode.FileType][] = [];
                try { items = await vscode.workspace.fs.readDirectory(cur.base); } catch { continue; }
                for (const [name, type] of items) {
                    if (type === vscode.FileType.Directory) {
                        stack.push({ base: vscode.Uri.joinPath(cur.base, name), segs: [...cur.segs, name] });
                    } else if (type === vscode.FileType.File && name.endsWith('.ms')) {
                        const fileName = name.replace(/\.ms$/, '');
                        const groupPathSub = cur.segs.join('/');
                        const dir = `${t}${groupPathSub ? '/' + groupPathSub : ''}`;
                        result.push({ type: t, dir, groupPathSub, fileName });
                    }
                }
            }
        }
        return result;
    }

    // 根据任意文件 URI 查找其所在镜像工作区根目录
    public async findMirrorRootForUri(uri: vscode.Uri): Promise<vscode.Uri | null> {
        if (uri.scheme !== 'file') return null;
        // 自底向上查找 .magic-api-mirror.json
        let current = uri;
        const maxDepth = 10;
        for (let i = 0; i < maxDepth; i++) {
            try {
                const marker = vscode.Uri.joinPath(current, '.magic-api-mirror.json');
                await vscode.workspace.fs.stat(marker);
                return current;
            } catch {}
            const parent = vscode.Uri.joinPath(current, '..');
            if (parent.fsPath === current.fsPath) break;
            current = parent;
        }
        return null;
    }

    // 扫描当前工作区，查找所有镜像根目录（支持镜像文件夹在工作区的子目录的场景）
    public async findAllMirrorRootsInWorkspace(): Promise<vscode.Uri[]> {
        const results: vscode.Uri[] = [];
        try {
            const files = await vscode.workspace.findFiles('**/.magic-api-mirror.json', '**/{node_modules,.git}/**');
            for (const file of files) {
                results.push(vscode.Uri.joinPath(file, '..'));
            }
        } catch {}
        return results;
    }

    // 根据连接信息在工作区内查找对应的镜像根目录
    public async findMirrorRootByConnection(conn: { url?: string; token?: string; username?: string; password?: string; lspPort?: number; debugPort?: number; }): Promise<vscode.Uri | null> {
        const roots = await this.findAllMirrorRootsInWorkspace();
        const normUrl = (u?: string) => (u || '').replace(/\/$/, '');
        const targetUrl = normUrl(conn.url);
        for (const root of roots) {
            const meta = await this.readMirrorMeta(root);
            if (!meta) continue;
            const metaUrl = normUrl(meta.url);
            if (targetUrl && metaUrl === targetUrl) {
                const tokenOk = !conn.token || conn.token === (meta as any).token;
                const basicOk = (!conn.username && !conn.password) || (conn.username === (meta as any).username && conn.password === (meta as any).password);
                if (tokenOk && basicOk) return root;
            }
        }
        return null;
    }

    // 公开方法：连接镜像根（启动监听并进行一次比较同步）
    public async connectMirrorRoot(client: MagicApiClient, root: vscode.Uri): Promise<void> {
        const disposables = this.startMirrorListeners(client, root);
        this.context.subscriptions.push(...disposables);
        try { await this.compareAndSyncOnLoad(client, root); } catch {}
    }

    // 公开方法：断开镜像根（释放监听）
    public disconnectMirrorRoot(root: vscode.Uri): void {
        const key = root.fsPath;
        const arr = this.activeMirrorDisposables.get(key);
        if (arr && Array.isArray(arr)) {
            try { arr.forEach(d => d.dispose()); } catch {}
        }
        this.activeMirrorDisposables.delete(key);
    }

    // 解析镜像工作区内文件的相对信息
    public parseMirrorFile(mirrorRoot: vscode.Uri, fileUri: vscode.Uri): { type: MagicResourceType | null; groupPathSub: string; fileName: string | null; typedPath: string | null } {
        const rel = fileUri.fsPath.replace(mirrorRoot.fsPath, '').replace(/^\\|\//, '').replace(/\\/g, '/');
        const segs = rel.split('/').filter(Boolean);
        const last = segs[segs.length - 1] || '';
        const isMsFile = last.endsWith('.ms');
        const typeIndex = segs.findIndex(s => (MAGIC_RESOURCE_TYPES as readonly string[]).includes(s));
        const type = (typeIndex >= 0 ? segs[typeIndex] : '') as MagicResourceType;
        const isValidType = !!type && (MAGIC_RESOURCE_TYPES as readonly string[]).includes(type);
        const fileName = isMsFile ? last.replace(/\.ms$/, '') : null;
        const groupStart = typeIndex >= 0 ? typeIndex + 1 : 1;
        const groupPathSub = segs.slice(groupStart, fileName ? segs.length - 1 : segs.length).join('/');
        const typedPath = (isValidType && fileName) ? `${type}${groupPathSub ? '/' + groupPathSub : ''}/${fileName}.ms` : null;
        return { type: isValidType ? type : null, groupPathSub, fileName, typedPath };
    }

    // 校验本地元数据的规范性（基本校验）
    private validateLocalMeta(meta: MirrorFileMeta, fileName?: string): { ok: boolean; errors: string[] } {
        const errors: string[] = [];
        // 类型与分组路径
        if (!meta.type || !(MAGIC_RESOURCE_TYPES as readonly string[]).includes(meta.type)) {
            errors.push('type 不合法');
        }
        if (!meta.groupPath || (meta.type && !String(meta.groupPath).startsWith(String(meta.type)))) {
            errors.push('groupPath 必须以资源类型开头，例如 "api/user"');
        }
        // 名称与文件名一致性
        if (!meta.name) {
            errors.push('name 不能为空');
        } else if (fileName && meta.name !== fileName) {
            errors.push(`name (${meta.name}) 与文件名 (${fileName}) 不一致`);
        }
        // 针对 API：建议提供 method 与 requestMapping/path
        if (meta.type === 'api') {
            const hasRoute = !!(meta.requestMapping || meta.path);
            const hasMethod = !!meta.method;
            if (!hasMethod) errors.push('API 元数据缺少 method');
            if (!hasRoute) errors.push('API 元数据缺少 requestMapping 或 path');
        }
        return { ok: errors.length === 0, errors };
    }
}
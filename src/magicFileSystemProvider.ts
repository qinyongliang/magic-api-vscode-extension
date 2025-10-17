import * as vscode from 'vscode';
import { getAgentsManual } from './agentsManual';
import { MagicApiClient } from './magicApiClient';
import { MagicResourceType, MAGIC_RESOURCE_TYPES } from './types';

export interface MagicFileInfo {
    id: string;
    name: string;
    path: string;
    script: string;
    groupId: string;
    groupPath: string;
    type: MagicResourceType;
    createTime?: number;
    updateTime?: number;
    createBy?: string;
    updateBy?: string;
    method?: string;
    requestMapping?: string;
    description?: string;
    locked?: boolean;
    // 类型专属字段：API
    params?: any[];
    headers?: Record<string, any> | any;
    contentType?: string;
    timeout?: number;
    // 类型专属字段：任务
    cron?: string;
    enabled?: boolean;
    executeOnStart?: boolean;
    // 其他服务端扩展字段（未识别的字段原样保留）
    extra?: Record<string, any>;
}

export interface MagicGroupInfo {
    id: string;
    name: string;
    path: string;
    parentId?: string;
    type: MagicResourceType;
    createTime?: number;
    updateTime?: number;
}

export class MagicFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private _bufferedEvents: vscode.FileChangeEvent[] = [];
    private _fireSoonHandle?: NodeJS.Timer;

    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    constructor(private client: MagicApiClient, private configDir?: vscode.Uri) {}

    private isAgentsUri(uri: vscode.Uri): boolean {
        const p = uri.path.replace(/^\/+/, '');
        return p === 'AGENTS.md';
    }

    private getAgentsFileUri(): vscode.Uri | undefined {
        if (!this.configDir) return undefined;
        return vscode.Uri.joinPath(this.configDir, 'AGENTS.md');
    }

    private async ensureConfigDirExists(): Promise<void> {
        if (!this.configDir) return;
        try {
            await vscode.workspace.fs.stat(this.configDir);
        } catch {
            await vscode.workspace.fs.createDirectory(this.configDir);
        }
    }

    private generateAgentsContent(): string {
        return getAgentsManual();
    }

    private async readAgentsFile(): Promise<Uint8Array> {
        const agentsUri = this.getAgentsFileUri();
        if (!agentsUri) {
            const content = this.generateAgentsContent();
            return Buffer.from(content, 'utf8');
        }
        await this.ensureConfigDirExists();
        let exists = true;
        try {
            await vscode.workspace.fs.stat(agentsUri);
        } catch {
            exists = false;
        }
        if (!exists) {
            const content = this.generateAgentsContent();
            await vscode.workspace.fs.writeFile(agentsUri, Buffer.from(content, 'utf8'));
        }
        return vscode.workspace.fs.readFile(agentsUri);
    }

    private async writeAgentsFile(content: Uint8Array): Promise<void> {
        const agentsUri = this.getAgentsFileUri();
        if (!agentsUri) return;
        await this.ensureConfigDirExists();
        await vscode.workspace.fs.writeFile(agentsUri, content);
    }

    // 监听文件变化
    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // 实现文件监听逻辑
        return new vscode.Disposable(() => {});
    }

    // 获取文件状态（统一资源目录结构）
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        if (this.isAgentsUri(uri)) {
            return { type: vscode.FileType.File, ctime: Date.now(), mtime: Date.now(), size: (await this.readAgentsFile()).length };
        }
        const p = this.parsePath(uri);
        if (p.isRoot) {
            return { type: vscode.FileType.Directory, ctime: Date.now(), mtime: Date.now(), size: 0 };
        }

        if (p.isFile) {
            const filePath = `${p.dir}/${p.fileName}.ms`;
            let fid = this.client.getFileIdByPath(filePath);
            if (!fid) {
                // 填充缓存
                await this.client.getResourceFiles(p.dir);
                fid = this.client.getFileIdByPath(filePath);
            }
            if (!fid) throw vscode.FileSystemError.FileNotFound(uri);
            const fileInfo = await this.client.getFile(fid);
            if (!fileInfo) throw vscode.FileSystemError.FileNotFound(uri);
            return {
                type: vscode.FileType.File,
                ctime: fileInfo.createTime || Date.now(),
                mtime: fileInfo.updateTime || Date.now(),
                size: Buffer.byteLength(fileInfo.script || '', 'utf8')
            };
        }

        // 目录：仅由统一目录列表驱动
        const files = await this.client.getResourceFiles(p.dir);
        if (files) {
            return { type: vscode.FileType.Directory, ctime: Date.now(), mtime: Date.now(), size: 0 };
        }
        throw vscode.FileSystemError.FileNotFound(uri);
    }

    // 读取目录（统一资源目录结构）
    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const p = this.parsePath(uri);
        const entries: [string, vscode.FileType][] = [];

        const dirs = await this.client.getResourceDirs();
        if (p.isRoot) {
            // 展示顶层目录：严格使用服务返回的第一段
            const topSet = new Set<string>();
            for (const d of dirs) {
                const seg = d.split('/')[0];
                if (seg) topSet.add(seg);
            }
            for (const name of Array.from(topSet)) entries.push([name, vscode.FileType.Directory]);
            // 根目录追加 AGENTS.md
            entries.push(['AGENTS.md', vscode.FileType.File]);
            return entries;
        }

        // 子目录：展示 p.dir 的子目录与文件
        const childDirSet = new Set<string>();
        const prefix = p.dir + '/';
        for (const d of dirs) {
            if (d.startsWith(prefix)) {
                const rest = d.substring(prefix.length);
                const next = rest.split('/')[0];
                if (next) childDirSet.add(next);
            }
        }
        for (const name of Array.from(childDirSet)) entries.push([name, vscode.FileType.Directory]);

        const files = await this.client.getResourceFiles(p.dir);
        for (const f of files) entries.push([`${f.name}.ms`, vscode.FileType.File]);
        return entries;
    }

    // 创建目录
    async createDirectory(uri: vscode.Uri): Promise<void> {
        const p = this.parsePath(uri);
        if (p.isRoot) {
            throw vscode.FileSystemError.NoPermissions('Cannot create directory at root level');
        }
        // 目录创建依旧走分组接口（后端已有），通过父目录路径解析 parentId
        const parentUri = vscode.Uri.parse(uri.toString().substring(0, uri.toString().lastIndexOf('/')));
        const parent = this.parsePath(parentUri);
        const groupName = uri.path.split('/').pop()!;
        const type = parent.dir.split('/')[0] as MagicResourceType;
        const groupPathSub = parent.dir.split('/').slice(1).join('/');
        // 通过资源树填充缓存并解析 parentId
        await this.client.getResourceDirs();
        const parentId = this.client.getGroupIdByPath(`${type}/${groupPathSub}`) || null;

        await this.client.createGroup({ name: groupName, parentId, type });

        this._fireSoon({ type: vscode.FileChangeType.Created, uri });
    }

    // 读取文件
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        if (this.isAgentsUri(uri)) {
            return this.readAgentsFile();
        }
        const p = this.parsePath(uri);
        const filePath = `${p.dir}/${p.fileName}.ms`;
        let fid = p.fileId || this.client.getFileIdByPath(filePath);
        if (!fid) {
            await this.client.getResourceFiles(p.dir);
            fid = this.client.getFileIdByPath(filePath);
        }
        if (!fid) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        const fileInfo = await this.client.getFile(fid);
        if (!fileInfo) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        return Buffer.from(fileInfo.script || '', 'utf8');
    }

    // 写入文件
    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        if (this.isAgentsUri(uri)) {
            await this.writeAgentsFile(content);
            this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
            return;
        }
        const p = this.parsePath(uri);
        const script = Buffer.from(content).toString('utf8');
        const type = p.dir.split('/')[0] as MagicResourceType;
        const groupPathSub = p.dir.split('/').slice(1).join('/');

        if (p.fileId) {
            // 更新现有文件
            const fileInfo = await this.client.getFile(p.fileId);
            if (!fileInfo) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            await this.client.saveFile({
                ...fileInfo,
                script,
                type
            });

            this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
        } else {
            // 创建新文件
            if (!options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            const fileName = uri.path.split('/').pop()!.replace('.ms', '');
            // 通过统一资源保存接口，按目录路径创建
            await this.client.createFile({
                name: fileName,
                script,
                type,
                groupPath: groupPathSub ? `${type}/${groupPathSub}` : `${type}`
            });

            this._fireSoon({ type: vscode.FileChangeType.Created, uri });
        }
    }

    // 删除文件或目录
    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        if (this.isAgentsUri(uri)) {
            throw vscode.FileSystemError.NoPermissions('AGENTS.md cannot be deleted');
        }
        const p = this.parsePath(uri);
        if (p.isFile) {
            const filePath = `${p.dir}/${p.fileName}.ms`;
            let fid = p.fileId || this.client.getFileIdByPath(filePath);
            if (!fid) {
                await this.client.getResourceFiles(p.dir);
                fid = this.client.getFileIdByPath(filePath);
            }
            if (!fid) throw vscode.FileSystemError.FileNotFound(uri);
            await this.client.deleteFile(fid);
        } else {
            const type = p.dir.split('/')[0] as MagicResourceType;
            const groupSub = p.dir.split('/').slice(1).join('/');
            if (!groupSub) {
                throw vscode.FileSystemError.NoPermissions('Cannot delete type root directories');
            }
            await this.client.getResourceDirs();
            const gid = this.client.getGroupIdByPath(`${type}/${groupSub}`);
            if (!gid) throw vscode.FileSystemError.FileNotFound(uri);
            await this.client.deleteGroup(gid);
        }

        this._fireSoon({ type: vscode.FileChangeType.Deleted, uri });
    }

    // 重命名文件或目录
    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        if (this.isAgentsUri(oldUri) || this.isAgentsUri(newUri)) {
            throw vscode.FileSystemError.NoPermissions('AGENTS.md cannot be renamed');
        }
        const oldPath = this.parsePath(oldUri);
        const newName = newUri.path.split('/').pop()!.replace('.ms', '');
        const type = oldPath.dir.split('/')[0] as MagicResourceType;
        const oldGroupPathStr = oldPath.dir.split('/').slice(1).join('/');

        if (oldPath.fileId) {
            const fileInfo = await this.client.getFile(oldPath.fileId);
            if (!fileInfo) {
                throw vscode.FileSystemError.FileNotFound(oldUri);
            }

            await this.client.saveFile({
                ...fileInfo,
                name: newName,
                type
            });
        } else if (!oldPath.isFile) {
            // 目录重命名仍通过分组接口实现
            await this.client.getResourceDirs();
            const gid = this.client.getGroupIdByPath(`${type}/${oldGroupPathStr}`);
            const groupInfo = gid ? await this.client.getGroup(gid) : null;
            if (!groupInfo) {
                throw vscode.FileSystemError.FileNotFound(oldUri);
            }

            await this.client.saveGroup({
                ...groupInfo,
                name: newName
            });
        } else {
            // 尝试解析ID后再重命名
            const fileName = oldUri.path.split('/').pop() || '';
            if (fileName.endsWith('.ms')) {
                const name = fileName.replace(/\.ms$/, '');
                const fileKey = oldGroupPathStr ? `${type}/${oldGroupPathStr}/${name}.ms` : `${type}/${name}.ms`;
                const fid = this.client.getFileIdByPath(fileKey);
                if (fid) {
                    const fileInfo = await this.client.getFile(fid);
                    if (!fileInfo) throw vscode.FileSystemError.FileNotFound(oldUri);
                    await this.client.saveFile({ ...fileInfo, name: newName, type });
                } else {
                    const gid = this.client.getGroupIdByPath(`${type}/${oldGroupPathStr}`);
                    if (gid) {
                        const groupInfo = await this.client.getGroup(gid);
                        if (!groupInfo) throw vscode.FileSystemError.FileNotFound(oldUri);
                        await this.client.saveGroup({ ...groupInfo, name: newName });
                    } else {
                        throw vscode.FileSystemError.FileNotFound(oldUri);
                    }
                }
            }
        }

        this._fireSoon(
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri }
        );
    }

    // 解析路径
    private parsePath(uri: vscode.Uri): {
        isRoot: boolean;
        isFile: boolean;
        dir: string; // /magic-api/ 后的目录路径，例如 "api/user"
        fileName?: string;
        fileId?: string;
    } {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length === 0) {
            return { isRoot: true, isFile: false, dir: '' };
        }
        const isFile = parts[parts.length - 1].endsWith('.ms');
        const dir = isFile ? parts.slice(0, -1).join('/') : parts.join('/');
        const fileName = isFile ? parts[parts.length - 1].replace(/\.ms$/, '') : undefined;
        let fileId: string | undefined;
        if (isFile) {
            const key = `${dir}/${fileName}.ms`;
            fileId = this.client.getFileIdByPath(key);
        }
        return { isRoot: false, isFile, dir, fileName, fileId };
    }

    // 触发文件变化事件
    private _fireSoon(...events: vscode.FileChangeEvent[]): void {
        this._bufferedEvents.push(...events);

        if (this._fireSoonHandle) {
            clearTimeout(this._fireSoonHandle);
        }

        this._fireSoonHandle = setTimeout(() => {
            this._emitter.fire(this._bufferedEvents);
            this._bufferedEvents.length = 0;
        }, 5);
    }
}
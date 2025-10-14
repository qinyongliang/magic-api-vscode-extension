import * as vscode from 'vscode';
import { MagicApiClient } from './magicApiClient';
import { MagicResourceType, MAGIC_RESOURCE_TYPES, isMagicResourceType } from './types';

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

    constructor(private client: MagicApiClient) {}

    // 监听文件变化
    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // 实现文件监听逻辑
        return new vscode.Disposable(() => {});
    }

    // 获取文件状态
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const path = this.parsePath(uri);
        
        if (path.isRoot) {
            return {
                type: vscode.FileType.Directory,
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0
            };
        }

        if (path.isTypeRoot) {
            return {
                type: vscode.FileType.Directory,
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0
            };
        }

        if (path.fileId) {
            // 获取文件信息
            const fileInfo = await this.client.getFile(path.fileId);
            if (!fileInfo) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            return {
                type: vscode.FileType.File,
                ctime: fileInfo.createTime || Date.now(),
                mtime: fileInfo.updateTime || Date.now(),
                size: Buffer.byteLength(fileInfo.script || '', 'utf8')
            };
        }

        if (path.groupId) {
            // 获取分组信息
            const groupInfo = await this.client.getGroup(path.groupId);
            if (!groupInfo) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            return {
                type: vscode.FileType.Directory,
                ctime: groupInfo.createTime || Date.now(),
                mtime: groupInfo.updateTime || Date.now(),
                size: 0
            };
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    // 读取目录
    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const path = this.parsePath(uri);
        const entries: [string, vscode.FileType][] = [];

        if (path.isRoot) {
            // 根目录显示所有资源类型文件夹
            for (const t of MAGIC_RESOURCE_TYPES) {
                entries.push([t, vscode.FileType.Directory]);
            }
            return entries;
        }

        if (path.isTypeRoot) {
            // 获取该类型的根分组
            const groups = await this.client.getGroups(path.type!);
            for (const group of groups) {
                if (!group.parentId) {
                    entries.push([group.name, vscode.FileType.Directory]);
                }
            }

            // 获取该类型根目录下的文件
            const files = await this.client.getFiles(path.type!, null);
            for (const file of files) {
                entries.push([`${file.name}.ms`, vscode.FileType.File]);
            }
            return entries;
        }

        if (path.groupId) {
            // 获取子分组
            const groups = await this.client.getGroups(path.type!);
            for (const group of groups) {
                if (group.parentId === path.groupId) {
                    entries.push([group.name, vscode.FileType.Directory]);
                }
            }

            // 获取该分组下的文件
            const files = await this.client.getFiles(path.type!, path.groupId);
            for (const file of files) {
                entries.push([`${file.name}.ms`, vscode.FileType.File]);
            }
            return entries;
        }

        return entries;
    }

    // 创建目录
    async createDirectory(uri: vscode.Uri): Promise<void> {
        const path = this.parsePath(uri);
        if (!path.type) {
            throw vscode.FileSystemError.NoPermissions('Cannot create directory at root level');
        }

        const parentPath = this.parsePath(vscode.Uri.parse(uri.toString().substring(0, uri.toString().lastIndexOf('/'))));
        const groupName = uri.path.split('/').pop()!;

        await this.client.createGroup({
            name: groupName,
            parentId: parentPath.groupId || null,
            type: path.type
        });

        this._fireSoon({ type: vscode.FileChangeType.Created, uri });
    }

    // 读取文件
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const path = this.parsePath(uri);
        if (!path.fileId) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        const fileInfo = await this.client.getFile(path.fileId);
        if (!fileInfo) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        return Buffer.from(fileInfo.script || '', 'utf8');
    }

    // 写入文件
    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        const path = this.parsePath(uri);
        const script = Buffer.from(content).toString('utf8');

        if (path.fileId) {
            // 更新现有文件
            const fileInfo = await this.client.getFile(path.fileId);
            if (!fileInfo) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            await this.client.saveFile({
                ...fileInfo,
                script
            });

            this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
        } else {
            // 创建新文件
            if (!options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }

            const fileName = uri.path.split('/').pop()!.replace('.ms', '');
            const parentPath = this.parsePath(vscode.Uri.parse(uri.toString().substring(0, uri.toString().lastIndexOf('/'))));

            await this.client.createFile({
                name: fileName,
                script,
                groupId: parentPath.groupId || null,
                type: path.type!
            });

            this._fireSoon({ type: vscode.FileChangeType.Created, uri });
        }
    }

    // 删除文件或目录
    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        const path = this.parsePath(uri);

        if (path.fileId) {
            await this.client.deleteFile(path.fileId);
        } else if (path.groupId) {
            await this.client.deleteGroup(path.groupId);
        } else {
            throw vscode.FileSystemError.NoPermissions('Cannot delete root directories');
        }

        this._fireSoon({ type: vscode.FileChangeType.Deleted, uri });
    }

    // 重命名文件或目录
    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        const oldPath = this.parsePath(oldUri);
        const newName = newUri.path.split('/').pop()!.replace('.ms', '');

        if (oldPath.fileId) {
            const fileInfo = await this.client.getFile(oldPath.fileId);
            if (!fileInfo) {
                throw vscode.FileSystemError.FileNotFound(oldUri);
            }

            await this.client.saveFile({
                ...fileInfo,
                name: newName
            });
        } else if (oldPath.groupId) {
            const groupInfo = await this.client.getGroup(oldPath.groupId);
            if (!groupInfo) {
                throw vscode.FileSystemError.FileNotFound(oldUri);
            }

            await this.client.saveGroup({
                ...groupInfo,
                name: newName
            });
        }

        this._fireSoon(
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri }
        );
    }

    // 解析路径
    private parsePath(uri: vscode.Uri): {
        isRoot: boolean;
        isTypeRoot: boolean;
        type?: MagicResourceType;
        groupId?: string;
        fileId?: string;
        groupPath?: string[];
    } {
        const pathParts = uri.path.split('/').filter(p => p);
        
        if (pathParts.length === 0) {
            return { isRoot: true, isTypeRoot: false };
        }

        const maybeType = pathParts[0];
        if (!isMagicResourceType(maybeType)) {
            return { isRoot: false, isTypeRoot: false };
        }
        const type = maybeType as MagicResourceType;

        if (pathParts.length === 1) {
            return { isRoot: false, isTypeRoot: true, type };
        }

        // 解析文件或分组路径
        const isFile = pathParts[pathParts.length - 1].endsWith('.ms');
        const groupPath = isFile ? pathParts.slice(1, -1) : pathParts.slice(1);
        
        // 这里需要根据路径查找对应的分组ID和文件ID
        // 实际实现中需要维护路径到ID的映射
        
        return {
            isRoot: false,
            isTypeRoot: false,
            type,
            groupPath,
            // 这些需要通过API查询获得
            groupId: undefined,
            fileId: undefined
        };
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
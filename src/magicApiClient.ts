import * as vscode from 'vscode';
import axios from 'axios';
import { debug, info, error as logError } from './logger';
import { MagicFileInfo, MagicGroupInfo } from './magicFileSystemProvider';
import { MagicResourceType } from './types';

export interface MagicServerConfig {
    id: string;
    name: string;
    url: string;
    username?: string;
    password?: string;
    token?: string;
    lspPort?: number;
    debugPort?: number;
}

export interface CreateFileRequest {
    name: string;
    script: string;
    // 统一资源保存支持按目录路径定位分组
    groupPath?: string; // 例如: "api/user" 或 "function/util"
    groupId?: string | null; // 兼容旧接口，优先使用 groupPath
    type: MagicResourceType;
    method?: string;
    requestMapping?: string;
    description?: string;
}

export interface CreateGroupRequest {
    name: string;
    parentId: string | null;
    type: MagicResourceType;
    description?: string;
}

export class MagicApiClient {
    private httpClient: any;
    private pathToIdCache = new Map<string, string>();
    private idToPathCache = new Map<string, string>();
    private webPrefix: string;

    constructor(private config: MagicServerConfig) {
        // 读取可配置的接口前缀
        const cfg = vscode.workspace.getConfiguration('magicApi');
        this.webPrefix = cfg.get<string>('webPrefix', '/magic/web');

        this.httpClient = axios.create({
            baseURL: config.url,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        debug(`MagicApiClient init: baseURL=${config.url}, webPrefix=${this.webPrefix}, lspPort=${config.lspPort || 8081}, debugPort=${config.debugPort || 8082}`);

        // 设置认证
        if (config.token) {
            this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${config.token}`;
        } else if (config.username && config.password) {
            this.httpClient.defaults.auth = {
                username: config.username,
                password: config.password
            };
        }

        // 响应拦截器处理错误
        this.httpClient.interceptors.response.use(
            (response: any) => response,
            (error: any) => {
                const status = error?.response?.status;
                const path = error?.config?.url;
                debug(`HTTP error: status=${status ?? 'n/a'} url=${path ?? 'n/a'} message=${error.message}`);
                vscode.window.showErrorMessage(`Magic API 请求失败: ${error.message}`);
                return Promise.reject(error);
            }
        );
    }

    // 获取所有分组
    async getGroups(type: MagicResourceType): Promise<MagicGroupInfo[]> {
        try {
            // 通过统一资源树解析分组列表并填充缓存
            const urlPath = `${this.webPrefix}/resource`;
            debug(`GetGroups: baseURL=${this.config.url} path=${urlPath} type=${type}`);
            const response = await this.httpClient.post(urlPath);
            const tree: any = response.data?.data || {};
            const root = tree[type];
            if (!root) return [];
            const groups: MagicGroupInfo[] = [];
            const queue: any[] = [root];
            while (queue.length) {
                const cur = queue.shift();
                const n = cur.node || {};
                const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
                if (isGroup && n.id && n.id !== '0') {
                    const path = this.buildPathFromNode(root, n.id);
                    const info: MagicGroupInfo = {
                        id: n.id,
                        name: n.name,
                        path,
                        parentId: n.parentId,
                        type,
                        createTime: n.createTime,
                        updateTime: n.updateTime,
                    };
                    groups.push(info);
                    this.pathToIdCache.set(`${type}/${path}`, n.id);
                    this.idToPathCache.set(n.id, `${type}/${path}`);
                }
                for (const child of (cur.children || [])) queue.push(child);
            }
            return groups;
        } catch (error) {
            logError(`获取分组失败: ${String(error)}`);
            return [];
        }
    }

    // 获取分组信息
    async getGroup(groupId: string): Promise<MagicGroupInfo | null> {
        try {
            // 通过资源树查找分组
            const treeResp = await this.httpClient.post(`${this.webPrefix}/resource`);
            const tree: any = treeResp.data?.data || {};
            for (const type of Object.keys(tree)) {
                const found = this.findGroupNodeById(tree[type], groupId);
                if (found) {
                    const n = found.node || {};
                    const path = this.buildPathFromNode(tree[type], groupId);
                    const info: MagicGroupInfo = {
                        id: n.id,
                        name: n.name,
                        path,
                        parentId: n.parentId,
                        type: type as MagicResourceType,
                        createTime: n.createTime,
                        updateTime: n.updateTime,
                    };
                    return info;
                }
            }
            return null;
        } catch (error) {
            logError(`获取分组信息失败: ${String(error)}`);
            return null;
        }
    }

    // 获取文件列表
    async getFiles(type: MagicResourceType, groupId: string | null): Promise<MagicFileInfo[]> {
        try {
            // 通过资源树解析指定分组的文件列表
            const treeResp = await this.httpClient.post(`${this.webPrefix}/resource`);
            const tree: any = treeResp.data?.data || {};
            const root = tree[type];
            if (!root || !groupId) return [];
            const groupNode = this.findGroupNodeById(root, groupId);
            if (!groupNode) return [];
            const dir = this.buildPathFromNode(root, groupId);
            const files: MagicFileInfo[] = [];
            const children: any[] = groupNode.children || [];
            for (const child of children) {
                const n = child.node || {};
                const isFile = n && typeof n.groupId !== 'undefined' && typeof n.type === 'undefined';
                if (isFile) {
                    const info: MagicFileInfo = {
                        id: n.id,
                        name: n.name,
                        path: n.path || '',
                        script: '',
                        groupId: n.groupId,
                        groupPath: dir,
                        type,
                        createTime: n.createTime,
                        updateTime: n.updateTime,
                        createBy: n.createBy,
                        updateBy: n.updateBy,
                    };
                    files.push(info);
                    const filePath = `${dir}/${n.name}.ms`;
                    this.pathToIdCache.set(filePath, n.id);
                    this.idToPathCache.set(n.id, filePath);
                }
            }
            return files;
        } catch (error) {
            logError(`获取文件列表失败: ${String(error)}`);
            return [];
        }
    }

    // 获取文件信息
    async getFile(fileId: string): Promise<MagicFileInfo | null> {
        try {
            const urlPath = `${this.webPrefix}/resource/file/${fileId}`;
            debug(`GetFile: baseURL=${this.config.url} path=${urlPath}`);
            const response = await this.httpClient.get(urlPath);
            return response.data.data || null;
        } catch (error) {
            logError(`获取文件信息失败: ${String(error)}`);
            return null;
        }
    }

    // 保存文件
    async saveFile(file: MagicFileInfo): Promise<boolean> {
        try {
            const type = file.type || this.inferTypeFromId(file.id);
            if (!type) {
                logError('保存文件失败：无法解析资源类型');
                return false;
            }
            const entity: any = {
                id: file.id,
                groupId: file.groupId,
                name: file.name,
                description: file.description,
            };
            if (type === 'api') {
                entity.path = file.path || '';
                entity.method = (file.method || 'GET').toUpperCase();
                if (file.requestMapping) entity.requestMapping = file.requestMapping;
            } else if (type === 'function') {
                entity.path = file.path || '';
            }
            const combined = JSON.stringify(entity) + "\r\n================================\r\n" + (file.script || '');
            const payload = this.rot13(combined);
            const urlPath = `${this.webPrefix}/resource/file/${type}/save`;
            debug(`SaveFile: path=${urlPath} id=${file.id} name=${file.name}`);
            const response = await this.httpClient.post(urlPath, payload, { headers: { 'Content-Type': 'text/plain' } });
            const ok = response.data?.code === 1;
            return !!ok;
        } catch (error) {
            console.error('保存文件失败:', error);
            return false;
        }
    }

    // 创建文件
    async createFile(request: CreateFileRequest): Promise<string | null> {
        try {
            const type = request.type;
            // 解析分组ID（优先 groupId，其次通过资源树从 groupPath 推导）
            let groupId = request.groupId || null;
            if (!groupId && request.groupPath) {
                await this.getResourceDirs();
                groupId = this.getGroupIdByPath(request.groupPath) || null;
            }
            if (!groupId) {
                vscode.window.showErrorMessage('创建文件失败：未定位到分组，请先创建分组目录');
                return null;
            }
            const entity: any = {
                groupId,
                name: request.name,
                description: request.description,
            };
            if (type === 'api') {
                entity.path = request.requestMapping || request.name;
                entity.method = (request.method || 'GET').toUpperCase();
                if (request.requestMapping) entity.requestMapping = request.requestMapping;
            } else if (type === 'function') {
                entity.path = request.requestMapping || request.name;
            }
            const combined = JSON.stringify(entity) + "\r\n================================\r\n" + (request.script || '');
            const payload = this.rot13(combined);
            const urlPath = `${this.webPrefix}/resource/file/${type}/save`;
            debug(`CreateFile: path=${urlPath} groupId=${groupId} name=${request.name}`);
            const response = await this.httpClient.post(urlPath, payload, { headers: { 'Content-Type': 'text/plain' } });
            if (response.data.code === 1) {
                const id: string | null = response.data.data || null;
                if (id && request.groupPath) {
                    const filePath = `${request.groupPath}/${request.name}.ms`;
                    this.pathToIdCache.set(filePath, id);
                    this.idToPathCache.set(id, filePath);
                }
                return id;
            }
            return null;
        } catch (error) {
            console.error('创建文件失败:', error);
            return null;
        }
    }

    // 删除文件
    async deleteFile(fileId: string): Promise<boolean> {
        try {
            const urlPath = `${this.webPrefix}/resource/delete`;
            debug(`DeleteFile: path=${urlPath} id=${fileId}`);
            const response = await this.httpClient.post(urlPath, null, { params: { id: fileId } });
            return response.data.code === 1;
        } catch (error) {
            console.error('删除文件失败:', error);
            return false;
        }
    }

    // 创建分组
    async createGroup(request: CreateGroupRequest): Promise<string | null> {
        try {
            const urlPath = `${this.webPrefix}/resource/folder/save`;
            debug(`CreateGroup: path=${urlPath} name=${request.name} type=${request.type}`);
            const response = await this.httpClient.post(urlPath, request);
            if (response.data.code === 1) {
                return response.data.data || null;
            }
            return null;
        } catch (error) {
            console.error('创建分组失败:', error);
            return null;
        }
    }

    // 保存分组
    async saveGroup(group: MagicGroupInfo): Promise<boolean> {
        try {
            const urlPath = `${this.webPrefix}/resource/folder/save`;
            debug(`SaveGroup: path=${urlPath} id=${group.id} name=${group.name}`);
            const response = await this.httpClient.post(urlPath, group);
            return response.data.code === 1;
        } catch (error) {
            console.error('保存分组失败:', error);
            return false;
        }
    }

    // 删除分组
    async deleteGroup(groupId: string): Promise<boolean> {
        try {
            const urlPath = `${this.webPrefix}/resource/delete`;
            debug(`DeleteGroup: path=${urlPath} id=${groupId}`);
            const response = await this.httpClient.post(urlPath, null, { params: { id: groupId } });
            return response.data.code === 1;
        } catch (error) {
            console.error('删除分组失败:', error);
            return false;
        }
    }

    // 根据路径获取文件ID
    getFileIdByPath(path: string): string | undefined {
        return this.pathToIdCache.get(path);
    }

    // 根据路径获取分组ID
    getGroupIdByPath(path: string): string | undefined {
        return this.pathToIdCache.get(path);
    }

    // 根据ID获取路径
    getPathById(id: string): string | undefined {
        return this.idToPathCache.get(id);
    }

    // 构建分组路径
    private buildGroupPath(group: MagicGroupInfo, allGroups: MagicGroupInfo[]): string {
        const path: string[] = [];
        let current = group;
        
        while (current) {
            path.unshift(current.name);
            if (!current.parentId) {
                break;
            }
            current = allGroups.find(g => g.id === current.parentId)!;
        }
        
        return path.join('/');
    }

    // 统一资源接口：获取所有目录（从 /resource 资源树解析）
    async getResourceDirs(): Promise<string[]> {
        try {
            const urlPath = `${this.webPrefix}/resource`;
            debug(`GetResourceDirs: baseURL=${this.config.url} path=${urlPath}`);
            const response = await this.httpClient.post(urlPath);
            const tree: any = response.data?.data || {};
            const dirs: string[] = [];
            for (const type of Object.keys(tree)) {
                // 顶层类型目录也加入，保证根展示类型名称
                dirs.push(type);
                this.collectGroupDirsFromNode(type, tree[type], [], dirs);
            }
            return dirs;
        } catch (error) {
            logError(`获取资源目录失败: ${String(error)}`);
            return [];
        }
    }

    // 统一资源接口：按目录获取文件（从 /resource 资源树解析）
    async getResourceFiles(dir: string): Promise<MagicFileInfo[]> {
        try {
            const urlPath = `${this.webPrefix}/resource`;
            debug(`GetResourceFiles: baseURL=${this.config.url} path=${urlPath} dir=${dir}`);
            const response = await this.httpClient.post(urlPath);
            const tree: any = response.data?.data || {};
            const [type, ...segs] = dir.split('/').filter(Boolean);
            const root = tree[type];
            if (!root) return [];
            const groupNode = this.findGroupNodeByPath(root, segs);
            const files: MagicFileInfo[] = [];
            if (!groupNode) return files;
            const children: any[] = groupNode.children || [];
            for (const child of children) {
                const n = child.node || {};
                const isFile = n && typeof n.groupId !== 'undefined' && typeof n.type === 'undefined';
                if (isFile) {
                    const info: MagicFileInfo = {
                        id: n.id,
                        name: n.name,
                        path: n.path || '',
                        script: '',
                        groupId: n.groupId,
                        groupPath: dir,
                        type: type as MagicResourceType,
                        createTime: n.createTime,
                        updateTime: n.updateTime,
                        createBy: n.createBy,
                        updateBy: n.updateBy,
                    };
                    files.push(info);
                    const filePath = `${dir}/${n.name}.ms`;
                    this.pathToIdCache.set(filePath, n.id);
                    this.idToPathCache.set(n.id, filePath);
                }
            }
            return files;
        } catch (error) {
            logError(`获取资源文件失败: ${String(error)}`);
            return [];
        }
    }

    // 获取 LSP 服务器地址
    getLspServerUrl(): string {
        const base = new URL(this.config.url);
        const wsProto = base.protocol === 'https:' ? 'wss' : 'ws';
        // 端口优先使用 lspPort，其次使用 URL 中的端口，最后回退到 8081
        const port = this.config.lspPort ?? (base.port ? Number(base.port) : 8081);
        const hostPort = `${base.hostname}:${port}`;
        // 路径前缀合并：同时考虑 URL 的 context-path 与 webPrefix，避免重复
        const basePath = (base.pathname || '').replace(/\/$/, '');
        const cfgPrefix = (this.webPrefix || '').replace(/\/$/, '');
        let prefix = '';
        if (basePath && cfgPrefix) {
            if (cfgPrefix.startsWith(basePath)) {
                prefix = cfgPrefix; // 例如 basePath=/app, cfgPrefix=/app/magic/web → 使用 cfgPrefix
            } else if (basePath.startsWith(cfgPrefix)) {
                prefix = basePath;
            } else {
                prefix = `${basePath}${cfgPrefix}`; // 合并 /app + /magic/web → /app/magic/web
            }
        } else {
            prefix = basePath || cfgPrefix || '';
        }
        const wsUrl = `${wsProto}://${hostPort}${prefix}/lsp`;
        debug(`LSP URL computed: ${wsUrl} (host=${base.hostname}, port=${port}, basePath=${basePath || '/'}, cfgPrefix=${cfgPrefix || ''})`);
        return wsUrl;
    }

    // 获取调试服务器地址
    getDebugServerUrl(): string {
        const base = new URL(this.config.url);
        const wsProto = base.protocol === 'https:' ? 'wss' : 'ws';
        // 端口优先使用 debugPort，其次使用 URL 中的端口，最后回退到 8082
        const port = this.config.debugPort ?? (base.port ? Number(base.port) : 8082);
        const hostPort = `${base.hostname}:${port}`;
        // 路径前缀合并逻辑同上
        const basePath = (base.pathname || '').replace(/\/$/, '');
        const cfgPrefix = (this.webPrefix || '').replace(/\/$/, '');
        let prefix = '';
        if (basePath && cfgPrefix) {
            if (cfgPrefix.startsWith(basePath)) {
                prefix = cfgPrefix;
            } else if (basePath.startsWith(cfgPrefix)) {
                prefix = basePath;
            } else {
                prefix = `${basePath}${cfgPrefix}`;
            }
        } else {
            prefix = basePath || cfgPrefix || '';
        }
        const wsUrl = `${wsProto}://${hostPort}${prefix}/debug`;
        debug(`Debug WS URL computed: ${wsUrl} (host=${base.hostname}, port=${port}, basePath=${basePath || '/'}, cfgPrefix=${cfgPrefix || ''})`);
        return wsUrl;
    }

    // 通过资源树收集分组目录并填充缓存
    private collectGroupDirsFromNode(type: string, node: any, pathSegs: string[], dirs: string[]): void {
        const children: any[] = node?.children || [];
        for (const child of children) {
            const n = child.node || {};
            const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
            if (isGroup) {
                const seg = n.name;
                const newSegs = pathSegs.concat([seg]);
                const dirPath = `${type}/${newSegs.join('/')}`;
                dirs.push(dirPath);
                if (n.id) {
                    this.pathToIdCache.set(dirPath, n.id);
                    this.idToPathCache.set(n.id, dirPath);
                }
                this.collectGroupDirsFromNode(type, child, newSegs, dirs);
            }
        }
    }

    // 按路径段在资源树中查找分组节点
    private findGroupNodeByPath(root: any, segs: string[]): any | null {
        let current = root;
        for (const seg of segs) {
            const next = (current.children || []).find((c: any) => {
                const n = c.node || {};
                const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
                return isGroup && n.name === seg;
            });
            if (!next) return null;
            current = next;
        }
        return current;
    }

    // 按 ID 在资源树中查找分组节点
    private findGroupNodeById(root: any, id: string): any | null {
        if (!root) return null;
        const queue: any[] = [root];
        while (queue.length) {
            const cur = queue.shift();
            const n = cur.node || {};
            const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
            if (isGroup && n.id === id) return cur;
            const children: any[] = cur.children || [];
            for (const child of children) queue.push(child);
        }
        return null;
    }

    // 从资源树根构建指定分组的路径
    private buildPathFromNode(root: any, targetId: string): string {
        const path: string[] = [];
        // DFS 追溯路径
        const dfs = (node: any, segs: string[]): boolean => {
            const n = node.node || {};
            const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
            let localSegs = segs;
            if (isGroup && n.name && n.id !== '0') {
                localSegs = segs.concat([n.name]);
            }
            if (isGroup && n.id === targetId) {
                path.push(...localSegs);
                return true;
            }
            for (const child of (node.children || [])) {
                if (dfs(child, localSegs)) return true;
            }
            return false;
        };
        dfs(root, []);
        const type = (root?.node?.type) || '';
        return path.join('/');
    }

    // 推断资源类型（api/function 等）
    private inferTypeFromId(id?: string): MagicResourceType | undefined {
        if (!id) return undefined;
        const p = this.idToPathCache.get(id);
        if (!p) return undefined;
        const type = p.split('/')[0] as MagicResourceType;
        return type;
    }

    // ROT13 编码（与后端 MagicResourceController.saveFile 解密一致）
    private rot13(input: string): string {
        return input.replace(/[a-zA-Z]/g, (c) => {
            const base = c <= 'Z' ? 'A'.charCodeAt(0) : 'a'.charCodeAt(0);
            const code = c.charCodeAt(0) - base;
            return String.fromCharCode(((code + 13) % 26) + base);
        });
    }
}
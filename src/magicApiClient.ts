import * as vscode from 'vscode';
import axios from 'axios';
import { Buffer } from 'buffer';
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
    // 例如: "api/user" 或 "function/util"
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

// 原始分组导出结构（用于写入 .group.meta.json）
export interface MagicGroupMetaRaw {
    properties?: Record<string, any>;
    id?: string;
    name?: string;
    type?: MagicResourceType | string;
    parentId?: string;
    path?: string; // 分组 URL 路由片段（可能带前导 /）
    createTime?: number;
    updateTime?: number;
    createBy?: string;
    updateBy?: string;
    paths?: any[];
    options?: any[];
}

export class MagicApiClient {
    private exposeHeaders: string = 'magic-token';
    private httpClient: any;
    private pathToIdCache = new Map<string, string>();
    private idToPathCache = new Map<string, string>();
    private webPrefix: string;
    private sessionToken?: string;
    private loginInFlight?: Promise<string | null>;

    constructor(private config: MagicServerConfig) {
        const base = new URL(config.url);
        const basePath = base.pathname.replace(/\/$/, '');
        this.webPrefix = `${base.origin}${basePath}`;
        this.httpClient = axios.create({
            baseURL: this.webPrefix,
            timeout: 15000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        this.httpClient.interceptors.request.use((cfg: any) => {
            const tok = this.sessionToken || this.config.token;
            if (tok) {
                cfg.headers = cfg.headers || {};
                cfg.headers[this.exposeHeaders] = tok;
            }
            return cfg;
        });

        // 响应拦截器：同时在成功分支与错误分支处理鉴权失效（code=401 或消息提示）并自动登录重试
        this.httpClient.interceptors.response.use(
            async (response: any) => {
                try {
                    const body =  response?.data;
                    const code = typeof body?.code !== 'undefined' ? body.code : undefined;
                    const message = body?.message || '';
                    const path = response?.config?.url;
                    const isTokenInvalid = code === 401 || /token无效/i.test(String(message));
                    if (isTokenInvalid && response?.config && !response.config._retry) {
                        response.config._retry = true;
                        debug(`HTTP 200 但业务码为401/token无效: url=${path ?? 'n/a'}，尝试自动登录并重试`);
                        const token = await this.ensureLogin();
                        if (token) {
                            response.config.headers = response.config.headers || {};
                            response.config.headers[this.exposeHeaders] = token;
                            try {
                                return await this.httpClient.request(response.config);
                            } catch (retryErr: any) {
                                const rStatus = retryErr?.response?.status;
                                debug(`重试失败: status=${rStatus ?? 'n/a'} url=${path ?? 'n/a'} message=${retryErr?.message}`);
                                vscode.window.showErrorMessage(`请求重试失败: ${retryErr?.message}`);
                                return Promise.reject(retryErr);
                            }
                        }
                    }
                } catch (e) {
                    // 安全兜底：若解析失败则直接返回原响应
                }
                return response;
            },
            (error: any) => error
        )
    }

    getAuthHeaders(): Record<string, string> {
        const tok = this.sessionToken || this.config.token;
        return tok ? { [this.exposeHeaders]: tok } : {};
    }

    async ensureLogin(): Promise<string | null> {
        if (this.sessionToken) return this.sessionToken;
        if (this.loginInFlight) return this.loginInFlight;
        this.loginInFlight = this.login();
        const tok = await this.loginInFlight.catch(() => null);
        this.loginInFlight = undefined;
        return tok;
    }
    
    // 使用用户名密码自动登录并获取令牌（兼容多种返回结构与路径）
    private async login(): Promise<string | null> {
        const { username, password } = this.config;
        if (!username || !password) {
            debug('未配置用户名/密码，无法自动登录获取令牌');
            return null;
        }
        try {
            const axiosClient = axios.create({
                baseURL: this.httpClient.getUri(),
                timeout: 3000,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            const resp = await axiosClient.post(`${this.webPrefix}/login`, `username=${username}&password=${password}`);
            this.exposeHeaders = (resp.headers['access-control-expose-headers'] || '').toLowerCase();
            const token = resp.headers[this.exposeHeaders] 
            if (typeof token === 'string' && token.length > 0) {
                this.sessionToken = token;
                this.httpClient.defaults.headers.common[this.exposeHeaders] = token;
                debug(`登录成功，令牌已更新并附加到请求头: ${this.exposeHeaders}`);
                return token;
            }
        } catch (e: any) {
            debug(`登录失败 : ${String(e?.message || e)}`);
        }
        vscode.window.showErrorMessage('自动登录失败：未能获取令牌');
        return null;
    }

    async getGroups(type: MagicResourceType): Promise<MagicGroupInfo[]> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const root = tree[type];
        if (!root) return [];
        const groups: MagicGroupInfo[] = [];
        const queue: any[] = [root];
        while (queue.length) {
            const cur = queue.shift();
            const n = cur.node || {};
            const isGroup = n && typeof n.groupId === 'undefined';
            if (isGroup) {
                const id = String(n.id || '');
                const name = String(n.name || '');
                const path = this.buildPathFromNode(root, id);
                const info: MagicGroupInfo = {
                    id,
                    name,
                    path,
                    parentId: n.parentId ? String(n.parentId) : undefined,
                    type: (n.type || type) as MagicResourceType,
                };
                groups.push(info);
                if (id) {
                    this.pathToIdCache.set(`${type}/${path}`, id);
                    this.idToPathCache.set(id, `${type}/${path}`);
                }
            }
            const children: any[] = cur.children || [];
            for (const child of children) queue.push(child);
        }
        return groups;
    }

    async getGroup(groupId: string): Promise<MagicGroupInfo | null> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const typeKeys = Object.keys(tree);
        for (const type of typeKeys) {
            const root = tree[type];
            const node = this.findGroupNodeById(root, groupId);
            if (node) {
                const n = node.node || {};
                const id = String(n.id || '');
                const name = String(n.name || '');
                const path = this.buildPathFromNode(root, id);
                const info: MagicGroupInfo = {
                    id,
                    name,
                    path,
                    parentId: n.parentId ? String(n.parentId) : undefined,
                    type: (n.type || type) as MagicResourceType,
                };
                return info;
            }
        }
        return null;
    }

    async getFiles(type: MagicResourceType, groupId: string | null): Promise<MagicFileInfo[]> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const root = tree[type];
        if (!root) return [];
        let target: any = null;
        if (groupId) {
            target = this.findGroupNodeById(root, groupId);
        } else {
            target = root;
        }
        if (!target) return [];
        const files: MagicFileInfo[] = [];
        const children: any[] = target.children || [];
        for (const child of children) {
            const n = child.node || {};
            const isFile = n && typeof n.groupId !== 'undefined';
            if (isFile) {
                const groupPathName = this.buildPathFromNode(root, String(n.groupId || ''));
                const groupPath = groupPathName ? `${type}/${groupPathName}` : `${type}`;
                const info: MagicFileInfo = {
                    id: String(n.id || ''),
                    name: String(n.name || ''),
                    type: type as MagicResourceType,
                    groupId: String(n.groupId || ''),
                    groupPath,
                    path: String(n.path || ''),
                    requestMapping: String(n.requestMapping || ''),
                    method: String(n.method || ''),
                    description: String(n.description || ''),
                    script: String(n.script || ''),
                };
                files.push(info);
                if (info.id) {
                    const fileKey = `${groupPath}/${info.name}.ms`;
                    this.idToPathCache.set(info.id, fileKey);
                    this.pathToIdCache.set(fileKey, info.id);
                }
            }
        }
        return files;
    }

    async getFile(fileId: string): Promise<MagicFileInfo | null> {
        await this.ensureLogin();
        const resp = await this.httpClient.get(`/resource/file/${fileId}`, { headers: this.getAuthHeaders() });
        const data = resp?.data?.data || resp?.data;
        if (!data) return null;

        const id = String((data as any)?.id || fileId);
        const name = String((data as any)?.name || '');
        const script = String((data as any)?.script || '');
        const groupId = String((data as any)?.groupId || '');
        const type = (this.inferTypeFromId(id) || 'api') as MagicResourceType;

        // 计算 groupPath 与缓存 fileKey
        let fileKey = this.idToPathCache.get(id);
        let groupPath = '';
        if (fileKey) {
            const segs = fileKey.split('/').filter(Boolean);
            groupPath = segs.slice(0, -1).join('/');
        } else {
            try {
                const r = await this.httpClient.post('/resource');
                const tree = r?.data?.data || {};
                const root = tree[type];
                if (root && groupId) {
                    const gpName = this.buildPathFromNode(root, groupId);
                    groupPath = gpName ? `${type}/${gpName}` : `${type}`;
                } else if (root) {
                    const queue: any[] = [root];
                    while (queue.length) {
                        const cur = queue.shift();
                        const n = cur.node || {};
                        if (n && String(n.id || '') === id) {
                            const gpName = this.buildPathFromNode(root, String(n.groupId || ''));
                            groupPath = gpName ? `${type}/${gpName}` : `${type}`;
                            break;
                        }
                        const children: any[] = cur.children || [];
                        for (const child of children) queue.push(child);
                    }
                }
                if (!groupPath) groupPath = `${type}`;
            } catch {
                groupPath = `${type}`;
            }
            fileKey = `${groupPath}/${name}.ms`;
            if (id) this.idToPathCache.set(id, fileKey);
            if (fileKey) this.pathToIdCache.set(fileKey, id);
        }

        const info: MagicFileInfo = {
            id,
            name,
            type,
            groupId,
            groupPath,
            path: String((data as any)?.path || ''),
            requestMapping: String((data as any)?.requestMapping || ''),
            method: String((data as any)?.method || ''),
            description: String((data as any)?.description || ''),
            script,
            createTime: (data as any)?.createTime,
            updateTime: (data as any)?.updateTime,
            createBy: (data as any)?.createBy,
            updateBy: (data as any)?.updateBy,
            params: (data as any)?.params,
            headers: (data as any)?.headers,
            contentType: (data as any)?.contentType,
            timeout: (data as any)?.timeout,
            cron: (data as any)?.cron,
            enabled: (data as any)?.enabled,
            executeOnStart: (data as any)?.executeOnStart,
            extra: (data as any)?.properties,
        };
        return info;

    }

    async saveFile(file: MagicFileInfo): Promise<boolean> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/file/save', file, { headers: this.getAuthHeaders() });
        return !!(resp?.data?.success || resp?.data?.code === 200);
    }

    async createFile(request: CreateFileRequest): Promise<string | null> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/file/create', request, { headers: this.getAuthHeaders() });
        const id = resp?.data?.data || resp?.data?.id || null;
        return id;
    }

    async deleteFile(fileId: string): Promise<boolean> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/file/delete', { id: fileId }, { headers: this.getAuthHeaders() });
        return !!(resp?.data?.success || resp?.data?.code === 200);
    }

    async createGroup(request: CreateGroupRequest): Promise<string | null> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/group/create', request, { headers: this.getAuthHeaders() });
        const id = resp?.data?.data || resp?.data?.id || null;
        return id;
    }

    async saveGroup(group: MagicGroupInfo): Promise<boolean> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/group/save', group, { headers: this.getAuthHeaders() });
        return !!(resp?.data?.success || resp?.data?.code === 200);
    }

    async deleteGroup(groupId: string): Promise<boolean> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/group/delete', { id: groupId }, { headers: this.getAuthHeaders() });
        return !!(resp?.data?.success || resp?.data?.code === 200);
    }

    getFileIdByPath(path: string): string | undefined {
        return this.pathToIdCache.get(path);
    }

    getGroupIdByPath(path: string): string | undefined {
        return this.pathToIdCache.get(path);
    }

    getPathById(id: string): string | undefined {
        return this.idToPathCache.get(id);
    }

    // 兜底：通过遍历资源树按路径解析文件ID，并填充缓存
    async resolveFileIdByPath(fileKey: string): Promise<string | undefined> {
        try {
            await this.ensureLogin();
            // 规范化输入路径（去除前导斜杠）
            const key = String(fileKey || '').replace(/^\/+/, '');
            const segs = key.split('/').filter(Boolean);
            if (segs.length < 2) return undefined;
            const type = segs[0] as MagicResourceType;
            const fileNameWithExt = segs[segs.length - 1];
            const fileName = fileNameWithExt.replace(/\.ms$/i, '');
            const groupSegs = segs.slice(1, -1);

            const resp = await this.httpClient.post('/resource');
            const tree = resp?.data?.data || {};
            const root = tree[type];
            if (!root) return undefined;

            const queue: any[] = [root];
            while (queue.length) {
                const cur = queue.shift();
                const n = cur.node || {};
                const isFile = n && typeof n.groupId !== 'undefined';
                if (isFile) {
                    const gp = this.buildPathFromNode(root, String(n.groupId || ''));
                    const full = `${type}/${gp}/${String(n.name || '')}.ms`;
                    if (full === key) {
                        const id = String(n.id || '');
                        if (id) {
                            this.idToPathCache.set(id, full);
                            this.pathToIdCache.set(full, id);
                            return id;
                        }
                    }
                }
                const children: any[] = cur.children || [];
                for (const child of children) queue.push(child);
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    private buildGroupPath(group: MagicGroupInfo, allGroups: MagicGroupInfo[]): string {
        const path: string[] = [group.name];
        let parentId = group.parentId;
        while (parentId) {
            const p = allGroups.find(g => g.id === parentId);
            if (!p) break;
            path.unshift(p.name);
            parentId = p.parentId;
        }
        return path.join('/');
    }

    async getResourceDirs(): Promise<string[]> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const dirs: string[] = [];
        for (const type of Object.keys(tree)) {
            const root = tree[type];
            this.collectGroupDirsFromNode(type, root, [], dirs);
        }
        return dirs;
    }

    async getResourceFiles(dir: string): Promise<MagicFileInfo[]> {
        await this.ensureLogin();
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const segs = dir.split('/').filter(Boolean);
        const type = segs[0];
        const root = tree[type];
        if (!root) return [];
        const groupNode = this.findGroupNodeByPath(root, segs.slice(1));
        const target = groupNode || root;
        const files: MagicFileInfo[] = [];
        const children: any[] = target.children || [];
        for (const child of children) {
            const n = child.node || {};
            const isFile = n && typeof n.groupId !== 'undefined';
            if (isFile) {
                const groupPathName = this.buildPathFromNode(root, String(n.groupId || ''));
                const groupPath = groupPathName ? `${type}/${groupPathName}` : `${type}`;
                const info: MagicFileInfo = {
                    id: String(n.id || ''),
                    name: String(n.name || ''),
                    type: type as MagicResourceType,
                    groupId: String(n.groupId || ''),
                    groupPath,
                    path: String(n.path || ''),
                    requestMapping: String(n.requestMapping || ''),
                    method: String(n.method || ''),
                    description: String(n.description || ''),
                    script: String(n.script || ''),
                };
                files.push(info);
                if (info.id) {
                    const fileKey = `${groupPath}/${info.name}.ms`;
                    this.idToPathCache.set(info.id, fileKey);
                    this.pathToIdCache.set(fileKey, info.id);
                }
            }
        }
        return files;
    }

    // 新增：根据目录获取分组原始元数据（用于写入 .group.meta.json）
    async getGroupMetaByDir(dir: string): Promise<MagicGroupMetaRaw | null> {
        try {
            await this.ensureLogin();
            const resp = await this.httpClient.post('/resource');
            const tree = resp?.data?.data || {};
            const segs = dir.split('/').filter(Boolean);
            const type = segs[0];
            const root = tree[type];
            if (!root) return null;
            if (segs.length <= 1) return null; // 顶层类型目录没有分组节点
            const groupNode = this.findGroupNodeByPath(root, segs.slice(1));
            if (!groupNode) return null;
            const n = groupNode.node || {};
            const raw: MagicGroupMetaRaw = {
                properties: n.properties || {},
                id: String(n.id || ''),
                name: String(n.name || ''),
                type: (n.type || type) as MagicResourceType,
                parentId: n.parentId ? String(n.parentId) : undefined,
                path: String(n.path || ''),
                createTime: n.createTime,
                updateTime: n.updateTime,
                createBy: n.createBy,
                updateBy: n.updateBy,
                paths: n.paths || [],
                options: n.options || []
            };
            return raw;
        } catch {
            return null;
        }
    }

    getLspServerUrl(): string {
        const base = new URL(this.config.url);
        const wsProto = base.protocol === 'https:' ? 'wss' : 'ws';
        const cfgPort = this.config.lspPort;
        const basePath = base.pathname.replace(/\/$/, '');
        const cfgPrefix = basePath;
        let hostPort = base.host;
        if (cfgPort) {
            const port = String(cfgPort);
            hostPort = `${base.hostname}:${port}`;
        }
        const wsUrl = `${wsProto}://${hostPort}${cfgPrefix}/lsp`;
        debug(`LSP WS URL computed: ${wsUrl} (host=${base.hostname}, port=${cfgPort || base.port}, basePath=${basePath || '/'}, cfgPrefix=${cfgPrefix || ''})`);
        return wsUrl;
    }

    getDebugServerUrl(): string {
        const base = new URL(this.config.url);
        const wsProto = base.protocol === 'https:' ? 'wss' : 'ws';
        const port = this.config.debugPort || (base.port ? Number(base.port) : (base.protocol === 'https:' ? 443 : 80));
        const basePath = base.pathname.replace(/\/$/, '');
        const cfgPrefix = basePath;
        const hostPort = this.config.debugPort ? `${base.hostname}:${port}` : base.host;
        const wsUrl = `${wsProto}://${hostPort}${cfgPrefix}/debug`;
        debug(`Debug WS URL computed: ${wsUrl} (host=${base.hostname}, port=${port}, basePath=${basePath || '/'}, cfgPrefix=${cfgPrefix || ''})`);
        return wsUrl;
    }

    // 通过资源树收集分组目录并填充缓存
    private collectGroupDirsFromNode(type: string, node: any, pathSegs: string[], dirs: string[]): void {
        const children: any[] = node?.children || [];
        for (const child of children) {
            const n = child.node || {};
            const isGroup = n && typeof n.groupId === 'undefined';
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
                const isGroup = n && typeof n.groupId === 'undefined';
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
            const isGroup = n && typeof n.groupId === 'undefined';
            if (isGroup && n.id === id) return cur;
            const children: any[] = cur.children || [];
            for (const child of children) queue.push(child);
        }
        return null;
    }

    // 从资源树根构建指定分组的路径
    private buildPathFromNode(root: any, targetId: string): string {
        const path: string[] = [];
        const stack: any[] = [root];
        const parentMap = new Map<any, any>();
        while (stack.length) {
            const cur = stack.pop();
            const children: any[] = cur.children || [];
            for (const child of children) {
                parentMap.set(child, cur);
                stack.push(child);
            }
        }
        // DFS 找到目标节点
        const findNode = (node: any): any | null => {
            const n = node.node || {};
            if (String(n.id || '') === String(targetId || '')) return node;
            for (const child of (node.children || [])) {
                const r = findNode(child);
                if (r) return r;
            }
            return null;
        };
        const target = findNode(root);
        if (!target) return '';
        // 回溯构建路径名
        let cur: any | undefined = target;
        const nameSegs: string[] = [];
        while (cur && cur !== root) {
            const n = cur.node || {};
            const isGroup = n && typeof n.groupId === 'undefined';
            if (isGroup) nameSegs.unshift(String(n.name || ''));
            cur = parentMap.get(cur);
        }
        return nameSegs.join('/');
    }

    private inferTypeFromId(id?: string): MagicResourceType | undefined {
        if (!id) return undefined;
        if (id.startsWith('api_')) return 'api';
        if (id.startsWith('task_')) return 'task';
        if (id.startsWith('function_')) return 'function';
        return undefined;
    }

    private rot13(input: string): string {
        return input.replace(/[a-zA-Z]/g, (char) => {
            const code = char.charCodeAt(0);
            const base = code >= 97 ? 97 : 65;
            return String.fromCharCode(((code - base + 13) % 26) + base);
        });
    }

    private encrypt(input: string): string {
        const rot = this.rot13(input);
        return Buffer.from(rot, 'utf8').toString('base64');
    }

    async getWorkbenchCompletionData(): Promise<any | null> {
        try {
            await this.ensureLogin();
            const resp = await this.httpClient.post('/workbench');
            const data = resp?.data?.data || null;
            return data;
        } catch {
            return null;
        }
    }

    async searchWorkbench(keyword: string): Promise<Array<{ id: string; text: string; line: number }>> {
        try {
            await this.ensureLogin();
            const resp = await this.httpClient.post('/workbench/search', { keyword });
            const data = resp?.data?.data || [];
            return data;
        } catch {
            return [];
        }
    }
}
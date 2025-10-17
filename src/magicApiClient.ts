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
        this.httpClient.interceptors.response.use((resp: any) => resp, (err: any) => {
            if (err?.response?.status === 401) {
                this.sessionToken = undefined;
            }
            throw err;
        });
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

    private async login(): Promise<string | null> {
        try {
            const { username, password } = this.config;
            if (!username || !password) return null;
            const resp = await this.httpClient.post('/login', { username, password });
            const tok = resp?.data?.data?.token || resp?.data?.token || resp?.headers?.[this.exposeHeaders];
            if (tok) this.sessionToken = tok;
            return tok || null;
        } catch (e) {
            logError(`Login failed: ${String(e)}`);
            return null;
        }
    }

    async getGroups(type: MagicResourceType): Promise<MagicGroupInfo[]> {
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const root = tree[type];
        if (!root) return [];
        const groups: MagicGroupInfo[] = [];
        const queue: any[] = [root];
        while (queue.length) {
            const cur = queue.shift();
            const n = cur.node || {};
            const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
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
            const isFile = n && typeof n.script === 'string';
            if (isFile) {
                const info: MagicFileInfo = {
                    id: String(n.id || ''),
                    name: String(n.name || ''),
                    type: type,
                    groupId: String(n.groupId || ''),
                    groupPath: `${type}/${this.buildPathFromNode(root, String(n.groupId || ''))}`,
                    path: String(n.path || ''),
                    requestMapping: String(n.requestMapping || ''),
                    method: String(n.method || ''),
                    description: String(n.description || ''),
                    script: String(n.script || ''),
                };
                files.push(info);
                if (info.id) this.idToPathCache.set(info.id, `${info.groupPath}/${info.name}.ms`);
            }
        }
        return files;
    }

    async getFile(fileId: string): Promise<MagicFileInfo | null> {
        const resp = await this.httpClient.post('/resource');
        const tree = resp?.data?.data || {};
        const typeKeys = Object.keys(tree);
        for (const type of typeKeys) {
            const root = tree[type];
            const queue: any[] = [root];
            while (queue.length) {
                const cur = queue.shift();
                const n = cur.node || {};
                if (n && String(n.id || '') === String(fileId || '')) {
                    const info: MagicFileInfo = {
                        id: String(n.id || ''),
                        name: String(n.name || ''),
                        type: (n.type || type) as MagicResourceType,
                        groupId: String(n.groupId || ''),
                        groupPath: `${type}/${this.buildPathFromNode(root, String(n.groupId || ''))}`,
                        path: String(n.path || ''),
                        requestMapping: String(n.requestMapping || ''),
                        method: String(n.method || ''),
                        description: String(n.description || ''),
                        script: String(n.script || ''),
                    };
                    return info;
                }
                const children: any[] = cur.children || [];
                for (const child of children) queue.push(child);
            }
        }
        return null;
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
            const isFile = n && typeof n.script === 'string';
            if (isFile) {
                const info: MagicFileInfo = {
                    id: String(n.id || ''),
                    name: String(n.name || ''),
                    type: type as MagicResourceType,
                    groupId: String(n.groupId || ''),
                    groupPath: `${type}/${this.buildPathFromNode(root, String(n.groupId || ''))}`,
                    path: String(n.path || ''),
                    requestMapping: String(n.requestMapping || ''),
                    method: String(n.method || ''),
                    description: String(n.description || ''),
                    script: String(n.script || ''),
                };
                files.push(info);
                if (info.id) this.idToPathCache.set(info.id, `${info.groupPath}/${info.name}.ms`);
            }
        }
        return files;
    }

    // 新增：根据目录获取分组原始元数据（用于写入 .group.meta.json）
    async getGroupMetaByDir(dir: string): Promise<MagicGroupMetaRaw | null> {
        try {
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
            const isGroup = n && (typeof n.parentId !== 'undefined' || typeof n.type !== 'undefined');
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
            const resp = await this.httpClient.post('/workbench');
            const data = resp?.data?.data || null;
            return data;
        } catch {
            return null;
        }
    }

    async searchWorkbench(keyword: string): Promise<Array<{ id: string; text: string; line: number }>> {
        try {
            const resp = await this.httpClient.post('/workbench/search', { keyword });
            const data = resp?.data?.data || [];
            return data;
        } catch {
            return [];
        }
    }
}
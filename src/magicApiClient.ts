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
            const urlPath = `${this.webPrefix}/group/list`;
            debug(`GetGroups: baseURL=${this.config.url} path=${urlPath} type=${type}`);
            const response = await this.httpClient.get(urlPath, {
                params: { type }
            });
            
            const groups: MagicGroupInfo[] = response.data.data || [];
            
            // 更新路径缓存
            for (const group of groups) {
                const path = this.buildGroupPath(group, groups);
                this.pathToIdCache.set(`${type}/${path}`, group.id);
                this.idToPathCache.set(group.id, `${type}/${path}`);
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
            const urlPath = `${this.webPrefix}/group/get/${groupId}`;
            debug(`GetGroup: baseURL=${this.config.url} path=${urlPath}`);
            const response = await this.httpClient.get(urlPath);
            return response.data.data || null;
        } catch (error) {
            logError(`获取分组信息失败: ${String(error)}`);
            return null;
        }
    }

    // 获取文件列表
    async getFiles(type: MagicResourceType, groupId: string | null): Promise<MagicFileInfo[]> {
        try {
            const urlPath = `${this.webPrefix}/${type}/list`;
            debug(`GetFiles: baseURL=${this.config.url} path=${urlPath} groupId=${groupId ?? ''}`);
            const response = await this.httpClient.get(urlPath, {
                params: { groupId: groupId || '' }
            });
            
            const files: MagicFileInfo[] = response.data.data || [];
            
            // 更新路径缓存
            for (const file of files) {
                const groupPath = this.idToPathCache.get(file.groupId) || '';
                const filePath = groupPath ? `${groupPath}/${file.name}.ms` : `${type}/${file.name}.ms`;
                this.pathToIdCache.set(filePath, file.id);
                this.idToPathCache.set(file.id, filePath);
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
            const urlPath = `${this.webPrefix}/resource/get/${fileId}`;
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
            const response = await this.httpClient.post(`${this.webPrefix}/resource/save`, file);
            return response.data.code === 1;
        } catch (error) {
            console.error('保存文件失败:', error);
            return false;
        }
    }

    // 创建文件
    async createFile(request: CreateFileRequest): Promise<string | null> {
        try {
            const response = await this.httpClient.post(`${this.webPrefix}/resource/save`, request as any);
            if (response.data.code === 1) {
                const created = response.data.data || {};
                // 更新缓存：需要存在目录信息
                if (created?.id && request.groupPath) {
                    const filePath = `${request.groupPath}/${request.name}.ms`;
                    this.pathToIdCache.set(filePath, created.id);
                    this.idToPathCache.set(created.id, filePath);
                }
                return created.id || null;
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
            const response = await this.httpClient.delete(`${this.webPrefix}/file/delete/${fileId}`);
            return response.data.code === 1;
        } catch (error) {
            console.error('删除文件失败:', error);
            return false;
        }
    }

    // 创建分组
    async createGroup(request: CreateGroupRequest): Promise<string | null> {
        try {
            const response = await this.httpClient.post(`${this.webPrefix}/group/save`, request);
            if (response.data.code === 1) {
                return response.data.data.id || null;
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
            const response = await this.httpClient.post(`${this.webPrefix}/group/save`, group);
            return response.data.code === 1;
        } catch (error) {
            console.error('保存分组失败:', error);
            return false;
        }
    }

    // 删除分组
    async deleteGroup(groupId: string): Promise<boolean> {
        try {
            const response = await this.httpClient.delete(`${this.webPrefix}/group/delete/${groupId}`);
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

    // 统一资源接口：获取所有目录（/magic-api/ 后相对路径）
    async getResourceDirs(): Promise<string[]> {
        try {
            const urlPath = `${this.webPrefix}/resource/dirs`;
            debug(`GetResourceDirs: baseURL=${this.config.url} path=${urlPath}`);
            const response = await this.httpClient.get(urlPath);
            const dirs: string[] = response.data.data || [];
            return dirs;
        } catch (error) {
            logError(`获取资源目录失败: ${String(error)}`);
            return [];
        }
    }

    // 统一资源接口：按目录获取文件
    async getResourceFiles(dir: string): Promise<MagicFileInfo[]> {
        try {
            const urlPath = `${this.webPrefix}/resource/files`;
            debug(`GetResourceFiles: baseURL=${this.config.url} path=${urlPath} dir=${dir}`);
            const response = await this.httpClient.get(urlPath, { params: { dir } });
            const files: MagicFileInfo[] = response.data.data || [];
            // 更新路径缓存（统一路径为 dir/<name>.ms）
            for (const file of files) {
                const filePath = `${dir}/${file.name}.ms`;
                this.pathToIdCache.set(filePath, file.id);
                this.idToPathCache.set(file.id, filePath);
            }
            return files;
        } catch (error) {
            logError(`获取资源文件失败: ${String(error)}`);
            return [];
        }
    }

    // 获取 LSP 服务器地址
    getLspServerUrl(): string {
        const port = this.config.lspPort || 8081;
        const url = new URL(this.config.url);
        const wsUrl = `ws://${url.hostname}:${port}/magic/lsp`;
        debug(`LSP URL computed: ${wsUrl}`);
        return wsUrl;
    }

    // 获取调试服务器地址
    getDebugServerUrl(): string {
        const port = this.config.debugPort || 8082;
        const url = new URL(this.config.url);
        const dbg = `${url.hostname}:${port}`;
        debug(`Debug URL computed: ${dbg}`);
        return dbg;
    }
}
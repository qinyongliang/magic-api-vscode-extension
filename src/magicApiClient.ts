import * as vscode from 'vscode';
import axios from 'axios';
import { MagicFileInfo, MagicGroupInfo } from './magicFileSystemProvider';

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
    groupId: string | null;
    type: 'api' | 'function' | 'datasource';
    method?: string;
    requestMapping?: string;
    description?: string;
}

export interface CreateGroupRequest {
    name: string;
    parentId: string | null;
    type: 'api' | 'function' | 'datasource';
    description?: string;
}

export class MagicApiClient {
    private httpClient: any;
    private pathToIdCache = new Map<string, string>();
    private idToPathCache = new Map<string, string>();

    constructor(private config: MagicServerConfig) {
        this.httpClient = axios.create({
            baseURL: config.url,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });

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
                vscode.window.showErrorMessage(`Magic API 请求失败: ${error.message}`);
                return Promise.reject(error);
            }
        );
    }

    // 测试连接
    async testConnection(): Promise<boolean> {
        try {
            const response = await this.httpClient.get('/magic/web/health');
            return response.status === 200;
        } catch (error) {
            return false;
        }
    }

    // 获取所有分组
    async getGroups(type: 'api' | 'function' | 'datasource'): Promise<MagicGroupInfo[]> {
        try {
            const response = await this.httpClient.get(`/magic/web/group/list`, {
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
            console.error('获取分组失败:', error);
            return [];
        }
    }

    // 获取分组信息
    async getGroup(groupId: string): Promise<MagicGroupInfo | null> {
        try {
            const response = await this.httpClient.get(`/magic/web/group/get/${groupId}`);
            return response.data.data || null;
        } catch (error) {
            console.error('获取分组信息失败:', error);
            return null;
        }
    }

    // 获取文件列表
    async getFiles(type: 'api' | 'function' | 'datasource', groupId: string | null): Promise<MagicFileInfo[]> {
        try {
            const response = await this.httpClient.get(`/magic/web/${type}/list`, {
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
            console.error('获取文件列表失败:', error);
            return [];
        }
    }

    // 获取文件信息
    async getFile(fileId: string): Promise<MagicFileInfo | null> {
        try {
            const response = await this.httpClient.get(`/magic/web/file/get/${fileId}`);
            return response.data.data || null;
        } catch (error) {
            console.error('获取文件信息失败:', error);
            return null;
        }
    }

    // 保存文件
    async saveFile(file: MagicFileInfo): Promise<boolean> {
        try {
            const response = await this.httpClient.post(`/magic/web/${file.type}/save`, file);
            return response.data.code === 1;
        } catch (error) {
            console.error('保存文件失败:', error);
            return false;
        }
    }

    // 创建文件
    async createFile(request: CreateFileRequest): Promise<string | null> {
        try {
            const response = await this.httpClient.post(`/magic/web/${request.type}/save`, request);
            if (response.data.code === 1) {
                return response.data.data.id || null;
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
            const response = await this.httpClient.delete(`/magic/web/file/delete/${fileId}`);
            return response.data.code === 1;
        } catch (error) {
            console.error('删除文件失败:', error);
            return false;
        }
    }

    // 创建分组
    async createGroup(request: CreateGroupRequest): Promise<string | null> {
        try {
            const response = await this.httpClient.post(`/magic/web/group/save`, request);
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
            const response = await this.httpClient.post(`/magic/web/group/save`, group);
            return response.data.code === 1;
        } catch (error) {
            console.error('保存分组失败:', error);
            return false;
        }
    }

    // 删除分组
    async deleteGroup(groupId: string): Promise<boolean> {
        try {
            const response = await this.httpClient.delete(`/magic/web/group/delete/${groupId}`);
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

    // 获取 LSP 服务器地址
    getLspServerUrl(): string {
        const port = this.config.lspPort || 8080;
        const url = new URL(this.config.url);
        return `ws://${url.hostname}:${port}/magic/lsp`;
    }

    // 获取调试服务器地址
    getDebugServerUrl(): string {
        const port = this.config.debugPort || 8081;
        const url = new URL(this.config.url);
        return `${url.hostname}:${port}`;
    }
}
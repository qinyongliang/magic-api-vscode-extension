"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MagicApiClient = void 0;
const vscode = __importStar(require("vscode"));
const axios_1 = __importDefault(require("axios"));
class MagicApiClient {
    constructor(config) {
        this.config = config;
        this.pathToIdCache = new Map();
        this.idToPathCache = new Map();
        this.httpClient = axios_1.default.create({
            baseURL: config.url,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        // 设置认证
        if (config.token) {
            this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${config.token}`;
        }
        else if (config.username && config.password) {
            this.httpClient.defaults.auth = {
                username: config.username,
                password: config.password
            };
        }
        // 响应拦截器处理错误
        this.httpClient.interceptors.response.use((response) => response, (error) => {
            vscode.window.showErrorMessage(`Magic API 请求失败: ${error.message}`);
            return Promise.reject(error);
        });
    }
    // 测试连接
    async testConnection() {
        try {
            const response = await this.httpClient.get('/magic/web/health');
            return response.status === 200;
        }
        catch (error) {
            return false;
        }
    }
    // 获取所有分组
    async getGroups(type) {
        try {
            const response = await this.httpClient.get(`/magic/web/group/list`, {
                params: { type }
            });
            const groups = response.data.data || [];
            // 更新路径缓存
            for (const group of groups) {
                const path = this.buildGroupPath(group, groups);
                this.pathToIdCache.set(`${type}/${path}`, group.id);
                this.idToPathCache.set(group.id, `${type}/${path}`);
            }
            return groups;
        }
        catch (error) {
            console.error('获取分组失败:', error);
            return [];
        }
    }
    // 获取分组信息
    async getGroup(groupId) {
        try {
            const response = await this.httpClient.get(`/magic/web/group/get/${groupId}`);
            return response.data.data || null;
        }
        catch (error) {
            console.error('获取分组信息失败:', error);
            return null;
        }
    }
    // 获取文件列表
    async getFiles(type, groupId) {
        try {
            const response = await this.httpClient.get(`/magic/web/${type}/list`, {
                params: { groupId: groupId || '' }
            });
            const files = response.data.data || [];
            // 更新路径缓存
            for (const file of files) {
                const groupPath = this.idToPathCache.get(file.groupId) || '';
                const filePath = groupPath ? `${groupPath}/${file.name}.ms` : `${type}/${file.name}.ms`;
                this.pathToIdCache.set(filePath, file.id);
                this.idToPathCache.set(file.id, filePath);
            }
            return files;
        }
        catch (error) {
            console.error('获取文件列表失败:', error);
            return [];
        }
    }
    // 获取文件信息
    async getFile(fileId) {
        try {
            const response = await this.httpClient.get(`/magic/web/file/get/${fileId}`);
            return response.data.data || null;
        }
        catch (error) {
            console.error('获取文件信息失败:', error);
            return null;
        }
    }
    // 保存文件
    async saveFile(file) {
        try {
            const response = await this.httpClient.post(`/magic/web/${file.type}/save`, file);
            return response.data.code === 1;
        }
        catch (error) {
            console.error('保存文件失败:', error);
            return false;
        }
    }
    // 创建文件
    async createFile(request) {
        try {
            const response = await this.httpClient.post(`/magic/web/${request.type}/save`, request);
            if (response.data.code === 1) {
                return response.data.data.id || null;
            }
            return null;
        }
        catch (error) {
            console.error('创建文件失败:', error);
            return null;
        }
    }
    // 删除文件
    async deleteFile(fileId) {
        try {
            const response = await this.httpClient.delete(`/magic/web/file/delete/${fileId}`);
            return response.data.code === 1;
        }
        catch (error) {
            console.error('删除文件失败:', error);
            return false;
        }
    }
    // 创建分组
    async createGroup(request) {
        try {
            const response = await this.httpClient.post(`/magic/web/group/save`, request);
            if (response.data.code === 1) {
                return response.data.data.id || null;
            }
            return null;
        }
        catch (error) {
            console.error('创建分组失败:', error);
            return null;
        }
    }
    // 保存分组
    async saveGroup(group) {
        try {
            const response = await this.httpClient.post(`/magic/web/group/save`, group);
            return response.data.code === 1;
        }
        catch (error) {
            console.error('保存分组失败:', error);
            return false;
        }
    }
    // 删除分组
    async deleteGroup(groupId) {
        try {
            const response = await this.httpClient.delete(`/magic/web/group/delete/${groupId}`);
            return response.data.code === 1;
        }
        catch (error) {
            console.error('删除分组失败:', error);
            return false;
        }
    }
    // 根据路径获取文件ID
    getFileIdByPath(path) {
        return this.pathToIdCache.get(path);
    }
    // 根据路径获取分组ID
    getGroupIdByPath(path) {
        return this.pathToIdCache.get(path);
    }
    // 根据ID获取路径
    getPathById(id) {
        return this.idToPathCache.get(id);
    }
    // 构建分组路径
    buildGroupPath(group, allGroups) {
        const path = [];
        let current = group;
        while (current) {
            path.unshift(current.name);
            if (!current.parentId) {
                break;
            }
            current = allGroups.find(g => g.id === current.parentId);
        }
        return path.join('/');
    }
    // 获取 LSP 服务器地址
    getLspServerUrl() {
        const port = this.config.lspPort || 8080;
        const url = new URL(this.config.url);
        return `ws://${url.hostname}:${port}/magic/lsp`;
    }
    // 获取调试服务器地址
    getDebugServerUrl() {
        const port = this.config.debugPort || 8081;
        const url = new URL(this.config.url);
        return `${url.hostname}:${port}`;
    }
}
exports.MagicApiClient = MagicApiClient;
//# sourceMappingURL=magicApiClient.js.map
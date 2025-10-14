# Magic API VS Code 扩展：LSP 客户端与服务器实现分析与提示档

## 概述
- 本扩展通过远程 LSP 服务器为 `magic-script` 提供语义功能，并通过自定义虚拟文件系统访问、编辑 Magic API 远程资源。
- 客户端核心组件：`RemoteLspClient`（LSP 连接）、`ServerManager`（服务器配置与状态）、`MagicApiClient`（HTTP 接口）、`MagicFileSystemProvider`（远程 FS 映射）、`extension.ts`（初始化与命令注册）。
- 服务器端期望：开放 LSP 端口（默认 `8081`），支持标准 LSP JSON-RPC（`Content-Length` 帧），并提供语义标记等能力；提供健康检查接口用于连通性验证。

## 客户端实现

### 入口与初始化（`src/extension.ts`）
- 激活时初始化 `ServerManager`、`StatusBarManager`、`RemoteLspClient`，注册虚拟文件系统 `scheme: magic-api`。
- 根据当前选定服务器自动启动 LSP：`if (serverManager.getCurrentServer()) remoteLspClient.start();`。
- 暴露命令：选择/添加服务器、刷新文件信息、重启 LSP、连接工作区、创建文件/分组、测试 API。

### LSP 客户端（`src/remoteLspClient.ts`）
- 监听服务器切换：`serverManager.onServerChanged(this.onServerChanged)`，变更时 `stop` → `start` 重连。
- 连接方式：解析 `ServerManager.getLspUrl(serverId)` 的主机与端口后，使用 `net.createConnection({ host, port })` 建立 TCP 连接，并将 `socket` 作为 `reader/writer` 传入 `LanguageClient`。
- `LanguageClientOptions`：
  - `documentSelector`: 文件系统 `file` 与虚拟文件系统 `magic-api` 的 `magic-script`。
  - `synchronize.fileEvents`: 监听 `**/*.ms`。
- 方法封装：`start/stop/restart/isRunning/getClient`；提供 `sendRequest/sendNotification` 用于自定义 LSP 交互。

### 服务器管理（`src/serverManager.ts`）
- 管理 `magicApi.servers` 配置（ID/名称/URL/认证/LSP/Debug 端口），维护 `MagicApiClient` 映射与当前选择。
- 提供 `getLspUrl(serverId)`、`getDebugUrl(serverId)` 给客户端与调试器使用。
- UI：快速选择器、添加/编辑/删除服务器对话框，保存到 VS Code 全局配置。

### HTTP 客户端与 URL 计算（`src/magicApiClient.ts`）
- 读取 `magicApi.webPrefix`（默认 `/magic/web`）；连通性测试优先访问 `/<prefix>/health`，Fallback 访问根路径（允许 2xx/3xx）。
- 计算 LSP 地址：
  - `getLspServerUrl()`: 依据 `config.url` 与 `lspPort`（默认 `8081`）返回 `ws://{host}:{port}/magic/lsp`（用于日志/可视化）。
  - 注意：`RemoteLspClient` 实际仅使用 `host/port` 建立原生 TCP 连接（非 WebSocket 握手），服务器需支持纯 TCP LSP。
- 计算调试地址：`getDebugServerUrl()`: `{host}:{debugPort}`（默认 `8082`）。
- 暴露文件/分组的 CRUD（用于虚拟 FS），并维护路径与 ID 的缓存映射（`getFileIdByPath` 等）。

### 虚拟文件系统（`src/magicFileSystemProvider.ts`）
- 将远程资源映射为 VS Code 目录结构：根包含 `api/function/datasource` 三类；文件扩展名统一为 `.ms`。
- `readDirectory/stat/readFile/writeFile/createDirectory/delete/rename` 通过 `MagicApiClient` 对应 REST 接口实现。
- 与状态栏联动，展示当前文件类型、API 方法/路径、分组、时间、作者等信息。

### 配置（`package.json`）
- 语言定义：`id: magic-script`，扩展名 `*.ms`/`*.magic`。
- 用户设置：
  - `magicApi.webPrefix`（默认 `/magic/web`）。
  - `magicApi.servers[]`（包含 `id/name/url/username/password/token/lspPort/debugPort`）。
  - `magicApi.currentServer` 与 `magicApi.autoConnect` 控制启动行为。
- 调试器：`type: magic-api`，支持当前服务器或自定义主机端口。

## 服务器端期望与约定

### LSP 服务
- 协议：标准 LSP JSON-RPC over TCP，消息采用 `Content-Length: <n>\r\n\r\n<json>` 格式。
- 端口：默认 `8081`，可通过扩展设置 `lspPort` 配置。
- 能力：至少提供 `semanticTokensProvider`（legend/tokenTypes/tokenModifiers、`range`/`full`）。
- 语言：`textDocument.languageId` 为 `magic-script`；文件扩展名 `.ms`/`.magic`。

### 健康检查与管理接口
- 健康检查路径优先：`{webPrefix}/health`，兼容 `/magic/health` 与 `/magic-api/health`。
- 服务器配置样例（Spring Boot `application.yml`）：
```yaml
magic-api:
  lsp:
    enable: true
    port: 8081
  debug:
    enable: true
    port: 8082
```

## 交互流程（典型）
- 选择服务器 → `ServerManager.setCurrentServer` → 触发 `onServerChanged` → `RemoteLspClient.restart()`。
- 打开/编辑 `*.ms` 文件 → 虚拟 FS 读取/写入远程脚本 → LSP 客户端向服务器请求语义标记等语言功能。
- 状态栏实时显示当前文件的元信息；命令面板支持创建资源与测试 API。

## 常见问题与排查
- 连接失败：确认服务器运行、端口开放、防火墙允许、`url/lspPort` 正确。
- 高亮无效：确认文件语言 ID 为 `magic-script`、服务器已实现 `semanticTokens`、`.ms` 扩展名匹配。
- WebSocket 与 TCP：`getLspServerUrl()` 打印 `ws://.../magic/lsp`，但当前客户端以原生 TCP 连接（无需 WS 握手），服务器需支持 TCP LSP；如仅支持 WebSocket，需要改造 `RemoteLspClient` 为 WebSocket 传输层。
- 接口前缀问题：`magicApi.webPrefix` 可配置，确保健康检查与 REST 接口路径一致。

## AI 提示档（可复用的任务提示模版）

### 快速了解架构
- “请基于以下文件解释 Magic API VS Code 扩展的 LSP 架构与数据流：`src/extension.ts`、`src/remoteLspClient.ts`、`src/serverManager.ts`、`src/magicApiClient.ts`、`src/magicFileSystemProvider.ts`，重点说明 LSP 连接、虚拟文件系统、配置项与语义标记能力。”

### 添加代码补全
- “在 `RemoteLspClient` 基础上，为 `magic-script` 增加 `textDocument/completion` 支持。描述客户端如何发送补全请求、如何在服务端实现对应的 LSP handler，并给出最小可行的客户端代码片段。”

### 诊断 LSP 连接问题
- “排查为什么 LSP 无法连接：检查 `ServerManager.getLspUrl()` 与 `RemoteLspClient` 的主机/端口解析、健康检查接口、端口防火墙、`Content-Length` 编解码。必要时将连接层改造为 WebSocket 并说明改造点。”

### 语义标记能力验证
- “使用 `lsp-test-client.js` 连接到 `localhost:8081`，发送 `initialize/initialized/textDocument/didOpen/textDocument/semanticTokens/full`，打印 `legend/tokenTypes/tokenModifiers` 与返回的 `data` 前若干项以验证颜色方案。”

### 扩展虚拟文件系统
- “在 `MagicFileSystemProvider` 中新增对某资源类型的支持（如 `task`），实现目录结构与 `read/write/delete/rename` 映射，并更新状态栏展示。说明与 `MagicApiClient` 的接口约定。”

### 增强稳定性（心跳与重连）
- “在 `RemoteLspClient` 增加心跳与自动重连：定期发送轻量请求（如 `$/ping` 自定义通知），超时则触发 `restart()`，并在状态栏显示连接质量。”

## 参考文件索引
- `src/extension.ts`：扩展初始化、命令注册、自动启动 LSP。
- `src/remoteLspClient.ts`：LSP 客户端连接/生命周期/请求封装。
- `src/serverManager.ts`：服务器配置管理、当前服务器状态、地址计算。
- `src/magicApiClient.ts`：HTTP 接口与 LSP/调试地址计算、连通性测试。
- `src/magicFileSystemProvider.ts`：远程资源的 FS 映射与编辑操作。
- `lsp-test-client.js` 与 `LSP_TEST_README.md`：独立 LSP 行为验证工具与指南。

## 总结
- 客户端通过 `LanguageClient` + 原生 TCP 连接远程 LSP；`magic-script` 的语言功能由服务器统一提供，扩展不内置语法文件。
- 通过本提示档可快速定位实现与约定，并以模版加速新增功能或问题排查，避免重复分析成本。
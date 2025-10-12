# Magic API VS Code Extension

Magic API 的 VS Code 扩展，提供完整的远程开发支持，包括语法高亮、智能提示、虚拟文件系统、远程调试等功能。

## 功能特性

### 🌐 远程服务器连接
- 支持多个 Magic API 服务器配置
- 支持多种认证方式（无认证、用户名密码、Token）
- 自动连接测试和状态显示
- 服务器切换和管理

### 📁 虚拟文件系统
- 远程文件浏览和编辑
- 支持 API、函数、数据源三种类型
- 文件和分组的创建、删除、重命名
- 实时同步远程文件内容

### 🎨 语法支持
- Magic Script 语法高亮
- 智能代码补全
- 语法错误检查
- 代码格式化

### 🐛 远程调试
- 支持远程断点调试
- 变量查看和监控
- 调用堆栈跟踪
- 表达式求值

### 📊 状态栏信息
- 当前服务器状态显示
- 活动文件元信息展示
- LSP 连接状态指示

## 安装

1. 下载 `.vsix` 文件
2. 在 VS Code 中按 `Ctrl+Shift+P` 打开命令面板
3. 输入 "Extensions: Install from VSIX..."
4. 选择下载的 `.vsix` 文件进行安装

## 配置

### 服务器配置

在 VS Code 设置中配置 Magic API 服务器：

```json
{
  "magicApi.servers": [
    {
      "id": "dev-server",
      "name": "开发环境",
      "url": "http://localhost:8080",
      "username": "admin",
      "password": "123456",
      "lspPort": 8081,
      "debugPort": 8082
    }
  ],
  "magicApi.currentServer": "dev-server"
}
```

### 配置项说明

- `id`: 服务器唯一标识
- `name`: 服务器显示名称
- `url`: Magic API 服务器地址
- `username`: 用户名（可选）
- `password`: 密码（可选）
- `token`: 访问令牌（可选）
- `lspPort`: LSP 服务端口（默认 8081）
- `debugPort`: 调试服务端口（默认 8082）

## 使用方法

### 1. 添加服务器

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Magic API: 选择服务器"
3. 选择 "添加新服务器"
4. 按提示输入服务器信息

### 2. 浏览远程文件

1. 在资源管理器中找到 "Magic API" 视图
2. 展开文件夹浏览远程文件
3. 双击文件进行编辑

### 3. 创建新文件

1. 右键点击分组文件夹
2. 选择 "创建 API/函数/数据源"
3. 输入文件名和相关信息

### 4. 调试 API

1. 在 API 文件中设置断点
2. 按 `F5` 启动调试
3. 选择 "Magic API: 当前服务器" 配置
4. 发送请求触发断点

## 命令列表

- `Magic API: 选择服务器` - 选择或添加服务器
- `Magic API: 添加服务器` - 添加新服务器
- `Magic API: 刷新文件信息` - 刷新当前文件信息
- `Magic API: 重启 LSP` - 重启语言服务器
- `Magic API: 连接工作区` - 连接到 Magic API 工作区
- `Magic API: 创建文件` - 创建新的 Magic API 文件
- `Magic API: 创建分组` - 创建新的分组
- `Magic API: 测试 API` - 测试当前 API

## 调试配置

在 `.vscode/launch.json` 中添加调试配置：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Magic API: 当前服务器",
      "type": "magic-api",
      "request": "launch"
    },
    {
      "name": "Magic API: 自定义服务器",
      "type": "magic-api",
      "request": "launch",
      "host": "localhost",
      "port": 8082
    }
  ]
}
```

## 文件类型支持

### API 文件 (.ms)
- HTTP 方法配置
- 请求路径映射
- 参数验证
- 响应处理

### 函数文件 (.ms)
- 函数定义
- 参数声明
- 返回值处理

### 数据源文件 (.ms)
- 数据库连接配置
- SQL 查询定义
- 数据转换逻辑

## 故障排除

### 连接问题
1. 检查服务器地址是否正确
2. 确认网络连接正常
3. 验证认证信息是否正确

### LSP 问题
1. 检查 LSP 端口是否开放
2. 重启 LSP 服务
3. 查看输出面板的错误信息

### 调试问题
1. 确认调试端口配置正确
2. 检查防火墙设置
3. 验证 Magic API 服务器支持调试功能

## 开发

### 构建项目

```bash
npm install
npm run compile
```

### 打包扩展

```bash
npm install -g @vscode/vsce
vsce package
```

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个扩展。

## 许可证

MIT License

## 更新日志

### 2.0.0
- 添加远程服务器连接支持
- 实现虚拟文件系统
- 支持远程调试
- 添加状态栏信息显示
- 完整的 Magic Script 语言支持

### 1.0.0
- 基础语法高亮
- 简单的代码补全
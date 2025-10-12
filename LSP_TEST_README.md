# Magic API LSP 测试工具

这是一个简单的 LSP 客户端测试工具，用于验证 Magic API LSP 服务器的功能。

## 功能特性

- ✅ 连接到 Magic API LSP 服务器
- ✅ 发送初始化请求
- ✅ 测试语义标记功能
- ✅ 显示服务器响应和能力

## 使用方法

### 1. 确保 Magic API LSP 服务器正在运行

首先需要启动一个包含 Magic API LSP 的服务器，默认端口为 8081。

### 2. 运行测试客户端

```bash
node lsp-test-client.js
```

### 3. 查看测试结果

测试工具会：
1. 连接到 LSP 服务器 (localhost:8081)
2. 发送初始化请求
3. 创建一个测试的 Magic Script 文档
4. 请求语义标记
5. 显示服务器响应

## 测试输出示例

```
🚀 开始 LSP 连接测试...
✅ 已连接到 LSP 服务器 localhost:8081
📤 发送消息: initialize
📥 收到响应: Content-Length: 1234...
🎉 LSP 服务器初始化成功
服务器能力: {
  "semanticTokensProvider": {
    "legend": {
      "tokenTypes": ["keyword", "string", "comment", ...],
      "tokenModifiers": ["declaration", "definition", ...]
    },
    "range": true,
    "full": true
  }
}
📤 发送消息: initialized
📤 发送消息: textDocument/didOpen
📤 发送消息: textDocument/semanticTokens/full
🎨 收到语义标记响应
语义标记数据长度: 45
前10个标记: [0, 0, 3, 2, 0, 1, 0, 4, 1, 0]
🔚 测试完成，断开连接
🔌 连接已关闭
```

## 配置选项

可以通过修改 `SimpleLspClient` 构造函数参数来连接不同的服务器：

```javascript
const client = new SimpleLspClient('your-server-host', 8081);
```

## 故障排除

### 连接失败
- 确保 Magic API LSP 服务器正在运行
- 检查端口 8081 是否被占用
- 验证防火墙设置

### 没有语义标记数据
- 检查服务器是否支持语义标记
- 验证文档语言 ID 是否正确 (magic-script)
- 查看服务器日志获取更多信息

## VS Code 扩展集成测试

要测试 VS Code 扩展与 LSP 的集成：

1. 确保 LSP 服务器正在运行
2. 在 VS Code 中配置 Magic API 服务器地址
3. 打开 `.ms` 或 `.magic` 文件
4. 检查语法高亮是否正常工作
5. 查看 VS Code 开发者工具中的 LSP 通信日志

## 扩展功能

这个测试工具可以扩展以测试更多 LSP 功能：
- 代码补全 (textDocument/completion)
- 悬停信息 (textDocument/hover)
- 跳转定义 (textDocument/definition)
- 诊断信息 (textDocument/publishDiagnostics)
- 代码格式化 (textDocument/formatting)
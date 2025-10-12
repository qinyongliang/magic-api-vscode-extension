# Magic API VS Code 扩展配置和测试指南

## 概述

本指南详细说明如何配置和测试 Magic API VS Code 扩展的 LSP (Language Server Protocol) 功能。

## 扩展优化成果

### ✅ 已完成的优化

1. **移除本地语法高亮**
   - 删除了 `syntaxes/magic-script.tmLanguage.json`
   - 从 `package.json` 中移除了 `grammars` 配置
   - 完全依赖 LSP 服务器提供的语义标记

2. **配置 LSP 客户端**
   - 在 `remoteLspClient.ts` 中启用语义标记支持
   - 自动处理语义标记请求和响应

3. **优化扩展包**
   - 减少了扩展包大小
   - 提高了语法高亮的准确性
   - 改善了维护性

## 配置步骤

### 1. 安装扩展

```bash
# 安装打包好的扩展
code --install-extension magic-api-language-support-2.0.0.vsix
```

### 2. 配置 Magic API 服务器

在 VS Code 设置中配置 Magic API 服务器：

```json
{
  "magicApi.servers": [
    {
      "name": "本地开发服务器",
      "url": "http://localhost:8080",
      "username": "admin",
      "password": "123456"
    }
  ]
}
```

### 3. 确保 LSP 服务启用

在 Magic API 服务器的配置中启用 LSP 服务：

```yaml
# application.yml
magic-api:
  lsp:
    enable: true
    port: 8081
  debug:
    enable: true
    port: 8082
```

## 测试方法

### 方法一：使用 LSP 测试客户端

1. **运行测试客户端**
   ```bash
   cd magic-api-vscode-extension
   node lsp-test-client.js
   ```

2. **预期输出**
   ```
   🚀 开始 LSP 连接测试...
   ✅ 已连接到 LSP 服务器 localhost:8081
   🎉 LSP 服务器初始化成功
   🎨 收到语义标记响应
   ```

### 方法二：在 VS Code 中测试

1. **创建测试文件**
   - 创建 `.ms` 或 `.magic` 文件
   - 输入 Magic Script 代码

2. **验证功能**
   - 检查语法高亮是否正确
   - 验证关键字、字符串、注释等是否有不同颜色
   - 测试代码补全功能

3. **查看 LSP 通信**
   - 打开 VS Code 开发者工具 (F12)
   - 查看 Console 中的 LSP 通信日志

### 方法三：使用开发者工具调试

1. **启用 LSP 日志**
   ```json
   {
     "magicApi.lsp.trace.server": "verbose"
   }
   ```

2. **查看输出面板**
   - 打开 VS Code 输出面板
   - 选择 "Magic API Language Server" 通道
   - 查看 LSP 通信详情

## 故障排除

### 问题 1: 语法高亮不工作

**可能原因：**
- LSP 服务器未运行
- 网络连接问题
- 配置错误

**解决方案：**
1. 检查 Magic API 服务器状态
2. 验证 LSP 端口 (8081) 是否开放
3. 检查 VS Code 设置中的服务器配置

### 问题 2: 连接超时

**可能原因：**
- 防火墙阻止连接
- 服务器地址错误
- LSP 服务未启用

**解决方案：**
1. 检查防火墙设置
2. 验证服务器地址和端口
3. 确认 Magic API 配置中 LSP 已启用

### 问题 3: 语义标记数据为空

**可能原因：**
- 文件类型不匹配
- LSP 服务器不支持语义标记
- 文档内容解析失败

**解决方案：**
1. 确保文件扩展名为 `.ms` 或 `.magic`
2. 检查 LSP 服务器版本和功能
3. 查看服务器日志获取详细错误信息

## 开发调试

### 调试扩展

1. **在 VS Code 中打开扩展项目**
2. **按 F5 启动调试**
3. **在新窗口中测试扩展功能**

### 查看 LSP 通信

```typescript
// 在 remoteLspClient.ts 中添加日志
console.log('LSP Request:', method, params);
console.log('LSP Response:', response);
```

### 测试语义标记

```typescript
// 手动请求语义标记
const tokens = await client.sendRequest('textDocument/semanticTokens/full', {
    textDocument: { uri: documentUri }
});
console.log('Semantic tokens:', tokens);
```

## 性能优化建议

### 1. 缓存优化
- 启用 LSP 客户端缓存
- 减少不必要的请求

### 2. 网络优化
- 使用本地 LSP 服务器
- 配置合适的超时时间

### 3. 内存优化
- 限制同时打开的文档数量
- 定期清理未使用的资源

## 扩展功能

### 计划中的功能
- [ ] 代码补全
- [ ] 错误诊断
- [ ] 跳转定义
- [ ] 悬停提示
- [ ] 代码格式化

### 自定义配置
```json
{
  "magicApi.lsp.semanticTokens.enable": true,
  "magicApi.lsp.completion.enable": true,
  "magicApi.lsp.diagnostics.enable": true,
  "magicApi.lsp.hover.enable": true
}
```

## 总结

通过本次优化，Magic API VS Code 扩展现在：

1. ✅ **更轻量** - 移除了本地语法文件
2. ✅ **更准确** - 使用 LSP 语义标记
3. ✅ **更易维护** - 集中化的语法处理
4. ✅ **更强大** - 支持更多 LSP 功能

扩展现在完全依赖 Magic API LSP 服务器提供语法高亮和其他语言功能，确保了与服务器端语法解析的一致性。
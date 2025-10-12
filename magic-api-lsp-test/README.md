# Magic API LSP 测试服务器

这是一个简单的 Spring Boot 项目，用于测试 Magic API 的 LSP (Language Server Protocol) 功能。

## 功能特性

- ✅ Magic API 核心功能
- ✅ LSP 语言服务器 (端口: 8081)
- ✅ 调试服务器 (端口: 8082)
- ✅ Web 管理界面 (/magic/web)
- ✅ H2 内存数据库
- ✅ CORS 跨域支持

## 快速启动

1. **编译项目**
   ```bash
   mvn clean compile
   ```

2. **启动服务器**
   ```bash
   mvn spring-boot:run
   ```

3. **访问服务**
   - 主服务: http://localhost:8080
   - Magic API 管理界面: http://localhost:8080/magic/web
   - H2 数据库控制台: http://localhost:8080/h2-console
   - LSP 服务器: localhost:8081 (TCP)
   - 调试服务器: localhost:8082 (TCP)

## VS Code 扩展配置

在 VS Code 中配置 Magic API 服务器：

```json
{
  "magicApi.servers": [
    {
      "id": "local-test",
      "name": "本地测试服务器",
      "url": "http://localhost:8080",
      "username": "admin",
      "password": "123456",
      "lspPort": 8081,
      "debugPort": 8082
    }
  ]
}
```

## 测试 LSP 功能

1. 启动测试服务器
2. 在 VS Code 中选择 "本地测试服务器"
3. 创建 `.ms` 文件测试语法高亮和代码补全
4. 验证 LSP 连接状态

## 登录信息

- 用户名: `admin`
- 密码: `123456`
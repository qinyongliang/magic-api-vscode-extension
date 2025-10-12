const net = require('net');

class SimpleLspClient {
    constructor(host = 'localhost', port = 8081) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.messageId = 1;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();
            
            this.socket.connect(this.port, this.host, () => {
                console.log(`✅ 已连接到 LSP 服务器 ${this.host}:${this.port}`);
                this.sendInitialize();
                resolve();
            });

            this.socket.on('data', (data) => {
                this.handleResponse(data);
            });

            this.socket.on('error', (err) => {
                console.error('❌ 连接错误:', err.message);
                reject(err);
            });

            this.socket.on('close', () => {
                console.log('🔌 连接已关闭');
            });
        });
    }

    sendMessage(method, params = {}) {
        const message = {
            jsonrpc: '2.0',
            id: this.messageId++,
            method: method,
            params: params
        };

        const content = JSON.stringify(message);
        const header = `Content-Length: ${Buffer.byteLength(content, 'utf8')}\r\n\r\n`;
        const fullMessage = header + content;

        console.log(`📤 发送消息: ${method}`);
        this.socket.write(fullMessage);
    }

    sendInitialize() {
        this.sendMessage('initialize', {
            processId: process.pid,
            clientInfo: {
                name: 'Simple LSP Test Client',
                version: '1.0.0'
            },
            capabilities: {
                textDocument: {
                    semanticTokens: {
                        requests: {
                            range: true,
                            full: {
                                delta: true
                            }
                        },
                        tokenTypes: [
                            'namespace', 'type', 'class', 'enum', 'interface',
                            'struct', 'typeParameter', 'parameter', 'variable',
                            'property', 'enumMember', 'event', 'function',
                            'method', 'macro', 'keyword', 'modifier', 'comment',
                            'string', 'number', 'regexp', 'operator'
                        ],
                        tokenModifiers: [
                            'declaration', 'definition', 'readonly', 'static',
                            'deprecated', 'abstract', 'async', 'modification',
                            'documentation', 'defaultLibrary'
                        ]
                    }
                }
            },
            workspaceFolders: [{
                uri: 'file:///test',
                name: 'test'
            }]
        });
    }

    testSemanticTokens() {
        // 测试语义标记功能
        const testDocument = {
            uri: 'file:///test/test.ms',
            languageId: 'magic-script',
            version: 1,
            text: `
// 这是一个测试的 Magic Script 文件
var name = "Hello World";
var count = 42;

function testFunction() {
    return name + " " + count;
}

// 测试注释
if (count > 0) {
    console.log(testFunction());
}
`
        };

        // 发送 textDocument/didOpen
        this.sendMessage('textDocument/didOpen', {
            textDocument: testDocument
        });

        // 请求语义标记
        setTimeout(() => {
            this.sendMessage('textDocument/semanticTokens/full', {
                textDocument: {
                    uri: testDocument.uri
                }
            });
        }, 1000);
    }

    handleResponse(data) {
        const dataStr = data.toString();
        console.log(`📥 收到响应: ${dataStr.substring(0, 200)}...`);
        
        // 解析 LSP 消息
        const lines = dataStr.split('\r\n');
        let contentLength = 0;
        let headerEnd = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('Content-Length:')) {
                contentLength = parseInt(line.split(':')[1].trim());
            } else if (line === '' && !headerEnd) {
                headerEnd = true;
                const content = lines.slice(i + 1).join('\r\n');
                if (content.length >= contentLength) {
                    try {
                        const message = JSON.parse(content.substring(0, contentLength));
                        this.processMessage(message);
                    } catch (e) {
                        console.error('❌ 解析消息失败:', e.message);
                    }
                }
                break;
            }
        }
    }

    processMessage(message) {
        if (message.method === 'initialize') {
            console.log('🎉 LSP 服务器初始化成功');
            console.log('服务器能力:', JSON.stringify(message.result?.capabilities, null, 2));
            
            // 发送 initialized 通知
            this.sendMessage('initialized', {});
            
            // 测试语义标记
            setTimeout(() => {
                this.testSemanticTokens();
            }, 500);
        } else if (message.method === 'textDocument/semanticTokens/full') {
            console.log('🎨 收到语义标记响应');
            if (message.result && message.result.data) {
                console.log(`语义标记数据长度: ${message.result.data.length}`);
                console.log('前10个标记:', message.result.data.slice(0, 10));
            } else {
                console.log('❌ 没有语义标记数据');
            }
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.end();
        }
    }
}

// 使用示例
async function testLspConnection() {
    const client = new SimpleLspClient('localhost', 8081);
    
    try {
        await client.connect();
        
        // 保持连接一段时间进行测试
        setTimeout(() => {
            console.log('🔚 测试完成，断开连接');
            client.disconnect();
        }, 10000);
        
    } catch (error) {
        console.error('❌ LSP 连接测试失败:', error.message);
        console.log('💡 请确保 Magic API LSP 服务器正在运行在 localhost:8081');
    }
}

// 如果直接运行此文件
if (require.main === module) {
    console.log('🚀 开始 LSP 连接测试...');
    testLspConnection();
}

module.exports = SimpleLspClient;
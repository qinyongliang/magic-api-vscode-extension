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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MagicApiDebugSession = void 0;
const vscode = __importStar(require("vscode"));
const vscode_debugadapter_1 = require("vscode-debugadapter");
const net = __importStar(require("net"));
const serverManager_1 = require("./serverManager");
class MagicApiDebugSession extends vscode_debugadapter_1.DebugSession {
    constructor() {
        super();
        this._configurationDone = new Promise((resolve) => {
            this._configurationDoneResolve = resolve;
        });
        this._isConnected = false;
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);
    }
    initializeRequest(response, args) {
        response.body = response.body || {};
        // Capabilities
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = false;
        response.body.supportsDataBreakpoints = false;
        response.body.supportsCompletionsRequest = false;
        response.body.supportsCancelRequest = false;
        response.body.supportsBreakpointLocationsRequest = false;
        response.body.supportsStepInTargetsRequest = false;
        response.body.supportsExceptionFilterOptions = false;
        response.body.supportsValueFormattingOptions = false;
        response.body.supportsExceptionInfoRequest = false;
        response.body.supportTerminateDebuggee = true;
        response.body.supportSuspendDebuggee = true;
        response.body.supportsDelayedStackTraceLoading = false;
        response.body.supportsLoadedSourcesRequest = false;
        response.body.supportsLogPoints = false;
        response.body.supportsTerminateThreadsRequest = false;
        response.body.supportsSetVariable = false;
        response.body.supportsRestartFrame = false;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsSteppingGranularity = false;
        response.body.supportsInstructionBreakpoints = false;
        response.body.supportsReadMemoryRequest = false;
        response.body.supportsDisassembleRequest = false;
        this.sendResponse(response);
        this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
    }
    configurationDoneRequest(response, args) {
        super.configurationDoneRequest(response, args);
        this._configurationDoneResolve();
    }
    launchRequest(response, args) {
        // 获取连接参数
        let host = 'localhost';
        let port = 8081;
        if (args.serverId) {
            // 使用指定的服务器
            const serverManager = serverManager_1.ServerManager.getInstance();
            const server = serverManager.getServers().find(s => s.id === args.serverId);
            const client = serverManager.getCurrentClient();
            if (server && client) {
                const debugUrl = client.getDebugServerUrl();
                const parts = debugUrl.split(':');
                host = parts[0];
                port = parseInt(parts[1]) || 8081;
            }
            else {
                this.sendErrorResponse(response, 1001, `服务器 ${args.serverId} 不存在或未连接`);
                return;
            }
        }
        else if (args.host && args.port) {
            // 使用指定的主机和端口
            host = args.host;
            port = args.port;
        }
        else if (args.port) {
            // 使用指定的端口，默认主机
            port = args.port;
        }
        // 连接到调试服务器
        this._debuggerSocket = new net.Socket();
        this._debuggerSocket.connect(port, host, () => {
            this.sendResponse(response);
            this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
        });
        this._debuggerSocket.on('data', (data) => {
            // 处理从调试服务器接收到的数据
            this.handleDebugServerMessage(data.toString());
        });
        this._debuggerSocket.on('error', (err) => {
            this.sendEvent(new vscode_debugadapter_1.OutputEvent(`调试连接错误 (${host}:${port}): ${err.message}\n`));
            this.sendErrorResponse(response, 1002, `无法连接到调试服务器: ${err.message}`);
        });
        this._debuggerSocket.on('close', () => {
            this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
        });
    }
    async connectToDebugServer() {
        return new Promise((resolve, reject) => {
            const config = vscode.workspace.getConfiguration('magicApi');
            const port = config.get('debug.port', 9999);
            this._debuggerSocket = new net.Socket();
            this._debuggerSocket.connect(port, 'localhost', () => {
                this._isConnected = true;
                this.sendEvent(new vscode_debugadapter_1.OutputEvent(`Connected to Magic API Debug Server on port ${port}\\n`));
                resolve();
            });
            this._debuggerSocket.on('error', (err) => {
                this.sendEvent(new vscode_debugadapter_1.OutputEvent(`Failed to connect to debug server: ${err.message}\\n`));
                reject(err);
            });
            this._debuggerSocket.on('data', (data) => {
                // Handle debug protocol messages from server
                this.handleDebugServerMessage(data.toString());
            });
            this._debuggerSocket.on('close', () => {
                this._isConnected = false;
                this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
            });
        });
    }
    handleDebugServerMessage(message) {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'stopped':
                    this.sendEvent(new vscode_debugadapter_1.StoppedEvent(data.reason || 'breakpoint', MagicApiDebugSession.THREAD_ID));
                    break;
                case 'output':
                    this.sendEvent(new vscode_debugadapter_1.OutputEvent(data.output));
                    break;
                case 'terminated':
                    this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
                    break;
            }
        }
        catch (error) {
            this.sendEvent(new vscode_debugadapter_1.OutputEvent(`Debug protocol error: ${error}\\n`));
        }
    }
    setBreakPointsRequest(response, args) {
        const path = args.source.path;
        const clientLines = args.lines || [];
        // Set breakpoints
        const actualBreakpoints = clientLines.map(line => {
            const bp = new vscode_debugadapter_1.Breakpoint(true, line);
            bp.id = this.generateBreakpointId();
            return bp;
        });
        response.body = {
            breakpoints: actualBreakpoints
        };
        this.sendResponse(response);
    }
    generateBreakpointId() {
        return Math.floor(Math.random() * 1000000);
    }
    threadsRequest(response) {
        response.body = {
            threads: [
                new vscode_debugadapter_1.Thread(MagicApiDebugSession.THREAD_ID, 'Magic API Main Thread')
            ]
        };
        this.sendResponse(response);
    }
    stackTraceRequest(response, args) {
        const frames = [
            new vscode_debugadapter_1.StackFrame(0, 'main', undefined, 1, 1)
        ];
        response.body = {
            stackFrames: frames,
            totalFrames: frames.length
        };
        this.sendResponse(response);
    }
    scopesRequest(response, args) {
        response.body = {
            scopes: [
                new vscode_debugadapter_1.Scope('Local', 1000, false),
                new vscode_debugadapter_1.Scope('Global', 1001, true)
            ]
        };
        this.sendResponse(response);
    }
    variablesRequest(response, args) {
        const variables = [];
        if (args.variablesReference === 1000) {
            // Local variables
            variables.push(new vscode_debugadapter_1.Variable('localVar', 'local value'));
        }
        else if (args.variablesReference === 1001) {
            // Global variables
            variables.push(new vscode_debugadapter_1.Variable('globalVar', 'global value'));
        }
        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }
    continueRequest(response, args) {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'continue' }));
        }
        this.sendResponse(response);
    }
    nextRequest(response, args) {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'next' }));
        }
        this.sendResponse(response);
    }
    stepInRequest(response, args) {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'stepIn' }));
        }
        this.sendResponse(response);
    }
    stepOutRequest(response, args) {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'stepOut' }));
        }
        this.sendResponse(response);
    }
    evaluateRequest(response, args) {
        response.body = {
            result: `Evaluation result for: ${args.expression}`,
            variablesReference: 0
        };
        this.sendResponse(response);
    }
    disconnectRequest(response, args) {
        if (this._debuggerSocket) {
            this._debuggerSocket.destroy();
        }
        this.sendResponse(response);
    }
}
exports.MagicApiDebugSession = MagicApiDebugSession;
MagicApiDebugSession.THREAD_ID = 1;
//# sourceMappingURL=debugAdapter.js.map
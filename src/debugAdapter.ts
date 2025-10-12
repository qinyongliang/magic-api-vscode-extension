import * as vscode from 'vscode';
import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Variable, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as net from 'net';
import { ServerManager } from './serverManager';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    stopOnEntry?: boolean;
    trace?: boolean;
    port?: number;
    serverId?: string;
    host?: string;
}

export class MagicApiDebugSession extends DebugSession {
    private static THREAD_ID = 1;
    private _configurationDone = new Promise<void>((resolve) => {
        this._configurationDoneResolve = resolve;
    });
    private _configurationDoneResolve!: () => void;
    private _debuggerSocket?: net.Socket;
    private _isConnected = false;

    public constructor() {
        super();
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
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
        this.sendEvent(new InitializedEvent());
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);
        this._configurationDoneResolve();
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        // 获取连接参数
        let host = 'localhost';
        let port = 8081;

        if (args.serverId) {
            // 使用指定的服务器
            const serverManager = ServerManager.getInstance();
            const server = serverManager.getServers().find(s => s.id === args.serverId);
            const client = serverManager.getCurrentClient();
            
            if (server && client) {
                const debugUrl = client.getDebugServerUrl();
                const parts = debugUrl.split(':');
                host = parts[0];
                port = parseInt(parts[1]) || 8081;
            } else {
                this.sendErrorResponse(response, 1001, `服务器 ${args.serverId} 不存在或未连接`);
                return;
            }
        } else if (args.host && args.port) {
            // 使用指定的主机和端口
            host = args.host;
            port = args.port;
        } else if (args.port) {
            // 使用指定的端口，默认主机
            port = args.port;
        }

        // 连接到调试服务器
        this._debuggerSocket = new net.Socket();
        this._debuggerSocket.connect(port, host, () => {
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        });

        this._debuggerSocket.on('data', (data) => {
            // 处理从调试服务器接收到的数据
            this.handleDebugServerMessage(data.toString());
        });

        this._debuggerSocket.on('error', (err) => {
            this.sendEvent(new OutputEvent(`调试连接错误 (${host}:${port}): ${err.message}\n`));
            this.sendErrorResponse(response, 1002, `无法连接到调试服务器: ${err.message}`);
        });

        this._debuggerSocket.on('close', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    private async connectToDebugServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            const config = vscode.workspace.getConfiguration('magicApi');
            const port = config.get('debug.port', 9999) as number;

            this._debuggerSocket = new net.Socket();
            
            this._debuggerSocket.connect(port, 'localhost', () => {
                this._isConnected = true;
                this.sendEvent(new OutputEvent(`Connected to Magic API Debug Server on port ${port}\\n`));
                resolve();
            });

            this._debuggerSocket.on('error', (err) => {
                this.sendEvent(new OutputEvent(`Failed to connect to debug server: ${err.message}\\n`));
                reject(err);
            });

            this._debuggerSocket.on('data', (data) => {
                // Handle debug protocol messages from server
                this.handleDebugServerMessage(data.toString());
            });

            this._debuggerSocket.on('close', () => {
                this._isConnected = false;
                this.sendEvent(new TerminatedEvent());
            });
        });
    }

    private handleDebugServerMessage(message: string): void {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'stopped':
                    this.sendEvent(new StoppedEvent(data.reason || 'breakpoint', MagicApiDebugSession.THREAD_ID));
                    break;
                case 'output':
                    this.sendEvent(new OutputEvent(data.output));
                    break;
                case 'terminated':
                    this.sendEvent(new TerminatedEvent());
                    break;
            }
        } catch (error) {
            this.sendEvent(new OutputEvent(`Debug protocol error: ${error}\\n`));
        }
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const path = args.source.path as string;
        const clientLines = args.lines || [];

        // Set breakpoints
        const actualBreakpoints = clientLines.map(line => {
            const bp = new Breakpoint(true, line) as DebugProtocol.Breakpoint;
            bp.id = this.generateBreakpointId();
            return bp;
        });

        response.body = {
            breakpoints: actualBreakpoints
        };

        this.sendResponse(response);
    }

    private generateBreakpointId(): number {
        return Math.floor(Math.random() * 1000000);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(MagicApiDebugSession.THREAD_ID, 'Magic API Main Thread')
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        const frames: StackFrame[] = [
            new StackFrame(0, 'main', undefined, 1, 1)
        ];

        response.body = {
            stackFrames: frames,
            totalFrames: frames.length
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        response.body = {
            scopes: [
                new Scope('Local', 1000, false),
                new Scope('Global', 1001, true)
            ]
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        const variables: Variable[] = [];

        if (args.variablesReference === 1000) {
            // Local variables
            variables.push(new Variable('localVar', 'local value'));
        } else if (args.variablesReference === 1001) {
            // Global variables
            variables.push(new Variable('globalVar', 'global value'));
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'continue' }));
        }
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'next' }));
        }
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'stepIn' }));
        }
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        if (this._isConnected && this._debuggerSocket) {
            this._debuggerSocket.write(JSON.stringify({ command: 'stepOut' }));
        }
        this.sendResponse(response);
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        response.body = {
            result: `Evaluation result for: ${args.expression}`,
            variablesReference: 0
        };
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        if (this._debuggerSocket) {
            this._debuggerSocket.destroy();
        }
        this.sendResponse(response);
    }
}
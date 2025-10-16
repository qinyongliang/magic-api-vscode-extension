import * as vscode from 'vscode';
import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Variable, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import WebSocket from 'ws';
import { MessageConnection, createMessageConnection } from 'vscode-jsonrpc';
import { WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc/cjs';
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
    private _ws?: WebSocket;
    private _connection?: MessageConnection;
    private _isConnected = false;
    private _initializedSent = false;

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

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): Promise<void> {
        try {
            let debugUrl: string | null = null;
            if (args.serverId) {
                const serverManager = ServerManager.getInstance();
                const server = serverManager.getServers().find(s => s.id === args.serverId);
                const client = serverManager.getCurrentClient();
                if (server && client) {
                    debugUrl = await serverManager.getDebugUrl(server.id);
                    if (!debugUrl) {
                        this.sendErrorResponse(response, 1001, `无法获取调试服务器地址`);
                        return;
                    }
                } else {
                    this.sendErrorResponse(response, 1001, `服务器 ${args.serverId} 不存在或未连接`);
                    return;
                }
            } else if (args.host && args.port) {
                // 按 host/port 组装 WS 地址（默认 ws 协议）
                debugUrl = `ws://${args.host}:${args.port}/magic/debug`;
            } else {
                const serverManager = ServerManager.getInstance();
                const current = serverManager.getCurrentServer();
                if (!current) {
                    this.sendErrorResponse(response, 1001, `请先选择 Magic API 服务器`);
                    return;
                }
                debugUrl = await serverManager.getDebugUrl(current.id);
            }

            if (!debugUrl) {
                this.sendErrorResponse(response, 1001, `未能确定调试服务器地址`);
                return;
            }

            // 建立 WebSocket 连接并创建 JSON-RPC 通道（附带认证头）
            const serverManager = ServerManager.getInstance();
            const client = serverManager.getCurrentClient();
            const headers = client?.getAuthHeaders() || {};
            this._ws = new WebSocket(debugUrl, { perMessageDeflate: false, headers });

            this._ws.on('open', async () => {
                const socket = {
                    send: (content: string) => this._ws?.send(content),
                    onMessage: (cb: (data: any) => void) => this._ws?.on('message', (data: any) => cb(typeof data === 'string' ? data : data?.toString?.() ?? '')),
                    onError: (cb: (reason: any) => void) => this._ws?.on('error', (err: any) => cb(err)),
                    onClose: (cb: (code: number, reason: string) => void) => this._ws?.on('close', (code: number, reason: any) => cb(code, typeof reason === 'string' ? reason : reason?.toString?.() ?? '')),
                    dispose: () => this._ws?.close()
                };

                const reader = new WebSocketMessageReader(socket);
                const writer = new WebSocketMessageWriter(socket);
                this._connection = createMessageConnection(reader, writer);

                // 远端事件转发到 VS Code
                this._connection.onNotification('initialized', () => {
                    if (!this._initializedSent) {
                        this.sendEvent(new InitializedEvent());
                        this._initializedSent = true;
                    }
                });
                this._connection.onNotification('stopped', (evt: any) => {
                    this.sendEvent(new StoppedEvent(evt?.reason || 'breakpoint', MagicApiDebugSession.THREAD_ID));
                });
                this._connection.onNotification('output', (evt: any) => {
                    const category = typeof evt?.category === 'string' ? evt.category : undefined;
                    const output = typeof evt?.output === 'string' ? evt.output : JSON.stringify(evt);
                    this.sendEvent(new OutputEvent(output, category));
                });
                this._connection.onNotification('terminated', () => {
                    this.sendEvent(new TerminatedEvent());
                });

                this._connection.onClose(() => {
                    this._isConnected = false;
                    this.sendEvent(new TerminatedEvent());
                });

                this._connection.listen();
                this._isConnected = true;

                // 进行远端初始化
                try {
                    await this._connection.sendRequest('initialize', {
                        adapterID: 'magic-api',
                        linesStartAt1: false,
                        columnsStartAt1: false,
                        pathFormat: 'path'
                    });
                } catch (e) {
                    this.sendEvent(new OutputEvent(`远端初始化失败: ${e}\n`));
                }

                // 发送远端 launch（将 launch 参数透传，便于服务端使用）
                try {
                    await this._connection.sendRequest('launch', args);
                } catch (e) {
                    this.sendEvent(new OutputEvent(`远端启动失败: ${e}\n`));
                }

                this.sendResponse(response);
                // 如果远端未发送 initialized，则本地触发一次，避免 VS Code 阻塞
                if (!this._initializedSent) {
                    this.sendEvent(new InitializedEvent());
                    this._initializedSent = true;
                }
            });

            this._ws.on('error', (err) => {
                this.sendEvent(new OutputEvent(`调试连接错误 (${debugUrl}): ${err.message}\n`));
                this.sendErrorResponse(response, 1002, `无法连接到调试服务器: ${err.message}`);
            });

            this._ws.on('close', () => {
                this._isConnected = false;
                this.sendEvent(new TerminatedEvent());
            });
        } catch (e) {
            this.sendErrorResponse(response, 1002, `启动调试失败: ${e}`);
        }
    }

    // 旧的 TCP 连接与桥接消息处理逻辑已移除，改为 JSON-RPC over WebSocket

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try {
                const remote = await this._connection.sendRequest('setBreakpoints', args);
                response.body = remote as any;
            } catch (e) {
                this.sendEvent(new OutputEvent(`设置断点失败: ${e}\n`));
                response.body = { breakpoints: [] } as any;
            }
        } else {
            // 本地回退：直接标记为可验证断点
            const clientLines = args.lines || [];
            const actualBreakpoints = clientLines.map(line => {
                const bp = new Breakpoint(true, line) as DebugProtocol.Breakpoint;
                bp.id = this.generateBreakpointId();
                return bp;
            });
            response.body = { breakpoints: actualBreakpoints } as any;
        }
        this.sendResponse(response);
    }

    private generateBreakpointId(): number {
        return Math.floor(Math.random() * 1000000);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        if (this._connection && this._isConnected) {
            try {
                const remote = await this._connection.sendRequest('threads');
                response.body = remote as any;
            } catch (e) {
                this.sendEvent(new OutputEvent(`获取线程失败: ${e}\n`));
                response.body = { threads: [ new Thread(MagicApiDebugSession.THREAD_ID, 'Magic API Main Thread') ] } as any;
            }
        } else {
            response.body = { threads: [ new Thread(MagicApiDebugSession.THREAD_ID, 'Magic API Main Thread') ] } as any;
        }
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try {
                const remote = await this._connection.sendRequest('stackTrace', args);
                response.body = remote as any;
            } catch (e) {
                this.sendEvent(new OutputEvent(`获取堆栈失败: ${e}\n`));
                response.body = { stackFrames: [], totalFrames: 0 } as any;
            }
        } else {
            response.body = { stackFrames: [], totalFrames: 0 } as any;
        }
        this.sendResponse(response);
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try {
                const remote = await this._connection.sendRequest('scopes', args);
                response.body = remote as any;
            } catch (e) {
                this.sendEvent(new OutputEvent(`获取变量作用域失败: ${e}\n`));
                response.body = { scopes: [] } as any;
            }
        } else {
            response.body = { scopes: [] } as any;
        }
        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try {
                const remote = await this._connection.sendRequest('variables', args);
                response.body = remote as any;
            } catch (e) {
                this.sendEvent(new OutputEvent(`获取变量失败: ${e}\n`));
                response.body = { variables: [] } as any;
            }
        } else {
            response.body = { variables: [] } as any;
        }
        this.sendResponse(response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try { await this._connection.sendRequest('continue', args); } catch {}
        }
        this.sendResponse(response);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try { await this._connection.sendRequest('next', args); } catch {}
        }
        this.sendResponse(response);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try { await this._connection.sendRequest('stepIn', args); } catch {}
        }
        this.sendResponse(response);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try { await this._connection.sendRequest('stepOut', args); } catch {}
        }
        this.sendResponse(response);
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        if (this._connection && this._isConnected) {
            try {
                const remote = await this._connection.sendRequest('evaluate', args);
                response.body = remote as any;
            } catch (e) {
                this.sendEvent(new OutputEvent(`表达式求值失败: ${e}\n`));
                response.body = { result: '', variablesReference: 0 } as any;
            }
        } else {
            response.body = { result: '', variablesReference: 0 } as any;
        }
        this.sendResponse(response);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        try {
            if (this._connection && this._isConnected) {
                try { await this._connection.sendRequest('disconnect', args); } catch {}
            }
            this._connection?.dispose();
            this._ws?.close();
        } finally {
            this._isConnected = false;
            this.sendResponse(response);
        }
    }
}
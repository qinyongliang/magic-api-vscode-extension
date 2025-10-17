import * as vscode from 'vscode';
import { MagicApiDebugSession } from './debugAdapter';
import { ServerManager } from './serverManager';

export class MagicApiDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // 放宽限制：允许在无“当前服务器”时通过 host/port 或 serverId 直接启动
        return new vscode.DebugAdapterInlineImplementation(new MagicApiDebugSession());
    }
}
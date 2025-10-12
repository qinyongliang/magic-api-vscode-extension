import * as vscode from 'vscode';
import { MagicApiDebugSession } from './debugAdapter';
import { ServerManager } from './serverManager';

export class MagicApiDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        
        // 检查是否有配置的服务器
        const serverManager = ServerManager.getInstance();
        const currentServer = serverManager.getCurrentServer();
        
        if (!currentServer) {
            vscode.window.showErrorMessage('请先选择 Magic API 服务器');
            return null;
        }

        // 返回内联调试适配器
        return new vscode.DebugAdapterInlineImplementation(new MagicApiDebugSession());
    }
}
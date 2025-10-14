import * as vscode from 'vscode';

// Simple shared output channel for debugging
export const magicOutput = vscode.window.createOutputChannel('Magic API');

export function debug(message: string): void {
    magicOutput.appendLine(`[debug] ${new Date().toISOString()} ${message}`);
}

export function info(message: string): void {
    magicOutput.appendLine(`[info] ${new Date().toISOString()} ${message}`);
}

export function error(message: string): void {
    magicOutput.appendLine(`[error] ${new Date().toISOString()} ${message}`);
}
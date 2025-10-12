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
exports.MagicApiDebugAdapterDescriptorFactory = void 0;
const vscode = __importStar(require("vscode"));
const debugAdapter_1 = require("./debugAdapter");
const serverManager_1 = require("./serverManager");
class MagicApiDebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session, executable) {
        // 检查是否有配置的服务器
        const serverManager = serverManager_1.ServerManager.getInstance();
        const currentServer = serverManager.getCurrentServer();
        if (!currentServer) {
            vscode.window.showErrorMessage('请先选择 Magic API 服务器');
            return null;
        }
        // 返回内联调试适配器
        return new vscode.DebugAdapterInlineImplementation(new debugAdapter_1.MagicApiDebugSession());
    }
}
exports.MagicApiDebugAdapterDescriptorFactory = MagicApiDebugAdapterDescriptorFactory;
//# sourceMappingURL=debugAdapterFactory.js.map
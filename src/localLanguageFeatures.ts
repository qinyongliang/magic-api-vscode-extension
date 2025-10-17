import * as vscode from 'vscode';
import { RemoteLspClient } from './remoteLspClient';

// 简单关键字列表（来源于 tmLanguage 语法定义）
const MAGIC_KEYWORDS = [
    'import','as','var','let','const','return','break','continue','if','for','in','new','true','false','null','else','try','catch','finally','async','while','exit','and','or','throw','from','join','left','group','by','having','where','on','limit','offset','instanceof'
];

function getWordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    const regex = /[A-Za-z_][A-Za-z0-9_]*/g;
    const lineText = document.lineAt(position.line).text;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lineText)) !== null) {
        const start = new vscode.Position(position.line, match.index);
        const end = new vscode.Position(position.line, match.index + match[0].length);
        const range = new vscode.Range(start, end);
        if (range.contains(position)) return range;
    }
    return undefined;
}

function parseDeclarations(document: vscode.TextDocument): Map<string, vscode.Location> {
    const decls = new Map<string, vscode.Location>();
    const varDecl = /\b(var|let|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    const importAlias = /\bimport\b[\s\S]*?\bas\b\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        let m: RegExpExecArray | null;
        varDecl.lastIndex = 0; importAlias.lastIndex = 0;
        while ((m = varDecl.exec(text)) !== null) {
            const name = m[2];
            const start = new vscode.Position(line, m.index + m[1].length + 1);
            const end = new vscode.Position(line, m.index + m[0].length);
            decls.set(name, new vscode.Location(document.uri, new vscode.Range(start, end)));
        }
        while ((m = importAlias.exec(text)) !== null) {
            const name = m[1];
            const start = new vscode.Position(line, m.index + m[0].lastIndexOf(name));
            const end = new vscode.Position(line, start.character + name.length);
            decls.set(name, new vscode.Location(document.uri, new vscode.Range(start, end)));
        }
    }
    return decls;
}

type WorkbenchData = {
    classes?: Record<string, any> | undefined;
    extensions?: Record<string, any> | undefined;
    functions?: string[] | undefined;
};

const workbenchCache = new Map<string, WorkbenchData>();

async function readWorkbenchFromMirrorMeta(uri: vscode.Uri): Promise<WorkbenchData | null> {
    // 优先以工作区根为镜像根
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) {
        try {
            const metaUri = vscode.Uri.joinPath(ws.uri, '.magic-api-mirror.json');
            const buf = await vscode.workspace.fs.readFile(metaUri);
            const json = JSON.parse(Buffer.from(buf).toString('utf8'));
            const wb: WorkbenchData = json?.workbench || {};
            return wb || null;
        } catch {}
    }
    // 回退：沿文档路径向上查找
    try {
        let current = uri;
        for (let i = 0; i < 5; i++) {
            const metaUri = vscode.Uri.joinPath(current, '.magic-api-mirror.json');
            try {
                const buf = await vscode.workspace.fs.readFile(metaUri);
                const json = JSON.parse(Buffer.from(buf).toString('utf8'));
                const wb: WorkbenchData = json?.workbench || {};
                return wb || null;
            } catch {}
            const parts = current.path.split('/').filter(Boolean);
            if (parts.length <= 1) break;
            current = vscode.Uri.joinPath(current, '..');
        }
    } catch {}
    return null;
}

async function getWorkbenchDataForDocument(document: vscode.TextDocument): Promise<WorkbenchData | null> {
    const ws = vscode.workspace.getWorkspaceFolder(document.uri);
    const key = ws ? ws.uri.toString() : document.uri.toString();
    if (workbenchCache.has(key)) return workbenchCache.get(key)!;
    const wb = await readWorkbenchFromMirrorMeta(document.uri);
    if (wb) workbenchCache.set(key, wb);
    return wb;
}

async function provideCompletions(remote: RemoteLspClient, document: vscode.TextDocument): Promise<vscode.CompletionItem[] | undefined> {
    if (remote.isRunning()) return undefined; // 远程 LSP 可用时，不提供本地补全以避免重复
    const items: vscode.CompletionItem[] = [];
    for (const kw of MAGIC_KEYWORDS) {
        const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
        item.detail = 'Magic Script 关键字（本地）';
        items.push(item);
    }
    // 常用片段
    const snippetIf = new vscode.CompletionItem('if', vscode.CompletionItemKind.Snippet);
    snippetIf.insertText = new vscode.SnippetString('if (${1:cond}) {\n    $0\n}');
    snippetIf.detail = 'if 代码片段（本地）';
    items.push(snippetIf);

    const snippetFor = new vscode.CompletionItem('for', vscode.CompletionItemKind.Snippet);
    snippetFor.insertText = new vscode.SnippetString('for (${1:item} in ${2:list}) {\n    $0\n}');
    snippetFor.detail = 'for-in 代码片段（本地）';
    items.push(snippetFor);

    const dbItem = new vscode.CompletionItem('db', vscode.CompletionItemKind.Module);
    dbItem.detail = '数据库模板（本地）';
    dbItem.documentation = new vscode.MarkdownString('支持三引号内嵌 SQL: db.xxx("""\nSELECT ...\n""")');
    items.push(dbItem);

    // 工作台数据（classes/extensions/functions）补全
    try {
        const wb = await getWorkbenchDataForDocument(document);
        if (wb) {
            // classes
            const classNames = wb.classes && typeof wb.classes === 'object' ? Object.keys(wb.classes) : [];
            for (const name of classNames) {
                const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                it.detail = '工作台类（本地补全）';
                items.push(it);
            }
            // extensions
            const extNames = wb.extensions && typeof wb.extensions === 'object' ? Object.keys(wb.extensions) : [];
            for (const name of extNames) {
                const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
                it.detail = '扩展类（本地补全）';
                items.push(it);
            }
            // functions
            const fnNames = Array.isArray(wb.functions) ? wb.functions : [];
            for (const name of fnNames) {
                const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                it.detail = '工作台函数（本地补全）';
                items.push(it);
            }
        }
    } catch {}

    return items;
}

async function provideHover(remote: RemoteLspClient, document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (remote.isRunning()) return undefined;
    const range = getWordRange(document, position);
    if (!range) return undefined;
    const word = document.getText(range);
    if (MAGIC_KEYWORDS.includes(word)) {
        return new vscode.Hover({
            language: 'magic-script',
            value: `${word}：Magic Script 关键字（本地提示）`
        }, range);
    }
    if (word === 'db') {
        return new vscode.Hover(new vscode.MarkdownString('数据库模板：可使用三引号 `"""` 包裹 SQL 语句。'));
    }
    // 工作台数据 hover
    try {
        const wb = await getWorkbenchDataForDocument(document);
        if (wb) {
            if (wb.classes && typeof wb.classes === 'object' && word in wb.classes) {
                return new vscode.Hover(new vscode.MarkdownString('类 ' + '`' + word + '`' + '（本地工作台数据）'), range);
            }
            if (wb.extensions && typeof wb.extensions === 'object' && word in wb.extensions) {
                return new vscode.Hover(new vscode.MarkdownString('扩展 ' + '`' + word + '`' + '（本地工作台数据）'), range);
            }
            if (Array.isArray(wb.functions) && wb.functions.includes(word)) {
                return new vscode.Hover(new vscode.MarkdownString('函数 ' + '`' + word + '`' + '（本地工作台数据）'), range);
            }
        }
    } catch {}
    return undefined;
}

function provideDefinition(remote: RemoteLspClient, document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    if (remote.isRunning()) return undefined;
    const range = getWordRange(document, position);
    if (!range) return undefined;
    const ident = document.getText(range);
    const decls = parseDeclarations(document);
    const loc = decls.get(ident);
    return loc ? loc : undefined;
}

function provideDocumentSymbols(remote: RemoteLspClient, document: vscode.TextDocument): vscode.DocumentSymbol[] | undefined {
    if (remote.isRunning()) return undefined;
    const symbols: vscode.DocumentSymbol[] = [];
    const decls = parseDeclarations(document);
    for (const [name, loc] of decls) {
        const ds = new vscode.DocumentSymbol(
            name,
            '',
            vscode.SymbolKind.Variable,
            loc.range,
            loc.range
        );
        symbols.push(ds);
    }
    // 语言块 ```lang
    const blockRegex = /```([A-Za-z_][A-Za-z0-9_]*)/g;
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        let m: RegExpExecArray | null;
        blockRegex.lastIndex = 0;
        while ((m = blockRegex.exec(text)) !== null) {
            const lang = m[1];
            const start = new vscode.Position(line, m.index);
            const end = new vscode.Position(line, m.index + m[0].length);
            const ds = new vscode.DocumentSymbol(
                `block:${lang}`,
                '语言块',
                vscode.SymbolKind.Namespace,
                new vscode.Range(start, end),
                new vscode.Range(start, end)
            );
            symbols.push(ds);
        }
    }
    return symbols;
}

export function registerLocalLanguageFeatures(context: vscode.ExtensionContext, remoteClient: RemoteLspClient): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    // 监听镜像元数据变更，更新工作台缓存
    const watcher = vscode.workspace.createFileSystemWatcher('**/.magic-api-mirror.json');
    watcher.onDidCreate(async (uri) => { try { const wb = await readWorkbenchFromMirrorMeta(uri); if (wb) workbenchCache.set(uri.toString(), wb); } catch {} });
    watcher.onDidChange(async (uri) => { try { const wb = await readWorkbenchFromMirrorMeta(uri); if (wb) workbenchCache.set(uri.toString(), wb); } catch {} });
    watcher.onDidDelete((uri) => { workbenchCache.delete(uri.toString()); });
    disposables.push(watcher);

    // 补全
    disposables.push(
        vscode.languages.registerCompletionItemProvider({ language: 'magic-script', scheme: 'file' }, {
            async provideCompletionItems(doc, pos) { return await provideCompletions(remoteClient, doc); }
        }, ...MAGIC_KEYWORDS)
    );
    disposables.push(
        vscode.languages.registerCompletionItemProvider({ language: 'magic-script', scheme: 'magic-api' }, {
            async provideCompletionItems(doc, pos) { return await provideCompletions(remoteClient, doc); }
        }, ...MAGIC_KEYWORDS)
    );

    // Hover
    disposables.push(
        vscode.languages.registerHoverProvider({ language: 'magic-script', scheme: 'file' }, {
            async provideHover(doc, pos) { return await provideHover(remoteClient, doc, pos); }
        })
    );
    disposables.push(
        vscode.languages.registerHoverProvider({ language: 'magic-script', scheme: 'magic-api' }, {
            async provideHover(doc, pos) { return await provideHover(remoteClient, doc, pos); }
        })
    );

    // 定义跳转
    disposables.push(
        vscode.languages.registerDefinitionProvider({ language: 'magic-script', scheme: 'file' }, {
            provideDefinition(doc, pos) { return provideDefinition(remoteClient, doc, pos); }
        })
    );
    disposables.push(
        vscode.languages.registerDefinitionProvider({ language: 'magic-script', scheme: 'magic-api' }, {
            provideDefinition(doc, pos) { return provideDefinition(remoteClient, doc, pos); }
        })
    );

    // 文档符号
    disposables.push(
        vscode.languages.registerDocumentSymbolProvider({ language: 'magic-script', scheme: 'file' }, {
            provideDocumentSymbols(doc) { return provideDocumentSymbols(remoteClient, doc); }
        })
    );
    disposables.push(
        vscode.languages.registerDocumentSymbolProvider({ language: 'magic-script', scheme: 'magic-api' }, {
            provideDocumentSymbols(doc) { return provideDocumentSymbols(remoteClient, doc); }
        })
    );

    context.subscriptions.push(...disposables);
    return disposables;
}
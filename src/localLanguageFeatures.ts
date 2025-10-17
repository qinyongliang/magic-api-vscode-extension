import * as vscode from 'vscode';
import { RemoteLspClient } from './remoteLspClient';
import { ServerManager } from './serverManager';
import { MagicFileInfo } from './magicFileSystemProvider';
import { MirrorWorkspaceManager } from './mirrorWorkspaceManager';
import { MAGIC_RESOURCE_TYPES, MagicResourceType } from './types';

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
    // 语言块 """lang
    const blockRegex = /"""([A-Za-z_][A-Za-z0-9_]*)/g;
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

// 使用 URL 作为工作区符号名称（服务器文件信息）
function buildUrlSymbolName(file: MagicFileInfo): string {
    const type = file.type || ('api' as any);
    if (type === 'api') {
        const p0 = file.requestMapping || file.path || `/${file.name}`;
        const p = p0.startsWith('/') ? p0 : '/' + p0;
        return `#${p}`;
    }
    const p1 = file.path || `/${file.name}`;
    const p2 = p1.startsWith('/') ? p1 : '/' + p1;
    return `#${p2}`;
}

// 使用 URL 作为工作区符号名称（本地镜像 meta）
function buildUrlSymbolNameFromLocal(meta: { type?: string; requestMapping?: string; path?: string; name?: string }): string {
    const type = meta.type || 'api';
    if (type === 'api') {
        const p0 = meta.requestMapping || meta.path || `/${meta.name || ''}`;
        const p = p0.startsWith('/') ? p0 : '/' + p0;
        return `#${p}`;
    }
    const p1 = meta.path || `/${meta.name || ''}`;
    const p2 = p1.startsWith('/') ? p1 : '/' + p1;
    return `#${p2}`;
}

// 读取某镜像文件的本地元数据 .meta.json
async function readLocalMeta(root: vscode.Uri, type: MagicResourceType, groupPathSub: string | undefined, fileName: string): Promise<any | null> {
    const dirUri = vscode.Uri.joinPath(root, type, ...(groupPathSub ? groupPathSub.split('/') : []));
    const metaName = `.${fileName}.meta.json`;
    const metaUri = vscode.Uri.joinPath(dirUri, metaName);
    try {
        const buf = await vscode.workspace.fs.readFile(metaUri);
        const text = Buffer.from(buf).toString('utf8');
        const obj = JSON.parse(text);
        return obj;
    } catch {
        return null;
    }
}

// 读取某分组目录的分组元数据 .group.meta.json
async function readLocalGroupMeta(root: vscode.Uri, type: MagicResourceType, groupPathSub: string | undefined): Promise<any | null> {
    const dirUri = vscode.Uri.joinPath(root, type, ...(groupPathSub ? groupPathSub.split('/') : []));
    const metaUri = vscode.Uri.joinPath(dirUri, '.group.meta.json');
    try {
        const buf = await vscode.workspace.fs.readFile(metaUri);
        const text = Buffer.from(buf).toString('utf8');
        const obj = JSON.parse(text);
        return obj;
    } catch {
        return null;
    }
}

// 列出某镜像根目录的所有 .ms 文件
async function listLocalMsFiles(root: vscode.Uri): Promise<Array<{ type: MagicResourceType; dir: string; groupPathSub: string; fileName: string }>> {
    const result: Array<{ type: MagicResourceType; dir: string; groupPathSub: string; fileName: string }> = [];
    for (const t of MAGIC_RESOURCE_TYPES) {
        const tRoot = vscode.Uri.joinPath(root, t);
        let entries: [string, vscode.FileType][] = [];
        try { entries = await vscode.workspace.fs.readDirectory(tRoot); } catch { continue; }
        const stack: { base: vscode.Uri; segs: string[] }[] = [{ base: tRoot, segs: [] }];
        while (stack.length) {
            const cur = stack.pop()!;
            let items: [string, vscode.FileType][] = [];
            try { items = await vscode.workspace.fs.readDirectory(cur.base); } catch { continue; }
            for (const [name, ft] of items) {
                if (ft === vscode.FileType.Directory) {
                    stack.push({ base: vscode.Uri.joinPath(cur.base, name), segs: [...cur.segs, name] });
                } else if (ft === vscode.FileType.File && name.endsWith('.ms')) {
                    const fileName = name.replace(/\.ms$/, '');
                    const groupPathSub = cur.segs.join('/');
                    const dir = `${t}${groupPathSub ? '/' + groupPathSub : ''}`;
                    result.push({ type: t, dir, groupPathSub, fileName });
                }
            }
        }
    }
    return result;
}

// 本地镜像工作区符号缓存与监听器
const mirrorSymbolsCache = new Map<string, { symbols: vscode.SymbolInformation[]; namesLower: string[] }>();
const mirrorRootWatchers = new Map<string, vscode.FileSystemWatcher>();

// 重建某镜像根目录下的本地工作区符号缓存
async function rebuildLocalSymbolsForRoot(root: vscode.Uri): Promise<void> {
    const files = await listLocalMsFiles(root);
    const symbols: vscode.SymbolInformation[] = [];
    const namesLower: string[] = [];
    for (const f of files) {
        const meta = await readLocalMeta(root, f.type, f.groupPathSub, f.fileName);
        // 递归读取分组 .group.meta.json，构建 URL 前缀
        let prefixSegs: string[] = [];
        if (f.groupPathSub) {
            const segParts = f.groupPathSub.split('/').filter(Boolean);
            for (let i = 1; i <= segParts.length; i++) {
                const cur = segParts.slice(0, i).join('/');
                const gmeta = await readLocalGroupMeta(root, f.type, cur);
                const gp = gmeta?.path;
                if (gp && typeof gp === 'string') {
                    const cleaned = gp.replace(/^\/+/,'').replace(/\/+$/,'');
                    if (cleaned) prefixSegs.push(cleaned);
                }
            }
        }
        const prefix = prefixSegs.join('/');

        const groupPath = meta?.groupPath || f.dir; // 保持容器名
        const baseName = meta?.name ?? f.fileName;
        let leafRaw: string;
        if (f.type === 'api') {
            const p0 = meta?.requestMapping || meta?.path || `/${baseName}`;
            leafRaw = p0.startsWith('/') ? p0.substring(1) : p0;
        } else {
            const p1 = meta?.path || `/${baseName}`;
            leafRaw = p1.startsWith('/') ? p1.substring(1) : p1;
        }
        const urlPath = '/' + [prefix, leafRaw].filter(Boolean).join('/');
        const name = `#${urlPath}`;
        const segs = f.dir.split('/').filter(Boolean);
        const fileUri = vscode.Uri.joinPath(root, ...segs, `${f.fileName}.ms`);
        const location = new vscode.Location(fileUri, new vscode.Position(0, 0));
        const kind = vscode.SymbolKind.Function;
        const containerName = groupPath;
        symbols.push(new vscode.SymbolInformation(name, kind, containerName, location));
        namesLower.push(urlPath.replace(/^\//, '').toLowerCase());
    }
    mirrorSymbolsCache.set(root.toString(), { symbols, namesLower });
}

// 刷新镜像根目录与监听器，并确保初次构建缓存
async function refreshMirrorRoots(context: vscode.ExtensionContext): Promise<vscode.Uri[]> {
    const mm = MirrorWorkspaceManager.getInstance(context);
    const roots = await mm.findAllMirrorRootsInWorkspace();
    const active = new Set(roots.map(r => r.toString()));

    // 清理已移除的根的监听与缓存
    for (const [key, watcher] of mirrorRootWatchers) {
        if (!active.has(key)) {
            try { watcher.dispose(); } catch {}
            mirrorRootWatchers.delete(key);
            mirrorSymbolsCache.delete(key);
        }
    }

    // 为新根创建监听并构建缓存
    for (const root of roots) {
        const key = root.toString();
        if (!mirrorRootWatchers.has(key)) {
            const pattern = new vscode.RelativePattern(root, '**/.*.meta.json');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate(async () => { try { await rebuildLocalSymbolsForRoot(root); } catch {} });
            watcher.onDidChange(async () => { try { await rebuildLocalSymbolsForRoot(root); } catch {} });
            watcher.onDidDelete(async () => { try { await rebuildLocalSymbolsForRoot(root); } catch {} });
            mirrorRootWatchers.set(key, watcher);
        }
        if (!mirrorSymbolsCache.has(key)) {
            try { await rebuildLocalSymbolsForRoot(root); } catch {}
        }
    }
    return roots;
}

async function provideWorkspaceSymbolsLocal(context: vscode.ExtensionContext, remote: RemoteLspClient, query: string): Promise<vscode.SymbolInformation[] | undefined> {
    const q = (query || '').trim();
    if (!q) return [];

    // 优先：镜像工作区使用本地缓存（监听 .meta.json 变更即时更新）
    const roots = await refreshMirrorRoots(context);
    if (roots.length > 0) {
        const kw = q.replace(/^#/, '').toLowerCase();
        const out: vscode.SymbolInformation[] = [];
        for (const root of roots) {
            const idx = mirrorSymbolsCache.get(root.toString());
            if (!idx) continue;
            for (let i = 0; i < idx.symbols.length; i++) {
                if (kw && !idx.namesLower[i].includes(kw)) continue;
                out.push(idx.symbols[i]);
            }
        }
        return out;
    }

    // 远程工作区：若远程 LSP 已跑，避免重复（让远程 LSP 接管）；否则调用服务器 /workbench/search
    if (remote.isRunning()) return undefined;
    const client = ServerManager.getInstance().getCurrentClient();
    if (!client) return [];
    const kw = q.replace(/^#/, '');
    let results: Array<{ id: string; text: string; line: number }> = [];
    try { results = await (client as any).searchWorkbench(kw); } catch {}
    const symbols: vscode.SymbolInformation[] = [];
    for (const r of results) {
        const finfo: MagicFileInfo | null = await client.getFile(String(r.id));
        if (!finfo) continue;
        const type = finfo.type || ('api' as any);
        const gpRaw = (finfo.groupPath || '').replace(/^\/+/, '');
        const gp = gpRaw ? gpRaw : '';
        const fullDir = gp ? (gp.startsWith(`${type}/`) ? gp : `${type}/${gp}`) : `${type}`;
        const typedPath = `${fullDir}/${finfo.name}.ms`;
        const uri = vscode.Uri.parse(`magic-api:/${typedPath}`);
        const line = Math.max(0, Number(r.line || 0) - 1);
        const location = new vscode.Location(uri, new vscode.Position(line, 0));
        const name = buildUrlSymbolName(finfo);
        const kind = vscode.SymbolKind.Function;
        const containerName = finfo.groupPath || type;
        symbols.push(new vscode.SymbolInformation(name, kind, containerName, location));
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

    // 初始化镜像根监听与本地符号缓存
    refreshMirrorRoots(context).then(() => {
        for (const [, w] of mirrorRootWatchers) disposables.push(w);
    }).catch(() => {});

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

    // 工作区符号（镜像工作区本地化；否则远程/服务器）
    disposables.push(
        vscode.languages.registerWorkspaceSymbolProvider({
            async provideWorkspaceSymbols(query: string) { return await provideWorkspaceSymbolsLocal(context, remoteClient, query); }
        })
    );

    context.subscriptions.push(...disposables);
    return disposables;
}
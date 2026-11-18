'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const {ASSEMBLY, MANIFEST, confined, inferTarget, loadProject, locateProject, resolveSources, sourceDirective, includePath} = require('./project');
const {branchTargets, colorTokens, completionContext, indexSymbols, operandList, operationAt, radixLiteralAt, sourceLine, symbolAt} = require('./symbols');
const {externalInsertionLine, includeCandidates, includeContext} = require('./editor-support');
const instructionSets = require('./instructions.json');
const {callAt, instructionSignatures, signature} = require('./signatures');
const {DATA_TYPES} = require('./documentation');
const {registerFormatter} = require('./format-editor');
const {planRename} = require('./rename');
const {lintRoutines} = require('./routine-lint');
const {findCdmbot, editCdmbot} = require('./cdmbot');
const {operandKinds, conditionNames, comparisonConditions} = require('./operands');
const {getLaunchProfile} = require('./launch-profile');
const {entryPoints} = require('./entry-points');
const {indexModule, navigationGraph, nodesAt} = require('./navigation');

const SELECTOR = ['cocovs-assembly', 'cdm8-assembly', 'cdm8e-assembly', 'cdm16-assembly', 'cdm16e-assembly'];
const DIRECTIVES = 'asect rsect tplate dc db dw ds align ext end macro mend mpush mpop if is then else fi while stays wend do until break continue'.split(' ');
const TOKEN_TYPES = {instruction: 0, macro: 1, label: 2, control: 3, directive: 4};

function fileKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function registerEditor(context, liveDiagnostics) {
  registerFormatter(context, SELECTOR);
  const indexes = new WeakMap();
  const semanticTypes = new vscode.SemanticTokensLegend(['cocovsMnemonic', 'cocovsUserMacro', 'cocovsLabel', 'cocovsControlFlow', 'cocovsDirective']);
  const refreshColors = new vscode.EventEmitter();
  const refreshInlays = new vscode.EventEmitter();
  const refreshReferences = new vscode.EventEmitter();
  const diagnostics = vscode.languages.createDiagnosticCollection('cocovs-symbols');
  const hierarchy = new WeakMap();
  const referenceLenses = new WeakMap();

  function getSymbols(document) {
    const cached = indexes.get(document);
    if (cached?.version === document.version) return cached.symbols;
    const symbols = indexSymbols(document.getText(), /\.mlb$/i.test(document.fileName), true);
    indexes.set(document, {version: document.version, symbols});
    return symbols;
  }

  function getModule(document) {
    const symbols = getSymbols(document);
    const cache = indexes.get(document);
    return cache.module ??= indexModule(fileKey(document.fileName), document.getText(), symbols);
  }

  function projectInfo(document) {
    const folder = document.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(document.uri);
    const boundary = folder?.uri.fsPath ?? path.dirname(document.fileName);
    let root = boundary;
    let config;
    if (document.uri.scheme === 'file') {
      root = locateProject(document.fileName, boundary) ?? boundary;
      if (fs.existsSync(path.join(root, MANIFEST))) {
        try { config = loadProject(root); } catch { /* Build reports invalid manifests. */ }
      }
    }
    const setting = vscode.workspace.getConfiguration('cocovs', document.uri).get('target');
    const target = config?.target ?? getLaunchProfile(context.globalState, document.fileName)?.target ??
      inferTarget(document.fileName, document.languageId, setting);
    const instructions = target === 'custom' ? config?.instructions ?? [] : instructionSets[target] ?? [];
    return {root, config, target, instructions};
  }

  async function linkedDocuments(document, token, info, {forNavigation = false, strict = forNavigation} = {}) {
    const result = {documents: [document], includes: [], incomplete: false};
    if (document.uri.scheme !== 'file') return result;
    const {root, config} = info;
    const open = new Map(vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file')
      .map(doc => [fileKey(doc.fileName), doc]));
    const ownFile = fileKey(document.fileName);
    open.set(ownFile, document);
    const read = file => open.get(fileKey(file))?.getText() ?? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const onError = () => { result.incomplete = true; };
    const ownProject = {entry: path.relative(root, document.fileName)};
    const onInclude = forNavigation ? item => result.includes.push({...item, from: fileKey(item.from), to: fileKey(item.to)}) : undefined;
    let sources = [];
    try {
      sources = resolveSources(root, config ?? ownProject, {read, onError, onInclude});
      const belongsToProject = config && sources.some(file => fileKey(path.join(root, file)) === ownFile);
      if (config && !belongsToProject) {
        if (strict) {
          sources = [];
          result.includes.length = 0;
        }
        sources.push(...resolveSources(root, ownProject, {read, onError, onInclude}));
      }
      if (forNavigation && !belongsToProject) {
        const owners = [];
        for (const candidate of open.values()) {
          if (token?.isCancellationRequested) return result;
          const file = fileKey(candidate.fileName);
          if (file === ownFile || !ASSEMBLY.test(file) || !/^\s*(?:#|;)\s*@include\b/im.test(candidate.getText())) continue;
          try { confined(root, candidate.fileName); } catch { continue; }
          const entry = path.relative(root, candidate.fileName);
          const paths = resolveSources(root, {entry}, {read, onError() {}});
          const keys = new Set(paths.map(name => fileKey(path.join(root, name))));
          if (keys.has(ownFile)) owners.push({file, entry, keys});
        }
        const entries = owners.filter(owner => !owners.some(other => other !== owner && other.keys.has(owner.file)));
        if (entries.length === 1) {
          result.includes.length = 0;
          sources = resolveSources(root, {entry: entries[0].entry}, {read, onError, onInclude});
        }
      }
    } catch {
      onError();
      return result;
    }
    for (const relative of new Set(sources)) {
      if (token?.isCancellationRequested) break;
      if (/\.(?:obj|o|lib)$/i.test(relative)) result.incomplete = true;
      if (!ASSEMBLY.test(relative)) continue;
      const file = path.join(root, relative);
      if (fileKey(file) === ownFile) continue;
      try { result.documents.push(open.get(fileKey(file)) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(file))); }
      catch { onError(); }
    }
    return result;
  }

  async function available(document, token, info = projectInfo(document), options) {
    const {documents, incomplete} = await linkedDocuments(document, token, info, options);
    const symbols = getSymbols(document).map(symbol => ({...symbol, uri: document.uri}));
    for (const dependency of documents.slice(1)) {
      const relative = path.relative(info.root, dependency.fileName).split(path.sep).join('/');
      for (const symbol of getSymbols(dependency)) {
        if (!symbol.external && (symbol.exported || symbol.kind === 'macro' && /\.mlb$/i.test(relative) || info.target === 'custom')) {
          symbols.push({...symbol, uri: dependency.uri, imported: true, relative});
        }
      }
    }
    return {symbols, incomplete};
  }

  function range(symbol) {
    return new vscode.Range(symbol.line, symbol.column, symbol.line, symbol.column + (symbol.definitionLength ?? symbol.name.length));
  }

  function formatName(symbol) {
    return symbol.kind === 'macro' ? symbol.name + '/' + symbol.arity : symbol.name;
  }

  function span({line, column, length}) {
    return new vscode.Range(line, column, line, column + length);
  }

  async function navigation(document, token) {
    const info = projectInfo(document);
    const {documents, includes} = await linkedDocuments(document, token, info, {forNavigation: true});
    const cancelled = () => !!token?.isCancellationRequested;
    if (cancelled()) return undefined;
    const graph = navigationGraph(documents.map(getModule), includes, {target: info.target, cancelled});
    if (!graph) return undefined;
    const uris = new Map(documents.map(doc => [fileKey(doc.fileName), doc.uri]));
    return {graph, root: info.root, uris};
  }

  function referenceLocations(session, document, position, includeDeclaration = false) {
    if (!session) return [];
    const {graph, uris} = session;
    const locations = new Map();
    for (const node of nodesAt(graph, fileKey(document.fileName), position)) {
      for (const hit of graph.uses.get(node) ?? []) {
        if (hit.declaration && !includeDeclaration) continue;
        locations.set(JSON.stringify([hit.file, hit.line, hit.column, hit.length]), new vscode.Location(uris.get(hit.file), span(hit)));
      }
    }
    return [...locations.values()];
  }

  function provideReferenceLenses(document, token) {
    if (token?.isCancellationRequested ||
        vscode.workspace.getConfiguration('cocovs', document.uri).get('referenceCodeLens') === false) return [];
    const version = document.version;
    let session;
    // VS Code resolves visible lenses individually. Share one graph across this batch.
    const getSession = () => session ??= navigation(document);
    return getSymbols(document).filter(symbol => symbol.kind === 'macro' || symbol.kind === 'label' && !symbol.external).map(symbol => {
      const lens = new vscode.CodeLens(range(symbol));
      referenceLenses.set(lens, {document, version, getSession});
      return lens;
    });
  }

  async function resolveReferenceLens(lens, token) {
    const {document, version, getSession} = referenceLenses.get(lens);
    const stale = () => token?.isCancellationRequested || document.isClosed || document.version !== version;
    if (stale()) return undefined;
    const session = await getSession();
    if (stale()) return undefined;
    const position = lens.range.start;
    const locations = referenceLocations(session, document, position);
    const ru = /^ru(?:-|$)/i.test(vscode.env?.language ?? 'en');
    const count = locations.length;
    const title = ru ? 'Ссылок: ' + count : count + (count === 1 ? ' reference' : ' references');
    lens.command = {title, command: count ? 'editor.action.peekLocations' : '',
      ...(count && {arguments: [document.uri, position, locations, 'peek'],
        tooltip: ru ? 'Показать места использования' : 'Show references'}),
    };
    return lens;
  }

  function hierarchyItem(node, session) {
    const uri = session.uris.get(node.file);
    const file = uri.fsPath;
    const kind = node.kind === 'file' ? vscode.SymbolKind.File :
      node.kind === 'macro' ? vscode.SymbolKind.Method : vscode.SymbolKind.Function;
    const selection = span(node);
    const item = new vscode.CallHierarchyItem(kind, node.kind === 'file' ? path.basename(file) : formatName(node),
      path.relative(session.root, file), uri, selection, selection);
    hierarchy.set(item, {session, node});
    return item;
  }

  function callHierarchy(item, direction, token) {
    const entry = hierarchy.get(item);
    if (!entry || token?.isCancellationRequested) return [];
    const {session, node} = entry;
    const incoming = direction === 'incoming';
    return [...(session.graph[direction].get(node) ?? [])].map(([other, sites]) => {
      const related = hierarchyItem(other, session);
      return incoming ? new vscode.CallHierarchyIncomingCall(related, sites.map(span)) :
        new vscode.CallHierarchyOutgoingCall(related, sites.map(span));
    });
  }

  async function argumentHints(document, visible, token) {
    if (token?.isCancellationRequested || vscode.workspace.getConfiguration('cocovs', document.uri).get('inlayHints') === false) return [];
    const module = getModule(document);
    const slots = [];
    for (const row of module.rows.slice(visible.start.line, visible.end.line + 1)) {
      const {line, operation, code} = row;
      if (!operation || row.args?.length || !/\s/.test(code[operation.end] ?? '')) continue;
      const text = document.lineAt(line).text;
      const list = operandList(text, code, operation.end);
      if (!list || list.depth || list.previous.includes('') || text.slice(list.start, code.length).trim()) continue;
      const position = new vscode.Position(line, code.length);
      if (visible.contains(position)) slots.push({row, previous: list.previous, position, paddingLeft: /\S/.test(text[code.length - 1])});
    }
    if (!slots.length) return [];

    const info = projectInfo(document);
    const {symbols} = await available(document, token, info, {strict: true});
    const macros = symbols.filter(symbol => symbol.kind === 'macro');
    const hints = [];
    for (const {row: {operation, name, macro, line}, previous, position, paddingLeft} of slots) {
      if (token?.isCancellationRequested) return [];
      const index = previous.length;
      const visibleMacros = macros.filter(symbol => symbol.name === operation.name &&
        (symbol.imported || module.library || macro || symbol.line < line));
      if (index === 0 && visibleMacros.some(symbol => symbol.arity === 0)) continue;
      let matching = visibleMacros.filter(symbol => symbol.arity > index);
      if (!matching.length) {
        if (DIRECTIVES.includes(name) || !operandKinds({name, previous}, info.target, info.instructions, []).length) continue;
        matching = instructionSignatures(info.target, operation.name);
      }
      const forms = matching.map(symbol => signature(symbol).params);
      if (index === 0 && forms.some(params => params.length === 0)) continue;
      const arity = Math.min(...forms.filter(params => params.length > index).map(params => params.length));
      const candidates = forms.filter(params => params.length === arity);
      const parameter = candidates[0]?.[index];
      if (!parameter || parameter.name.startsWith('$') || parameter.name === '...' ||
          candidates.some(params => params[index].name !== parameter.name)) continue;
      const hint = new vscode.InlayHint(position, parameter.name + ':', vscode.InlayHintKind.Parameter);
      hint.paddingLeft = paddingLeft;
      hint.paddingRight = true;
      if (parameter.description) hint.tooltip = parameter.description;
      hints.push(hint);
    }
    return hints;
  }

  async function lookup(document, position, token) {
    const name = symbolAt(document.lineAt(position.line).text, position.character);
    if (!name) return [];
    const {symbols} = await available(document, token);
    const declaration = symbols.filter(symbol => !symbol.imported && symbol.line === position.line &&
      position.character >= symbol.column && position.character < symbol.column + (symbol.definitionLength ?? symbol.name.length));
    if (declaration.length) return declaration;
    const matches = symbols.filter(symbol => symbol.name === name);
    const local = matches.filter(symbol => !symbol.imported && !symbol.external);
    if (local.length) return local;
    const definitions = matches.filter(symbol => !symbol.external);
    return definitions.length ? definitions : matches;
  }

  async function rename(document, position, newName, token) {
    const {root, config, target, instructions} = projectInfo(document);
    if (document.uri.scheme !== 'file' || target === 'custom' || /\.mlb$/i.test(document.fileName)) {
      throw new Error('Rename is available for labels in CoCAS assembly modules.');
    }
    const open = new Map(vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file')
      .map(doc => [fileKey(doc.fileName), doc]));
    const read = file => open.get(fileKey(file))?.getText() ?? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const entry = {entry: path.relative(root, document.fileName)};
    const files = resolveSources(root, config ?? entry, {read}).map(file => path.join(root, file));
    const documents = new Map();
    const opaque = new Set();
    const realRoot = fs.realpathSync(root);
    async function addFiles(entries) {
      for (const file of entries) {
        if (token?.isCancellationRequested) return;
        if (!ASSEMBLY.test(file)) { opaque.add(file); continue; }
        const real = confined(realRoot, fs.realpathSync(confined(root, file)));
        const key = fileKey(real);
        if (documents.has(key)) continue;
        const source = open.get(fileKey(file)) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        documents.set(key, {file: key, document: source, text: source.getText(), version: source.version});
      }
    }
    await addFiles(files);
    if (token?.isCancellationRequested) return undefined;
    const active = fileKey(fs.realpathSync(document.fileName));
    const projects = ['project.yaml', 'project.yml'].map(name => path.join(root, name)).filter(file => fs.existsSync(file));
    let initial;
    if (documents.has(active)) {
      try { initial = planRename([...documents.values()], active, position); }
      catch (error) { if (!projects.length || !/linked export/.test(error.message)) throw error; }
    }
    if ((!initial || initial.definition.item.exported) && projects.length) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace to check cdmbot test references.');
      const python = await findCdmbot(vscode.workspace.getConfiguration('cocovs').get('cdmbotPythonPath'));
      if (!python) throw new Error('Configure cdmbot before renaming labels referenced by test suites.');
      const suites = (await Promise.all(projects.map(file => editCdmbot(python, 'discover', file)))).flatMap(result => result ?? []);
      const related = suites.filter(suite => [suite.program, ...(suite.sources ?? [])].some(file =>
        documents.has(fileKey(file)) || fileKey(file) === active));
      if (related.some(suite => suite.error)) throw new Error('Fix invalid cdmbot suites before renaming a linked label.');
      await addFiles(related.flatMap(suite => [suite.program, ...(suite.sources ?? [])]));
      if (token?.isCancellationRequested) return undefined;
      initial = planRename([...documents.values()], active, position);
      if (related.some(suite => suite.cases.some(test => test.inputs.includes(initial.selected.name)))) {
        throw new Error('This label is used by setup.input in a cdmbot YAML suite. Update that reference explicitly.');
      }
    }
    const plan = planRename([...documents.values()], active, position, newName, [...instructions, ...DIRECTIVES]);
    if (plan.definition.item.exported && opaque.size) throw new Error('A linked binary can refer to this export.');
    if (plan.definition.item.exported && !config && !projects.length) {
      throw new Error('Open a CocoVS or cdmbot project to rename exported labels across modules.');
    }
    if (token?.isCancellationRequested) return undefined;
    if (newName === undefined) return {range: range(plan.selected), placeholder: plan.selected.name};
    if ([...documents.values()].some(source => source.document.version !== source.version)) {
      throw new Error('Sources changed while planning the rename. Try again.');
    }
    const edit = new vscode.WorkspaceEdit();
    for (const occurrence of plan.edits) edit.replace(documents.get(occurrence.file).document.uri, range(occurrence), newName);
    return edit;
  }

  async function includeItems(document, position, context, root) {
    if (document.uri.scheme !== 'file') return [];
    const prefix = document.lineAt(position.line).text.slice(context.start, position.character);
    const items = await includeCandidates(root, document.fileName, context.directory, prefix);
    if (context.directory && items.some(item => !item.folder && ASSEMBLY.test(item.name))) {
      items.unshift({name: '*', folder: false});
    }
    return items.flatMap(({name, folder, detail}) => {
      const quote = context.quote || (name.includes('"') ? "'" : '"');
      if (name.includes(quote)) return [];
      const item = new vscode.CompletionItem(name + (folder ? '/' : ''),
        folder ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
      item.range = new vscode.Range(position.line, context.start, position.line, context.end);
      if (detail) item.detail = detail;
      if (name === '*') item.detail = 'All assembly sources in this folder';
      const opening = !context.quote ? quote : '';
      const closing = !folder && !context.closed ? quote : '';
      item.insertText = opening + name + (folder ? '/' : '') + closing;
      if (folder) item.command = {title: 'Suggest assembly files', command: 'editor.action.triggerSuggest'};
      return [item];
    });
  }

  function documentationItems(document, position, line) {
    const prefix = line.slice(0, position.character);
    const tag = /^\s*#+[ \t]*(@[\w]*)$/.exec(prefix);
    const type = /^\s*#+[ \t]*@type[ \t]*:[ \t]*([\w]*)$/i.exec(prefix);
    const register = /^\s*#+[ \t]*@(?:param|returns?|changed)[ \t]+([\w]*)$/i.exec(prefix);
    const word = tag?.[1] ?? type?.[1] ?? register?.[1];
    if (word === undefined) return undefined;
    const suffix = line.slice(position.character);
    const end = position.character + (/^\w*/.exec(suffix)[0].length);
    const separator = tag ? /^[ \t]*:?[ \t]*/.exec(line.slice(end))[0].length : 0;
    const replacement = new vscode.Range(position.line, position.character - word.length, position.line, end + separator);
    const item = (label, detail, insertText) => {
      const completion = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
      completion.range = replacement;
      completion.detail = detail;
      completion.insertText = insertText;
      return completion;
    };
    if (tag) {
      const tags = [['@type', 'Memory display type'], ['@param', 'Input argument'],
        ['@return', 'Result'], ['@returns', 'Result (alias for @return)'], ['@changed', 'Registers, flags or memory modified by the routine']];
      return tags.filter(([name]) => name.startsWith(word.toLowerCase())).map(([name, detail]) => {
        const completion = item(name, detail, name === '@type' ? '@type: ' : name + ' ');
        completion.command = {command: 'editor.action.triggerSuggest', title: 'Suggest documentation values'};
        return completion;
      });
    }
    if (type) {
      const spacer = prefix[position.character - word.length - 1] === ':' ? ' ' : '';
      return Object.entries(DATA_TYPES).filter(([name]) => name.startsWith(word.toLowerCase()))
        .map(([name, description]) => item(name, description, spacer + name));
    }
    const wide = /^cdm16/.test(projectInfo(document).target);
    const names = [...Array.from({length: wide ? 8 : 4}, (_, index) => 'r' + index), 'SP', 'PS'];
    return names.filter(name => name.toLowerCase().startsWith(word.toLowerCase()))
      .map(name => item(name, 'Register', name + ' '));
  }

  function externalEdit(document, name, position) {
    const line = externalInsertionLine(document.getText());
    if (line === undefined || line === position.line) return undefined;
    return vscode.TextEdit.insert(new vscode.Position(line, 0), name + ': ext' +
      (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
  }

  function symbolItems(document, position, symbols, info, kind) {
    const localNames = new Set(symbols.filter(symbol => !symbol.imported).map(symbol => symbol.name));
    const candidates = symbols.filter(symbol => kind === 'operand' ? ['label', 'field', 'constant'].includes(symbol.kind) : symbol.kind === 'macro');
    const distinct = new Map();
    for (const symbol of candidates) {
      const key = formatName(symbol);
      const prior = distinct.get(key);
      if (!prior || prior.external && symbol.imported) distinct.set(key, symbol);
    }
    return [...distinct.values()].map(symbol => {
      const item = new vscode.CompletionItem(symbol.name,
        symbol.kind === 'macro' ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Reference);
      const details = symbol.kind === 'macro' && signature(symbol);
      item.detail = (details ? details.label : formatName(symbol)) + (symbol.imported ? ' · ' + symbol.relative : '');
      item.documentation = details ? signatureMarkdown(symbol, details) : symbol.documentation;
      item.sortText = (symbol.imported ? '1' : '0') + symbol.name;
      if (kind === 'operand' && symbol.kind === 'label' && symbol.imported && info.target !== 'custom' && !localNames.has(symbol.name)) {
        const edit = externalEdit(document, symbol.name, position);
        if (edit) item.additionalTextEdits = [edit];
      }
      return item;
    });
  }

  function signatureMarkdown(symbol, details) {
    const markdown = new vscode.MarkdownString();
    if (details.summary) markdown.appendText(details.summary);
    if (details.params.length) {
      markdown.appendMarkdown(symbol.kind === 'macro' ? '\n\n**Arguments**\n\n' : '\n\n**Inputs**\n\n');
      for (const parameter of details.params) {
        markdown.appendText(parameter.name + (parameter.description ? ' - ' + parameter.description : ''));
        markdown.appendMarkdown('  \n');
      }
    }
    if (details.returns) {
      markdown.appendMarkdown('\n\n**Returns**  \n');
      markdown.appendText(details.returns);
    }
    if (details.changed) {
      markdown.appendMarkdown('\n\n**Changed**  \n');
      markdown.appendText(details.changed);
    }
    if (details.dataType) {
      markdown.appendMarkdown('\n\n**Debug type**  \n');
      markdown.appendText(details.dataType + ' - ' + DATA_TYPES[details.dataType]);
    }
    return markdown;
  }

  let timer;
  let revision = 0;
  function scheduleHints() {
    clearTimeout(timer);
    const check = ++revision;
    timer = setTimeout(() => {
      refreshInlays.fire();
      refreshReferences.fire();
      for (const editor of vscode.window.visibleTextEditors) {
        const document = editor.document;
        if (SELECTOR.includes(document.languageId)) void updateHints(document, check).catch(() => {});
      }
    }, 180);
  }

  async function updateHints(document, check) {
    const info = projectInfo(document);
    const library = /\.mlb$/i.test(document.fileName);
    if (info.target === 'custom') {
      diagnostics.delete(document.uri);
      return;
    }
    const {symbols, incomplete} = await available(document, undefined, info);
    if (check !== revision || document.isClosed) return;
    const local = new Set(symbols.filter(symbol => !symbol.imported && symbol.kind === 'label').map(symbol => symbol.name));
    const exported = new Set(symbols.filter(symbol => symbol.imported && symbol.kind === 'label').map(symbol => symbol.name));
    const userMacros = new Set(symbols.filter(symbol => symbol.kind === 'macro').map(symbol => symbol.name));
    const instructions = new Set(info.instructions.filter(name => !userMacros.has(name)));
    const hints = [];
    for (const target of library ? [] : branchTargets(document.getText(), instructions)) {
      if (local.has(target.name)) continue;
      const imported = exported.has(target.name);
      if (!imported && incomplete) continue;
      const message = imported ? 'Add ' + target.name + ': ext to use this imported label.' : 'Label not found: ' + target.name;
      const issue = new vscode.Diagnostic(range(target), message, vscode.DiagnosticSeverity.Hint);
      issue.source = 'CocoVS';
      issue.code = imported ? 'cocovs.external' : 'cocovs.label';
      hints.push(issue);
    }
    for (const warning of lintRoutines(document.getText(), info.target, userMacros, library)) {
      const issue = new vscode.Diagnostic(new vscode.Range(warning.line, warning.column, warning.line,
        warning.column + warning.length), warning.message, vscode.DiagnosticSeverity.Warning);
      issue.source = 'CocoVS';
      issue.code = warning.code;
      hints.push(issue);
    }
    diagnostics.set(document.uri, hints);
  }

  function refresh(document) {
    if (!SELECTOR.includes(document.languageId) && ![MANIFEST, 'cdm-packages.json', 'cdm-packages.lock.json'].includes(path.basename(document.fileName))) return;
    refreshColors.fire();
    scheduleHints();
  }

  function includeLocation(document, line) {
    if (document.uri.scheme !== 'file') return undefined;
    const source = document.lineAt(line).text;
    const directive = sourceDirective(source);
    if (!directive || directive.folder) return undefined;
    const {column} = directive;
    try {
      const {root} = projectInfo(document);
      const file = includePath(root, document.fileName, directive.path);
      confined(fs.realpathSync(root), fs.realpathSync(file));
      if (!fs.statSync(file).isFile()) return undefined;
      return {uri: vscode.Uri.file(file), range: new vscode.Range(line, column, line, column + directive.name.length)};
    } catch { return undefined; }
  }

  if (vscode.workspace.createFileSystemWatcher) {
    const changed = () => { refreshColors.fire(); scheduleHints(); };
    for (const pattern of ['**/.cdm/packages/**/*', '**/cdm-packages.json', '**/cdm-packages.lock.json']) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
    }
    const sources = vscode.workspace.createFileSystemWatcher('**/{cdm-project.json,*.asm,*.mlb,*.cdm8,*.cdm8e,*.cdm16,*.cdm16e,*.cocoasm}');
    context.subscriptions.push(sources, sources.onDidCreate(scheduleHints), sources.onDidChange(scheduleHints), sources.onDidDelete(scheduleHints));
  }

  if (liveDiagnostics?.onDidChangeLaunchProfile) {
    context.subscriptions.push(liveDiagnostics.onDidChangeLaunchProfile(() => { refreshColors.fire(); scheduleHints(); }));
  }
  context.subscriptions.push(refreshColors, refreshInlays, refreshReferences, diagnostics, {dispose() { clearTimeout(timer); revision++; }},
    vscode.languages.registerCodeLensProvider(SELECTOR, {
      onDidChangeCodeLenses: refreshColors.event,
      provideCodeLenses(document) {
        if (document.uri.scheme !== 'file' || /\.mlb$/i.test(document.fileName) ||
            !['cdm8', 'cdm8e', 'cdm16'].includes(projectInfo(document).target)) return [];
        const ru = /^ru(?:-|$)/i.test(vscode.env?.language ?? 'en');
        return entryPoints(document.getText()).map(symbol => new vscode.CodeLens(range(symbol), {
          title: ru ? '▶ Отладить' : '▶ Debug', command: 'cdmProject.debug', arguments: [document.uri],
          tooltip: ru ? 'Собрать и начать отладку этого файла' : 'Build and start debugging this file',
        }));
      },
    }),
    vscode.languages.registerCodeLensProvider(SELECTOR, {
      onDidChangeCodeLenses: refreshReferences.event,
      provideCodeLenses: provideReferenceLenses,
      resolveCodeLens: resolveReferenceLens,
    }),
    vscode.commands.registerCommand('cocovs.showSuggestions', () => vscode.commands.executeCommand('editor.action.triggerSuggest')),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && SELECTOR.includes(event.document.languageId)) scheduleHints();
    }),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
    vscode.window.onDidChangeVisibleTextEditors(scheduleHints),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('cocovs.target')) {
        refreshColors.fire();
        scheduleHints();
      }
      if (event.affectsConfiguration('cocovs.inlayHints')) refreshInlays.fire();
      if (event.affectsConfiguration('cocovs.referenceCodeLens')) refreshReferences.fire();
    }),
    vscode.languages.registerHoverProvider(SELECTOR, {async provideHover(document, position, token) {
      const {line, character} = position;
      const text = document.lineAt(line).text;
      const literal = radixLiteralAt(text, character);
      if (literal) {
        const markdown = new vscode.MarkdownString();
        const title = /^ru(?:-|$)/i.test(vscode.env?.language ?? '') ? 'Десятичное значение' : 'Decimal value';
        markdown.appendMarkdown('**' + title + '**\n\n');
        markdown.appendCodeblock(literal.text + ' = ' + BigInt(literal.text).toString(10));
        return new vscode.Hover([markdown], new vscode.Range(line, literal.start, line, literal.end));
      }
      const symbols = await lookup(document, position, token);
      if (!symbols.length) {
        const op = operationAt(sourceLine(text));
        if (!op || character < op.column || character >= op.end) return undefined;
        const instructions = instructionSignatures(projectInfo(document).target, op.name);
        if (!instructions.length) return undefined;
        const [first] = instructions;
        const variants = instructions.map(signature);
        const params = new Map(variants.flatMap(variant => variant.params)
          .filter(parameter => parameter.name !== '...').map(parameter => [parameter.name, parameter]));
        const heading = variants.map(({params}) => params.length
          ? first.name + '(' + params.map(parameter => parameter.name).join(', ') + ')'
          : first.name);
        const markdown = new vscode.MarkdownString();
        markdown.appendCodeblock(heading.join('\n'));
        markdown.appendMarkdown(signatureMarkdown(first, {...variants[0], params: [...params.values()]}).value);
        return new vscode.Hover([markdown]);
      }
      return new vscode.Hover(symbols.map(symbol => {
        const markdown = new vscode.MarkdownString();
        const details = signature(symbol);
        markdown.appendCodeblock(symbol.kind === 'macro' || details.params.length ? details.label : formatName(symbol));
        markdown.appendMarkdown(signatureMarkdown(symbol, details).value);
        return markdown;
      }));
    }}),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, {async provideSignatureHelp(document, position, token) {
      const call = callAt(document.lineAt(position.line).text, position.character);
      if (!call) return undefined;
      const {symbols} = await available(document, token);
      let matches = symbols.filter(symbol => symbol.kind === 'macro' && symbol.name === call.name);
      if (!matches.length && /^jsr$/i.test(call.name)) {
        matches = symbols.filter(symbol => symbol.kind === 'label' && !symbol.external &&
          symbol.name === call.target && symbol.documentation);
      }
      if (!matches.length) {
        matches = instructionSignatures(projectInfo(document).target, call.name);
        if (!matches.length) return undefined;
      }
      const help = new vscode.SignatureHelp();
      help.signatures = matches.map(symbol => {
        const details = signature(symbol);
        const info = new vscode.SignatureInformation(symbol.kind === 'label' ? 'jsr ' + symbol.name : details.label,
          signatureMarkdown(symbol, details));
        info.parameters = symbol.kind === 'label' ? [new vscode.ParameterInformation(symbol.name)] :
          details.params.map(parameter => new vscode.ParameterInformation(parameter.name, parameter.description));
        return info;
      });
      const fitting = help.signatures.findIndex(item => item.parameters.length > call.active);
      help.activeSignature = Math.max(0, fitting);
      help.activeParameter = Math.max(0, Math.min(call.active, help.signatures[help.activeSignature].parameters.length - 1));
      return help;
    }}, ' ', ','),
    vscode.languages.registerInlayHintsProvider(SELECTOR, {
      onDidChangeInlayHints: refreshInlays.event,
      provideInlayHints: argumentHints,
    }),
    vscode.languages.registerReferenceProvider(SELECTOR, {async provideReferences(document, position, options, token) {
      const session = await navigation(document, token);
      return referenceLocations(session, document, position, options.includeDeclaration);
    }}),
    vscode.languages.registerCallHierarchyProvider(SELECTOR, {
      async prepareCallHierarchy(document, position, token) {
        const session = await navigation(document, token);
        if (!session) return [];
        const {graph} = session;
        const file = fileKey(document.fileName);
        const nodes = nodesAt(graph, file, position);
        const text = document.lineAt(position.line).text;
        const directive = sourceDirective(text);
        if (directive && position.character >= text.indexOf('@') && position.character < directive.column) nodes.push(graph.files.get(file));
        return nodes.filter(node => node?.kind === 'macro' || graph.callable.has(node)).map(node => hierarchyItem(node, session));
      },
      provideCallHierarchyIncomingCalls: (item, token) => callHierarchy(item, 'incoming', token),
      provideCallHierarchyOutgoingCalls: (item, token) => callHierarchy(item, 'outgoing', token),
    }),
    vscode.languages.registerRenameProvider(SELECTOR, {
      prepareRename: (document, position, token) => rename(document, position, undefined, token),
      provideRenameEdits: (document, position, newName, token) => rename(document, position, newName, token),
    }),
    vscode.languages.registerDefinitionProvider(SELECTOR, {async provideDefinition(document, position, token) {
      const include = includeLocation(document, position.line);
      if (include && position.character >= include.range.start.character && position.character <= include.range.end.character) {
        return [new vscode.Location(include.uri, new vscode.Range(0, 0, 0, 0))];
      }
      return (await lookup(document, position, token)).map(symbol => new vscode.Location(symbol.uri, range(symbol)));
    }}),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {provideDocumentSymbols(document) {
      return getSymbols(document).filter(symbol => !symbol.external).map(symbol =>
        new vscode.DocumentSymbol(formatName(symbol), '', symbol.kind === 'macro' ? vscode.SymbolKind.Method : vscode.SymbolKind.Function,
          document.lineAt(symbol.line).range, range(symbol)));
    }}),
    vscode.languages.registerCompletionItemProvider(SELECTOR, {async provideCompletionItems(document, position, token) {
      const line = document.lineAt(position.line).text;
      const include = includeContext(line, position.character);
      if (include) return includeItems(document, position, include, projectInfo(document).root);
      const documentation = documentationItems(document, position, line);
      if (documentation) return documentation;
      const completion = completionContext(line, position.character);
      if (!completion) return [];
      const info = projectInfo(document);
      const keyword = word => new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
      if (completion.kind === 'operation') {
        const {symbols} = await available(document, token, info);
        const macros = symbolItems(document, position, symbols, info, 'operation');
        return [...macros, ...[...new Set([...DIRECTIVES, ...info.instructions])].map(keyword)];
      }
      const {name} = completion;
      const linked = await available(document, token, info);
      const kinds = operandKinds(completion, info.target, info.instructions,
        linked.symbols.filter(symbol => symbol.kind === 'macro' && symbol.name === name));
      const items = [];
      if (kinds.includes('l')) {
        items.push(...symbolItems(document, position, linked.symbols, info, 'operand'));
      }
      if (!completion.expression) {
        if (kinds.includes('r')) {
          const count = info.target.startsWith('cdm16') ? 8 : 4;
          items.push(...Array.from({length: count}, (_, index) => keyword('r' + index)));
        }
        if (kinds.includes('condition')) {
          items.push(...conditionNames(info.target).map(keyword));
          for (const {alias, condition, signedness} of comparisonConditions(info.target)) {
            const item = keyword(alias + (signedness ? ' (' + signedness + ')' : '') + ' → ' + condition);
            item.insertText = condition;
            item.filterText = alias;
            item.detail = signedness === 'signed' ? 'Знаковое сравнение (s = signed)' :
              signedness === 'unsigned' ? 'Беззнаковое сравнение (u = unsigned)' : 'Равенство / неравенство';
            item.documentation = 'cmp left, right: left ' + alias.replace(/[su]$/, '') +
              ' right. Вставить ' + condition + '.';
            items.push(item);
          }
        }
        if (kinds.includes('conjunction')) items.push(keyword('and'), keyword('or'));
      }
      const replacement = new vscode.Range(position.line, completion.start, position.line, completion.end);
      for (const item of items) item.range = replacement;
      return items;
    }}, '"', "'", '/', ' ', ',', '@', ':', '<', '>', '=', '!'),
    vscode.languages.registerCodeActionsProvider(SELECTOR, {provideCodeActions(document, _range, context) {
      return context.diagnostics.filter(issue => issue.code === 'cocovs.external').flatMap(issue => {
        const name = document.getText(issue.range);
        if (!/^[A-Za-z_.][A-Za-z0-9_.]*$/.test(name) ||
            getSymbols(document).some(symbol => symbol.kind === 'label' && symbol.name === name)) return [];
        const edit = externalEdit(document, name, issue.range.start);
        if (!edit) return [];
        const action = new vscode.CodeAction('Declare ' + name + ' as external', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [issue];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.set(document.uri, [edit]);
        return [action];
      });
    }}, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}),
    vscode.languages.registerDocumentLinkProvider(SELECTOR, {provideDocumentLinks(document) {
      if (document.uri.scheme !== 'file') return [];
      const links = [];
      for (let line = 0; line < document.lineCount; line++) {
        const include = includeLocation(document, line);
        if (!include) continue;
        const link = new vscode.DocumentLink(include.range, include.uri);
        link.tooltip = 'Open included source';
        links.push(link);
      }
      return links;
    }}),
    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, {
      onDidChangeSemanticTokens: refreshColors.event,
      async provideDocumentSemanticTokens(document, token) {
        const builder = new vscode.SemanticTokensBuilder(semanticTypes);
        const info = projectInfo(document);
        const {symbols} = await available(document, token, info);
        const macros = new Set();
        const labels = new Set();
        for (const symbol of symbols) {
          if (symbol.kind === 'macro') macros.add(symbol.name);
          else labels.add(symbol.name);
        }
        const instructions = new Set(info.instructions);
        for (let line = 0; line < document.lineCount && !token.isCancellationRequested; line++) {
          for (const item of colorTokens(document.lineAt(line).text, macros, labels, instructions)) {
            builder.push(line, item.column, item.name.length, TOKEN_TYPES[item.kind], 0);
          }
        }
        return builder.build();
      },
    }, semanticTypes),
  );
  scheduleHints();
  if (liveDiagnostics) {
    const {registerLiveDiagnostics} = require('./live-diagnostics');
    registerLiveDiagnostics(context, vscode, {selector: SELECTOR, projectInfo, ...liveDiagnostics});
  }
}

module.exports = {registerEditor};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const {ASSEMBLY, MANIFEST, confined, inferTarget, loadProject, locateProject, resolveSources, sourceDirective} = require('./project');
const {branchTargets, colorTokens, completionContext, indexSymbols, operationAt, sourceLine, symbolAt} = require('./symbols');
const {externalInsertionLine, includeCandidates, includeContext} = require('./editor-support');
const instructionSets = require('./instructions.json');
const {callAt, instructionSignatures, signature} = require('./signatures');
const {DATA_TYPES} = require('./documentation');
const {registerFormatter} = require('./format-editor');
const {planRename} = require('./rename');
const {lintRoutines} = require('./routine-lint');
const {findCdmbot, editCdmbot} = require('./cdmbot');
const {operandKinds, conditionNames} = require('./operands');

const SELECTOR = ['cocovs-assembly', 'cdm8-assembly', 'cdm8e-assembly', 'cdm16-assembly', 'cdm16e-assembly'];
const DIRECTIVES = 'asect rsect tplate dc db dw ds align ext end macro mend mpush mpop if is then else fi while stays wend do until break continue'.split(' ');
const TOKEN_TYPES = {instruction: 0, macro: 1, label: 2, control: 3};

function fileKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function registerEditor(context, liveDiagnostics) {
  registerFormatter(context, SELECTOR);
  const indexes = new WeakMap();
  const semanticTypes = new vscode.SemanticTokensLegend(['cocovsMnemonic', 'cocovsUserMacro', 'cocovsLabel', 'cocovsControlFlow']);
  const refreshColors = new vscode.EventEmitter();
  const diagnostics = vscode.languages.createDiagnosticCollection('cocovs-symbols');

  function getSymbols(document) {
    const cached = indexes.get(document);
    if (cached?.version === document.version) return cached.symbols;
    const symbols = indexSymbols(document.getText(), /\.mlb$/i.test(document.fileName), true);
    indexes.set(document, {version: document.version, symbols});
    return symbols;
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
    const target = config?.target ?? inferTarget(document.fileName, document.languageId, setting);
    const instructions = target === 'custom' ? config?.instructions ?? [] : instructionSets[target] ?? [];
    return {root, config, target, instructions};
  }

  if (liveDiagnostics) {
    const {registerLiveDiagnostics} = require('./live-diagnostics');
    registerLiveDiagnostics(context, vscode, {selector: SELECTOR, projectInfo, ...liveDiagnostics});
  }

  async function available(document, token, info = projectInfo(document)) {
    const symbols = getSymbols(document).map(symbol => ({...symbol, uri: document.uri}));
    const result = {symbols, incomplete: false};
    if (document.uri.scheme !== 'file') return result;
    const {root, config} = info;
    const open = new Map(vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file')
      .map(doc => [fileKey(doc.fileName), doc]));
    const read = file => open.get(fileKey(file))?.getText() ?? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const onError = () => { result.incomplete = true; };
    const ownFile = fileKey(document.fileName);
    const ownProject = {entry: path.relative(root, document.fileName)};
    let sources;
    try {
      sources = resolveSources(root, config ?? ownProject, {read, onError});
      if (config && !sources.some(file => fileKey(path.join(root, file)) === ownFile)) {
        sources.push(...resolveSources(root, ownProject, {read, onError}));
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
      let dependency;
      try { dependency = open.get(fileKey(file)) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(file)); }
      catch { onError(); continue; }
      for (const symbol of getSymbols(dependency)) {
        if (!symbol.external && (symbol.exported || symbol.kind === 'macro' && /\.mlb$/i.test(file) || info.target === 'custom')) {
          symbols.push({...symbol, uri: dependency.uri, imported: true, relative});
        }
      }
    }
    return result;
  }

  function range(symbol) {
    return new vscode.Range(symbol.line, symbol.column, symbol.line, symbol.column + symbol.name.length);
  }

  function formatName(symbol) {
    return symbol.kind === 'macro' ? symbol.name + '/' + symbol.arity : symbol.name;
  }

  async function lookup(document, position, token) {
    const name = symbolAt(document.lineAt(position.line).text, position.character);
    if (!name) return [];
    const {symbols} = await available(document, token);
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
    const items = await includeCandidates(root, document.fileName, context.directory);
    if (context.directory && items.some(item => !item.folder && ASSEMBLY.test(item.name))) {
      items.unshift({name: '*', folder: false});
    }
    return items.flatMap(({name, folder}) => {
      const quote = context.quote || (name.includes('"') ? "'" : '"');
      if (name.includes(quote)) return [];
      const item = new vscode.CompletionItem(name + (folder ? '/' : ''),
        folder ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
      item.range = new vscode.Range(position.line, context.start, position.line, context.end);
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
    const candidates = symbols.filter(symbol => kind === 'operand' ? symbol.kind === 'label' : symbol.kind === 'macro');
    const distinct = new Map();
    for (const symbol of candidates) {
      const key = formatName(symbol);
      const prior = distinct.get(key);
      if (!prior || prior.external && symbol.imported) distinct.set(key, symbol);
    }
    return [...distinct.values()].map(symbol => {
      const item = new vscode.CompletionItem(symbol.name,
        symbol.kind === 'macro' ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Reference);
      item.detail = formatName(symbol) + (symbol.imported ? ' · ' + symbol.relative : '');
      item.documentation = symbol.documentation;
      item.sortText = (symbol.imported ? '1' : '0') + symbol.name;
      if (kind === 'operand' && symbol.imported && info.target !== 'custom' && !localNames.has(symbol.name)) {
        const edit = externalEdit(document, symbol.name, position);
        if (edit) item.additionalTextEdits = [edit];
      }
      return item;
    });
  }

  function signatureMarkdown(symbol, details) {
    const markdown = new vscode.MarkdownString();
    if (details.summary) markdown.appendText(details.summary);
    if (symbol.kind !== 'macro' && details.params.length) {
      markdown.appendMarkdown('\n\n**Inputs**\n\n');
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
    if (!SELECTOR.includes(document.languageId) && path.basename(document.fileName) !== MANIFEST) return;
    refreshColors.fire();
    scheduleHints();
  }

  context.subscriptions.push(refreshColors, diagnostics, {dispose() { clearTimeout(timer); revision++; }},
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
    }),
    vscode.languages.registerHoverProvider(SELECTOR, {async provideHover(document, position, token) {
      const symbols = await lookup(document, position, token);
      if (!symbols.length) {
        const line = document.lineAt(position.line).text;
        const op = operationAt(sourceLine(line));
        if (!op || position.character < op.column || position.character >= op.end) return undefined;
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
        if (symbol.kind === 'macro' && details.params.some(parameter => parameter.description)) {
          markdown.appendMarkdown('\n\n**Arguments**\n\n');
          for (const parameter of details.params) {
            markdown.appendText(parameter.name + (parameter.description ? ' - ' + parameter.description : ''));
            markdown.appendMarkdown('  \n');
          }
        }
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
    vscode.languages.registerRenameProvider(SELECTOR, {
      prepareRename: (document, position, token) => rename(document, position, undefined, token),
      provideRenameEdits: (document, position, newName, token) => rename(document, position, newName, token),
    }),
    vscode.languages.registerDefinitionProvider(SELECTOR, {async provideDefinition(document, position, token) {
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
      // Most instructions can be completed without loading all imported files.
      const {name} = completion;
      let linked;
      if (!info.instructions.includes(name.toLowerCase()) && !DIRECTIVES.includes(name.toLowerCase())) {
        linked = await available(document, token, info);
      }
      const kinds = operandKinds(completion, info.target, info.instructions,
        (linked?.symbols ?? getSymbols(document)).filter(symbol => symbol.kind === 'macro' && symbol.name === name));
      const items = [];
      if (kinds.includes('l')) {
        linked ??= await available(document, token, info);
        items.push(...symbolItems(document, position, linked.symbols, info, 'operand'));
      }
      if (!completion.expression) {
        if (kinds.includes('r')) {
          const count = info.target.startsWith('cdm16') ? 8 : 4;
          items.push(...Array.from({length: count}, (_, index) => keyword('r' + index)));
        }
        if (kinds.includes('condition')) items.push(...conditionNames(info.target).map(keyword));
        if (kinds.includes('conjunction')) items.push(keyword('and'), keyword('or'));
      }
      const replacement = new vscode.Range(position.line, completion.start, position.line, completion.end);
      for (const item of items) item.range = replacement;
      return items;
    }}, '"', "'", '/', ' ', ',', '@', ':'),
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
      const {root} = projectInfo(document);
      const directory = path.dirname(document.fileName);
      const links = [];
      for (let line = 0; line < document.lineCount; line++) {
        const source = document.lineAt(line).text;
        const directive = sourceDirective(source);
        if (!directive || directive.folder) continue;
        const {name} = directive;
        const column = source.indexOf(name, source.indexOf('@') + '@include'.length);
        try {
          const file = confined(root, path.resolve(directory, directive.path));
          confined(fs.realpathSync(root), fs.realpathSync(file));
          links.push(new vscode.DocumentLink(new vscode.Range(line, column, line, column + name.length), vscode.Uri.file(file)));
        } catch { /* Missing or out-of-project sources are reported during build. */ }
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
}

module.exports = {registerEditor};

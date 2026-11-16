'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');

test('editor completes includes and imported symbols, colors references and navigates to definitions', async t => {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-editor-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'lib'));
  const main = path.join(root, 'main.asm');
  const library = path.join(root, 'lib', 'math.asm');
  const text = '# @include "lib/math.asm"\n# @include "not yet.asm"\nasect 0\n    jsr calculate\n    halt\nend\n';
  await fs.writeFile(main, text);
  await fs.writeFile(library, 'rsect math\nstale>\n    rts\nend\n');

  const uri = fsPath => ({fsPath, scheme: 'file'});
  const document = (fileName, content) => ({
    uri: uri(fileName), fileName, languageId: 'cocovs-assembly', version: 1, eol: 1,
    lineCount: content.split('\n').length, lineAt: line => ({text: content.split('\n')[line]}), getText: () => content,
  });
  const mainDoc = document(main, text);
  const libDoc = document(library, 'rsect math\n# Computes the result\ncalculate>\n    rts\nend\n');
  const providers = {};
  const dispose = {dispose() {}};
  class Position {
    constructor(line, character) { this.line = line; this.character = character; }
  }
  class Range {
    constructor(line, start, endLine, end) {
      this.start = new Position(line, start);
      this.end = new Position(endLine, end);
    }
  }
  const api = {
    commands: {registerCommand: () => dispose},
    Uri: {file: uri}, Position, Range, EndOfLine: {CRLF: 2}, SymbolKind: {}, CodeActionKind: {QuickFix: 'quickfix'},
    Location: class { constructor(target, range) { this.uri = target; this.range = range; } },
    EventEmitter: class { fire() {} dispose() {} },
    MarkdownString: class {
      value = '';
      appendText(value) { this.value += value; }
      appendMarkdown(value) { this.value += value; }
      appendCodeblock(value) { this.value += value; }
    },
    Hover: class { constructor(contents) { this.contents = contents; } },
    SignatureHelp: class {},
    SignatureInformation: class { constructor(label) { this.label = label; } },
    ParameterInformation: class { constructor(label) { this.label = label; } },
    TextEdit: {insert: (position, newText) => ({position, newText})},
    WorkspaceEdit: class { entries = []; replace(uri, range, text) { this.entries.push({uri, range, text}); } },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    CompletionItemKind: {Function: 1, Reference: 2, Keyword: 3, Folder: 4, File: 5},
    SemanticTokensLegend: class { constructor(tokens) { this.tokens = tokens; } },
    SemanticTokensBuilder: class {
      items = [];
      push(...item) { this.items.push(item); }
      build() { return this.items; }
    },
    workspace: {
      textDocuments: [mainDoc, libDoc], getWorkspaceFolder: () => ({uri: uri(root)}),
      getConfiguration: () => ({get: () => 'cdm8'}), onDidSaveTextDocument: () => dispose,
      onDidChangeTextDocument: () => dispose, onDidCloseTextDocument: () => dispose, onDidChangeConfiguration: () => dispose,
    },
    window: {visibleTextEditors: [], onDidChangeVisibleTextEditors: () => dispose},
    languages: new Proxy({createDiagnosticCollection: () => dispose}, {
      get(target, name) {
        return target[name] ?? ((_selector, provider) => { providers[name] = provider; return dispose; });
      },
    }),
  };
  const file = path.resolve(__dirname, '../src/editor.js');
  const code = await fs.readFile(file, 'utf8');
  const nodeRequire = createRequire(file);
  const moduleForTest = {exports: {}};
  const execute = vm.runInThisContext('(function(require, module) {' + code + '\n})', {filename: file});
  execute(name => name === 'vscode' ? api : name === './format-editor' ? {registerFormatter() {}} : nodeRequire(name), moduleForTest);
  const context = {subscriptions: []};
  const profiles = new Map();
  context.globalState = {get: key => profiles.get(key), update: async (key, value) => profiles.set(key, value)};
  moduleForTest.exports.registerEditor(context);
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  const token = {isCancellationRequested: false};
  const lenses = providers.registerCodeLensProvider.provideCodeLenses(
    document(main, 'run boot\nmain:\nhalt\nboot:\nhalt\nend'));
  assert.equal(lenses.length, 1);
  assert.equal(lenses[0].range.start.line, 3);
  assert.equal(lenses[0].command.command, 'cdmProject.debug');
  assert.equal(lenses[0].command.arguments[0].fsPath, main);
  assert.equal(lenses[0].command.title, '▶ Debug');
  assert.equal(lenses[0].command.tooltip, 'Build and start debugging this file');
  api.env = {language: 'ru'};
  const russianLens = providers.registerCodeLensProvider.provideCodeLenses(document(main, 'main:\nhalt'))[0];
  assert.equal(russianLens.command.title, '▶ Отладить');
  assert.equal(russianLens.command.tooltip, 'Собрать и начать отладку этого файла');
  api.env = {language: 'en'};
  assert.deepEqual(providers.registerCodeLensProvider.provideCodeLenses(document(library.replace('.asm', '.mlb'), 'main:\nhalt')), []);
  const {chooseLaunchProfile} = require('../src/launch-profile');
  const profiled = path.join(root, 'profiled.asm');
  await chooseLaunchProfile(context.globalState, profiled, {target: 'cdm16', architecture: 'harvard'}, async items => items[0]);
  const profiledDoc = document(profiled, '    ldw r0, r');
  const profiledItems = await providers.registerCompletionItemProvider.provideCompletionItems(profiledDoc, new Position(0, 13), token);
  assert.ok(profiledItems.some(item => item.label === 'r7'));

  const definition = providers.registerDefinitionProvider;
  const locations = await definition.provideDefinition(mainDoc, new Position(3, 11), token);
  assert.equal(locations[0].uri.fsPath, library);
  assert.equal(locations[0].range.start.line, 2);

  const completion = providers.registerCompletionItemProvider;
  const files = await completion.provideCompletionItems(mainDoc, new Position(0, 16), token);
  assert.ok(files.some(item => item.label === 'math.asm'));
  const labels = await completion.provideCompletionItems(mainDoc, new Position(3, 8), token);
  const candidate = labels.find(item => item.label === 'calculate');
  assert.equal(candidate.documentation, 'Computes the result');
  assert.equal(candidate.additionalTextEdits[0].newText, 'calculate: ext\n');
  assert.equal(candidate.additionalTextEdits[0].position.line, 2);

  const commentItems = line => completion.provideCompletionItems(document(main, line), new Position(0, line.length), token);
  const suggestions = async line => (await commentItems(line)).map(item => item.label);
  assert.ok((await suggestions('    ld')).includes('ldi'));
  assert.ok((await suggestions('# @include "lib/m')).includes('math.asm'));
  assert.deepEqual(await suggestions('    tst '), ['r0', 'r1', 'r2', 'r3']);
  for (const line of ['    tst r0 ', '    tst r0, ', '    ldi r0 ', '    ldi r0 next',
    '    ldi r0 r1, ', '    ldi , ', '    halt ', '    is z ']) {
    assert.deepEqual(await suggestions(line), [], line);
  }
  assert.ok((await suggestions('    is ')).includes('z'));
  assert.deepEqual(await suggestions('    is z, '), ['and', 'or']);
  const comparisons = {'==': 'eq', '!=': 'ne', '>s': 'gt', '>=s': 'ge', '<s': 'lt', '<=s': 'le',
    '>u': 'hi', '>=u': 'hs', '<u': 'lo', '<=u': 'ls'};
  for (const target of ['cdm8', 'cdm8e', 'cdm16', 'cdm16e']) {
    const file = path.join(root, 'comparison.' + target + '.asm');
    for (const clause of ['is', 'stays', 'until']) {
      for (const [alias, condition] of Object.entries(comparisons)) {
        const line = 'label: ' + clause + ' ' + alias + ' # keep comment';
        const column = line.indexOf(' #');
        const items = await completion.provideCompletionItems(document(file, line), new Position(0, column), token);
        const item = items.find(item => item.filterText === alias);
        assert.ok(item, target + ' ' + clause + ' ' + alias);
        assert.equal(item.insertText, condition);
        assert.equal(line.slice(0, item.range.start.character) + item.insertText + line.slice(item.range.end.character),
          'label: ' + clause + ' ' + condition + ' # keep comment');
        if (alias.endsWith('s')) assert.match(item.detail, /Знаковое/);
        if (alias.endsWith('u')) assert.match(item.detail, /Беззнаковое/);
      }
    }
  }
  for (const operator of ['>', '>=', '<', '<=']) {
    const items = await commentItems('    stays ' + operator);
    assert.equal(items.filter(item => item.filterText === operator + 's' || item.filterText === operator + 'u').length, 2);
  }
  for (const clause of ['is', 'stays', 'until', 'IS']) {
    for (const [alias, condition] of Object.entries(comparisons)) {
      const line = '    ' + clause + ' ' + alias;
      const item = (await commentItems(line)).find(item => item.filterText === alias);
      assert.ok(item, line);
      assert.equal(line.slice(0, item.range.start.character) + item.insertText, '    ' + clause + ' ' + condition);
    }
  }
  const middle = '    is >=u, and # keep';
  const midItems = await completion.provideCompletionItems(document(main, middle), new Position(0, 8), token);
  const midItem = midItems.find(item => item.filterText === '>=u');
  assert.equal(middle.slice(0, midItem.range.start.character) + midItem.insertText + middle.slice(midItem.range.end.character),
    '    is hs, and # keep');
  assert.ok((await commentItems('    is ')).some(item => item.filterText === '<s'));
  assert.ok((await commentItems('    stays h')).some(item => item.label === 'hi'));
  for (const line of ['# is >=', '    dc "is >=', '    cmp r0, >=', '    is >=s ', '    is z, >=', '    stays >= # comment']) {
    assert.ok(!(await commentItems(line)).some(item => item.filterText), line);
  }
  const completeInModule = line => completion.provideCompletionItems(
    document(main, '# @include "lib/math.asm"\n' + line), new Position(1, line.length), token);
  assert.ok((await completeInModule('    ldi r0, ')).some(item => item.label === 'calculate'));
  assert.deepEqual((await completeInModule('    st r1, ')).map(item => item.label), ['r0', 'r1', 'r2', 'r3']);
  assert.ok((await completeInModule('    dc "a,b", ')).some(item => item.label === 'calculate'));
  assert.deepEqual(await completeInModule('    dc first second, '), []);
  const macro = 'macro put/2\nmend\n    put r0, ';
  assert.ok((await completion.provideCompletionItems(document(main, macro), new Position(2, 12), token))
    .some(item => item.label === 'r0'));
  const tags = await commentItems('# @');
  assert.deepEqual(tags.map(item => item.label), ['@type', '@param', '@return', '@returns', '@changed']);
  assert.equal(tags[0].insertText, '@type: ');
  const types = await commentItems('# @type: i');
  assert.deepEqual(types.map(item => item.label), ['i8', 'i16']);
  assert.equal(types[0].range.start.character, 9);
  const registers = await commentItems('# @param r');
  assert.deepEqual(registers.map(item => item.label), ['r0', 'r1', 'r2', 'r3']);
  assert.ok((await commentItems('# @return ')).some(item => item.label === 'r0'));
  assert.ok((await commentItems('# @changed ')).some(item => item.label === 'PS'));
  assert.deepEqual(await commentItems('    dc "# @type: i"'), []);

  const manifest = require('../package.json');
  for (const language of ['cocovs-assembly', 'cdm8-assembly', 'cdm8e-assembly', 'cdm16-assembly', 'cdm16e-assembly']) {
    const defaults = manifest.contributes.configurationDefaults['[' + language + ']'];
    assert.deepEqual(defaults['editor.quickSuggestions'], {other: 'on', comments: 'on', strings: 'on'});
    assert.equal(defaults['editor.suggestOnTriggerCharacters'], true);
    assert.ok(manifest.activationEvents.includes('onLanguage:' + language));
  }

  const hover = providers.registerHoverProvider;
  const documented = document(main, '# @param r0 Input\n# @return r1 Result\n# @changed PS Flags\nroutine:\n    rts');
  const details = await hover.provideHover(documented, new Position(3, 1), token);
  assert.match(details.contents[0].value, /Inputs[\s\S]*r0 Input|Inputs[\s\S]*r0 - Input/);
  assert.match(details.contents[0].value, /Returns[\s\S]*r1 Result/);
  assert.match(details.contents[0].value, /Changed[\s\S]*PS Flags/);

  const semantic = providers.registerDocumentSemanticTokensProvider;
  const startupTokens = await semantic.provideDocumentSemanticTokens(document(main, 'run start\nstart:\nhalt'), token);
  assert.ok(startupTokens.some(([line, column, length, type]) => line === 0 && column === 0 && length === 3 && type === 4));
  assert.ok(startupTokens.some(([line, column, length, type]) => line === 0 && column === 4 && length === 5 && type === 2));
  assert.equal(manifest.contributes.semanticTokenTypes[4].id, 'cocovsDirective');
  assert.deepEqual(manifest.contributes.semanticTokenScopes[0].scopes.cocovsDirective, ['keyword.control.cocovs']);
  const wide = document(path.join(root, 'sample.cdm16.asm'), '    ldw r0, r1, r2');
  const wideHover = await hover.provideHover(wide, new Position(0, 5), token);
  assert.match(wideHover.contents[0].value, /ldw\(addressRegister, destination\)\nldw\(baseRegister, indexRegister, destination\)/);
  assert.match(wideHover.contents[0].value, /Read from data memory[\s\S]*\*\*Inputs\*\*[\s\S]*\*\*Returns\*\*[\s\S]*16-bit word/);
  assert.equal(await hover.provideHover(wide, new Position(0, 9), token), undefined);
  const help = await providers.registerSignatureHelpProvider.provideSignatureHelp(wide, new Position(0, 15), token);
  assert.equal(help.signatures[help.activeSignature].parameters[help.activeParameter].label, 'destination');
  const narrow = await hover.provideHover(document(main, '    ldi r0, 42'), new Position(0, 5), token);
  assert.match(narrow.contents[0].value, /ldi\(destination, value\)[\s\S]*\*\*Inputs\*\*[\s\S]*\*\*Returns\*\*[\s\S]*receives the byte value/);
  const narrowExtended = document(path.join(root, 'sample.cdm8e.asm'), '    ldi r0, 42');
  assert.match((await hover.provideHover(narrowExtended, new Position(0, 5), token)).contents[0].value, /ldi\(destination, value\)/);
  const extendedHelp = await providers.registerSignatureHelpProvider.provideSignatureHelp(narrowExtended, new Position(0, 14), token);
  assert.equal(extendedHelp.signatures[0].parameters[extendedHelp.activeParameter].label, 'value');
  const add = await hover.provideHover(document(wide.fileName, '    add r0, r1, r2'), new Position(0, 5), token);
  assert.match(add.contents[0].value, /add\(first, second\)\nadd\(first, second, destination\)\nadd\(register, immediate\)/);
  assert.match(add.contents[0].value, /\*\*Inputs\*\*[\s\S]*immediate - constant value to add/);
  assert.match(add.contents[0].value, /\*\*Returns\*\*[\s\S]*low 16 bits of the sum/);
  const extended = document(path.join(root, 'sample.cdm16e.asm'), '    swpw r0, r1');
  assert.match((await hover.provideHover(extended, new Position(0, 5), token)).contents[0].value, /Atomically exchange/);
  assert.equal(await hover.provideHover(document(wide.fileName, '    swpw r0, r1'), new Position(0, 5), token), undefined);
  const highlights = await semantic.provideDocumentSemanticTokens(mainDoc, token);
  assert.ok(highlights.some(([line, column, length, type]) => line === 3 && column === 4 && length === 3 && type === 3));
  assert.ok(highlights.some(([line, column, length, type]) => line === 3 && column === 8 && length === 9 && type === 2));

  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify({entry: 'main.asm', target: 'cdm8'}));
  const importer = document(main, '# @include "lib/math.asm"\ncalculate: ext\nasect 0\n    jsr calculate\n    halt\nend\n');
  api.workspace.textDocuments[0] = importer;
  const rename = providers.registerRenameProvider;
  const selected = await rename.prepareRename(importer, new Position(3, 10), token);
  assert.equal(selected.placeholder, 'calculate');
  const edit = await rename.provideRenameEdits(importer, new Position(3, 10), 'sum', token);
  assert.deepEqual(edit.entries.map(entry => [entry.uri.fsPath, entry.range.start.line, entry.text]),
    [[main, 1, 'sum'], [main, 3, 'sum'], [library, 2, 'sum']]);
});

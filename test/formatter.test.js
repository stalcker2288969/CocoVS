'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {FORMAT_FILE, formatAssembly, formatSettings} = require('../src/formatter');
const {command, processResult} = require('../src/tools');

const source = [
  '# @include "lib/*"', '  asect 0', '    start:', ' ldi r0, 0 # initial',
  '\tldi r1, 1    # increment', 'while', 'tst r0', ' stays nz', 'if',
  'tst r1', 'is z', 'then', 'add r0, r1', 'else', 'sub r0, r1', 'fi',
  '  wend', ' halt # last', '# @type: str', '  message:',
  'dc "hello # world", \'#\'  # data', '  end  ', '',
].join('\r\n');

const expected = [
  '# @include "lib/*"', 'asect 0', 'start:', '    ldi r0, 0  # initial',
  '    ldi r1, 1  # increment', '    while', '        tst r0', '    stays nz', '        if',
  '            tst r1', '        is z', '        then', '            add r0, r1', '        else',
  '            sub r0, r1', '        fi', '    wend', '    halt  # last', '# @type: str', 'message:',
  '    dc "hello # world", \'#\'  # data', 'end', '',
].join('\r\n');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-format-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('formatting preserves assembly tokens, comments and line endings, and is idempotent', () => {
  assert.equal(formatAssembly(source), expected);
  assert.equal(formatAssembly(expected), expected);
  assert.equal(formatAssembly('asect 0\nstart:\nif\ntst r0\nis z\nthen\n# then branch\nelse\n# else branch\nfi\nend\n'),
    'asect 0\nstart:\n    if\n        tst r0\n    is z\n    then\n        # then branch\n    else\n        # else branch\n    fi\nend\n');
  assert.equal(formatAssembly('macro local/0\n label\':\n br label\' # loop\n mend\n'),
    'macro local/0\nlabel\':\n    br label\'  # loop\nmend\n');
  const settings = formatSettings({indentSize: 2, indentStyle: 'tabs', commentColumn: 19});
  const text = formatAssembly('asect 0\n  jsr load_value # call\n halt # done\nend', settings);
  assert.equal(text, 'asect 0\n\tjsr load_value  # call\n\thalt            # done\nend');
  assert.throws(() => formatSettings({indentSize: 0}), /indentSize/);
});

test('the VS Code formatter applies project settings to save and creates the settings file without overwriting', async t => {
  const root = await fixture(t);
  const project = path.join(root, 'nested');
  const sourceFile = path.join(project, 'lib', 'main.asm');
  await fs.mkdir(path.dirname(sourceFile), {recursive: true});
  await fs.writeFile(path.join(project, 'cdm-project.json'), '{"target":"cdm8","entry":"lib/main.asm"}');
  const configFile = path.join(project, FORMAT_FILE);
  const initial = 'asect 0\n label:\n\t halt # done\nend';
  const uri = fsPath => ({fsPath, scheme: 'file'});
  const document = {uri: uri(sourceFile), fileName: sourceFile, languageId: 'cocovs-assembly', getText: () => initial};
  const registered = {};
  const disposable = {dispose() {}};
  const api = {
    Uri: {file: uri},
    Range: class { constructor(line, start, _endLine, end) { Object.assign(this, {line, start, end}); } },
    TextEdit: {replace: (range, text) => ({range, text})},
    workspace: {
      getWorkspaceFolder: () => ({uri: uri(root)}),
      onWillSaveTextDocument: listener => { registered.save = listener; return disposable; },
    },
    window: {
      activeTextEditor: {document},
      showTextDocument: async uri => { registered.opened = uri.fsPath; },
      showWarningMessage: message => assert.fail(message),
    },
    languages: {
      registerDocumentFormattingEditProvider: (_selector, provider) => { registered.provider = provider; return disposable; },
    },
    commands: {
      registerCommand: (_name, callback) => { registered.create = callback; return disposable; },
    },
  };
  const file = path.resolve(__dirname, '../src/format-editor.js');
  const requireModule = createRequire(file);
  const moduleForTest = {exports: {}};
  vm.runInThisContext('(function(require, module) {' + await fs.readFile(file, 'utf8') + '\n})', {filename: file})(
    name => name === 'vscode' ? api : requireModule(name), moduleForTest,
  );
  moduleForTest.exports.registerFormatter({subscriptions: []}, ['cocovs-assembly']);

  const save = () => {
    let edits;
    registered.save({document, waitUntil: promise => { edits = promise; }});
    return edits;
  };
  const apply = edits => {
    const lines = initial.split('\n');
    for (const {range: {line, start, end}, text} of edits) lines[line] = lines[line].slice(0, start) + text + lines[line].slice(end);
    return lines.join('\n');
  };
  assert.equal(apply(await save()), 'asect 0\nlabel:\n    halt  # done\nend');
  await registered.create();
  assert.equal(registered.opened, configFile);
  const settings = '{\n  // Local project style\n  "indentSize": 2,\n  "commentColumn": 14,\n}';
  await fs.writeFile(configFile, settings);
  await registered.create();
  assert.equal(await fs.readFile(configFile, 'utf8'), settings);
  assert.equal(apply(await save()), 'asect 0\nlabel:\n  halt       # done\nend');
  await fs.writeFile(configFile, '{"formatOnSave":false,"indentSize":2}');
  assert.deepEqual(await save(), []);
  assert.equal(apply(registered.provider.provideDocumentFormattingEdits(document)), 'asect 0\nlabel:\n  halt  # done\nend');
});

test('CoCAS emits the same image after formatting structured code', {skip: process.env.COCOVS_INTEGRATION !== '1'}, async t => {
  const root = await fixture(t);
  for (const [name, text] of [['before', source], ['after', expected]]) {
    const file = path.join(root, name + '.asm');
    await fs.writeFile(file, text);
    const output = await processResult(command(process.env.COCOVS_COCAS ?? 'cocas'),
      ['-t', 'cdm8', '-o', name + '.img', file], {cwd: root});
    assert.equal(output.code, 0, output.stderr || output.stdout);
  }
  assert.deepEqual(await fs.readFile(path.join(root, 'before.img')), await fs.readFile(path.join(root, 'after.img')));
});

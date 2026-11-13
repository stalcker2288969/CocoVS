'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {findCdmbot, jsonResult, editCdmbot, exactCasePattern} = require('../src/cdmbot');

test('selected names are passed to cdmbot as literal glob patterns', () => {
  assert.equal(exactCasePattern('sum[1]*?'), 'sum[[]1][*][?]');
});

test('cdmbot YAML creation, discovery, project checks and selected cases use the real runner', {
  skip: process.env.COCOVS_INTEGRATION !== '1' || process.env.COCOVS_SKIP_CDMBOT === '1',
}, async t => {
  const temp = process.env.COCOVS_TEST_TEMP ?? os.tmpdir();
  const root = await fs.mkdtemp(path.join(temp, 'cocovs-cdmbot-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const interpreter = await findCdmbot(process.env.COCOVS_PYTHON);
  assert.ok(interpreter);
  const manifest = path.join(root, 'project.yaml');
  const suite = path.join(root, 'tests.yaml');
  const source = path.join(root, 'main.asm');
  await fs.writeFile(source, 'asect 0\n    ldi r0, 5\n    halt\nend\n');
  await fs.writeFile(manifest, 'version: 1\nsource_roots: [.]\nsuites: {} # keep this comment\nstructure:\n  files: [main.asm]\n');
  const created = await editCdmbot(interpreter, 'suite', manifest, ['smoke', 'main.asm', 'tests.yaml', 'cdm8', 'unified']);
  assert.match(created.manifest, /# keep this comment/);
  await fs.writeFile(manifest, created.manifest);
  await fs.writeFile(suite, created.suite);
  const added = await editCdmbot(interpreter, 'case', suite, ['result[0]']);
  await fs.writeFile(suite, added.replace('  result[0]:\n    run:', '  result[0]:\n    expect: {registers: {r0: 5}}\n    run:'));
  const discovered = await editCdmbot(interpreter, 'discover', manifest);
  assert.deepEqual(discovered[0].cases.map(item => item.name).sort(), ['result[0]', 'smoke']);
  const options = {cwd: root, env: {...process.env, TEMP: temp, TMP: temp, TMPDIR: temp}};
  const all = await jsonResult(interpreter, ['-m', 'cdmbot', 'project', manifest, '--json'], options);
  assert.equal(all.report.passed, true, JSON.stringify(all.report));
  assert.equal(all.report.summary.passed, 2);
  const only = await jsonResult(interpreter, ['-m', 'cdmbot', source, suite, '--json', '--case', exactCasePattern('result[0]')], options);
  assert.deepEqual(only.report.cases.map(item => [item.name, item.started, item.passed]), [['result[0]', true, true]]);
  await exerciseController(t, {root, manifest, interpreter, env: options.env});
});

async function exerciseController(t, {root, manifest, interpreter, env}) {
  const result = [];
  const calls = [];
  const context = {subscriptions: []};
  const disposable = {dispose() {}};
  const uri = fsPath => ({fsPath, toString: () => fsPath});
  const collection = parent => {
    const items = new Map();
    return {
      get: key => items.get(key),
      add: item => { item.parent = parent; items.set(item.id, item); },
      delete: key => items.delete(key),
      forEach: callback => items.forEach(callback),
    };
  };
  let execute;
  const controller = {
    ...disposable, items: collection(),
    createTestItem(id, label, uri) {
      const item = {id, label, uri};
      item.children = collection(item);
      return item;
    },
    createRunProfile(_label, _kind, callback) { execute = callback; return disposable; },
    createTestRun() {
      return new Proxy({}, {get: (_, status) => item => result.push([status, item?.label])});
    },
  };
  const file = path.resolve(__dirname, '../src/testing.js');
  const load = createRequire(file);
  const api = {
    tests: {createTestController: () => controller},
    commands: {registerCommand: () => disposable},
    Uri: {file: uri}, Range: class {}, TestRunProfileKind: {Run: 1},
    window: {showErrorMessage: message => assert.fail(message)},
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({get: (_key, fallback) => fallback}),
      findFiles: async () => [uri(manifest)],
      getWorkspaceFolder: () => ({uri: uri(root), name: 'demo'}),
      saveAll: async () => true,
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: () => disposable,
      onDidChangeConfiguration: () => disposable,
      createFileSystemWatcher: () => ({...disposable, onDidCreate: () => disposable,
        onDidChange: () => disposable, onDidDelete: () => disposable}),
    },
  };
  const cdmbot = load('./cdmbot');
  const code = await fs.readFile(file, 'utf8');
  const moduleForTest = {exports: {}};
  vm.runInThisContext('(function(require, module) {' + code + '\n})', {filename: file})(name => {
    if (name === 'vscode') return api;
    if (name !== './cdmbot') return load(name);
    return {...cdmbot, findCdmbot: async () => interpreter, jsonResult: (tool, args, options) => {
      calls.push(args);
      return jsonResult(tool, args, {...options, env});
    }};
  }, moduleForTest);
  moduleForTest.exports.registerTesting(context);
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  await controller.refreshHandler();
  const project = controller.items.get(manifest);
  let suite;
  project.children.forEach(item => { if (item.label === 'smoke') suite = item; });
  let selected;
  suite.children.forEach(item => { if (item.label === 'result[0]') selected = item; });
  const token = {onCancellationRequested: () => disposable};
  await execute({include: [selected]}, token);
  assert.deepEqual(result.filter(([state]) => state === 'passed'), [['passed', 'result[0]']]);
  assert.ok(calls[0].includes(exactCasePattern('result[0]')));
  await execute({include: [project], exclude: [selected]}, token);
  assert.ok(!calls[1].includes('project'));
  assert.ok(result.some(([state, label]) => state === 'skipped' && label === 'Project checks'));
}

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {command} = require('../src/tools');

test('the native VS Code launch provider builds an active CdM-8 file with no launch.json', {
  skip: process.env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-launch-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'sample.asm');
  await fs.writeFile(source, 'asect 0\n    halt\nend\n');

  const uri = fsPath => ({fsPath, scheme: 'file', toString: () => fsPath});
  const folder = {uri: uri(root)};
  const disposable = {dispose() {}};
  const token = {onCancellationRequested: () => disposable};
  const output = [];
  let provider;
  let saves = 0;
  const commands = new Map();
  const api = {
    Uri: {file: uri}, ProgressLocation: {},
    window: {
      activeTextEditor: {document: {uri: uri(source), languageId: 'cocovs-assembly'}},
      createOutputChannel: () => ({show() {}, append: text => output.push(text), appendLine: text => output.push(text)}),
      showErrorMessage: message => assert.fail(message),
      showQuickPick: async () => 'cdm8',
      showTextDocument: async () => {},
      withProgress: (_options, action) => action(undefined, token),
    },
    workspace: {
      workspaceFolders: [folder], isTrusted: true,
      getWorkspaceFolder: () => folder,
      getConfiguration: () => ({get: key => ({target: 'cdm8', architecture: 'harvard', maxSteps: 500})[key]}),
      saveAll: async () => { saves++; return true; },
      onDidSaveTextDocument: () => disposable,
    },
    debug: {
      registerDebugConfigurationProvider(type, configurationProvider) {
        assert.equal(type, 'cocovs-debug');
        provider = configurationProvider;
        return disposable;
      },
      registerDebugAdapterDescriptorFactory: () => disposable,
    },
    languages: {createDiagnosticCollection: () => disposable},
    tasks: {registerTaskProvider: () => disposable},
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return disposable; }},
  };
  const file = path.resolve(__dirname, '../src/extension.js');
  const code = await fs.readFile(file, 'utf8');
  const requireModule = createRequire(file);
  const moduleForTest = {exports: {}};
  const replacements = {
    vscode: api,
    './editor': {registerEditor() {}},
    './testing': {registerTesting() {}},
    './memory-view': {memoryView: () => () => {}},
    './setup': {registerSetup: () => ({
      toolchain: {prepare: async () => ({cocas: command(process.env.COCOVS_COCAS ?? 'cocas')})},
    })},
  };
  vm.runInThisContext('(function(require, module) {' + code + '\n})', {filename: file})(
    name => replacements[name] ?? requireModule(name), moduleForTest,
  );
  moduleForTest.exports.activate({subscriptions: []});

  const config = provider.resolveDebugConfiguration(folder, {});
  assert.equal(config.type, 'cocovs-debug');
  assert.equal(config.request, 'launch');
  const launch = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config, token);
  assert.equal(launch.architecture, 'harvard');
  assert.equal(launch.maxSteps, 500);
  assert.match(await fs.readFile(launch.artifacts.image, 'utf8'), /v2\.0 raw/);
  assert.ok(JSON.parse(await fs.readFile(launch.artifacts.debug, 'utf8')).codeLocations);
  assert.equal(saves, 1);
  assert.equal(output.filter(line => line.startsWith('Built ')).length, 1);
  await assert.rejects(fs.access(path.join(root, '.vscode', 'launch.json')), {code: 'ENOENT'});

  const prebuilt = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, {...launch, maxSteps: 100}, token);
  assert.equal(prebuilt.maxSteps, 100);
  assert.equal(saves, 1);

  await commands.get('cdmProject.init')();
  const generated = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'launch.json'), 'utf8'));
  const tasks = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'tasks.json'), 'utf8'));
  assert.equal(generated.configurations[0].type, 'cocovs-debug');
  assert.equal(generated.configurations[0].preLaunchTask, tasks.tasks[0].label);
  assert.match(await fs.readFile(path.join(root, 'main.asm'), 'utf8'), /halt/);
});

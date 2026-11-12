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
  const errors = [];
  let provider;
  let taskProvider;
  let commandLaunch;
  let saves = 0;
  const commands = new Map();
  const api = {
    Uri: {file: uri}, ProgressLocation: {}, Range: class {}, Diagnostic: class {}, DiagnosticSeverity: {Error: 0},
    TaskScope: {Workspace: 2},
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    EventEmitter: class {
      event = listener => { this.listener = listener; return disposable; };
      fire(value) { this.listener?.(value); }
      dispose() {}
    },
    window: {
      activeTextEditor: {document: {uri: uri(source), languageId: 'cocovs-assembly'}},
      createOutputChannel: () => ({show() {}, append: text => output.push(text), appendLine: text => output.push(text)}),
      showErrorMessage: message => errors.push(message),
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
      async startDebugging(folder, config) {
        commandLaunch = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config, token);
        return !!commandLaunch;
      },
    },
    languages: {createDiagnosticCollection: () => ({...disposable, set() {}, delete() {}})},
    tasks: {registerTaskProvider(type, provider) {
      assert.equal(type, 'cocovs');
      taskProvider = provider;
      return disposable;
    }},
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return disposable; }},
  };
  const file = path.resolve(__dirname, '../src/extension.js');
  const code = await fs.readFile(file, 'utf8');
  const requireModule = createRequire(file);
  const moduleForTest = {exports: {}};
  const replacements = {
    vscode: api,
    './editor': {registerEditor() {
      assert.ok(taskProvider, 'The task provider must already be registered');
      throw new Error('Simulated editor initialization failure');
    }},
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
  assert.ok(output.some(line => line.startsWith('Editor: Error: Simulated editor initialization failure')));

  const config = provider.resolveDebugConfiguration(folder, {});
  assert.equal(config.type, 'cocovs-debug');
  assert.equal(config.request, 'launch');
  const launch = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config, token);
  assert.equal(launch.architecture, 'harvard');
  assert.equal(launch.stopOnEntry, true);
  assert.equal(launch.maxSteps, 500);
  assert.match(await fs.readFile(launch.artifacts.image, 'utf8'), /v2\.0 raw/);
  assert.ok(JSON.parse(await fs.readFile(launch.artifacts.debug, 'utf8')).codeLocations);
  assert.equal(saves, 1);
  assert.equal(output.filter(line => line.startsWith('Built ')).length, 1);
  await assert.rejects(fs.access(path.join(root, '.vscode', 'launch.json')), {code: 'ENOENT'});

  const prebuilt = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, {...launch, maxSteps: 100}, token);
  assert.equal(prebuilt.maxSteps, 100);
  assert.equal(saves, 1);

  await commands.get('cdmProject.debug')();
  assert.deepEqual(commandLaunch, launch);
  assert.equal(saves, 2);

  await commands.get('cdmProject.init')();
  const generated = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'launch.json'), 'utf8'));
  const tasks = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'tasks.json'), 'utf8'));
  assert.equal(generated.configurations[0].type, 'cocovs-debug');
  assert.equal(generated.configurations[0].preLaunchTask, undefined);
  assert.equal(generated.configurations[0].artifacts, undefined);
  assert.equal(tasks.tasks[0].label, 'CdM Project: Compile');
  assert.equal(tasks.tasks[0].type, 'cocovs');
  assert.match(await fs.readFile(path.join(root, 'main.asm'), 'utf8'), /halt/);
  const old = provider.resolveDebugConfiguration(folder, {...generated.configurations[0], root,
    target: 'cdm16', architecture: 'harvard', artifacts: launch.artifacts, preLaunchTask: tasks.tasks[0].label});
  assert.equal(old.preLaunchTask, undefined);
  const projectLaunch = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, old, token);
  assert.equal(projectLaunch.target, 'cdm8');
  assert.equal(projectLaunch.architecture, 'vonNeumann');
  assert.equal(projectLaunch.artifacts.image, path.join(root, 'build', 'out.img'));
  assert.deepEqual(errors, []);
  const buildTask = {scope: api.TaskScope.Workspace, definition: tasks.tasks[0]};
  assert.equal(taskProvider.resolveTask(buildTask), buildTask);
  const terminal = await buildTask.execution.callback(buildTask.definition);
  const taskOutput = [];
  terminal.onDidWrite(chunk => taskOutput.push(chunk));
  const exitCode = new Promise(resolve => terminal.onDidClose(resolve));
  terminal.open();
  assert.equal(await exitCode, 0, taskOutput.join(''));
  assert.match(taskOutput.join(''), /Built .*out\.img/);
  const image = await fs.readFile(projectLaunch.artifacts.image);
  await fs.writeFile(path.join(root, 'main.asm'), 'asect 0\nldi r0, a, a\nhalt\na: dc 0\nend\n');
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, old, token), undefined);
  assert.match(errors[0], /ldi: expected 2 arguments, got 3/);
  assert.deepEqual(await fs.readFile(projectLaunch.artifacts.image), image);
});

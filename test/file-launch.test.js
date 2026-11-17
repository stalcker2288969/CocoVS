'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {entryPoints} = require('../src/entry-points');
const {getLaunchProfile} = require('../src/launch-profile');

test('entry lenses prefer run targets and ignore macros, comments, strings, external and data labels', () => {
  assert.deepEqual(entryPoints('run boot # main\nmain:\nhalt\nboot:\nhalt\nend').map(s => s.name), ['boot']);
  assert.deepEqual(entryPoints('macro init/0\nstart:\nrun elsewhere\nmend\n# run fake\nasect 0\nmain:\nldi r0, 0\ninit:\nhalt\nprogram: dc "run fake"\nstart: ext\nend').map(s => s.name), ['main', 'init']);
  assert.deepEqual(entryPoints('main:\n# comment\ndc 0\nstart: ds 5\ninit: ext\nend'), []);
  assert.deepEqual(entryPoints('run missing\nmain:\nhalt\nend'), []);
  assert.deepEqual(entryPoints('run arbitrary\narbitrary> halt\nend').map(s => s.name), ['arbitrary']);
});

test('standalone launch remembers each file, supports cancellation and reconfiguration, and debugs the requested URI', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-file-launch-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const uri = fsPath => ({fsPath, scheme: 'file', toString: () => fsPath});
  const makeDoc = file => ({uri: uri(file), fileName: file, languageId: 'cocovs-assembly'});
  const first = makeDoc(path.join(root, 'first.asm'));
  const second = makeDoc(path.join(root, 'second.asm'));
  for (const doc of [first, second]) await fs.writeFile(doc.fileName, 'run main\nmain:\nhalt\nend\n');
  const commands = new Map(), state = new Map(), jobs = [], launches = [], errors = [];
  const dispose = {dispose() {}};
  const token = {onCancellationRequested: () => dispose};
  let provider, prompts = 0, choices = ['cdm16', 'harvard'];
  const context = {subscriptions: [], globalState: {
    get: key => state.get(key), update: async (key, value) => state.set(key, value),
  }};
  const api = {
    Uri: {file: uri}, ProgressLocation: {},
    EventEmitter: class { event = () => dispose; fire() {} dispose() {} },
    window: {
      activeTextEditor: {document: first},
      createOutputChannel: () => ({...dispose, show() {}, append() {}, appendLine() {}}),
      showErrorMessage: message => errors.push(message),
      showQuickPick: async items => { prompts++; const value = choices.shift(); return items.find(item => item.value === value); },
      withProgress: (_options, action) => action(undefined, token),
    },
    workspace: {
      isTrusted: true, textDocuments: [], getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({get: key => ({target: 'cdm8', architecture: 'vonNeumann', maxSteps: 100})[key]}),
      openTextDocument: async target => target.fsPath === first.fileName ? first : second,
      saveAll: async () => true, onDidSaveTextDocument: () => dispose,
    },
    tasks: {registerTaskProvider: () => dispose},
    languages: {createDiagnosticCollection: () => ({...dispose, set() {}, delete() {}})},
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return dispose; }},
    debug: {
      registerDebugConfigurationProvider: (_type, value) => { provider = value; return dispose; },
      registerDebugAdapterDescriptorFactory: () => dispose,
      startDebugging: async (folder, config) => { launches.push({folder, config}); return true; },
    },
  };
  const file = path.resolve(__dirname, '../src/extension.js');
  const requireModule = createRequire(file);
  const {artifactPaths, hasPackageImports} = requireModule('./build');
  const replacements = {
    vscode: api,
    './editor': {registerEditor() {}}, './testing': {registerTesting() {}}, './memory-view': {memoryView() {}},
    './setup': {registerSetup: () => ({toolchain: {prepare: async () => ({})}})},
    './build': {artifactPaths, hasPackageImports, build: async job => {
      jobs.push(structuredClone(job));
      return {ok: true, problems: [], artifacts: artifactPaths(job)};
    }},
    './runtime': {runProgram: async () => undefined},
  };
  const moduleForTest = {exports: {}};
  vm.runInThisContext('(function(require, module) {' + await fs.readFile(file, 'utf8') + '\n})', {filename: file})(
    name => replacements[name] ?? requireModule(name), moduleForTest);
  moduleForTest.exports.activate(context);
  await commands.get('cocovs.run')();
  assert.equal(prompts, 2);
  assert.deepEqual([jobs[0].config.target, jobs[0].config.architecture], ['cdm16', 'harvard']);
  await commands.get('cocovs.run')();
  assert.equal(prompts, 2);
  assert.equal(jobs.length, 2);
  // A second file is configured independently; cancelling either picker never builds it.
  await commands.get('cdmProject.debug')(second.uri);
  assert.equal(jobs.length, 2);
  choices = ['cdm8', undefined];
  await commands.get('cdmProject.debug')(second.uri);
  assert.equal(jobs.length, 2);
  assert.equal(getLaunchProfile(context.globalState, second.fileName), undefined);
  choices = ['cdm8', 'vonNeumann'];
  await commands.get('cdmProject.debug')(second.uri);
  assert.equal(jobs[2].config.entry, 'second.asm');
  assert.equal(launches[0].folder, undefined);
  assert.equal(launches[0].config.target, 'cdm8');
  assert.match(launches[0].config.artifacts.image, /second\.img$/);
  choices = ['cdm8', 'vonNeumann'];
  await commands.get('cocovs.configureFile')();
  const config = provider.resolveDebugConfiguration(undefined, {});
  const launch = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, config, token);
  assert.equal(launch.target, 'cdm8');
  assert.equal(launch.architecture, 'vonNeumann');
  assert.equal(jobs.at(-1).config.entry, 'first.asm');
  assert.deepEqual(getLaunchProfile(context.globalState, second.fileName), {target: 'cdm8', architecture: 'vonNeumann'});
  // A project remains authoritative and does not open standalone pickers.
  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify({entry: 'first.asm', target: 'cdm16', architecture: 'harvard'}));
  const before = prompts;
  await commands.get('cdmProject.build')();
  assert.equal(prompts, before);
  assert.equal(jobs.at(-1).manifest, true);
  assert.equal(jobs.at(-1).config.target, 'cdm16');
  assert.deepEqual(errors, []);
  await fs.unlink(path.join(root, 'cdm-project.json'));
  assert.deepEqual((await fs.readdir(root)).sort(), ['first.asm', 'second.asm']);
  api.workspace.isTrusted = false;
  const count = jobs.length;
  await commands.get('cocovs.run')();
  assert.equal(jobs.length, count);
  assert.match(errors[0], /Trust/);
});

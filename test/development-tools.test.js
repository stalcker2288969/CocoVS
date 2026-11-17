'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {cdmbotManager, managedCdmbotPython} = require('../src/development-tools');
const {resolveSources, loadProject, projectDependencies, verifyPackages} = require('../src/project');
const {build} = require('../src/build');
const {createJob} = require('../src/jobs');
const {jsonResult} = require('../src/cdmbot');
const {runProgram} = require('../src/runtime');
const {initializeProject} = require('../src/project-template');
const {exposeCdmbot} = require('../src/cdmbot-launcher');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-development-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('managed cdmbot installation is isolated, capability checked, and preserves the working environment on failure', async t => {
  const root = await fixture(t);
  let fail = false, creations = 0;
  const execute = async (tool, args) => {
    if (args.includes('venv')) {
      creations++;
      const python = path.join(args.at(-1), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      await fs.mkdir(path.dirname(python), {recursive: true});
      await fs.writeFile(python, 'test interpreter');
      return {code: 0};
    }
    if (args.includes('pip')) return {code: fail ? 1 : 0, stderr: 'simulated installation failure'};
    const ready = await fs.stat(tool.file).catch(() => undefined);
    return {code: ready ? 0 : 1, stdout: ready ? JSON.stringify({api: 1, automatic_packages: true, template_constants: true, unified_manifest: true, language_versions: ['1.0'], commands: ['build', 'analyze']}) : ''};
  };
  const manager = cdmbotManager(root, () => 'legacy-python', {prepare: async () => ({python: {file: 'base-python', args: []}})},
    execute, async () => ({file: 'legacy-python', args: []}));
  assert.equal(await manager.find(), undefined);
  const [first, second] = await Promise.all([manager.install(), manager.install()]);
  assert.equal(creations, 1);
  assert.equal(first.file, managedCdmbotPython(root));
  assert.equal(second.file, first.file);
  assert.equal((await manager.find()).file, first.file);
  fail = true;
  await assert.rejects(manager.install(), /simulated/);
  assert.equal(await fs.readFile(first.file, 'utf8'), 'test interpreter');
  assert.equal((await manager.find()).file, first.file);
});

test('initialization uses the shared CLI template and preserves an existing entry', async t => {
  const root = await fixture(t);
  const template = require('../src/project-template.json');
  const config = await initializeProject(root, 'cdm16', 'harvard');
  assert.equal(config.entry, 'src/main.asm');
  assert.equal(config.languageVersion, '1.0');
  assert.deepEqual(config.dependencies, {});
  assert.equal(await fs.readFile(path.join(root, config.entry), 'utf8'), template.sources.cdm16);
  assert.match(await fs.readFile(path.join(root, 'tests.yaml'), 'utf8'), /memory_model: harvard/);
  const existing = await fixture(t);
  await fs.writeFile(path.join(existing, 'main.asm'), 'asect 0\nhalt\nend\n');
  await fs.writeFile(path.join(existing, 'README.md'), 'Existing README');
  assert.equal((await initializeProject(existing, 'cdm8')).entry, 'main.asm');
  assert.equal(await fs.readFile(path.join(existing, 'README.md'), 'utf8'), 'Existing README');
  assert.equal(await fs.readFile(path.join(existing, 'main.asm'), 'utf8'), 'asect 0\nhalt\nend\n');
  await assert.rejects(fs.stat(path.join(existing, 'tests.yaml')), {code: 'ENOENT'});
  const library = path.join(root, 'my-lib');
  const manifest = await initializeProject(library, 'cdm16', 'vonNeumann', {library: true});
  assert.equal(manifest.languageVersion, '1.0');
  assert.deepEqual(manifest.dependencies, {});
  assert.equal(await fs.readFile(path.join(library, 'lib.asm'), 'utf8'), template.librarySource);
});

test('project dependencies merge legacy metadata and reject incompatible dialects', async t => {
  const root = await fixture(t);
  const project = {entry: 'main.asm', target: 'cdm8', languageVersion: '1.0', dependencies: {'byte-utils': '*'}};
  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify(project));
  await fs.writeFile(path.join(root, 'cdm-packages.json'), JSON.stringify({version: 1, dependencies: {other: '*'}}));
  assert.deepEqual(projectDependencies(root).dependencies, {'byte-utils': '*', other: '*'});
  await fs.writeFile(path.join(root, 'cdm-packages.json'), JSON.stringify({version: 1, dependencies: {'byte-utils': {git: 'different'}}}));
  assert.throws(() => projectDependencies(root), /conflicting/);
  project.languageVersion = '2.0';
  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify(project));
  assert.throws(() => loadProject(root), /Unsupported languageVersion/);
});

test('the native backend checks the dialect of installed packages with valid hashes', async t => {
  const root = await fixture(t);
  const config = {entry: 'main.asm', target: 'cdm8', languageVersion: '1.0', dependencies: {math: '*'}};
  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify(config));
  const directory = path.join(root, '.cdm/packages/math');
  await fs.mkdir(directory, {recursive: true});
  for (const version of ['2.0', undefined]) {
    const manifest = JSON.stringify({name: 'math', languageVersion: version});
    await fs.writeFile(path.join(directory, 'cdm-package.json'), manifest);
    const entry = {targets: ['cdm8'], dependencies: {}, files: {
      'cdm-package.json': createHash('sha256').update(manifest).digest('hex'),
    }};
    await fs.writeFile(path.join(root, 'cdm-packages.lock.json'), JSON.stringify({version: 1, packages: {math: entry}}));
    if (version) assert.throws(() => verifyPackages(root, config), /languageVersion.*incompatible/);
    else assert.doesNotThrow(() => verifyPackages(root, config));
  }
});

test('terminal launchers forward arguments and register a user PATH idempotently', async t => {
  const root = await fixture(t);
  const python = path.join(root, 'Python folder', 'python.exe');
  const calls = [];
  const options = {platform: 'win32', run: async (tool, args) => { calls.push({tool, args}); return {code: 0}; }};
  const launcher = await exposeCdmbot(root, python, options);
  await exposeCdmbot(root, python, options);
  assert.match(await fs.readFile(launcher.launcher, 'utf8'), /" -I -m cdmbot %\*/);
  assert.equal(calls[0].tool.file, python);
  assert.equal(calls[0].args.at(-1), launcher.directory);
  assert.match(calls[0].args[2], /HKEY_CURRENT_USER/);
  const unix = {platform: 'linux', userHome: root, shell: '/bin/bash'};
  await exposeCdmbot(root, "/a b/python'3", unix);
  await exposeCdmbot(root, "/a b/python'3", unix);
  assert.equal((await fs.readFile(path.join(root, '.bashrc'), 'utf8')).match(/export PATH/g).length, 1);
  assert.match(await fs.readFile(path.join(root, 'bin', 'cdmbot'), 'utf8'), / -I -m cdmbot "\$@"/);
});

test('package includes resolve for nested standalone files, reject traversal and require a lock entry', async t => {
  const root = await fixture(t);
  const directory = path.join(root, 'sorting');
  const library = path.join(directory, '.cdm', 'packages', 'math');
  await fs.mkdir(library, {recursive: true});
  await fs.writeFile(path.join(directory, 'cdm-packages.json'), '{}');
  await fs.writeFile(path.join(directory, 'cdm-packages.lock.json'), '{"packages":{"math":{}}}');
  await fs.writeFile(path.join(library, 'lib.asm'), 'rsect math\nincrement> inc r0\nrts\nend');
  await fs.writeFile(path.join(directory, 'main.asm'), '# @include "@math/lib.asm"\nasect 0\nhalt\nend');
  assert.deepEqual(resolveSources(root, {entry: 'sorting/main.asm'}), ['sorting/main.asm', 'sorting/.cdm/packages/math/lib.asm']);
  await fs.writeFile(path.join(directory, 'main.asm'), '# @include "@math/../../main.asm"');
  assert.throws(() => resolveSources(root, {entry: 'sorting/main.asm'}), /escapes/);
  await fs.writeFile(path.join(directory, 'main.asm'), '# @include "@other/lib.asm"');
  assert.throws(() => resolveSources(root, {entry: 'sorting/main.asm'}), /not locked/);
});

test('compatible cdmbot build reports retain CocoVS artifacts and legacy error diagnostics', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'main.asm');
  await fs.writeFile(file, 'asect 0\nhalt\nend');
  const job = createJob({file});
  let fail = false;
  const execute = async (_tool, args) => {
    assert.ok(args.includes('cdmbot'));
    assert.equal(args[args.indexOf('--workspace') + 1], root);
    if (fail) return {code: 1, stdout: JSON.stringify({passed: false, error: '[Assembler] ERROR at main.asm, line 2\nUnknown instruction'}), stderr: ''};
    const directory = args[args.indexOf('--output') + 1];
    await fs.writeFile(path.join(directory, 'main.img'), 'v2.0 raw\n00');
    await fs.writeFile(path.join(directory, 'main.dbg.json'), '{}');
    return {code: 0, stdout: '{"passed":true}', stderr: ''};
  };
  const options = {cdmbot: {file: 'python', args: []}};
  const success = await build(job, undefined, options, execute);
  assert.ok(success.ok);
  fail = true;
  const failed = await build(job, undefined, options, execute);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Unknown instruction/);
  assert.equal(await fs.readFile(success.artifacts.image, 'utf8'), 'v2.0 raw\n00');
});

test('installed cdmbot development API builds and tests a locked package through CocoVS', {
  skip: !process.env.COCOVS_CDMBOT_DEVELOPMENT_PYTHON,
}, async t => {
  const root = await fixture(t);
  const python = {file: process.env.COCOVS_CDMBOT_DEVELOPMENT_PYTHON, args: []};
  const cli = async args => (await jsonResult(python, ['-m', 'cdmbot', ...args, '--json'])).report;
  const app = path.join(root, 'app');
  assert.ok((await cli(['create', app, '--target', 'cdm8'])).passed);
  const configuration = JSON.parse(await fs.readFile(path.join(app, 'cdm-project.json'), 'utf8'));
  const local = path.join(root, 'local');
  await fs.mkdir(local);
  assert.deepEqual(configuration, await initializeProject(local, 'cdm8'));
  const cliLibrary = path.join(root, 'my-lib');
  assert.ok((await cli(['create', cliLibrary, '--library', '--target', 'cdm16'])).passed);
  const localLibrary = path.join(root, 'other', 'my-lib');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cliLibrary, 'cdm-package.json'), 'utf8')),
    await initializeProject(localLibrary, 'cdm16', 'vonNeumann', {library: true}));
  const file = path.join(app, 'src/main.asm');
  await fs.writeFile(file, '# @include "@byte-utils/lib.asm"\nbyte_increment: ext\nasect 0\nmain:\nsetsp 240\nldi r0, 41\njsr byte_increment\nhalt\nend\n');
  const job = createJob({file, workspace: app, allowMissingPackages: true});
  const report = await build(job, undefined, {cdmbot: python});
  assert.ok(report.ok, report.message + '\n' + report.details);
  const state = await runProgram(job, report.artifacts, {python}, {maxSteps: 1000});
  assert.equal(state.reason, 'halt');
  assert.equal(state.registers[0], 42);
  assert.equal(state.sp, 240);
  assert.ok(JSON.parse(await fs.readFile(path.join(app, 'cdm-packages.lock.json'), 'utf8')).packages['byte-utils']);
  assert.equal(JSON.parse(await fs.readFile(path.join(app, 'cdm-project.json'), 'utf8')).dependencies['byte-utils'], '*');
  await assert.rejects(fs.stat(path.join(app, 'cdm-packages.json')), {code: 'ENOENT'});
  const analyzed = await cli(['analyze', app]);
  assert.equal(analyzed.files.length, 2);
  assert.equal(analyzed.passed, true);
  assert.ok((await cli(['test', app])).passed, 'The new test command and legacy suite linker resolve package includes');
  const previous = await fs.readFile(report.artifacts.image);
  await fs.appendFile(path.join(app, '.cdm/packages/byte-utils/lib.asm'), '\n# modified\n');
  const modified = await build(job, undefined, {cdmbot: python});
  assert.equal(modified.ok, false);
  assert.match(modified.message, /modified/);
  const native = await build(job);
  assert.equal(native.ok, false);
  assert.match(native.message, /modified/);
  assert.deepEqual(await fs.readFile(report.artifacts.image), previous);
});

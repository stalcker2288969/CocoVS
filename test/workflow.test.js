'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createJob} = require('../src/jobs');
const {build, diagnostics, expandArgs} = require('../src/build');
const {friendlyMessage} = require('../src/assembly-errors');
const {decodeImage, runProgram} = require('../src/runtime');
const {branchTargets, colorTokens, completionContext, indexSymbols, symbolAt} = require('../src/symbols');
const {externalInsertionLine, includeCandidates, includeContext} = require('../src/editor-support');
const {syncConfigs} = require('../src/project');
const {command} = require('../src/tools');

const placeholder = name => '$' + '{' + name + '}';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('assembly target comes from the suffix or manifest and the task uses the manifest entry', async t => {
  const root = await fixture(t);
  const nested = path.join(root, 'a project');
  await fs.mkdir(nested);
  const file = path.join(nested, 'demo.cdm16e.asm');
  await fs.writeFile(file, 'asect 0\nhalt\nend\n');
  assert.equal(createJob({file, target: 'cdm8'}).config.target, 'cdm16e');
  await fs.writeFile(path.join(nested, 'cdm-project.json'), JSON.stringify({entry: 'demo.cdm16e.asm', target: 'cdm8'}));
  const job = createJob({file, workspace: root});
  assert.equal(job.config.target, 'cdm8');
  assert.equal(job.root, nested);
  assert.throws(() => createJob({file, workspace: root, task: true}), /cdm-project/);
  const {task, session} = syncConfigs(root, job.config, nested);
  assert.equal(task.project, 'a project');
  assert.equal(session.root, placeholder('workspaceFolder') + '/a project');
  assert.equal(session.artifacts, undefined);
});

test('symbol documentation follows adjacent comments and matches exported and macro names', () => {
  const source = [
    '# @include "math.mlb"', '# Add two numbers.', '# r0 receives the sum.', 'add_values, add_alias> halt',
    '# This comment is separated.', '', 'plain:', 'add_values: ext',
    '# Set a register.', 'macro set_value/2.', 'local:', 'mend',
    '    jsr add_values # plain', '    dc "add_values # abc"',
  ].join('\r\n');
  const symbols = indexSymbols(source);
  assert.deepEqual(symbols.map(symbol => symbol.name), ['add_values', 'add_alias', 'plain', 'set_value']);
  assert.equal(symbols[0].documentation, 'Add two numbers.\nr0 receives the sum.');
  assert.equal(symbols[1].exported, true);
  assert.equal(symbols[2].documentation, '');
  assert.equal(symbols[3].arity, 2);
  assert.equal(symbolAt('    jsr add_values # plain', 10), 'add_values');
  assert.equal(symbolAt('    jsr add_values # plain', 23), undefined);
  assert.equal(symbolAt('    dc "add_values # abc"', 12), undefined);
});

test('colors labels, user macros and standard mnemonics as separate token types', () => {
  const local = indexSymbols('macro ldvm/2\n    ld $1, $2\nmend\nstart, alias>\na:');
  const library = indexSymbols('*write_value/1\n    st $1, r0', true);
  const symbols = [...local, ...library];
  const macros = new Set(symbols.filter(symbol => symbol.kind === 'macro').map(symbol => symbol.name));
  const labels = new Set(symbols.filter(symbol => symbol.kind === 'label').map(symbol => symbol.name));
  const instructions = new Set(['ldi', 'ldv', 'ld', 'dc']);
  const classify = line => colorTokens(line, macros, labels, instructions);
  assert.deepEqual(classify('  macro ldvm/2'), [{column: 8, name: 'ldvm', kind: 'macro'}]);
  assert.deepEqual(classify('start, alias> ldvm r0, a # start'), [
    {column: 0, name: 'start', kind: 'label'},
    {column: 7, name: 'alias', kind: 'label'},
    {column: 14, name: 'ldvm', kind: 'macro'},
    {column: 23, name: 'a', kind: 'label'},
  ]);
  assert.deepEqual(classify('  write_value a').map(token => token.kind), ['macro', 'label']);
  assert.deepEqual(classify('  ldv r0, a').map(token => token.kind), ['instruction', 'label']);
  assert.deepEqual(classify('  dc "a" # ldvm').map(token => token.kind), ['instruction']);
  assert.deepEqual(classify('a: ext'), [{column: 0, name: 'a', kind: 'label'}]);
});

test('classifies branch opcodes, label operands and simple unresolved targets', () => {
  const instructions = new Set(['jsr', 'beq', 'jmp', 'bit', 'ret']);
  assert.deepEqual(colorTokens('  jsr init', new Set(), new Set(['init']), instructions), [
    {column: 2, name: 'jsr', kind: 'control'}, {column: 6, name: 'init', kind: 'label'},
  ]);
  assert.equal(colorTokens('bit r0', new Set(), new Set(), instructions)[0].kind, 'instruction');
  assert.deepEqual(branchTargets('  jsr init\n  beq missing\n  jmp r1\n  jsr init+1\nmacro abc/0\n  beq local\nmend', instructions), [
    {line: 0, name: 'init', column: 6}, {line: 1, name: 'missing', column: 6},
  ]);
  assert.equal(completionContext('  jsr ', 6).kind, 'operand');
  assert.equal(completionContext('  js', 4).kind, 'operation');
  assert.equal(completionContext('  dc "text"', 10), undefined);
  assert.deepEqual(indexSymbols('init: ext', false, true).map(symbol => [symbol.name, symbol.external]), [['init', true]]);
  assert.equal(externalInsertionLine('macro go/0\nasect 0\nmend\n# Section docs\nasect 5\n'), 3);
});

test('include completion uses the quoted path and suggests only eligible project entries', async t => {
  const root = await fixture(t);
  const main = path.join(root, 'main.asm');
  const lib = path.join(root, 'lib');
  await fs.mkdir(lib);
  await fs.mkdir(path.join(lib, 'subfolder'));
  await fs.writeFile(main, '');
  await fs.writeFile(path.join(lib, 'math module.asm'), '');
  await fs.writeFile(path.join(lib, 'macros.mlb'), '');
  await fs.writeFile(path.join(lib, 'notes.txt'), '');
  const text = '# @include "lib/ma" # tail';
  const context = includeContext(text, text.indexOf('" #'));
  assert.deepEqual(context, {directory: 'lib/', start: 16, end: 18, quote: '"', closed: true});
  const items = await includeCandidates(root, main, context.directory);
  assert.deepEqual(items.map(item => item.name).sort(), ['macros.mlb', 'math module.asm', 'subfolder']);
  assert.equal(items.find(item => item.name === 'subfolder').folder, true);
  assert.deepEqual(await includeCandidates(root, main, '../'), []);
  assert.deepEqual(await includeCandidates(root, main, ''), [{name: 'lib', folder: true}]);
});

test('CoCAS diagnostics handle Windows paths, multiple problems and color codes', () => {
  const result = diagnostics('[ASM] \x1b[31mERROR\x1b[39m at C:\\my project\\main.asm, line 4\nUnknown mnemonic\n' +
    '[ASM] WARNING at lib.asm, line 2\nCheck label\n[Linker] ERROR\nmissing symbol');
  assert.deepEqual(result, [
    {file: 'C:\\my project\\main.asm', line: 4, message: 'Unknown mnemonic', warning: false},
    {file: 'lib.asm', line: 2, message: 'Check label', warning: true},
  ]);
});

test('invalid operand counts and CoCAS errors with exit code zero do not replace a valid build', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'main.asm');
  const correct = 'asect 0\n    ldi r0, a\n    halt\na: dc "x,y", 2\nend\n';
  await fs.writeFile(file, correct);
  const job = createJob({file});
  const assembler = command('cocas');
  let stderr = '';
  let invocations = 0;
  const run = async (_tool, args) => {
    invocations++;
    await fs.writeFile(args[args.indexOf('-o') + 1], stderr ? 'incomplete image' : 'previous image');
    await fs.writeFile(args[args.indexOf('--debug') + 1], '{}');
    return {code: 0, stdout: '', stderr};
  };
  const good = await build(job, assembler, {}, run);
  assert.equal(good.ok, true);
  await fs.writeFile(file, correct.replace('ldi r0, a', 'ldi r0, a, a'));
  const bad = await build(job, assembler, {}, run);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, [{file, line: 2, warning: false, message: 'ldi: expected 2 arguments, got 3.'}]);
  assert.equal(invocations, 1);
  await fs.writeFile(file, correct);
  for (const report of ['[Assembler] ERROR at ' + file + ', line 2\nInvalid instruction',
    "line 2:12 extraneous input ',' expecting NEWLINE", '[Linker] ERROR\nMissing symbol']) {
    stderr = report;
    assert.equal((await build(job, assembler, {}, run)).ok, false);
    assert.equal(await fs.readFile(good.artifacts.image, 'utf8'), 'previous image');
    assert.match(await fs.readFile(good.artifacts.combined, 'utf8'), /ldi r0, a\n/);
  }
});

test('explains an included module’s missing end and logs the original diagnostic once', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'main.asm');
  const library = path.join(root, 'lib.asm');
  await fs.writeFile(file, '# @include "lib.asm"\nasect 0\nhalt\nend\n');
  await fs.writeFile(library, 'rsect routines\n');
  const raw = "[Assembler] \x1b[31mERROR\x1b[39m at lib.asm, line 2\nextraneous input '<EOF>' expecting {'asect', End, WORD}\n";
  const output = [];
  const result = await build(createJob({file}), command('cocas'), {
    language: 'ru', onOutput: text => output.push(text),
  }, async (_tool, _args, options) => {
    assert.equal(options.onOutput, undefined);
    return {code: 1, stdout: raw, stderr: raw};
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.message, /^lib\.asm:2 .*Неожиданный конец файла.*end/);
  assert.equal(output.length, 0);
  assert.match(result.details, /extraneous input '<EOF>'/);
  assert.equal((result.details.match(/extraneous input/g) ?? []).length, 1);
  assert.doesNotMatch(result.details, /\x1b/);
  assert.match(friendlyMessage("extraneous input '<EOF>' expecting {'fi', End}", 'en', 'asect 0\nif\nend\n'),
    /unclosed block/);
  assert.match(friendlyMessage('Unresolved ext "sum"', 'en'), /sum>/);
  assert.match(friendlyMessage('ldi: expected 2 operand(s), found 3.', 'ru'), /Ожидалось 2, указано 3/);
});

test('the raw image reader supports Logisim repeat syntax and rejects invalid data', () => {
  assert.deepEqual([...decodeImage('v2.0 raw\r\n42 2*ff # fill\r\na', 5)], [66, 255, 255, 10, 0]);
  assert.throws(() => decodeImage('v3.0 hex words addressed\n0', 4), /Expected/);
  assert.throws(() => decodeImage('v2.0 raw\n5*00', 4), /address space/);
  assert.throws(() => decodeImage('v2.0 raw\nxz', 4), /Invalid/);
});

test('custom assembler and runner pass each path as a distinct argument', async t => {
  const root = await fixture(t);
  const main = path.join(root, 'my game.asm');
  const helper = path.join(root, 'helper file.asm');
  const assembler = 'const fs=require("node:fs"); const [out,...src]=process.argv.slice(1); fs.writeFileSync(out,src.map(f=>fs.readFileSync(f,"utf8")).join(""));';
  const runner = 'const fs=require("node:fs"); const [image,out]=process.argv.slice(1); fs.writeFileSync(out,fs.readFileSync(image));';
  await fs.writeFile(main, '# @include "helper file.asm"\nmain\n');
  await fs.writeFile(helper, 'helper\n');
  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify({
    target: 'custom', entry: 'my game.asm', imageExtension: '.bin', instructions: ['store'],
    assembler: {command: process.execPath, args: ['-e', assembler, placeholder('image'), placeholder('sources')]},
    runner: {command: process.execPath, args: ['-e', runner, placeholder('image'), placeholder('project') + '/loaded image.bin']},
  }));
  assert.throws(() => expandArgs([placeholder('unknown')], {}, []), /Unknown command placeholder/);
  const job = createJob({file: main});
  const result = await build(job);
  assert.equal(result.ok, true);
  assert.equal(path.extname(result.artifacts.image), '.bin');
  await runProgram(job, result.artifacts, {});
  assert.equal(await fs.readFile(path.join(root, 'loaded image.bin'), 'utf8'), '# @include "helper file.asm"\nmain\nhelper\n');
});

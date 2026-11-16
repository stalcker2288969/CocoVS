'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createJob} = require('../src/jobs');
const {build} = require('../src/build');
const {runProgram} = require('../src/runtime');
const {createToolchain, command} = require('../src/tools');
const {findCdmbot, editCdmbot, jsonResult} = require('../src/cdmbot');

test('documented examples build and halt with their stated registers, memory and stack', {
  skip: process.env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-examples-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const toolchain = createToolchain(path.join(root, 'tools'), () => ({
    pythonPath: process.env.COCOVS_PYTHON, cocasPath: process.env.COCOVS_COCAS,
    javaPath: process.env.COCOVS_JAVA, cocoemuJar: process.env.COCOVS_JAR,
  }));
  const tools = await toolchain.inspect();
  tools.jar = await toolchain.findJar(tools.python, tools.cocas);
  assert.ok(tools.python && tools.cocas && tools.java && tools.jar, 'Installed Python, CoCAS, JDK and Cocoemu are required');
  for (const [directory, entry, registers, total, sp] of [
    ['single-file', 'countdown.cdm8.asm', {0: 0, 1: 15}, 15, 0xF0],
    ['single-file', 'comparisons.cdm8.asm', {2: 1, 3: 1}, undefined, 0xF0],
    ['single-file', 'word-sum.cdm16.asm', {1: 0, 2: 6000}, 6000, 0x8000],
    ['byte-sum', 'src/main.asm', {2: 50}, 50, 0xF0],
    ['word-sum', 'src/main.asm', {2: 15000}, 15000, 0x8000],
  ]) {
    await t.test(directory + '/' + entry, async () => {
      const destination = path.join(root, directory);
      await fs.cp(path.join(__dirname, '../examples', directory), destination, {recursive: true});
      const job = createJob({file: path.join(destination, entry), workspace: destination, architecture: 'vonNeumann'});
      const result = await build(job, tools.cocas, {python: tools.python,
        cdmbot: process.env.COCOVS_CDMBOT_DEVELOPMENT_PYTHON ? command(process.env.COCOVS_CDMBOT_DEVELOPMENT_PYTHON) : undefined});
      assert.equal(result.ok, true, result.message + '\n' + (result.details ?? ''));
      const state = await runProgram(job, result.artifacts, tools, {maxSteps: 1000});
      assert.equal(state.reason, 'halt');
      assert.equal(state.sp, sp);
      for (const [index, value] of Object.entries(registers)) assert.equal(state.registers[index], value);
      if (total !== undefined) {
        const metadata = JSON.parse(await fs.readFile(result.artifacts.debug, 'utf8'));
        const label = metadata.dataLabels.find(label => label.name === 'total');
        assert.ok(label, 'The output is visible as a data label in CocoVS RAM');
        const ram = await fs.readFile(state.ramFile);
        const value = job.config.target === 'cdm16' ? ram.readUInt16LE(label.address) : ram[label.address];
        assert.equal(value, total);
      }
    });
  }
});

test('example cdmbot projects discover and pass all cases, allow selection, and catch an incorrect expectation', {
  skip: process.env.COCOVS_INTEGRATION !== '1' || process.env.COCOVS_SKIP_CDMBOT === '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-example-tests-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const python = await findCdmbot(process.env.COCOVS_PYTHON);
  assert.ok(python, 'An installed cdmbot environment is required');
  for (const directory of ['byte-sum', 'word-sum']) {
    const destination = path.join(root, directory);
    await fs.cp(path.join(__dirname, '../examples', directory), destination, {recursive: true});
    const manifest = path.join(destination, 'project.yaml');
    const discovered = await editCdmbot(python, 'discover', manifest);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].cases.length, 5);
    assert.equal(discovered[0].error, undefined);
    const {report} = await jsonResult(python, ['-m', 'cdmbot', 'project', manifest, '--json', '--jobs', '1']);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.summary.passed, 5);
    const selected = await jsonResult(python, ['-m', 'cdmbot', discovered[0].program, discovered[0].file,
      '--json', '--case', 'empty']);
    assert.deepEqual(selected.report.cases.map(test => [test.name, test.passed]), [['empty', true]]);
  }
  const file = path.join(root, 'byte-sum/tests/sum.yaml');
  const before = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, before.replace('registers: {r2: 50}', 'registers: {r2: 51}'));
  const {report} = await jsonResult(python, ['-m', 'cdmbot', path.join(root, 'byte-sum/src/main.asm'), file,
    '--json', '--case', 'normal']);
  assert.equal(report.passed, false);
  assert.match(report.cases[0].failures.join('\n'), /r2/);
});

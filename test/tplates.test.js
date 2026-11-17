'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {indexSymbols} = require('../src/symbols');
const {createJob} = require('../src/jobs');
const {build} = require('../src/build');
const {checkSyntax} = require('../src/live-check');
const {runProgram} = require('../src/runtime');
const {command, createToolchain} = require('../src/tools');

const layout = 'tplate Person\nname: ds 10\nage: ds 1\nid: ds 3\n';

test('templates index qualified fields, sizes and source ranges', () => {
  const symbols = indexSymbols(layout + 'asect 0\nage: dc 0\nend\n');
  assert.match(symbols.find(symbol => symbol.name === 'Person.age').documentation, /= 10/);
  assert.match(symbols.find(symbol => symbol.name === 'Person.id').documentation, /= 11/);
  assert.match(symbols.find(symbol => symbol.name === 'Person._').documentation, /= 14/);
  assert.equal(symbols.find(symbol => symbol.name === 'Person.age').definitionLength, 3);
  assert.equal(symbols.filter(symbol => symbol.name === 'age').length, 1);
  const unknown = indexSymbols('tplate Dynamic\nfield: ds SOME_CONSTANT\nasect 0\nend');
  assert.match(unknown.find(symbol => symbol.name === 'Dynamic._').documentation, /evaluated by CoCAS/);
  const multiple = indexSymbols(layout + 'tplate Packet\nname: ds 2\npayload: ds 6\nasect 0\nend');
  assert.match(multiple.find(symbol => symbol.name === 'Packet._').documentation, /= 8/);
  assert.match(multiple.find(symbol => symbol.name === 'Packet.payload').documentation, /= 2/);
  assert.match(multiple.find(symbol => symbol.name === 'Person._').documentation, /= 14/);
});

test('CoCAS builds, diagnoses and executes template allocation on both CPUs', {
  skip: process.env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-tplates-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const toolchain = createToolchain(path.join(root, 'tools'), () => ({pythonPath: process.env.COCOVS_PYTHON,
    cocasPath: process.env.COCOVS_COCAS, javaPath: process.env.COCOVS_JAVA}));
  const tools = await toolchain.inspect();
  tools.jar = await toolchain.findJar(tools.python, tools.cocas);
  for (const target of ['cdm8', 'cdm16']) {
    const wide = target === 'cdm16';
    const source = layout + (wide ? 'asect 0\ndc start, 0\nasect 0x200\nstart:\nldi r7, 0x8000\nstsp r7\n' : 'asect 0\nsetsp 240\n') +
      'addsp -Person._\n' + (wide ? 'ldsp r0\nadd r0, Person.age\n' : 'ldsa r0, Person.age\n') +
      'ldi r1, 42\n' + (wide ? 'stb' : 'st') + ' r0, r1\nldi r2, Person._\nldi r3, 20-Person.age\naddsp Person._\nhalt\n' +
      (wide ? 'asect 0x9000\n' : 'asect 0xA0\n') + 'object: ds Person._\nend\n';
    const file = path.join(root, 'person.' + target + '.asm');
    await fs.writeFile(file, source);
    const python = command(process.env.COCOVS_PYTHON);
    const cocas = command(process.env.COCOVS_COCAS);
    const launchers = [cocas, command(python.file, ['-c', 'from cocas.main import main; raise SystemExit(main())'])];
    if (process.env.COCOVS_PIP_COCAS) launchers.push(command(process.env.COCOVS_PIP_COCAS));
    for (const launcher of launchers) {
      assert.deepEqual(await checkSyntax({root, target, sources: [{file, text: source}]}, launcher), []);
      const invalid = source.replace('addsp -Person._', 'addsp -Person.missing');
      const problems = await checkSyntax({root, target, sources: [{file, text: invalid}]}, launcher);
      assert.ok(problems.some(problem => !problem.warning && problem.line === invalid.split('\n').findIndex(line => line.includes('Person.missing')) + 1),
        JSON.stringify(problems));
    }
    const job = createJob({file});
    const built = await build(job, cocas, {python});
    assert.ok(built.ok, built.message + '\n' + built.details);
    const state = await runProgram(job, built.artifacts, tools, {maxSteps: 100});
    assert.equal(state.reason, 'halt');
    assert.equal(state.sp, wide ? 0x8000 : 240);
    assert.equal(state.registers[2], 14);
    assert.equal(state.registers[3], 10);
    if (process.env.COCOVS_CDMBOT_DEVELOPMENT_PYTHON) {
      const modern = await build(job, cocas, {python, cdmbot: command(process.env.COCOVS_CDMBOT_DEVELOPMENT_PYTHON)});
      assert.ok(modern.ok, modern.message);
    }
  }
});

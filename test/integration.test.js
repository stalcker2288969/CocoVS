'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createJob} = require('../src/jobs');
const {build} = require('../src/build');
const {runProgram} = require('../src/runtime');
const {createToolchain} = require('../src/tools');

const env = process.env;
const enabled = env.COCOVS_INTEGRATION === '1';
const skip = enabled ? false : 'Set COCOVS_INTEGRATION=1 to exercise installed tools.';

test('installed CoCAS, Python and Cocoemu compile and run CdM programs', {skip}, async t => {
  const root = await fs.mkdtemp(path.join(env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-integration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const toolchain = createToolchain(path.join(root, 'tools'), () => ({
    pythonPath: env.COCOVS_PYTHON, cocasPath: env.COCOVS_COCAS, javaPath: env.COCOVS_JAVA, cocoemuJar: env.COCOVS_JAR,
  }));
  const status = await toolchain.inspect();
  assert.ok(status.cocas, 'CoCAS must be installed');
  assert.ok(status.python, 'Python must be installed');
  assert.ok(status.java, 'A JDK must be installed');
  status.jar = await toolchain.findJar(status.python, status.cocas);
  assert.ok(status.jar, 'The Cocoemu JAR must be available');

  for (const target of ['cdm8', 'cdm8e', 'cdm16', 'cdm16e']) {
    await t.test(target + ' single file', async () => {
      const file = path.join(root, 'main.' + target);
      await fs.writeFile(file, 'asect 0\nstart:\n    ldi r0, 42\n    halt\nend\n');
      const job = createJob({file});
      const result = await build(job, status.cocas);
      assert.equal(result.ok, true, result.message);
      if (target === 'cdm8e') return;
      for (const architecture of ['vonNeumann', 'harvard']) {
        const state = await runProgram({...job, config: {...job.config, architecture}}, result.artifacts, status);
        assert.equal(state.reason, 'halt');
        assert.equal(state.registers[0], 42);
        assert.equal((await fs.stat(state.ramFile)).size, target === 'cdm8' ? 256 : 65536);
      }
    });
  }
  await t.test('links a project with an external symbol and reports errors from a dependency', async () => {
    const project = path.join(root, 'multi file');
    await fs.cp(path.resolve(__dirname, '../examples/multi-file'), project, {recursive: true});
    const job = createJob({workspace: project, task: true});
    assert.deepEqual(job.sources, ['main.asm', 'lib/routines.asm']);
    const result = await build(job, status.cocas);
    assert.equal(result.ok, true, result.message);
    const state = await runProgram(job, result.artifacts, status);
    assert.equal(state.reason, 'halt');
    assert.equal(state.registers[0], 42);
    const saved = await fs.readFile(result.artifacts.image);
    const dependency = path.join(project, 'lib', 'routines.asm');
    await fs.writeFile(dependency, 'rsect routines\nload_value>\n    nonexistent\nend\n');
    const failure = await build(job, status.cocas);
    assert.equal(failure.ok, false);
    assert.ok(failure.problems.some(issue => path.resolve(project, issue.file) === dependency && issue.line === 3));
    assert.deepEqual(await fs.readFile(result.artifacts.image), saved);
  });
});

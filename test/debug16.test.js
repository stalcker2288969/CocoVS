'use strict';

const {once, EventEmitter} = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {DebugAdapter} = require('../src/debug-adapter');
const {createDebugWorker} = require('../src/debug-worker');
const {command, createToolchain} = require('../src/tools');
const {createJob} = require('../src/jobs');
const {build} = require('../src/build');

const env = process.env;

for (const architecture of ['vonNeumann', 'harvard']) {
  test('CdM-16 steps through calls and reads 16-bit data in ' + architecture, {
    skip: env.COCOVS_INTEGRATION !== '1',
  }, t => exercise(t, architecture));
}

async function exercise(t, architecture) {
  const root = await fs.mkdtemp(path.join(env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-debug16-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const toolchain = createToolchain(path.join(root, 'tools'), () => ({
    pythonPath: env.COCOVS_PYTHON, cocasPath: env.COCOVS_COCAS, javaPath: env.COCOVS_JAVA, cocoemuJar: env.COCOVS_JAR,
  }));
  const tools = await toolchain.inspect();
  const jar = await toolchain.findJar(tools.python, tools.cocas);
  assert.ok(jar && tools.java);

  const file = path.join(root, 'main.cdm16');
  await fs.writeFile(file, [
    'asect 0', 'br start', 'asect 0x0200', 'start:', 'jsr routine', 'halt',
    'routine:', 'ldi r0, 0x1234', 'rts', '# @type: i16', 'score:', 'dw 0xBEEF',
    '# @type: str', 'message: dc "Text"', 'end', '',
  ].join('\n'));
  const result = await build(createJob({file}), tools.cocas ?? command(env.COCOVS_COCAS ?? 'cocas'),
    {python: tools.python, localDebug: true});
  assert.ok(result.ok, result.message);
  const events = new EventEmitter();
  const responses = new Map();
  const snapshots = [];
  const adapter = new DebugAdapter(message => {
    if (message.type === 'response') responses.set(message.request_seq, message);
    else events.emit(message.event, message.body);
  }, target => {
    assert.equal(target, 'cdm16');
    return createDebugWorker(tools.java, jar);
  }, state => snapshots.push(state));
  t.after(() => adapter.dispose());
  let seq = 0;
  async function request(name, args = {}) {
    const id = ++seq;
    await adapter.handleMessage({type: 'request', seq: id, command: name, arguments: args});
    const response = responses.get(id);
    assert.ok(response?.success, response?.message ?? name);
    return response.body;
  }
  async function step(name, reason = 'step') {
    const stopped = once(events, 'stopped', {signal: AbortSignal.timeout(8000)});
    await request(name, {threadId: 1});
    assert.equal((await stopped)[0].reason, reason);
  }
  await request('launch', {root, artifacts: result.artifacts, target: 'cdm16', architecture, stopOnEntry: false});
  const {breakpoints} = await request('setBreakpoints', {source: {path: file}, breakpoints: [{line: 5}]});
  assert.equal(breakpoints[0].verified, true);
  await step('configurationDone', 'breakpoint');
  assert.equal((await request('evaluate', {expression: 'PC'})).result, '0x0200');
  const startingStack = snapshots.at(-1).stackBytes;
  await step('stepIn');
  assert.equal(snapshots.at(-1).stackBytes, startingStack + 2);
  let frames = (await request('stackTrace')).stackFrames;
  assert.equal(frames[0].line, 8);
  assert.equal(frames.length, 2);
  await step('next');
  assert.equal((await request('stackTrace')).stackFrames[0].line, 9);
  assert.equal((await request('evaluate', {expression: 'PC'})).result, '0x0208');
  await step('stepOut');
  assert.equal(snapshots.at(-1).stackBytes, startingStack);
  frames = (await request('stackTrace')).stackFrames;
  assert.equal(frames[0].line, 6);
  assert.equal(frames.length, 1);
  assert.equal((await request('evaluate', {expression: 'r0'})).result, '0x1234');
  const label = snapshots.at(-1).dataLabels.find(item => item.name === 'score');
  assert.equal(label.dataType, 'i16');
  assert.equal(label.definitionLine, 11);
  assert.equal(label.length, 2);
  async function readLabel(item) {
    if (architecture === 'harvard') {
      const {rom} = snapshots.at(-1);
      return Buffer.from(rom.slice(item.address * 2, (item.address + item.length) * 2), 'hex');
    }
    const bytes = await request('readMemory', {memoryReference: String(item.address), count: item.length});
    return Buffer.from(bytes.data, 'base64');
  }
  assert.deepEqual([...await readLabel(label)], [0xef, 0xbe]);
  const message = snapshots.at(-1).dataLabels.find(item => item.name === 'message');
  assert.equal((await readLabel(message)).toString(), 'Text');
  assert.equal(snapshots.at(-1).registers.length, 8);
  assert.equal(snapshots.at(-1).ram.length, 131072);
  const ended = once(events, 'terminated', {signal: AbortSignal.timeout(8000)});
  await request('continue');
  await ended;
}

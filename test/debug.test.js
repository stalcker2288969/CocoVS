'use strict';

const {once, EventEmitter} = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {DebugAdapter} = require('../src/debug-adapter');
const {createDebugWorker} = require('../src/debug-worker');
const {command} = require('../src/tools');
const {createJob} = require('../src/jobs');
const {build} = require('../src/build');

const env = process.env;

test('CdM-8 DAP handles real CoCAS breakpoints, source steps, RAM and subroutine frames', {
  skip: env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-debug-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.cp(path.resolve(__dirname, '../examples/multi-file'), root, {recursive: true});
  const job = createJob({workspace: root, task: true});
  const result = await build(job, command(env.COCOVS_COCAS ?? 'cocas'));
  assert.equal(result.ok, true, result.message);

  const events = new EventEmitter();
  const messages = [];
  const memoryUpdates = [];
  const adapter = new DebugAdapter(message => {
    messages.push(message);
    if (message.type === 'event') events.emit(message.event, message.body);
  }, () => createDebugWorker(command(env.COCOVS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'))),
  snapshot => memoryUpdates.push(snapshot));
  t.after(() => adapter.dispose());
  let seq = 0;
  async function request(name, args = {}) {
    const id = ++seq;
    await adapter.handleMessage({type: 'request', seq: id, command: name, arguments: args});
    const response = messages.find(item => item.type === 'response' && item.request_seq === id);
    assert.ok(response?.success, response?.message ?? 'Missing response to ' + name);
    return response.body;
  }
  async function resume(name, reason) {
    const stopped = once(events, 'stopped', {signal: AbortSignal.timeout(8000)});
    await request(name, {threadId: 1});
    assert.equal((await stopped)[0].reason, reason);
  }
  async function current() {
    return (await request('stackTrace', {threadId: 1})).stackFrames;
  }

  assert.equal((await request('initialize')).supportsConfigurationDoneRequest, true);
  await request('launch', {root, artifacts: result.artifacts, architecture: 'vonNeumann', stopOnEntry: false});
  assert.ok(messages.some(message => message.event === 'initialized'));

  const main = path.join(root, 'main.asm');
  const library = path.join(root, 'lib', 'routines.asm');
  const mainLines = (await fs.readFile(main, 'utf8')).split(/\r?\n/);
  const libraryLines = (await fs.readFile(library, 'utf8')).split(/\r?\n/);
  const callLine = mainLines.findIndex(line => /^\s*jsr\b/.test(line)) + 1;
  const haltLine = mainLines.findIndex(line => /^\s*halt\b/.test(line)) + 1;
  const loadLine = libraryLines.findIndex(line => /^\s*ldi\s+r0,\s*42\b/.test(line)) + 1;
  const returnLine = libraryLines.findIndex(line => /^\s*rts\b/.test(line)) + 1;
  const breakpoints = await request('setBreakpoints', {
    source: {path: main}, breakpoints: [{line: callLine - 1}, {line: callLine}],
  });
  assert.deepEqual(breakpoints.breakpoints.map(item => item.verified), [false, true]);
  await resume('configurationDone', 'breakpoint');
  assert.equal((await current())[0].source.path, main);
  assert.equal((await current())[0].line, callLine);
  assert.equal((await request('evaluate', {expression: 'r0'})).result, '0x00');

  await resume('stepIn', 'step');
  const frames = await current();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].source.path, library);
  assert.equal(frames[0].line, loadLine);
  assert.equal(frames[1].line, callLine);
  const scopes = await request('scopes', {frameId: frames[0].id});
  const ram = await request('variables', {variablesReference: scopes.scopes[1].variablesReference, start: 255, count: 1});
  assert.equal(ram.variables[0].value, '0x02');
  const memory = await request('readMemory', {memoryReference: '0xFF', count: 2});
  assert.deepEqual([...Buffer.from(memory.data, 'base64')], [2]);
  assert.equal(memory.unreadableBytes, 1);

  await resume('next', 'step');
  assert.equal((await current())[0].line, returnLine);
  assert.equal((await request('evaluate', {expression: 'r0'})).result, '0x2A');
  await resume('stepOut', 'step');
  assert.equal((await current())[0].line, haltLine);
  assert.equal((await current()).length, 1);
  const terminated = once(events, 'terminated', {signal: AbortSignal.timeout(8000)});
  await request('continue', {threadId: 1});
  await terminated;
  assert.ok(messages.some(item => item.event === 'output' && /halt.*r0=0x2A/.test(item.body.output)));
  assert.deepEqual([...new Set(memoryUpdates.map(snapshot => snapshot.status))], ['running', 'paused', 'ended']);
  assert.equal(memoryUpdates.at(-1).ram.slice(-2), '02');
  assert.equal(memoryUpdates.at(-1).status, 'ended');
  assert.equal(memoryUpdates.at(-1).registers[0], 42);
  assert.ok(Number.isInteger(memoryUpdates.at(-1).ps));
});

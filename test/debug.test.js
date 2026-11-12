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
const {decodeImage} = require('../src/runtime');

const env = process.env;

test('CdM-8 DAP handles real CoCAS breakpoints, source steps, RAM and subroutine frames', {
  skip: env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-debug-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'lib'));
  await fs.writeFile(path.join(root, 'cdm-project.json'), JSON.stringify({entry: 'main.asm', target: 'cdm8'}));
  await fs.writeFile(path.join(root, 'main.asm'),
    '# @include "lib/routines.asm"\nload_value: ext\nasect 0\nstart:\n    jsr load_value\n    halt\nend\n');
  await fs.writeFile(path.join(root, 'lib', 'routines.asm'),
    'rsect routines\nload_value>\n    ldi r0, 42\n    rts\nend\n');
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

test('CdM-8 debugger follows unsigned branches after CMP', {
  skip: env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fs.mkdtemp(path.join(env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-cmp-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'compare.cdm8');
  await fs.writeFile(file, [
    'asect 0', 'ldi r1, length', 'ld r1, r1', 'ldi r2, 1',
    'if', '    cmp r1, r2', 'is hi', '    ldi r3, 1',
    'else', '    if', '        cmp r1, r2', '    is lo', '        ldi r3, 2', '    fi',
    'fi', 'halt', 'length: dc 0', 'end', '',
  ].join('\n'));
  const result = await build(createJob({file}), command(env.COCOVS_COCAS ?? 'cocas'));
  assert.equal(result.ok, true, result.message);
  const image = decodeImage(await fs.readFile(result.artifacts.image, 'utf8'), 256);
  const debug = JSON.parse(await fs.readFile(result.artifacts.debug, 'utf8'));
  const length = debug.dataLabels.find(label => label.name === 'length');
  const worker = createDebugWorker(command(env.COCOVS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')));
  t.after(() => worker.dispose());

  for (const [input, branch, carryAndZero] of [[0, 2, 0], [1, 0, 10], [6, 1, 8], [255, 1, 8]]) {
    image[length.address] = input;
    await worker.request({command: 'start', image: image.toString('hex'), architecture: 'vonNeumann', locations: {}, limit: 100});
    const state = await worker.request({command: 'execute', mode: 'continue', breakpoints: [],
      startLine: null, startPc: 0, startSteps: 0, depth: 0, skipFirst: false});
    assert.equal(state.reason, 'halt', 'N = ' + input);
    assert.deepEqual(state.registers.slice(1), [input, 1, branch], 'N = ' + input);
    assert.equal(state.ps & 0b1010, carryAndZero, 'N = ' + input);
  }
});

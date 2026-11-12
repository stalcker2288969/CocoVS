'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {decodeImage} = require('./runtime');

const THREAD = 1;
const REGISTERS = 1;
const MEMORY = 2;
const hex = (value, width) => '0x' + value.toString(16).toUpperCase().padStart(width, '0');

function fileKey(file) {
  const normalized = path.resolve(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sourceMap(metadata, root, size) {
  if (!Array.isArray(metadata.files) || !metadata.codeLocations) throw new Error('Invalid CoCAS debug information.');
  const map = new Map();
  for (const [address, location] of Object.entries(metadata.codeLocations)) {
    const file = metadata.files[location.f];
    const pc = Number(address);
    if (typeof file !== 'string' || !Number.isInteger(location.l) || location.l < 1 ||
        !Number.isInteger(pc) || pc < 0 || pc >= size) continue;
    const filename = path.resolve(root, file);
    map.set(pc, {source: {name: path.basename(filename), path: filename}, line: location.l});
  }
  return map;
}

class DebugAdapter {
  constructor(send, makeWorker, onMemory = () => {}) {
    this.send = send;
    this.makeWorker = makeWorker;
    this.onMemory = onMemory;
    this.sequence = 0;
    this.size = 256;
    this.target = 'cdm8';
    this.breakpoints = new Map();
    this.running = false;
    this.disposed = false;
  }

  event(event, body) {
    if (!this.disposed) this.send({type: 'event', seq: ++this.sequence, event, body});
  }

  async handleMessage(message) {
    if (message.type !== 'request') return;
    const {seq: request_seq, command, arguments: args = {}} = message;
    try {
      const body = await this.request(command, args);
      this.send({type: 'response', seq: ++this.sequence, request_seq, command, success: true, body});
      if (command === 'launch') this.event('initialized');
      if (command === 'configurationDone' && this.state && !this.configured) {
        this.configured = true;
        if (this.stopOnEntry) this.stop('entry');
        else void this.resume('continue', false);
      }
      if (['continue', 'next', 'stepIn', 'stepOut'].includes(command)) {
        const modes = {continue: 'continue', next: 'over', stepIn: 'in', stepOut: 'out'};
        void this.resume(args.granularity === 'instruction' && command !== 'continue' ? 'instruction' : modes[command]);
      }
      if (command === 'disconnect' || command === 'terminate') this.finish();
    } catch (error) {
      if (!this.disposed) this.send({type: 'response', seq: ++this.sequence, request_seq, command, success: false, message: error.message});
    }
  }

  async request(command, args) {
    switch (command) {
      case 'initialize':
        return {supportsConfigurationDoneRequest: true, supportsSteppingGranularity: true,
          supportsTerminateRequest: true, supportsReadMemoryRequest: true, supportsEvaluateForHovers: true};
      case 'launch':
        return this.launch(args);
      case 'setBreakpoints':
        return this.setBreakpoints(args);
      case 'threads':
        return {threads: this.finished ? [] : [{id: THREAD, name: this.target === 'cdm16' ? 'CdM-16' : 'CdM-8'}]};
      case 'stackTrace':
        return this.stackTrace(args);
      case 'scopes':
        return {scopes: [{name: 'Registers', variablesReference: REGISTERS, expensive: false},
          {name: 'RAM', variablesReference: MEMORY, indexedVariables: this.size, expensive: false}]};
      case 'variables':
        return this.variables(args);
      case 'readMemory':
        return this.readMemory(args);
      case 'evaluate':
        return this.evaluate(args.expression);
      case 'pause':
        if (this.running) this.pauseRequested = true;
        return;
      case 'continue':
      case 'next':
      case 'stepIn':
      case 'stepOut':
        if (!this.state || this.finished || this.running) throw new Error('The processor is not paused.');
        return command === 'continue' ? {allThreadsContinued: true} : undefined;
      case 'setExceptionBreakpoints':
      case 'configurationDone':
      case 'disconnect':
      case 'terminate':
        return;
      default:
        throw new Error('Unsupported debug request: ' + command);
    }
  }

  async launch({artifacts, architecture, stopOnEntry = true, maxSteps = 100_000, root, target = 'cdm8'}) {
    if (!['cdm8', 'cdm16'].includes(target)) throw new Error('Unsupported local debug target: ' + target);
    this.target = target;
    this.size = target === 'cdm16' ? 65536 : 256;
    this.root = root;
    if (!['harvard', 'vonNeumann'].includes(architecture)) throw new Error('Invalid memory architecture.');
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000_000) throw new Error('Invalid instruction limit.');
    const [image, metadata] = await Promise.all([
      fs.readFile(artifacts.image, 'utf8'), fs.readFile(artifacts.debug, 'utf8'),
    ]);
    const debug = JSON.parse(metadata);
    this.locations = sourceMap(debug, root, this.size);
    this.dataLabels = Array.isArray(debug.dataLabels) ? debug.dataLabels : [];
    const rom = decodeImage(image, this.size).toString('hex');
    this.rom = architecture === 'harvard' ? rom : undefined;
    const locations = Object.fromEntries([...this.locations].map(([pc, item]) => [pc, fileKey(item.source.path) + ':' + item.line]));
    this.lines = locations;
    this.stopOnEntry = stopOnEntry;
    this.architecture = architecture;
    const worker = await this.makeWorker(target);
    if (this.disposed) {
      worker.dispose();
      return;
    }
    this.worker = worker;
    try {
      this.state = await worker.request({command: 'start', architecture, locations,
        image: rom, limit: maxSteps});
    } catch (error) {
      worker.dispose();
      throw error;
    }
  }

  setBreakpoints(args) {
    const source = args.source?.path;
    if (!source || !this.locations) return {breakpoints: []};
    const key = fileKey(source);
    const addresses = new Set();
    const breakpoints = (args.breakpoints ?? []).map(({line}) => {
      const matches = [...this.locations].filter(([, item]) => fileKey(item.source.path) === key && item.line === line);
      // CoCAS can emit several instructions for a single source line or macro call.
      if (matches.length) addresses.add(matches[0][0]);
      return {verified: matches.length > 0, line, ...(!matches.length && {message: 'No assembled code at this line.'})};
    });
    this.breakpoints.set(key, addresses);
    return {breakpoints};
  }

  format(value) {
    return hex(value, this.target === 'cdm16' ? 4 : 2);
  }

  stackTrace({startFrame = 0, levels = 0}) {
    const addresses = this.state ? [this.state.pc, ...[...this.state.frames].reverse()] : [];
    const frames = addresses.map((pc, index) => {
      const location = this.locations.get(pc);
      return {id: index + 1, name: (index ? 'Call at ' : 'PC ') + this.format(pc),
        source: location?.source, line: location?.line ?? 0, column: location ? 1 : 0,
        instructionPointerReference: this.format(pc)};
    });
    return {stackFrames: frames.slice(startFrame, levels ? startFrame + levels : undefined), totalFrames: frames.length};
  }

  registers() {
    const {pc, sp, ps, registers} = this.state;
    return {PC: pc, SP: sp, PS: ps, ...Object.fromEntries(registers.map((value, index) => ['r' + index, value]))};
  }

  variables({variablesReference, start = 0, count = 0}) {
    if (!this.state) return {variables: []};
    if (variablesReference === REGISTERS) {
      return {variables: Object.entries(this.registers()).map(([name, value]) =>
        ({name, value: this.format(value), variablesReference: 0, evaluateName: name}))};
    }
    if (variablesReference !== MEMORY) return {variables: []};
    const ram = Buffer.from(this.state.ram, 'hex');
    return {variables: Array.from(ram.subarray(start, count ? start + count : undefined), (value, index) => ({
      name: '[' + this.format(start + index) + ']', value: hex(value, 2), variablesReference: 0, memoryReference: this.format(start + index),
    }))};
  }

  readMemory({memoryReference, offset = 0, count}) {
    const address = Number(memoryReference) + offset;
    if (!this.state || !Number.isInteger(address) || address < 0 || address >= this.size || !Number.isInteger(count) || count < 0) {
      throw new Error('Invalid RAM address or size.');
    }
    const bytes = Buffer.from(this.state.ram, 'hex').subarray(address, address + count);
    return {address: this.format(address), data: bytes.toString('base64'), unreadableBytes: count - bytes.length};
  }

  evaluate(expression = '') {
    if (!this.state) throw new Error('The processor has no state yet.');
    const register = Object.entries(this.registers()).find(([name]) => name.toLowerCase() === expression.trim().toLowerCase());
    if (!register) throw new Error('Expected a register name such as r0, PC, SP or PS.');
    return {result: this.format(register[1]), variablesReference: 0};
  }

  memory(status) {
    if (!this.state) return;
    const {ram, pc, sp, ps, registers, steps, stackBytes} = this.state;
    this.onMemory({ram, pc, sp, ps, registers, steps, stackBytes, architecture: this.architecture, status,
      dataLabels: this.dataLabels, rom: this.rom, target: this.target, root: this.root});
  }

  stop(reason) {
    this.running = false;
    this.memory('paused');
    this.event('stopped', {reason, threadId: THREAD, allThreadsStopped: true});
  }

  async resume(mode, skipFirst = true) {
    if (this.running || this.finished || this.disposed) return;
    this.running = true;
    this.pauseRequested = false;
    let lastUpdate = Date.now();
    this.memory('running');
    this.event('continued', {threadId: THREAD, allThreadsContinued: true});
    const start = this.state;
    const request = {command: 'execute', mode, startLine: this.lines[start.pc] ?? null,
      startSteps: start.steps, startPc: start.pc, depth: start.frames.length, skipFirst};
    try {
      while (!this.disposed && !this.finished) {
        const state = await this.worker.request({...request, breakpoints: [...this.breakpoints.values()].flatMap(set => [...set])});
        if (this.disposed || this.finished) return;
        this.state = {...state, ram: state.ram || this.state.ram};
        request.skipFirst = false;
        if (state.reason === 'breakpoint' || state.reason === 'step') return this.stop(state.reason);
        if (state.reason !== 'running') {
          const values = Object.entries(this.registers()).map(([name, value]) => name + '=' + this.format(value)).join(' ');
          this.event('output', {category: 'console', output: state.reason + ' after ' + state.steps + ' instruction(s). ' +
            (state.detail ? state.detail + ' ' : '') + values + '\n'});
          return this.finish();
        }
        if (this.pauseRequested || Date.now() - lastUpdate >= 80) {
          if (!state.ram) {
            const snapshot = await this.worker.request({command: 'snapshot'});
            if (this.disposed || this.finished) return;
            this.state = snapshot;
          }
          if (this.pauseRequested) return this.stop('pause');
          this.memory('running');
          lastUpdate = Date.now();
        }
      }
    } catch (error) {
      if (this.finished || this.disposed) return;
      this.event('output', {category: 'stderr', output: error.message + '\n'});
      this.finish();
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.worker?.dispose();
    this.worker = undefined;
    if (!this.disposed) this.memory('ended');
    this.event('terminated');
  }

  dispose() {
    this.disposed = true;
    this.finish();
  }
}

module.exports = {DebugAdapter};

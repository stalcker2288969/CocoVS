'use strict';

const {controlFlow, indexSymbols, operationAt, sourceLine} = require('./symbols');

const LABEL_SECTIONS = /^(?:a|r)sect$/;
const RETURNS = new Set(['rts', 'rti', 'popc']);
const STOPS = new Set([...RETURNS, 'halt', 'wait', 'end', 'mend', 'tplate', 'asect', 'rsect', 'dc', 'db', 'dw', 'ds']);
const ARITHMETIC = new Set('add addc sub subc cmp inc dec neg not and or xor bic bis bit clr tst shl shr shla shra rol ror rcl rcr sxt scl'.split(' '));
const LAST_REGISTER = new Set('move ld ldc ldv ldw ldb ldsb lcw lcb lcsb'.split(' '));
const FIRST_REGISTER = new Set('ldi ldsa ldsp ldps ldpc lsb lssb lsw'.split(' '));
const STORE = new Set('st stv stw stb ssb ssw'.split(' '));
const REGISTER = /^r[0-7]$/;
const END_BLOCK = {fi: 'if', wend: 'while', until: 'do'};

function structure(lines) {
  const open = [];
  const edges = new Map();
  for (const [index, {name, args}] of lines.entries()) {
    if (name === 'if' || name === 'while' || name === 'do') {
      open.push({name, start: index, jumps: []});
    } else if (name === 'is' || name === 'else' || name === 'stays') {
      const block = open.at(-1);
      if (!block) continue;
      if (name === 'else') block.otherwise = index;
      else if (block.condition !== undefined || args.length > 1) block.compound = true;
      else block.condition = index;
    } else if (name === 'break' || name === 'continue') {
      open.findLast(block => block.name !== 'if')?.jumps.push({index, name});
    } else if (Object.hasOwn(END_BLOCK, name)) {
      const block = open.pop();
      if (!block || block.name !== END_BLOCK[name]) continue;
      if (block.name === 'if') {
        if (block.compound) edges.set(block.start, []);
        else if (block.condition !== undefined) {
          edges.set(block.condition, [block.condition + 1, (block.otherwise ?? index) + 1]);
        }
        if (block.otherwise !== undefined) edges.set(block.otherwise, [index + 1]);
      } else if (block.name === 'while') {
        if (block.condition !== undefined) edges.set(block.condition, [block.condition + 1, index + 1]);
        edges.set(index, [block.start + 1]);
      } else {
        edges.set(index, [index + 1, block.start + 1]);
      }
      for (const jump of block.jumps) {
        edges.set(jump.index, [jump.name === 'break' ? index + 1 : block.name === 'do' ? index : block.start + 1]);
      }
    }
  }
  return edges;
}

function numeric(input, wide) {
  if (!/^[+-]?(?:0x[\da-f]+|0b[01]+|\d+)$/i.test(input ?? '')) return undefined;
  const value = Number(input.replace(/^[+-]/, '')) * (input[0] === '-' ? -1 : 1);
  return wide || value < 128 ? value : value - 256;
}

function effects(state, operation, wide, macros) {
  const {name, args} = operation;
  const next = {depth: state.depth, stack: new Map(state.stack), dirty: new Set(state.dirty)};
  const writes = register => { if (REGISTER.test(register)) next.dirty.add(register); };
  const word = wide ? 2 : 1;
  function push(register) {
    if (next.depth === null) return;
    next.depth += word;
    next.stack.set(next.depth, next.dirty.has(register) ? undefined : register);
  }
  function pop(register) {
    const saved = next.stack.get(next.depth);
    next.stack.delete(next.depth);
    if (next.depth !== null) next.depth -= word;
    if (saved && saved === register) next.dirty.delete(register);
    else writes(register);
  }

  if (macros.has(name)) {
    next.depth = null;
    next.stack.clear();
  } else if (name === 'push' || name === 'pups' || name === 'pusp') push(name === 'pups' ? 'ps' : args[0]);
  else if (name === 'pop' || name === 'pops') {
    pop(name === 'pops' ? 'ps' : args[0]);
    if (name === 'pops' && state.stack.get(state.depth) !== 'ps') next.dirty.add('ps');
  } else if (!wide && name === 'pushall') for (let i = 3; i >= 0; i--) push('r' + i);
  else if (!wide && name === 'popall') for (let i = 0; i < 4; i++) pop('r' + i);
  else if (name === 'addsp' && next.depth !== null) {
    const delta = numeric(args[0], wide);
    next.depth = delta === undefined ? null : next.depth - delta;
    for (const address of next.stack.keys()) if (next.depth === null || address > next.depth) next.stack.delete(address);
  } else if (name === 'setsp' || name === 'stsp' || wide && ['posp', 'save', 'restore', 'reset'].includes(name)) {
    next.depth = null;
    next.stack.clear();
    next.dirty.add('sp');
  } else if (ARITHMETIC.has(name)) {
    next.dirty.add('ps');
    if (!['cmp', 'tst', 'bit'].includes(name)) {
      const destination = wide && args.length === 2 && !REGISTER.test(args[1]) ? args[0] : args.at(-1);
      writes(destination);
    }
  } else if (LAST_REGISTER.has(name)) {
    writes(args.at(-1));
    if (!wide && name === 'move') next.dirty.add('ps');
  } else if (FIRST_REGISTER.has(name)) writes(args[0]);
  else if (STORE.has(name)) {
    next.dirty.add('memory');
    next.stack.clear();
  } else if (name === 'stps' || name === 'ei' || name === 'di') next.dirty.add('ps');
  return next;
}

function lintRoutines(text, target, customMacros = new Set(), library = false) {
  if (!['cdm8', 'cdm16'].includes(target)) return [];
  const definitions = indexSymbols(text, library, true);
  const macros = new Set([...customMacros, ...definitions.filter(symbol => symbol.kind === 'macro').map(symbol => symbol.name)]);
  const labels = new Map();
  const entries = [];
  const calls = new Set();
  const branches = new Set();
  const symbolsAt = new Map();
  for (const symbol of definitions) {
    if (!symbolsAt.has(symbol.line)) symbolsAt.set(symbol.line, []);
    symbolsAt.get(symbol.line).push(symbol);
  }
  let section = 0;
  let startOfRoutine = true;
  let inMacro = false;
  const lines = text.split(/\r?\n/).map((line, index) => {
    const code = sourceLine(line);
    const op = operationAt(code);
    const name = library && /^\s*\*\s*[\w.]+\s*\//.test(code) ? 'macro' : op?.name.toLowerCase();
    const args = op ? code.slice(op.end).trim().toLowerCase().split(/\s*,\s*/).filter(Boolean) : [];
    const rawTarget = op && code.slice(op.end).trim();
    if (LABEL_SECTIONS.test(name) || name === 'tplate') section++;
    if (name === 'macro') inMacro = true;
    if (name === 'jsr' && !inMacro) calls.add(rawTarget);
    if (!inMacro && controlFlow.has(name) && /^b/.test(name)) branches.add(JSON.stringify([section, rawTarget]));
    for (const symbol of symbolsAt.get(index) ?? []) {
      if (symbol.external) continue;
      const documented = /^(?:@(?:param|returns?|changed)\b|changed\s*:)/im.test(symbol.documentation);
      if (symbol.kind === 'macro') {
        if (documented) entries.push({...symbol, line: index + 1, section, documented});
        continue;
      }
      labels.set(JSON.stringify([section, symbol.name]), index);
      if (startOfRoutine || symbol.exported || documented) entries.push({...symbol, section, documented, entry: symbol.exported || documented});
      startOfRoutine = false;
    }
    if (STOPS.has(name)) startOfRoutine = true;
    if (name === 'mend') inMacro = false;
    return {name, args, rawTarget, section, column: op?.column ?? 0};
  });
  for (const symbol of definitions) {
    if (symbol.kind === 'label' && !symbol.external && calls.has(symbol.name) && !entries.some(entry => entry.line === symbol.line)) {
      entries.push({...symbol, section: lines[symbol.line].section});
    }
  }

  if (library) lines.push({name: 'mend', section, column: 0});
  const edges = structure(lines);
  const issues = new Map();
  function warning(line, column, length, code, message) {
    const key = JSON.stringify([line, column, code]);
    if (!issues.has(key)) issues.set(key, {line, column, length, code, message});
  }
  for (const routine of entries) {
    if (routine.kind !== 'macro' && !routine.entry && !calls.has(routine.name) &&
        branches.has(JSON.stringify([routine.section, routine.name]))) continue;
    const todo = [{line: routine.line, depth: 0, stack: new Map(), dirty: new Set()}];
    const seen = new Set();
    const modified = new Set();
    const allowed = new Set(routine.documentation.split('\n').filter(line => /^(?:@(?:returns?|changed)\b|changed\s*:)/i.test(line))
      .flatMap(line => line.toLowerCase().match(/\b(?:r[0-7]|sp|ps|flags?|mem(?:ory)?)\b/g) ?? []));
    if (allowed.has('flag') || allowed.has('flags')) allowed.add('ps');
    if (allowed.has('mem')) allowed.add('memory');
    while (todo.length && seen.size < 1000) {
      const state = todo.pop();
      const op = lines[state.line];
      if (!op || op.section !== routine.section) continue;
      const key = JSON.stringify([state.line, state.depth, [...state.stack], [...state.dirty].sort()]);
      if (seen.has(key)) continue;
      seen.add(key);
      const returned = routine.kind === 'macro' ? op.name === 'mend' || library && op.name === 'macro' : RETURNS.has(op.name);
      if (returned) {
        if (routine.kind !== 'macro' && state.depth !== null && state.depth !== 0) {
          warning(state.line, op.column, op.name.length, 'cocovs.stack', 'Possible stack imbalance in ' + routine.name +
            ': ' + Math.abs(state.depth) + ' byte(s) ' + (state.depth > 0 ? 'remain on the stack' : 'were popped from the caller stack') + '.');
        }
        for (const register of state.dirty) if (!allowed.has(register)) modified.add(register);
        continue;
      }
      if (STOPS.has(op.name) || op.name === 'macro') continue;
      let successors = edges.get(state.line) ?? [state.line + 1];
      if (controlFlow.has(op.name) && /^b/.test(op.name)) {
        const jump = labels.get(JSON.stringify([op.section, op.rawTarget]));
        if (['br', 'btrue', 'banything', 'bnfalse'].includes(op.name)) successors = [jump];
        else if (!['bfalse', 'bnanything'].includes(op.name)) successors = [...successors, jump];
      }
      if (['jmp', 'stpc'].includes(op.name)) continue;
      const next = effects(state, op, target === 'cdm16', macros);
      if (next.depth !== null && Math.abs(next.depth) > 256) continue;
      for (const line of successors) if (line !== undefined) todo.push({...next, line});
    }
    if (routine.documented && modified.size) {
      const labelLine = routine.kind === 'macro' ? routine.line - 1 : routine.line;
      warning(labelLine, routine.column, routine.name.length, 'cocovs.changed',
        'Missing @changed entries for ' + routine.name + ': ' + [...modified].sort().join(', ') + '.');
    }
  }
  return [...issues.values()];
}

module.exports = {lintRoutines};

'use strict';

const {operationAt, sourceLine} = require('./symbols');
const {dataAnnotation} = require('./documentation');
const instructionSets = require('./instructions.json');
const cdm16 = require('./cdm16-docs');

function documentation(text) {
  const summary = [];
  const params = [];
  const returns = [];
  const changed = [];
  for (const line of (text ?? '').split('\n')) {
    const parameter = /^@param\s+(\S+)(?:\s+(.*))?$/i.exec(line.trim());
    const output = /^(?:@returns?\b|(?:output|returns?)\s*:)\s*(.*)$/i.exec(line.trim());
    const modified = /^(?:@changed\b|changed\s*:)\s*(.*)$/i.exec(line.trim());
    if (parameter) params.push({name: parameter[1], description: parameter[2] ?? ''});
    else if (output) returns.push(output[1]);
    else if (modified) changed.push(modified[1]);
    else if (!dataAnnotation(line.trim())) summary.push(line);
  }
  return {summary: summary.join('\n').trim(), params, returns: returns.join('\n'),
    changed: changed.join('\n'), dataType: dataAnnotation(text)};
}

function callAt(line, column) {
  const code = sourceLine(line);
  const op = operationAt(code);
  if (!op || column <= op.end || column > code.length) return undefined;
  const operands = code.slice(op.end, column);
  const target = /^\s*([A-Za-z_.][\w.]*)\b/.exec(operands)?.[1];
  let depth = 0;
  let active = 0;
  for (const character of operands) {
    if (character === '(') depth++;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) active++;
  }
  return {name: op.name, target, active};
}

function signature(symbol) {
  const docs = documentation(symbol.documentation);
  const params = symbol.kind === 'macro'
    ? Array.from({length: Math.min(symbol.arity, 64)}, (_, index) => docs.params[index] ?? {name: '$' + (index + 1), description: ''})
    : docs.params;
  return {...docs, params, label: symbol.syntax ?? symbol.name + '(' + params.map(parameter => parameter.name).join(', ') + ')'};
}

const cdm8 = {
  ldi: ['Load an immediate value.', ['destination', 'value'], 'destination receives the byte value.'],
  ld: ['Read a byte from RAM.', ['addressRegister', 'destination'], 'destination receives RAM[addressRegister].'],
  st: ['Write a byte to RAM.', ['addressRegister', 'source'], 'RAM[addressRegister] receives source.'],
  add: ['Add two registers and update the flags.', ['source', 'destination'], 'destination receives the low 8 bits of the sum.'],
  cmp: ['Compare two registers and update the flags.', ['first', 'second'], 'The result is reflected in PS.'],
  jsr: ['Call a subroutine and save the return address on the stack.', ['target'], 'See the subroutine documentation for its result.'],
  rts: ['Return from a subroutine using the address on the stack.', [], 'Execution resumes at the saved address.'],
  dc: ['Emit initialized data bytes.', ['value'], 'Accepts numbers, characters, strings and comma-separated values.'],
  ds: ['Reserve space for bytes.', ['count'], 'The reserved bytes are initialized to zero in the image.'],
};

function instructionSignatures(target, name) {
  const mnemonic = name.toLowerCase();
  if (target === 'cdm16' || target === 'cdm16e') {
    if (!instructionSets[target].includes(mnemonic)) return [];
    const {summary, forms, inputs = {}, returns} = cdm16[mnemonic];
    return forms.map(form => ({
      kind: 'instruction', name, syntax: form ? name + ' ' + form : name,
      documentation: [summary, ...(form ? form.split(', ').map(parameter =>
        '@param ' + parameter + (inputs[parameter] ? ' ' + inputs[parameter] : '')) : []),
        ...(returns ? ['@returns ' + returns] : [])].join('\n'),
    }));
  }
  if (target !== 'cdm8' || !Object.hasOwn(cdm8, mnemonic)) return [];
  const [summary, names, returns] = cdm8[mnemonic];
  return [{kind: 'instruction', name, documentation: [
    summary, ...names.map(parameter => '@param ' + parameter), '@returns ' + returns,
  ].join('\n')}];
}

module.exports = {callAt, instructionSignatures, signature};

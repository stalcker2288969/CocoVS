'use strict';

const path = require('node:path');
const {indexSymbols, operationAt, sourceLine} = require('./symbols');
const {dataAnnotation} = require('./documentation');

function declarationSize(kind, args, word) {
  if (kind === 'ds') {
    const terms = args.match(/[+-]?\s*(?:0x[\da-f]+|0b[01]+|\d+)/gi);
    return terms?.reduce((size, item) => {
      const term = item.replace(/\s/g, '');
      return size + (term.startsWith('-') ? -1 : 1) * Number(term.replace(/^[+-]/, ''));
    }, 0) ?? 0;
  }
  const operands = args.match(/(?:[^,"']|"(?:(?:\\.)|[^"\\])*"|'(?:(?:\\.)|[^'\\])*')+/g) ?? [];
  return operands.reduce((size, value) => {
    const operand = value.trim();
    if (!operand.startsWith('"')) return size + (operand.startsWith("'") ? 1 : word);
    const unescaped = operand.slice(1, -1).replace(/\\(?:x[\da-f]{2}|[0-7]{1,3}|.)/gi, 'x');
    return size + Buffer.byteLength(unescaped);
  }, 0);
}

function declarations(text, target) {
  const byLine = new Map();
  for (const symbol of indexSymbols(text)) {
    if (symbol.kind === 'label') byLine.set(symbol.line, [...(byLine.get(symbol.line) ?? []), symbol]);
  }
  const result = [];
  let pending = [];
  let inMacro = false;
  for (const [line, raw] of text.split(/\r?\n/).entries()) {
    const code = sourceLine(raw);
    const op = operationAt(code);
    if (op?.name === 'macro') inMacro = true;
    if (inMacro) {
      if (op?.name === 'mend') inMacro = false;
      continue;
    }
    pending.push(...(byLine.get(line) ?? []));
    if (!op) continue;
    if (['dc', 'ds', 'db', 'dw'].includes(op.name)) {
      const args = raw.slice(op.end, code.length);
      const word = target === 'cdm16' && ['dc', 'dw'].includes(op.name) ? 2 : 1;
      const length = declarationSize(op.name, args, word);
      const text = /^\s*"/.test(args);
      for (const symbol of pending) {
        const annotation = dataAnnotation(symbol.documentation);
        const dataType = annotation ?? (text ? 'str' : word === 2 ? 'u16' : 'bytes');
        result.push({name: symbol.name, line: line + 1, definitionLine: symbol.line + 1, column: symbol.column,
          kind: op.name, length, text, dataType});
      }
    }
    pending = [];
  }
  return result;
}

function dataLabels(root, metadata, sources, target = 'cdm8') {
  const limit = target === 'cdm16' ? 65536 : 256;
  const key = file => {
    const absolute = path.resolve(root, file);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const addresses = new Map();
  for (const [offset, location] of Object.entries(metadata.codeLocations ?? {})) {
    const file = metadata.files?.[location.f];
    const address = Number(offset);
    if (!file || !Number.isInteger(address) || address < 0 || address >= limit) continue;
    const line = key(file) + ':' + location.l;
    addresses.set(line, Math.min(address, addresses.get(line) ?? address));
  }
  return sources.flatMap(({file, text}) => declarations(text, target).flatMap(({line, length, ...item}) => {
    const address = addresses.get(key(file) + ':' + line);
    if (address === undefined || !Number.isInteger(length) || length < 0 || address + length > limit) return [];
    return [{...item, file: path.relative(root, file).split(path.sep).join('/'), line, address, length}];
  })).sort((a, b) => a.address - b.address);
}

module.exports = {dataLabels};

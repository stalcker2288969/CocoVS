'use strict';

const {branches, indexSymbols, operandList, operationAt, sourceLine} = require('./symbols');
const instructionSets = require('./instructions.json');
const term = '(?:[\\w.]+|\\$[1-9]\\d*)';
const expression = '[+-]?\\s*' + term + '(?:\\s*[+-]\\s*' + term + ')*';
const address = new RegExp('^(?:' + expression + '|\\w+\\s*\\(\\s*' + expression + '\\s*\\))$');
const literal = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/;

function forms(groups) {
  return new Map(groups.flatMap(([names, ...variants]) => names.split(' ').map(name => [name, variants])));
}

// r = register, l = relocatable expression, n = numeric constant.
const common = forms([
  ['ldi', 'rl'],
  ['move ld ldc st', 'rr'],
  ['tst clr inc dec pop', 'r'],
  ['dc db dw', 'l*'],
  ['halt wait rts rti nop ei di', ''],
]);
const narrow = forms([
  ['add addc sub and or xor cmp', 'rr'],
  ['not neg shr shla shra rol shl push save jsrr ldsp stsp', 'r'],
  ['jmp', 'r'],
  ['restore', '', 'r'],
  ['pushall popall ioi crc', ''],
  ['ldsa', 'rl'],
  ['ldv', 'lr'],
  ['stv', 'rl'],
  ['addsp setsp osix jsr run', 'l'],
]);
const wide = forms([
  ['add sub', 'rr', 'rrr', 'rl'],
  ['cmp', 'rr', 'rl'],
  ['and or xor bic addc subc', 'rr', 'rrr'],
  ['bis', 'rrr'],
  ['bit swp swpb swpw', 'rr'],
  ['ldw ldb ldsb lcw lcb lcsb stw stb', 'rr', 'rrr'],
  ['lsw lsb lssb ssw ssb', 'rl'],
  ['shl shr shra rol ror rcl rcr', 'r', 'rr', 'rn', 'rrn'],
  ['not neg sxt scl', 'r', 'rr'],
  ['pop jsrr ldsp stsp ldps stps ldpc stpc ldssp stssp save', 'r'],
  ['addsp', 'r', 'n'],
  ['restore', '', 'r'],
  ['pupc popc pusp posp pups pops', ''],
  ['push jsr', 'r', 'l'],
]);

function instructionForms(target, name) {
  if (branches.has(name)) return ['l'];
  return (target.startsWith('cdm16') ? wide : narrow).get(name) ?? common.get(name) ?? [];
}

function operandKinds(context, target, instructions, macros) {
  const name = context.name.toLowerCase();
  const index = context.previous.length;
  if (name === 'is' || name === 'stays' || name === 'until') {
    if (index === 0) return ['condition'];
    return name === 'is' && index === 1 && conditionNames(target).includes(context.previous[0].toLowerCase()) ? ['conjunction'] : [];
  }
  if (macros.length) return macros.some(macro => macro.arity > index) ? ['r', 'l'] : [];
  if (!instructions.includes(name) && !(target === 'cdm8e' && name === 'dc')) return [];
  if (target === 'custom') return ['l'];
  const isWide = target.startsWith('cdm16');
  const variants = instructionForms(target, name);
  const register = isWide ? /^r[0-7]$/i : /^r[0-3]$/i;
  const kinds = new Set();
  for (const variant of variants) {
    const repeat = variant.endsWith('*');
    if ((repeat || index < variant.length) && context.previous.every((operand, i) => {
      const kind = repeat ? variant[0] : variant[i];
      if (kind === 'r') return register.test(operand) || /^\$[1-9]\d*$/.test(operand);
      return !register.test(operand) && (address.test(operand) || repeat && literal.test(operand));
    })) {
      kinds.add(repeat ? variant[0] : variant[index]);
    }
  }
  return [...kinds];
}

function conditionNames(target) {
  return (instructionSets[target] ?? []).filter(name => name !== 'br' && branches.has(name)).map(name => name.slice(1));
}

function operandProblems(sources, target) {
  const instructions = new Set(instructionSets[target] ?? []);
  const libraryMacros = new Set(sources.filter(source => /\.mlb$/i.test(source.file))
    .flatMap(source => indexSymbols(source.text, true).filter(symbol => symbol.kind === 'macro').map(symbol => symbol.name)));
  const problems = [];
  for (const {file, text} of sources) {
    if (/\.mlb$/i.test(file)) continue;
    const macros = new Set(indexSymbols(text).filter(symbol => symbol.kind === 'macro').map(symbol => symbol.name));
    let inMacro = false;
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const code = sourceLine(raw);
      const op = operationAt(code);
      const name = op?.name.toLowerCase();
      if (name === 'macro') inMacro = true;
      if (name === 'mend') inMacro = false;
      if (inMacro || !instructions.has(name) || macros.has(op.name) || libraryMacros.has(op.name)) continue;
      const variants = instructionForms(target, name);
      if (!variants.length || variants.some(form => form.endsWith('*'))) continue;
      const operands = operandList(raw, code, op.end);
      if (!operands || operands.depth !== 0) continue;
      const tail = raw.slice(operands.start, code.length).trim();
      const count = operands.previous.length + Number(!!tail);
      const arities = [...new Set(variants.map(form => form.length))].sort((a, b) => a - b);
      const empty = operands.previous.includes('') || operands.previous.length > 0 && !tail;
      if (empty || !arities.includes(count)) {
        const message = empty ? op.name + ': missing operand next to a comma.' :
          op.name + ': expected ' + arities.join(' or ') + ' operand(s), found ' + count + '.';
        problems.push({file, line: index + 1, message, warning: false});
      }
    }
  }
  return problems;
}

module.exports = {operandKinds, conditionNames, operandProblems};

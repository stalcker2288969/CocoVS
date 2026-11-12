'use strict';

const IDENTIFIER = '[A-Za-z_.][A-Za-z0-9_.]*';
const labelPattern = new RegExp('^\\s*(' + IDENTIFIER + '(?:\\s*,\\s*' + IDENTIFIER + ')*)\\s*([:>])');
const macroPattern = new RegExp('^\\s*(macro\\s+|\\*\\s*)(' + IDENTIFIER + ')\\s*/\\s*([0-9]+)\\.?\\s*$', 'i');

function sourceLine(line) {
  const masked = line.replace(/"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/g, match => ' '.repeat(match.length));
  const commentStart = masked.indexOf('#');
  return commentStart < 0 ? masked : masked.slice(0, commentStart);
}

function indexSymbols(text, library = false, includeExternal = false) {
  const symbols = [];
  let documentation = [];
  let inMacro = false;
  for (const [line, original] of text.split(/\r?\n/).entries()) {
    const comment = /^\s*#+[ \t]?(.*)$/.exec(original);
    if (comment && !/^@include\b/i.test(comment[1].trimStart())) {
      documentation.push(comment[1].trimEnd());
      continue;
    }
    const code = sourceLine(original);
    const macro = macroPattern.exec(code);
    const label = labelPattern.exec(code);
    if (macro && (!inMacro || library)) {
      symbols.push({name: macro[2], line, column: code.indexOf(macro[1]) + macro[1].length,
        kind: 'macro', arity: Number(macro[3]), documentation: documentation.join('\n').trim()});
      inMacro = true;
    } else if (label && !inMacro) {
      const external = /^\s*ext\b/i.test(code.slice(label[0].length));
      if (external && !includeExternal) {
        documentation = [];
        continue;
      }
      let offset = 0;
      for (const name of label[1].split(/\s*,\s*/)) {
        const column = code.indexOf(name, offset);
        symbols.push({name, line, column, kind: 'label', exported: label[2] === '>',
          external, documentation: documentation.join('\n').trim()});
        offset = column + name.length;
      }
    }
    if (/^\s*mend\b/i.test(code)) inMacro = false;
    documentation = [];
  }
  return symbols;
}

const mnemonicPattern = new RegExp('^\\s*(' + IDENTIFIER + ')(?![A-Za-z0-9_.])');
const operandIdentifier = new RegExp('(?<![A-Za-z0-9_.$])' + IDENTIFIER, 'g');
const register = /^(?:r[0-9]+|fp|sp|pc|ps|ssp)$/i;

const branches = new Set('br banything bcc bcs beq bfalse bge bgt bhi bhs ble blo bls blt bmi bne bnz bpl btrue bvc bvs bz bnanything bncc bncs bneq bnfalse bnge bngt bnhi bnhs bnle bnlo bnls bnlt bnmi bnne bnnz bnpl bntrue bnvc bnvs'.split(' '));
const controlFlow = new Set([...branches, 'jmp', 'jsr', 'jsrr', 'rts', 'ret', 'rti', 'crc', 'popc', 'stpc']);

function operationAt(code) {
  const offset = labelPattern.exec(code)?.[0].length ?? 0;
  const match = mnemonicPattern.exec(code.slice(offset));
  if (!match) return undefined;
  const end = offset + match[0].length;
  return {name: match[1], end, column: end - match[1].length};
}

function branchTargets(text, instructions) {
  const targets = [];
  let inMacro = false;
  for (const [line, original] of text.split(/\r?\n/).entries()) {
    const code = sourceLine(original);
    if (macroPattern.test(code)) inMacro = true;
    if (/^\s*mend\b/i.test(code)) inMacro = false;
    if (inMacro) continue;
    const operation = operationAt(code);
    const name = operation?.name.toLowerCase();
    if (!instructions.has(name) || !(branches.has(name) || name === 'jsr' || name === 'jmp')) continue;
    const operands = code.slice(operation.end);
    const operand = new RegExp('^\\s+(' + IDENTIFIER + ')\\s*$').exec(operands);
    if (operand && !register.test(operand[1])) {
      targets.push({name: operand[1], line, column: operation.end + operands.indexOf(operand[1])});
    }
  }
  return targets;
}

function operandList(line, code, start, end = code.length) {
  const previous = [];
  let depth = 0;
  for (let index = start; index < end; index++) {
    const character = code[index];
    if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) {
      previous.push(line.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) return undefined;
  }
  return {previous, start, depth};
}

function completionContext(line, column) {
  const code = sourceLine(line);
  if (code.length < column || line[column] === '#' || /^\s*#/.test(line)) return undefined;
  const declaration = labelPattern.exec(code);
  if (declaration && column < declaration[0].length || macroPattern.test(code)) return undefined;
  const operation = operationAt(code);
  if (!operation || column <= operation.end) return {kind: 'operation'};
  if (!/\s/.test(code[operation.end])) return undefined;
  const operands = operandList(line, code, operation.end, column);
  if (!operands || operands.previous.includes('')) return undefined;
  const {previous, start} = operands;
  const prefix = line.slice(start, column);
  if (prefix !== code.slice(start, column)) return undefined;
  const match = /(?:^\s*|[+\-(]\s*)([A-Za-z_.][\w.]*)?$/.exec(prefix);
  if (!match) return undefined;
  const word = match[1] ?? '';
  const end = column + (/^[\w.]*/.exec(code.slice(column))?.[0].length ?? 0);
  return {kind: 'operand', name: operation.name, previous, start: column - word.length, end,
    expression: !/^\s*(?:[A-Za-z_.][\w.]*)?$/.test(prefix)};
}

function colorTokens(line, macros, labels, instructions) {
  const code = sourceLine(line);
  const macro = macroPattern.exec(code);
  if (macro) return [{column: macro.index + macro[0].indexOf(macro[1]) + macro[1].length, name: macro[2], kind: 'macro'}];

  const tokens = [];
  const declaration = labelPattern.exec(code);
  let offset = 0;
  if (declaration) {
    for (const name of declaration[1].split(/\s*,\s*/)) {
      const column = code.indexOf(name, offset);
      tokens.push({column, name, kind: 'label'});
      offset = column + name.length;
    }
  }

  const operation = operationAt(code);
  if (!operation) return tokens;
  const {name, end, column} = operation;
  if (macros.has(name)) tokens.push({column, name, kind: 'macro'});
  else if (instructions.has(name.toLowerCase())) {
    tokens.push({column, name, kind: controlFlow.has(name.toLowerCase()) ? 'control' : 'instruction'});
  }
  for (const match of code.slice(end).matchAll(operandIdentifier)) {
    if (labels.has(match[0]) && !register.test(match[0])) {
      tokens.push({column: end + match.index, name: match[0], kind: 'label'});
    }
  }
  return tokens;
}

function symbolAt(line, column) {
  for (const match of sourceLine(line).matchAll(new RegExp(IDENTIFIER, 'g'))) {
    if (match.index <= column && column < match.index + match[0].length) return match[0];
  }
  return undefined;
}

module.exports = {branchTargets, branches, colorTokens, completionContext, controlFlow, indexSymbols,
  operandList, operationAt, sourceLine, symbolAt};

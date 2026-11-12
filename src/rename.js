'use strict';

const {indexSymbols, operationAt, sourceLine} = require('./symbols');

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER = /(?<![\w.$?])[A-Za-z_.][\w.]*(?![\w.'])/g;
const NO_SYMBOL_OPERANDS = new Set('asect rsect tplate end if is then else fi while stays wend do until break continue'.split(' '));
const RESERVED = new Set([...NO_SYMBOL_OPERANDS, 'macro', 'mend', 'ext', 'sp', 'ps', 'pc', 'fp', 'ssp']);

function inspect(source) {
  const symbols = indexSymbols(source.text, /\.mlb$/i.test(source.file), true);
  const lines = source.text.split(/\r?\n/);
  const contexts = [];
  const references = [];
  let macro = false;
  let scope = 'top';
  for (const [line, raw] of lines.entries()) {
    const code = sourceLine(raw);
    if (/^\s*(?:macro\b|\*\s*[\w.]+\s*\/)/i.test(code)) macro = true;
    const op = operationAt(code);
    const name = op?.name.toLowerCase();
    if (!macro && ['asect', 'rsect', 'tplate'].includes(name)) scope = name + ':' + line;
    contexts.push(scope);
    if (macro || op && !NO_SYMBOL_OPERANDS.has(name)) {
      const start = macro ? 0 : op.end;
      for (const match of code.slice(start).matchAll(IDENTIFIER)) {
        references.push({name: match[0], line, column: start + match.index, scope, macro});
      }
    }
    if (name === 'mend') macro = false;
  }
  return {...source, declarations: symbols.filter(item => item.kind === 'label')
    .map(item => ({...item, scope: contexts[item.line]})), references};
}

function visible(item, scope) {
  if (item.scope === scope) return true;
  if (item.external) return item.scope === 'top' && !scope.startsWith('tplate:');
  return item.scope.startsWith('asect:') && /^(?:a|r)sect:/.test(scope);
}

function planRename(sources, origin, position, newName, instructions = []) {
  const modules = sources.map(inspect);
  const current = modules.find(module => module.file === origin);
  if (!current) throw new Error('The active file is outside the linked source set.');
  const hit = item => item.line === position.line && position.character >= item.column &&
    position.character < item.column + item.name.length;
  const declaration = current.declarations.find(hit);
  const selected = declaration ?? current.references.find(hit);
  if (!selected || selected.macro || !SIMPLE_NAME.test(selected.name) || selected.scope.startsWith('tplate:')) {
    throw new Error('Select a plain assembly label or its operand.');
  }
  const oldName = selected.name;
  const bindings = declaration ? [declaration] :
    current.declarations.filter(item => item.name === oldName && visible(item, selected.scope));
  if (bindings.length !== 1) throw new Error('This label has no unique definition in this scope.');
  const exports = modules.flatMap(module => module.declarations.filter(item => item.name === oldName && item.exported)
    .map(item => ({module, item})));
  const binding = bindings[0];
  const definition = binding.external ? exports[0] : {module: current, item: binding};
  if (!definition || (binding.external || binding.exported) && exports.length !== 1) {
    throw new Error('This external label does not have exactly one linked export.');
  }
  if (!newName || newName === oldName) return {selected, definition, edits: []};
  const lower = newName.toLowerCase();
  if (!SIMPLE_NAME.test(newName) || RESERVED.has(lower) || /^r\d+$/.test(lower) || instructions.includes(lower)) {
    throw new Error('Choose a valid label name that is not a register, instruction or directive.');
  }

  const edits = [];
  for (const module of modules) {
    const changed = module.declarations.filter(item => item === definition.item ||
      definition.item.exported && item.external && item.name === oldName);
    if (definition.item.exported && module.declarations.some(item => item.exported && item.name === newName)) {
      throw new Error('The new name is already exported by ' + module.file);
    }
    if (module.references.some(item => item.macro && (item.name === oldName || item.name.startsWith(oldName + '.'))) &&
        (changed.length || definition.item.exported)) {
      throw new Error('A macro uses this label. Its expansion must be reviewed before renaming.');
    }
    if (!changed.length) continue;
    const intersects = item => changed.some(binding => visible(binding, item.scope) || item === binding);
    if (module.declarations.some(item => item.name === newName &&
        (intersects(item) || changed.some(binding => visible(item, binding.scope)))) ||
        module.references.some(item => item.name === newName && intersects(item))) {
      throw new Error('The new name would collide with a symbol or operand in ' + module.file);
    }
    const occurrences = [...changed];
    for (const ref of module.references) {
      if (ref.macro || !intersects(ref)) continue;
      if (ref.name.startsWith(oldName + '.')) throw new Error('A qualified name depends on this label.');
      if (ref.name !== oldName) continue;
      const candidates = module.declarations.filter(item => item.name === oldName && visible(item, ref.scope));
      if (candidates.length !== 1) throw new Error('The label resolves ambiguously in ' + module.file);
      if (changed.includes(candidates[0])) occurrences.push(ref);
    }
    edits.push(...occurrences.map(item => ({file: module.file, line: item.line, column: item.column, name: oldName})));
  }
  return {selected, definition, edits};
}

module.exports = {planRename};

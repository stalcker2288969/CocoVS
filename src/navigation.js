'use strict';

const {argumentSpans, operationAt, sourceLine} = require('./symbols');

const SECTIONS = new Set(['asect', 'rsect', 'tplate', 'end']);
const DATA = new Set(['dc', 'db', 'dw', 'ds', 'equ', 'ext']);
const END_ROUTINE = new Set([...DATA, 'rts', 'rti', 'ret', 'popc', 'halt']);
const NO_SYMBOL_OPERANDS = new Set([...SECTIONS, 'if', 'is', 'then', 'else', 'fi', 'while', 'stays', 'wend', 'do', 'until', 'break', 'continue']);
const IDENTIFIER = /(?<![\w.$?!])[A-Za-z_.][\w.]*(?![\w.$?!])/g;
const REGISTER = /^(?:r\d+|fp|sp|ps|pc|ssp)$/i;

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const id = key(item);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  return groups;
}

function macroOverloads(symbols) {
  return groupBy(symbols.filter(symbol => symbol.kind === 'macro'), symbol => symbol.name + '/' + symbol.arity);
}

function indexModule(file, text, symbols) {
  const declarations = symbols.map(symbol => ({...symbol, file, length: symbol.definitionLength ?? symbol.name.length}));
  const byLine = groupBy(declarations, symbol => symbol.line);
  let scope = 'top';
  let macro;
  const rows = text.split(/\r?\n/).map((raw, line) => {
    const code = sourceLine(raw);
    const operation = operationAt(code);
    const name = operation?.name.toLowerCase();
    const symbolsHere = byLine.get(line) ?? [];
    const header = symbolsHere.find(symbol => symbol.kind === 'macro');
    if (header) macro = header;
    if (name === 'mend') macro = undefined;
    const boundary = !macro && SECTIONS.has(name);
    if (boundary) scope = name + ':' + line;
    for (const symbol of symbolsHere) symbol.scope = scope;
    if (header || name === 'mend') return {line, symbols: symbolsHere, macro};
    return {line, code, operation, name, scope, boundary, macro, symbols: symbolsHere,
      args: operation ? argumentSpans(raw, code, operation.end) : undefined};
  });
  const codeLabels = new Set();
  let next;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row.macro) continue;
    if (row.boundary) next = undefined;
    else if (row.operation && row.name !== 'align') next = row.name;
    if (next && !DATA.has(next)) {
      for (const symbol of row.symbols) if (symbol.kind === 'label' && !symbol.external) codeLabels.add(symbol);
    }
  }
  return {file, rows, declarations, codeLabels, library: /\.mlb$/i.test(file),
    symbols: groupBy(declarations, symbol => symbol.name), node: {kind: 'file', file, line: 0, column: 0, length: 0}};
}

function unique(items) {
  return items.length === 1 ? items[0] : undefined;
}

function labelBinding(module, row, name) {
  const candidates = (module.symbols.get(name) ?? []).filter(symbol => symbol.kind !== 'macro');
  const sameSection = candidates.filter(symbol => symbol.scope === row.scope && symbol.kind === 'label');
  const external = candidates.filter(symbol => symbol.external && symbol.scope === 'top');
  const absolute = candidates.filter(symbol => symbol.kind === 'label' && !symbol.external && symbol.scope.startsWith('asect:'));
  const template = candidates.filter(symbol => ['template', 'field', 'constant'].includes(symbol.kind));
  return unique([template, external, sameSection, absolute].find(group => group.length) ?? []);
}

function navigationGraph(modules, includes, {target, cancelled = () => false}) {
  const allSymbols = modules.flatMap(module => module.declarations);
  const exports = groupBy(allSymbols.filter(symbol => symbol.kind === 'label' && symbol.exported && !symbol.external), symbol => symbol.name);
  const definitions = symbol => symbol.external ? unique(exports.get(symbol.name) ?? []) ?? symbol : symbol;
  const macros = macroOverloads(allSymbols);
  const libraries = new Set(modules.filter(module => module.library).map(module => module.file));
  const byFile = new Map(modules.map(module => [module.file, module]));
  const hits = new Map(modules.map(module => [module.file, new Map()]));
  const uses = new Map();
  const incoming = new Map(), outgoing = new Map();
  const callable = new Set();

  function addHit(site, node, declaration = false) {
    if (!node) return;
    const lines = hits.get(site.file);
    if (!lines.has(site.line)) lines.set(site.line, []);
    const hit = {...site, node, declaration};
    lines.get(site.line).push(hit);
    if (!uses.has(node)) uses.set(node, []);
    uses.get(node).push(hit);
  }

  function addEdge(from, to, site) {
    if (!outgoing.has(from)) outgoing.set(from, new Map());
    if (!incoming.has(to)) incoming.set(to, new Map());
    const edges = outgoing.get(from);
    if (!edges.has(to)) {
      const sites = [];
      edges.set(to, sites);
      incoming.get(to).set(from, sites);
    }
    edges.get(to).push(site);
    callable.add(from);
    callable.add(to);
  }

  for (const {from, to, ...coordinates} of includes) {
    const parent = byFile.get(from), child = byFile.get(to);
    if (!parent || !child) continue;
    const site = {...coordinates, file: from};
    addHit(site, child.node);
    addEdge(parent.node, child.node, site);
  }

  const calls = new Map();
  for (const module of modules) {
    const {file} = module;
    for (const symbol of module.declarations) addHit(symbol, definitions(symbol), true);
    for (const row of module.rows) {
      if (cancelled()) return undefined;
      if (!row.operation || row.boundary) continue;
      const {operation, args, line, code, name} = row;
      const span = (column, length) => ({file, line, column, length});
      const matching = args ? (macros.get(operation.name + '/' + args.length) ?? []).filter(symbol =>
        libraries.has(symbol.file) || symbol.file === file && (row.macro || symbol.line < line)) : [];
      if (matching.length === 1) {
        const site = span(operation.column, operation.name.length);
        addHit(site, matching[0]);
        calls.set(row, {to: matching[0], site});
      }
      // Plain labels inside a macro resolve in the expansion site, which may be another module or section.
      if (row.macro || NO_SYMBOL_OPERANDS.has(name)) continue;
      for (const match of code.slice(operation.end).matchAll(IDENTIFIER)) {
        if (REGISTER.test(match[0])) continue;
        const to = labelBinding(module, row, match[0]);
        if (!to) continue;
        const node = definitions(to);
        const site = span(operation.end + match.index, match[0].length);
        addHit(site, node);
        if (target !== 'custom' && name === 'jsr' && !matching.length && args?.length === 1 && args[0].text === match[0] &&
            byFile.get(node.file).codeLabels.has(node)) {
          callable.add(node);
          calls.set(row, {to: node, site});
        }
      }
    }
  }

  for (const module of modules) {
    let routine;
    for (const row of module.rows) {
      if (cancelled()) return undefined;
      if (!row.macro) {
        if (row.boundary) routine = undefined;
        const labels = row.symbols.filter(symbol => module.codeLabels.has(symbol));
        const entry = labels.find(symbol => callable.has(symbol) || symbol.exported || /^(?:@(?:param|returns?|changed)\b)/im.test(symbol.documentation));
        routine = entry ?? routine ?? labels[0];
        if (routine) callable.add(routine);
      }
      const call = calls.get(row);
      if (call) addEdge(row.macro ?? routine ?? module.node, call.to, call.site);
      if (!row.macro && END_ROUTINE.has(row.name)) routine = undefined;
    }
  }

  return {hits, uses, incoming, outgoing, callable, files: new Map(modules.map(module => [module.file, module.node]))};
}

function nodesAt(graph, file, {line, character}) {
  const hits = graph.hits.get(file)?.get(line) ?? [];
  const selected = hits.filter(hit => hit.column <= character && character < hit.column + hit.length);
  // A template's generated size constant shares the template declaration location.
  return [...new Set(selected.filter(hit => !hit.declaration || hit.node.kind !== 'constant').map(hit => hit.node))];
}

module.exports = {indexModule, macroOverloads, navigationGraph, nodesAt};

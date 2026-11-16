'use strict';

const {indexSymbols, operationAt, sourceLine} = require('./symbols');
const COMMON_ENTRY = /^(?:_?main|_?start|program|init|entry|_entry|reset)$/i;

function entryPoints(text) {
  const lines = text.split(/\r?\n/);
  const explicit = new Set();
  let macro = false;
  for (const raw of lines) {
    const code = sourceLine(raw);
    const op = operationAt(code);
    if (op?.name.toLowerCase() === 'macro') macro = true;
    if (!macro && op?.name.toLowerCase() === 'run') {
      const target = /^\s+([A-Za-z_.][\w.]*)\s*$/.exec(code.slice(op.end));
      if (target) explicit.add(target[1]);
    }
    if (op?.name.toLowerCase() === 'mend') macro = false;
  }
  return indexSymbols(text, false, true).filter(symbol => {
    if (symbol.kind !== 'label' || symbol.external) return false;
    if (explicit.size) return explicit.has(symbol.name);
    if (!COMMON_ENTRY.test(symbol.name)) return false;
    // A conventional name on a data declaration is not an entry point.
    let op = operationAt(sourceLine(lines[symbol.line]));
    for (let line = symbol.line + 1; !op && line < lines.length; line++) op = operationAt(sourceLine(lines[line]));
    return !op || !/^(?:dc|db|dw|ds|ext|equ|end)$/i.test(op.name);
  });
}

module.exports = {entryPoints};

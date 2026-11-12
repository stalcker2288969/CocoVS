'use strict';

const FORMAT_FILE = 'cocovs-format.json';
const FORMAT_DEFAULTS = {
  formatOnSave: true,
  indentSize: 4,
  indentStyle: 'spaces',
  alignInlineComments: true,
  commentColumn: 0,
};

const OPEN = new Set(['if', 'while', 'do']);
const CLOSE = new Map([['fi', 'if'], ['wend', 'while'], ['until', 'do'], ['mend', 'macro']]);
const CLAUSE = new Map([['is', 'if'], ['then', 'if'], ['else', 'if'], ['stays', 'while']]);
const SECTIONS = new Set(['asect', 'rsect', 'tplate']);
const LABEL = /^(?:[\w.$?']+(?:[ \t]*,[ \t]*[\w.$?']+)*[ \t]*[:>])/;
const LIBRARY_HEADER = /^\*[ \t]*[a-z_.][\w.]*[ \t]*\/[ \t]*\d+\.?$/i;

function formatSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a formatter settings object.');
  const options = {...FORMAT_DEFAULTS, ...value};
  if (typeof options.formatOnSave !== 'boolean' || typeof options.alignInlineComments !== 'boolean') {
    throw new Error('formatOnSave and alignInlineComments must be true or false.');
  }
  if (!['spaces', 'tabs'].includes(options.indentStyle)) throw new Error('indentStyle must be spaces or tabs.');
  if (!Number.isInteger(options.indentSize) || options.indentSize < 1 || options.indentSize > 16) {
    throw new Error('indentSize must be between 1 and 16.');
  }
  if (!Number.isInteger(options.commentColumn) || options.commentColumn < 0 || options.commentColumn > 240) {
    throw new Error('commentColumn must be between 0 and 240.');
  }
  return options;
}

function splitLine(line) {
  // A postfix apostrophe in a macro name is a nonce, not a character literal.
  const tokens = /"(?:\\.|[^"\\])*(?:"|$)|(?<![\w.$?])'(?:\\.|[^'\\])*'|#/g;
  for (const token of line.matchAll(tokens)) {
    if (token[0] === '#') return [line.slice(0, token.index).trimEnd(), line.slice(token.index)];
  }
  return [line, ''];
}

function columnOf(text, tabSize) {
  let column = 0;
  for (const character of text) column += character === '\t' ? tabSize - column % tabSize : 1;
  return column;
}

function formatAssembly(text, options = FORMAT_DEFAULTS) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = options.indentStyle === 'tabs' ? '\t' : ' '.repeat(options.indentSize);
  const blocks = [];
  const lines = [];
  let section = false;
  let pendingComments = [];

  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    const macroDepth = blocks.lastIndexOf('macro');
    const inMacro = macroDepth >= 0;
    const depth = inMacro ? blocks.length - macroDepth : Number(section) + blocks.length;
    if (/^#(?![ \t]*@include\b)/i.test(line)) {
      pendingComments.push({index: lines.length, text: line});
      lines.push({code: indent.repeat(depth) + line});
      continue;
    }
    const [code, comment] = splitLine(line);
    const label = LABEL.exec(code)?.[0];
    const opcode = /^\w+/.exec(code.slice(label?.length ?? 0).trimStart())?.[0].toLowerCase();
    let level = depth;
    let boundary = !code || Boolean(label);

    if (LIBRARY_HEADER.test(code)) {
      blocks.splice(0, blocks.length, 'macro');
      section = false;
      level = 0;
      boundary = true;
    } else if (opcode === 'macro') {
      blocks.push('macro');
      level = 0;
      boundary = true;
    } else if (!inMacro && (SECTIONS.has(opcode) || opcode === 'end')) {
      blocks.length = 0;
      section = opcode !== 'end';
      level = 0;
      boundary = true;
    } else if (CLOSE.has(opcode)) {
      const index = blocks.lastIndexOf(CLOSE.get(opcode));
      if (index >= 0) {
        level = depth - (blocks.length - index);
        blocks.length = index;
      }
      boundary = true;
    } else if (CLAUSE.has(opcode)) {
      if (blocks.at(-1) === CLAUSE.get(opcode)) level--;
      boundary = true;
    } else if (OPEN.has(opcode)) {
      blocks.push(opcode);
      boundary = true;
    } else if (label) {
      level = Math.max(0, depth - 1);
    }

    if (label || LIBRARY_HEADER.test(code) || opcode === 'macro' || !inMacro && SECTIONS.has(opcode)) {
      for (const {index, text: commentLine} of pendingComments) lines[index].code = indent.repeat(level) + commentLine;
    }
    pendingComments = [];
    const padding = code ? indent.repeat(level) : '';
    lines.push({code: padding + code, comment, level, boundary});
  }

  for (let start = 0; start < lines.length;) {
    const first = lines[start];
    let end = start + 1;
    if (!first.boundary && first.level !== undefined) {
      while (end < lines.length && !lines[end].boundary && lines[end].level === first.level) end++;
    }
    const group = lines.slice(start, end);
    let column = Math.max(0, options.commentColumn - 1);
    if (options.alignInlineComments) {
      for (const line of group) {
        if (line.code && line.comment) column = Math.max(column, columnOf(line.code, options.indentSize) + 2);
      }
    }
    for (const line of group) {
      if (!line.comment) continue;
      const gap = !line.code ? 0 : options.alignInlineComments ? column - columnOf(line.code, options.indentSize) : 2;
      line.code += ' '.repeat(gap) + line.comment;
    }
    start = end;
  }
  return lines.map(line => line.code).join(eol);
}

module.exports = {FORMAT_FILE, FORMAT_DEFAULTS, formatAssembly, formatSettings};

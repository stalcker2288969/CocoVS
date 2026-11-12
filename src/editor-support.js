'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {ASSEMBLY, confined} = require('./project');

function includeContext(line, column) {
  const directive = /^\s*#\s*@include[ \t]+/i.exec(line);
  if (!directive) return undefined;
  let start = directive[0].length;
  const quote = ['"', "'"].includes(line[start]) ? line[start++] : '';
  const tail = line.slice(start);
  const end = quote ? tail.indexOf(quote) : tail.search(/[\s#;]/);
  const limit = end < 0 ? line.length : start + end;
  if (column < start || column > limit) return undefined;
  const prefix = line.slice(start, column).replaceAll('\\', '/');
  const slash = prefix.lastIndexOf('/') + 1;
  return {directory: prefix.slice(0, slash), start: start + slash, end: limit, quote, closed: !!quote && end >= 0};
}

async function includeCandidates(root, file, directory) {
  if (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)) return [];
  try {
    const candidate = confined(root, path.resolve(path.dirname(file), directory));
    confined(await fs.realpath(root), await fs.realpath(candidate));
    const entries = await fs.readdir(candidate, {withFileTypes: true});
    return entries.filter(entry => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return false;
      if (entry.isDirectory()) return true;
      const absolute = path.join(candidate, entry.name);
      const same = process.platform === 'win32' ? absolute.toLowerCase() === file.toLowerCase() : absolute === file;
      return entry.isFile() && !same && (ASSEMBLY.test(entry.name) || /\.(?:obj|o|lib)$/i.test(entry.name));
    }).map(entry => ({name: entry.name, folder: entry.isDirectory()}));
  } catch {
    return [];
  }
}

function externalInsertionLine(text) {
  const lines = text.split(/\r?\n/);
  let inMacro = false;
  const boundary = lines.findIndex(line => {
    if (/^\s*macro\b/.test(line)) inMacro = true;
    if (/^\s*mend\b/.test(line)) inMacro = false;
    return !inMacro && /^\s*(?:asect|rsect|tplate|end)\b/.test(line);
  });
  if (boundary < 0) return undefined;
  let insertion = boundary;
  while (insertion > 0 && /^\s*#(?!\s*@include\b)/i.test(lines[insertion - 1])) insertion--;
  return insertion;
}

module.exports = {includeContext, includeCandidates, externalInsertionLine};

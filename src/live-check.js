'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {describeProblems, plainOutput} = require('./assembly-errors');
const {assemblerProblems} = require('./build');
const {operandProblems} = require('./operands');
const {confined} = require('./project');
const {processResult} = require('./tools');

function fileKey(file) {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function checkSyntax({root, target, sources}, tool, {signal, language, tempRoot = os.tmpdir()} = {}) {
  const textSources = sources.filter(source => source.text !== undefined);
  const local = operandProblems(textSources, target);
  const assembly = textSources.filter(source => !/\.mlb$/i.test(source.file));
  if (!tool || !assembly.length) return describeProblems(local, root, textSources, language);

  signal?.throwIfAborted();
  let stage;
  try {
    stage = await fs.mkdtemp(path.join(tempRoot, 'cocovs-syntax-'));
    const originals = new Map();
    const inputs = [];
    for (const {file, text} of sources) {
      signal?.throwIfAborted();
      if (text === undefined) continue; // Object files are only used during linking.
      const staged = confined(stage, path.join('src', path.relative(root, file)));
      await fs.mkdir(path.dirname(staged), {recursive: true});
      await fs.writeFile(staged, text);
      originals.set(fileKey(staged), file);
      inputs.push({file: staged});
    }
    const result = await processResult(tool, ['-t', target, '-c', '-o', path.join(stage, 'syntax.obj'),
      ...inputs.map(input => input.file)], {cwd: stage, signal, timeout: 8_000});
    const output = [...new Set([result.stderr, result.stdout].map(text => plainOutput(text).trim()).filter(Boolean))].join('\n');
    const {problems} = assemblerProblems(output, inputs.filter(input => !/\.mlb$/i.test(input.file)));
    const occupied = new Set(local.map(problem => JSON.stringify([problem.file, problem.line])));
    for (const problem of problems) {
      const file = originals.get(fileKey(path.resolve(stage, problem.file)));
      if (file && (problem.warning || !occupied.has(JSON.stringify([file, problem.line])))) {
        local.push({...problem, file});
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // The editor can still report operand problems when CoCAS cannot run.
  } finally {
    if (stage) await fs.rm(stage, {recursive: true, force: true, maxRetries: 2});
  }
  return describeProblems(local, root, textSources, language);
}

module.exports = {checkSyntax, fileKey};

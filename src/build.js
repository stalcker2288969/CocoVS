'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {command, findDebug16Python, processResult} = require('./tools');
const {ASSEMBLY, combinedSource, confined} = require('./project');
const {dataLabels} = require('./data-labels');
const {operandProblems} = require('./operands');
const {describeProblems, friendlyMessage, plainOutput} = require('./assembly-errors');

const VARIABLE = /\$\{([a-zA-Z]+)\}/g;
const SOURCES = '$' + '{sources}';

function expandArgs(args, values, sources) {
  return (args ?? []).flatMap(arg => {
    if (arg === SOURCES) return sources;
    return [arg.replace(VARIABLE, (_, key) => {
      if (!Object.hasOwn(values, key)) throw new Error('Unknown command placeholder: ' + key);
      return values[key];
    })];
  });
}

function customInvocation(spec, values, sources) {
  const [file] = expandArgs([spec.command], values, []);
  if (!file || spec.command === SOURCES) throw new Error('Invalid custom executable.');
  const executable = /[\\/]/.test(file) ? path.resolve(values.project, file) : file;
  return {tool: command(executable), args: expandArgs(spec.args, values, sources)};
}

function diagnostics(text) {
  const cleaned = plainOutput(text);
  const reports = [];
  let current;
  for (const line of cleaned.split(/\r?\n/)) {
    const location = /^\[[^\]]+\]\s+(?:ERROR|WARNING) at (.+),\s*line\s+(\d+)\s*$/i.exec(line);
    if (location) {
      current = {file: location[1], line: Number(location[2]), message: '', warning: /\] WARNING/i.test(line)};
      reports.push(current);
    } else if (/^\[[^\]]+\]\s+(?:ERROR|WARNING)\b/i.test(line)) {
      current = undefined;
    } else if (current && line.trim()) {
      current.message += (current.message ? '\n' : '') + line.trim();
    }
  }
  return reports;
}

function assemblerProblems(text, sources) {
  const problems = diagnostics(text);
  const parserErrors = [...text.matchAll(/^line (\d+):(\d+)\s+([^\r\n]+)$/gim)];
  if (sources.length === 1 && !problems.some(problem => !problem.warning)) {
    for (const [, line, column, message] of parserErrors) {
      problems.push({file: sources[0].file, line: Number(line), column: Number(column), message, warning: false});
    }
  }
  return {problems, parserErrors};
}

function artifactPaths(job, directory = path.join(job.root, 'build')) {
  const basename = job.manifest ? 'out' : path.basename(job.config.entry, path.extname(job.config.entry));
  const suffix = job.config.target === 'custom' ? job.config.imageExtension ?? '.img' : '.img';
  return {
    image: path.join(directory, basename + suffix),
    debug: path.join(directory, basename + '.dbg.json'),
    combined: path.join(directory, basename + '.combined.asm'),
  };
}

async function publishArtifacts(temporary, final, hasDebug) {
  const updates = [];
  try {
    for (const key of ['combined', 'debug', 'image']) {
      const prior = await fs.lstat(final[key]).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (prior && !prior.isFile()) throw new Error('Expected an output file: ' + final[key]);
      const backup = prior ? temporary[key] + '.previous' : undefined;
      if (backup) await fs.copyFile(final[key], backup);
      if (key !== 'debug' || hasDebug) await fs.rename(temporary[key], final[key]);
      else if (prior) await fs.unlink(final[key]);
      updates.push({file: final[key], backup});
    }
  } catch (error) {
    for (const {file, backup} of updates.reverse()) {
      if (backup) await fs.rename(backup, file);
      else await fs.rm(file, {force: true});
    }
    throw error;
  }
}

async function build(job, cocas, options = {}, run = processResult) {
  options.signal?.throwIfAborted();
  const root = await fs.realpath(job.root);
  const output = path.join(root, 'build');
  await fs.mkdir(output, {recursive: true});
  const outputReal = confined(root, await fs.realpath(output));
  const stage = await fs.mkdtemp(path.join(outputReal, '.cocovs-'));
  const temporary = artifactPaths(job, stage);
  const final = artifactPaths(job, outputReal);
  const sources = job.sources.map(file => path.resolve(root, file));
  const values = {project: root, entry: path.resolve(root, job.config.entry), ...temporary};
  const native = job.config.target !== 'custom';
  function failed(problems, fallback, details = '') {
    const issue = problems.find(problem => !problem.warning && problem.message);
    const location = issue && (path.relative(root, path.resolve(root, issue.file)) || issue.file) + ':' + issue.line;
    return {ok: false, problems, message: issue ? location + ' — ' + issue.message : fallback, details};
  }
  try {
    const textSources = native ? await Promise.all(sources.filter(file => ASSEMBLY.test(file))
      .map(async file => ({file, text: (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')}))) : [];
    const invalid = native ? operandProblems(textSources, job.config.target) : [];
    if (invalid.length) return failed(describeProblems(invalid, root, textSources, options.language));
    await fs.writeFile(temporary.combined, combinedSource(root, job.sources, native));
    const invocation = native
      ? {tool: cocas, args: ['-t', job.config.target, '-o', temporary.image, '--debug', temporary.debug, ...sources]}
      : customInvocation(job.config.assembler, values, sources);
    if (!invocation.tool) throw new Error('Cannot find cocas. Run CocoVS: Set Up Toolchain.');
    if (job.config.target === 'cdm16') {
      const python = options.debugPython ?? await findDebug16Python(cocas,
        [options.python, command(process.platform === 'win32' ? 'python.exe' : 'python3')], run);
      if (python) {
        invocation.tool = python;
        invocation.args.unshift('-E', path.join(__dirname, '../runtime/cocas_debug16.py'));
      } else if (options.localDebug) {
        throw new Error('Could not load the CoCAS Python module for CdM-16 debugging.');
      }
    }
    const result = await run(invocation.tool, invocation.args,
      {...options, cwd: root, onOutput: native ? undefined : options.onOutput});
    const outputText = [...new Set([result.stderr, result.stdout].map(text => plainOutput(text).trim()).filter(Boolean))].join('\n');
    let {problems, parserErrors} = assemblerProblems(outputText, native ? textSources : []);
    const reportedError = native && (parserErrors.length > 0 || problems.some(problem => !problem.warning) ||
      /^(?:\[[^\]\r\n]+\]\s+ERROR\b|error\s*:|Traceback \(most recent call last\):)/im.test(outputText));
    if (native) problems = describeProblems(problems, root, textSources, options.language);
    if (result.code !== 0 || reportedError) {
      if (!native) return {ok: false, problems, message: outputText || 'Assembler exited with code ' + result.code};
      const detail = outputText.replace(/^\[[^\]\r\n]+\]\s+ERROR\s*\r?\n/i, '');
      const formatted = friendlyMessage(detail, options.language);
      const fallback = formatted !== detail ? formatted :
        /^ru(?:-|$)/i.test(options.language ?? '') ? 'Сборка CoCAS завершилась ошибкой. Подробности в Output → CocoVS.' :
          'CoCAS build failed. See Output → CocoVS for details.';
      return failed(problems, fallback, outputText);
    }
    if (native && outputText) options.onOutput?.(outputText + '\n');
    if (!(await fs.stat(temporary.image).catch(() => undefined))?.isFile()) throw new Error('Assembler did not create ' + path.basename(temporary.image));
    const hasDebug = (await fs.lstat(temporary.debug).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isFile();
    if (native && !hasDebug) throw new Error('CoCAS did not create debug information.');
    if (['cdm8', 'cdm16'].includes(job.config.target)) {
      const metadata = JSON.parse(await fs.readFile(temporary.debug, 'utf8'));
      metadata.dataLabels = dataLabels(root, metadata, textSources.filter(source => !/\.mlb$/i.test(source.file)), job.config.target);
      await fs.writeFile(temporary.debug, JSON.stringify(metadata, null, 2) + '\n');
    }
    options.signal?.throwIfAborted();
    await publishArtifacts(temporary, final, hasDebug);
    return {ok: true, artifacts: final, problems};
  } finally {
    // The staging directory was created under the canonical build directory above.
    await fs.rm(stage, {recursive: true, force: true});
  }
}

module.exports = {artifactPaths, assemblerProblems, build, customInvocation, diagnostics, expandArgs};

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {command, findWorking, processResult} = require('./tools');
const {ASSEMBLY, combinedSource, confined} = require('./project');
const {dataLabels} = require('./data-labels');

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
  const cleaned = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
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

async function debug16Assembler(cocas, python, run) {
  const basename = process.platform === 'win32' ? 'python.exe' : 'python3';
  const directory = path.isAbsolute(cocas.file) && path.dirname(cocas.file);
  const canonical = directory && await fs.realpath(cocas.file).catch(() => undefined);
  const adjacent = [directory, canonical && path.dirname(canonical)].filter(Boolean);
  const candidates = [...new Set(adjacent)].map(dir => command(path.join(dir, basename)));
  return findWorking([...candidates, python, command(basename)],
    ['-c', 'from cocas.assembler.targets import IVaryingLengthSegment'], undefined, run);
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
  try {
    await fs.writeFile(temporary.combined, combinedSource(root, job.sources, native));
    const invocation = native
      ? {tool: cocas, args: ['-t', job.config.target, '-o', temporary.image, '--debug', temporary.debug, ...sources]}
      : customInvocation(job.config.assembler, values, sources);
    if (!invocation.tool) throw new Error('Cannot find cocas. Run CocoVS: Set Up Toolchain.');
    if (job.config.target === 'cdm16') {
      const python = await debug16Assembler(cocas, options.python, run);
      if (python) {
        invocation.tool = python;
        invocation.args.unshift(path.join(__dirname, '../runtime/cocas_debug16.py'));
      } else if (options.localDebug) {
        throw new Error('CdM-16 debugging needs the Python installation that contains CoCAS. Set cocovs.pythonPath to its Python executable.');
      }
    }
    const result = await run(invocation.tool, invocation.args, {...options, cwd: root});
    const problems = diagnostics(result.stderr + '\n' + result.stdout);
    if (result.code !== 0) {
      return {ok: false, problems, message: (result.stderr || result.stdout).trim() || 'Assembler exited with code ' + result.code};
    }
    if (!(await fs.stat(temporary.image).catch(() => undefined))?.isFile()) throw new Error('Assembler did not create ' + path.basename(temporary.image));
    const hasDebug = (await fs.lstat(temporary.debug).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isFile();
    if (native && !hasDebug) throw new Error('CoCAS did not create debug information.');
    if (['cdm8', 'cdm16'].includes(job.config.target)) {
      const metadata = JSON.parse(await fs.readFile(temporary.debug, 'utf8'));
      const textSources = await Promise.all(sources.filter(file => ASSEMBLY.test(file) && !/\.mlb$/i.test(file))
        .map(async file => ({file, text: (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')})));
      metadata.dataLabels = dataLabels(root, metadata, textSources, job.config.target);
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

module.exports = {artifactPaths, build, customInvocation, diagnostics, expandArgs};

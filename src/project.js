'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');

const MANIFEST = 'cdm-project.json';
const PROJECT_DEBUG = 'CdM Project: Debug';
const PROJECT_BUILD = 'CdM Project: Compile';
const ASSEMBLY = /\.(?:asm|mlb|cdm8e?|cdm16e?|cocoasm)$/i;
const INCLUDE = /^\s*(?:#|;)\s*@include\s+(?:"([^"]+)"|'([^']+)'|([^\s#;]+))\s*(?:[#;].*)?$/i;
const TARGETS = ['cdm8', 'cdm8e', 'cdm16', 'cdm16e', 'custom'];

function confined(root, name) {
  const absolute = path.resolve(root, name);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Dependency escapes workspace: ' + name);
  }
  return absolute;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function strings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function validateCommand(value, field) {
  if (!value || typeof value.command !== 'string' || !value.command.trim() || !(Array.isArray(value.args ?? []) && (value.args ?? []).every(item => typeof item === 'string'))) {
    throw new Error(field + ' requires a command and an optional array of argument strings.');
  }
}

function loadProject(root) {
  const file = path.join(root, MANIFEST);
  let config;
  try { config = JSON.parse(readText(file)); }
  catch (error) { throw new Error(file + ': ' + error.message); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a project object.');
  const result = {architecture: 'vonNeumann', environment: 'emulator', extraSources: [], ...config};
  if (!TARGETS.includes(result.target)) throw new Error('target must be ' + TARGETS.join(', '));
  if (!['harvard', 'vonNeumann'].includes(result.architecture)) throw new Error('Unknown memory architecture.');
  if (!['external', 'emulator'].includes(result.environment)) throw new Error('Unknown runtime environment.');
  if (typeof result.entry !== 'string' || !result.entry.trim()) throw new Error('entry must name an assembly file.');
  if (!strings(result.extraSources)) throw new Error('extraSources must be an array of file paths.');
  if (result.address !== undefined) {
    let url;
    try { url = new URL(result.address); } catch { /* Report a project error below. */ }
    if (typeof result.address !== 'string' || !['ws:', 'wss:'].includes(url?.protocol) || !url.hostname) {
      throw new Error('address must be a valid ws:// or wss:// URL.');
    }
  }
  if (result.target === 'custom') {
    validateCommand(result.assembler, 'assembler');
    if (typeof (result.imageExtension ?? '.img') !== 'string' || !/^\.[a-z0-9][a-z0-9_-]*$/i.test(result.imageExtension ?? '.img')) {
      throw new Error('imageExtension must be a file suffix such as .img or .bin.');
    }
    if (result.instructions !== undefined && !strings(result.instructions)) throw new Error('instructions must be an array of mnemonics.');
  }
  if (result.runner !== undefined) validateCommand(result.runner, 'runner');
  return result;
}

function sourceDirective(line) {
  const match = INCLUDE.exec(line);
  if (!match) return undefined;
  const name = match[1] || match[2] || match[3];
  const folder = /[\\/]\*$/.test(name);
  return {name, folder, path: (folder ? name.slice(0, -1) : name).replaceAll('\\', '/')};
}

function verifyPackages(root, config) {
  const packageRoot = locateProject(path.resolve(root, config.entry), root, 'cdm-packages.json');
  if (!packageRoot) return;
  if (fs.existsSync(path.join(packageRoot, '.cdm', 'operation.lock'))) throw new Error('A package operation is in progress. Retry when it finishes.');
  const dependencies = JSON.parse(readText(path.join(packageRoot, 'cdm-packages.json'))).dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('Invalid cdm-packages.json.');
  const lock = Object.keys(dependencies).length ? JSON.parse(readText(path.join(packageRoot, 'cdm-packages.lock.json'))).packages : {};
  const pending = Object.entries(dependencies), checked = new Set();
  while (pending.length) {
    const [name, spec] = pending.pop();
    if (checked.has(name)) continue;
    checked.add(name);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid package name.');
    const entry = lock?.[name];
    if (!entry || spec !== '*' && !isDeepStrictEqual(entry.source, spec)) throw new Error('Package is not locked: ' + name);
    if (!entry.targets?.includes(config.target)) throw new Error('Package does not support ' + config.target + ': ' + name);
    const directory = path.join(packageRoot, '.cdm', 'packages', name);
    const hashes = {};
    function scan(folder) {
      if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('Package symlinks are not supported.');
      confined(fs.realpathSync(root), fs.realpathSync(folder));
      for (const filename of fs.readdirSync(folder)) {
        const file = path.join(folder, filename), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('Package symlinks are not supported.');
        if (stat.isDirectory()) scan(file);
        else if (stat.isFile()) {
          if (stat.size > 8 * 1024 * 1024) throw new Error('Package file exceeds its size limit.');
          hashes[path.relative(directory, file).split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
      }
    }
    scan(directory);
    if (!isDeepStrictEqual(hashes, entry.files)) throw new Error('Package sources are missing or modified: ' + name + '. Restore assembly packages first.');
    pending.push(...Object.entries(entry.dependencies ?? {}));
  }
}

function resolveSources(root, config, {read = readText, onError, allowMissingPackages = false} = {}) {
  const realRoot = fs.realpathSync(root);
  const visited = new Set();
  const stack = new Map();
  const result = [];
  const packageRoot = locateProject(path.resolve(root, config.entry), root, 'cdm-packages.json') ?? root;
  function dependency(name, parent) {
    if (!name.startsWith('@')) return path.resolve(path.dirname(parent), name);
    const match = /^@([a-z][a-z0-9_-]{0,63})\/(.+)$/.exec(name);
    if (!match) throw new Error('Package imports use @name/path.asm.');
    const lockFile = path.join(packageRoot, 'cdm-packages.lock.json');
    if (allowMissingPackages && !fs.existsSync(lockFile)) return undefined;
    const lock = JSON.parse(readText(lockFile));
    if (allowMissingPackages && (!Object.hasOwn(lock.packages ?? {}, match[1]) ||
        !fs.existsSync(path.join(packageRoot, '.cdm', 'packages', match[1])))) return undefined;
    if (!Object.hasOwn(lock.packages ?? {}, match[1])) throw new Error('Package is not locked: ' + match[1] + '. Restore assembly packages first.');
    const base = confined(root, path.join(packageRoot, '.cdm', 'packages', match[1]));
    return confined(base, path.resolve(base, match[2]));
  }
  function visit(name, parent) {
    try {
      visitSource(name, parent);
    } catch (error) {
      if (!onError) throw error;
      onError(error);
    }
  }
  function visitFolder(name, parent) {
    const resolved = dependency(name, parent);
    if (!resolved) return;
    const absolute = confined(root, resolved);
    confined(realRoot, fs.realpathSync(absolute));
    const entries = fs.readdirSync(absolute).filter(name => !name.startsWith('.') && ASSEMBLY.test(name)).sort();
    for (const entry of entries) {
      const file = path.join(absolute, entry);
      if (file === parent || !fs.statSync(file, {throwIfNoEntry: false})?.isFile()) continue;
      visit(file, parent);
    }
  }
  function visitSource(name, parent) {
    const resolved = parent ? dependency(name, parent) : path.resolve(root, name);
    if (!resolved) return;
    const absolute = confined(root, resolved);
    if (!fs.statSync(absolute, {throwIfNoEntry: false})?.isFile()) {
      throw new Error('Missing assembly dependency: ' + path.relative(root, absolute));
    }
    const real = confined(realRoot, fs.realpathSync(absolute));
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (stack.has(real)) throw new Error('Cyclic @include: ' + [...stack.values(), relative].join(' -> '));
    if (visited.has(real)) return;
    visited.add(real);
    stack.set(real, relative);
    result.push(relative);
    try {
      if (!/\.(?:obj|o|lib)$/i.test(absolute)) {
        for (const line of read(absolute).split(/\r?\n/)) {
          const directive = sourceDirective(line);
          if (!directive) continue;
          if (!directive.folder) visit(directive.path, absolute);
          else {
            try { visitFolder(directive.path, absolute); }
            catch (error) {
              if (!onError) throw error;
              onError(error);
            }
          }
        }
      }
    } finally {
      stack.delete(real);
    }
  }
  visit(config.entry);
  for (const extra of config.extraSources ?? []) visit(extra);
  return result;
}

function combinedSource(root, sources, native) {
  const parts = ['# CocoVS combined sources (module boundaries below).'];
  const ordered = native ? [...sources.filter(file => /\.mlb$/i.test(file)), ...sources.filter(file => !/\.mlb$/i.test(file))] : sources;
  for (const source of ordered) {
    const file = confined(root, source);
    parts.push('', '# --- ' + source + ' ---');
    if (/\.(?:obj|o|lib)$/i.test(file)) {
      parts.push('# Precompiled input: ' + source);
      continue;
    }
    const lines = readText(file).trimEnd().split(/\r?\n/);
    let macro = false;
    for (const line of lines) {
      if (sourceDirective(line) || native && /^\s*end\.?\s*(?:#.*)?$/i.test(line)) {
        parts.push('# ' + line.trim());
        continue;
      }
      const libraryMacro = native && /\.mlb$/i.test(file) && /^\s*\*\s*([A-Za-z_.][\w.]*\s*\/\s*\d+\.?)(.*)$/.exec(line);
      if (libraryMacro) {
        if (macro) parts.push('mend');
        parts.push('macro ' + libraryMacro[1] + libraryMacro[2]);
        macro = true;
      } else {
        parts.push(line);
        if (/^\s*mend\b/i.test(line)) macro = false;
      }
    }
    if (macro) parts.push('mend');
  }
  if (native) parts.push('', 'end');
  return parts.join('\n') + '\n';
}

function locateProject(file, boundary, manifest = MANIFEST) {
  if (!file || !boundary) return undefined;
  const root = path.resolve(boundary);
  let directory = path.dirname(confined(root, file));
  while (true) {
    if (fs.existsSync(path.join(directory, manifest))) return directory;
    if (directory === root) return undefined;
    directory = path.dirname(directory);
  }
}

function inferTarget(file, languageId, fallback = 'cdm8') {
  const suffix = /\.((?:cdm8|cdm16)e?)(?:\.asm)?$/i.exec(file);
  return suffix?.[1].toLowerCase() ?? /^(cdm(?:8|16)e?)-assembly$/.exec(languageId)?.[1] ?? fallback;
}

function readJsonc(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const clean = readText(file)
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token[0] === '"' ? token : ' ')
    .replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token[0] === '"' ? token : '');
  try { return JSON.parse(clean); }
  catch (error) { throw new Error('Cannot parse ' + file + ': ' + error.message); }
}

function syncConfigs(root, config, projectRoot = root) {
  const directory = fs.realpathSync(root);
  const vs = path.join(directory, '.vscode');
  const tasksFile = path.join(vs, 'tasks.json');
  const launchFile = path.join(vs, 'launch.json');
  for (const file of [vs, tasksFile, launchFile]) {
    if (fs.existsSync(file)) confined(directory, fs.realpathSync(file));
  }
  const tasks = readJsonc(tasksFile, {version: '2.0.0', tasks: []});
  const launch = readJsonc(launchFile, {version: '0.2.0', configurations: []});
  if (!Array.isArray(tasks?.tasks) || !Array.isArray(launch?.configurations)) {
    throw new Error('Unexpected tasks.json or launch.json structure.');
  }
  const label = PROJECT_BUILD;
  const name = PROJECT_DEBUG;
  const relative = path.relative(path.resolve(root), confined(root, projectRoot)).split(path.sep).join('/');
  const task = {label, type: 'cocovs', group: 'build', problemMatcher: [], ...(relative ? {project: relative} : {})};
  const local = ['cdm8', 'cdm16'].includes(config.target);
  const folderVariable = '$' + '{workspaceFolder}' + (relative ? '/' + relative : '');
  const artifacts = {image: folderVariable + '/build/out.img', debug: folderVariable + '/build/out.dbg.json'};
  const session = local ? {
    name, type: 'cocovs-debug', request: 'launch', root: folderVariable, stopOnEntry: true,
  } : config.target === 'cdm8e' ? {
    name, type: 'cdm', request: 'launch', target: config.target, architecture: config.architecture,
    environment: 'external',
    address: config.address ?? 'ws://localhost:7001', preLaunchTask: label,
    artifacts,
  } : undefined;
  tasks.tasks = [...tasks.tasks.filter(item => item?.label !== label), task];
  const configurations = launch.configurations.filter(item => item?.name !== name);
  if (session) configurations.push(session);
  fs.mkdirSync(vs, {recursive: true});
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2) + '\n');
  if (session || configurations.length !== launch.configurations.length) {
    fs.writeFileSync(launchFile, JSON.stringify({...launch, configurations}, null, 2) + '\n');
  }
  return {task, session};
}

module.exports = {ASSEMBLY, INCLUDE, MANIFEST, PROJECT_BUILD, PROJECT_DEBUG, TARGETS, combinedSource, confined,
  inferTarget, loadProject, locateProject, readJsonc, resolveSources, sourceDirective, syncConfigs, verifyPackages};

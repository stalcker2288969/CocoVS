'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function resolveSources(root, config, {read = readText, onError} = {}) {
  const realRoot = fs.realpathSync(root);
  const visited = new Set();
  const stack = new Map();
  const result = [];
  function visit(name, parent) {
    try {
      visitSource(name, parent);
    } catch (error) {
      if (!onError) throw error;
      onError(error);
    }
  }
  function visitFolder(name, parent) {
    const absolute = confined(root, path.resolve(path.dirname(parent), name));
    confined(realRoot, fs.realpathSync(absolute));
    const entries = fs.readdirSync(absolute).filter(name => !name.startsWith('.') && ASSEMBLY.test(name)).sort();
    for (const entry of entries) {
      const file = path.join(absolute, entry);
      if (file === parent || !fs.statSync(file, {throwIfNoEntry: false})?.isFile()) continue;
      visit(file, parent);
    }
  }
  function visitSource(name, parent) {
    const absolute = confined(root, path.resolve(parent ? path.dirname(parent) : root, name));
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
  inferTarget, loadProject, locateProject, readJsonc, resolveSources, sourceDirective, syncConfigs};

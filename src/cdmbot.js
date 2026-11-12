'use strict';

const path = require('node:path');
const os = require('node:os');
const {command, findWorking, processResult} = require('./tools');

const MANIFEST_PATTERN = '**/project.{yaml,yml}';
const IGNORE = '**/{.git,node_modules,build}/**';

function findCdmbot(configured) {
  const windows = process.platform === 'win32';
  const base = windows && process.env.APPDATA ? process.env.APPDATA :
    process.env.UV_DATA_DIR ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'uv');
  const uv = process.env.UV_TOOL_DIR ?? path.join(base, windows ? 'uv/tools' : 'tools');
  const python = windows ? 'Scripts/python.exe' : 'bin/python';
  const pipx = process.env.PIPX_HOME ?? path.join(os.homedir(), '.local', 'share', 'pipx');
  const candidates = [command(configured), command(path.join(uv, 'cdmbot', python)),
    command(path.join(pipx, 'venvs', 'cdmbot', python)),
    ...(windows ? [command('py', ['-3']), command('python')] : [command('python3'), command('python')])];
  return findWorking(candidates, ['-I', '-c', 'import cdmbot.project, yaml']);
}

async function jsonResult(python, args, options) {
  const {stdout, stderr, code} = await processResult(python, ['-I', ...args], options);
  let report;
  try { report = JSON.parse(stdout); }
  catch { throw new Error(stderr.trim() || 'cdmbot returned no JSON report (exit ' + code + ').'); }
  return {report, stderr};
}

async function editCdmbot(python, operation, file, args = [], options = {}) {
  const {report} = await jsonResult(python, [path.join(__dirname, '../runtime/cdmbot_editor.py'), operation, file, ...args],
    {cwd: path.dirname(file), ...options});
  return report;
}

function exactCasePattern(name) {
  return name.replace(/[[*?]/g, character => '[' + character + ']');
}

module.exports = {MANIFEST_PATTERN, IGNORE, findCdmbot, jsonResult, editCdmbot, exactCasePattern};

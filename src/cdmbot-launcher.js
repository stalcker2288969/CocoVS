'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {command, processResult} = require('./tools');

const WINDOWS_PATH = String.raw`
import ctypes, os, sys, winreg
directory = sys.argv[1]
with winreg.CreateKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
    try:
        value, kind = winreg.QueryValueEx(key, 'Path')
    except FileNotFoundError:
        value, kind = '', winreg.REG_EXPAND_SZ
    def canonical(item):
        return os.path.normcase(os.path.normpath(os.path.expandvars(item.strip().strip('"'))))
    entries = [item for item in value.split(';') if item and canonical(item) != canonical(directory)]
    winreg.SetValueEx(key, 'Path', 0, kind, ';'.join([directory, *entries]))
ctypes.windll.user32.SendMessageTimeoutW(0xffff, 0x1a, 0, 'Environment', 2, 1000, None)
`;

async function exposeCdmbot(home, python, {run = processResult, platform = process.platform, userHome = os.homedir(), shell = process.env.SHELL ?? ''} = {}) {
  const directory = path.join(home, 'bin');
  await fs.mkdir(directory, {recursive: true});
  const windows = platform === 'win32';
  const launcher = path.join(directory, windows ? 'cdmbot.cmd' : 'cdmbot');
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const content = windows ? '@echo off\r\n"' + python.replaceAll('%', '%%') + '" -I -m cdmbot %*\r\n' :
    '#!/bin/sh\nexec ' + quote(python) + ' -I -m cdmbot "$@"\n';
  await fs.writeFile(launcher, content, {mode: 0o755});
  if (windows) {
    const result = await run(command(python), ['-I', '-c', WINDOWS_PATH, directory], {timeout: 10000});
    if (result.code) throw new Error(result.stderr || 'Could not add cdmbot to the user PATH.');
  } else {
    await fs.chmod(launcher, 0o755);
    const profile = path.join(userHome, shell.endsWith('zsh') ? '.zshrc' : shell.endsWith('bash') ? '.bashrc' : '.profile');
    const text = await fs.readFile(profile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    const line = 'export PATH=' + quote(directory) + ':"$PATH"';
    if (!text.split(/\r?\n/).includes(line)) await fs.appendFile(profile, '\n# CocoVS cdmbot command\n' + line + '\n');
  }
  return {directory, launcher};
}

module.exports = {exposeCdmbot};

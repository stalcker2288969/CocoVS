'use strict';

const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-host-'));
  try {
    const userData = path.join(root, 'user-data');
    await fs.mkdir(path.join(userData, 'User'), {recursive: true});
    await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.emptyWindow': false,
      'cocovs.liveDiagnostics': false,
    }));
    const executable = process.env.COCOVS_VSCODE ??
      await require('@vscode/test-electron').downloadAndUnzipVSCode(process.env.COCOVS_VSCODE_VERSION ?? 'stable');
    await new Promise((resolve, reject) => {
      const args = [
        '--user-data-dir=' + userData, '--extensions-dir=' + path.join(root, 'extensions'), '--disable-extensions',
        '--skip-welcome', '--skip-release-notes',
        '--extensionDevelopmentPath=' + path.resolve(__dirname, '..'),
        '--extensionTestsPath=' + path.join(__dirname, 'editor.js'),
      ];
      if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
      const env = {...process.env};
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, args, {env, stdio: 'inherit', timeout: 120_000});
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error('VS Code Extension Host exited with ' + (signal ?? code)));
      });
    });
  } finally {
    await fs.rm(root, {recursive: true, force: true, maxRetries: 3});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

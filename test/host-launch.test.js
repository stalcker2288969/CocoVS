'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');

test('the Linux Extension Host launcher supplies Chromium sandbox flags', async () => {
  const file = path.resolve(__dirname, '../test-host/run.js');
  const source = (await fs.readFile(file, 'utf8')).replace('main().catch(', 'return main().catch(');
  const requireModule = createRequire(file);
  const launch = vm.runInThisContext('(function(require, __dirname, process) {' + source + '\n})', {filename: file});
  for (const platform of ['linux', 'darwin', 'win32']) {
    let invocation;
    const childProcess = {spawn(executable, args, options) {
      invocation = {executable, args, options};
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }};
    const environment = {platform, env: {COCOVS_VSCODE: 'test-code', ELECTRON_RUN_AS_NODE: '1'}};
    await launch(name => name === 'node:child_process' ? childProcess : requireModule(name), path.dirname(file), environment);
    assert.equal(environment.exitCode, undefined);
    assert.equal(invocation.executable, 'test-code');
    assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, undefined);
    for (const flag of ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu-sandbox']) {
      assert.equal(invocation.args.includes(flag), platform === 'linux', platform + ' ' + flag);
    }
    assert.ok(invocation.args.some(arg => arg.startsWith('--user-data-dir=')));
    assert.ok(invocation.args.some(arg => arg.startsWith('--extensionTestsPath=')));
  }
});

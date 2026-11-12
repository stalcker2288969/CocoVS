'use strict';

const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const path = require('node:path');

function createDebugWorker(tool, jar) {
  const runtime = path.join(__dirname, '..', 'runtime');
  const label = jar ? 'CdM-16' : 'CdM-8';
  const args = jar ? ['-cp', jar, path.join(runtime, 'CocoVSRun16.java'), '--debug'] :
    ['-B', '-u', path.join(runtime, 'debug8.py')];
  const child = spawn(tool.file, [...tool.args, ...args], {windowsHide: true});
  const lines = createInterface({input: child.stdout});
  let stderr = '';
  let pending;
  let failure;
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-4096); });

  function fail(error) {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => fail(new Error(stderr.trim() || label + ' emulator exited (' + code + ').')));
  lines.on('line', line => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    try {
      const result = JSON.parse(line);
      if (result.error) throw new Error(result.error);
      current.resolve(result);
    } catch (error) {
      current.reject(error);
    }
  });

  return {
    request(args) {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error('The ' + label + ' emulator is busy.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(new Error('The ' + label + ' emulator did not respond.'));
          child.kill();
        }, args.command === 'start' && jar ? 30_000 : 5000);
        pending = {resolve, reject, timer};
        child.stdin.write(JSON.stringify(args) + '\n');
      });
    },
    dispose() {
      fail(new Error(label + ' debugging ended.'));
      child.stdin.end();
      child.kill();
      lines.close();
    },
  };
}

module.exports = {createDebugWorker};

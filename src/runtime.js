'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {customInvocation} = require('./build');
const {processResult} = require('./tools');

function decodeImage(text, size) {
  const [header, ...lines] = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (header.trim() !== 'v2.0 raw') throw new Error('Expected a Logisim v2.0 raw image.');
  const image = Buffer.alloc(size);
  let offset = 0;
  for (const line of lines) {
    for (const token of line.split('#')[0].trim().split(/\s+/).filter(Boolean)) {
      const match = /^(?:(\d+)\*)?([\da-f]{1,2})$/i.exec(token);
      if (!match) throw new Error('Invalid Logisim image token: ' + token);
      const count = match[1] === undefined ? 1 : Number(match[1]);
      if (count < 1 || count > size - offset) throw new Error('Image exceeds the processor address space.');
      image.fill(parseInt(match[2], 16), offset, offset + count);
      offset += count;
    }
  }
  return image;
}

async function runProgram(job, artifacts, status, options = {}, execute = processResult) {
  const {target, runner, architecture} = job.config;
  const cwd = await fs.realpath(job.root);
  options.signal?.throwIfAborted();
  if (runner) {
    const values = {project: cwd, entry: path.resolve(cwd, job.config.entry), ...artifacts};
    const invocation = customInvocation(runner, values, job.sources.map(file => path.resolve(cwd, file)));
    const result = await execute(invocation.tool, invocation.args, {...options, cwd, timeout: 0});
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Runner exited with code ' + result.code);
    return undefined;
  }
  if (target === 'cdm8e') throw new Error('CdM-8e uses Logisim or a project runner. Select CocoVS: Debug or configure runner.');
  if (!['cdm8', 'cdm16', 'cdm16e'].includes(target)) throw new Error('Configure runner to execute this processor.');
  const directory = path.resolve(__dirname, '..', 'runtime');
  const image = await fs.mkdtemp(path.join(path.dirname(artifacts.image), '.run-'));
  try {
    const rom = path.join(image, 'rom.bin');
    const ram = path.join(image, 'ram.bin');
    const limit = options.maxSteps ?? 100_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000_000) throw new Error('Invalid instruction limit.');
    const args = [rom, architecture, String(limit), ram, target];
    const eightBit = target === 'cdm8';
    const tool = eightBit ? status.python : status.java;
    if (!tool) throw new Error(eightBit ? 'Local CdM-8 execution requires Python 3.10+.' : 'Local CdM-16 execution requires JDK 17+.');
    if (!eightBit && !status.jar) throw new Error('Cannot find the Cocoemu JAR. Set up cdm-devkit or set cocovs.cocoemuJar.');
    await fs.writeFile(rom, decodeImage(await fs.readFile(artifacts.image, 'utf8'), eightBit ? 256 : 65536));
    const prefix = eightBit
      ? ['-B', path.join(directory, 'run8.py')]
      : ['-cp', status.jar, path.join(directory, 'CocoVSRun16.java')];
    const result = await execute(tool, [...prefix, ...args.slice(0, eightBit ? 4 : 5)], {...options, cwd, timeout: 60_000});
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Emulator failed.');
    const state = JSON.parse(result.stdout.trim());
    const ramFile = artifacts.image.slice(0, -4) + '.ram.bin';
    await fs.rename(ram, ramFile);
    return {...state, ramFile};
  } finally {
    await fs.rm(image, {recursive: true, force: true});
  }
}

module.exports = {decodeImage, runProgram};

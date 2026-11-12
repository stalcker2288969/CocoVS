'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {checksumFor, downloadArchive, platformAssets} = require('../src/managed-tools');
const {command, createToolchain, processResult} = require('../src/tools');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-runtimes-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('the same extension selects native Python and Java archives for six desktop platforms', () => {
  for (const [platform, os, vendor] of [
    ['win32', 'windows', 'pc-windows-msvc'],
    ['darwin', 'mac', 'apple-darwin'],
    ['linux', 'linux', 'unknown-linux-gnu'],
  ]) {
    for (const [arch, java, python] of [['x64', 'x64', 'x86_64'], ['arm64', 'aarch64', 'aarch64']]) {
      const assets = platformAssets(platform, arch);
      const api = new URL(assets.java);
      assert.ok(assets.python.endsWith(python + '-' + vendor + '-install_only.tar.gz'));
      assert.equal(api.searchParams.get('architecture'), java);
      assert.equal(api.searchParams.get('os'), os);
    }
  }
  assert.throws(() => platformAssets('linux', 'ia32'), /x64 or ARM64/);
  assert.match(platformAssets('linux', 'arm64', true).python, /aarch64-unknown-linux-musl/);
});

test('download requires an exact checksum and refuses unexpected redirect hosts', async t => {
  const root = await fixture(t);
  const zero = '0'.repeat(64);
  const data = Buffer.from('archive');
  const checksum = createHash('sha256').update(data).digest('hex');
  assert.equal(checksumFor(zero + '  different\n' + checksum + ' *asset.tar.gz\n', 'asset.tar.gz'), checksum);
  assert.throws(() => checksumFor(checksum + '  asset2.tar.gz', 'asset.tar.gz'), /No SHA-256/);
  await assert.rejects(downloadArchive('https://github.com/runtime', path.join(root, 'bad'), zero,
    async () => new Response(data)), /checksum mismatch/);
  await assert.rejects(downloadArchive('https://github.com/runtime', path.join(root, 'redirect'), checksum,
    async () => new Response(null, {status: 302, headers: {location: 'https://example.org/runtime'}})), /Unexpected runtime download host/);
  let requests = 0;
  await downloadArchive('https://github.com/runtime', path.join(root, 'good'), checksum, async () => ++requests === 1
    ? new Response(null, {status: 302, headers: {location: 'https://release-assets.githubusercontent.com/runtime'}})
    : new Response(data));
  assert.deepEqual(await fs.readFile(path.join(root, 'good')), data);
});

test('a clean installation provisions Python and CoCAS, adds Java on demand, then reuses both', async t => {
  const root = await fixture(t);
  const win = process.platform === 'win32';
  const pyBinary = win ? 'python.exe' : 'bin/python3';
  const javaBinary = win ? 'bin/java.exe' : 'bin/java';
  const javaHome = process.platform === 'darwin' ? 'java/Contents/Home' : 'java';
  const venvBin = win ? 'Scripts' : 'bin';
  const venvPython = win ? 'python.exe' : 'python';
  const venvCocas = win ? 'cocas.exe' : 'cocas';
  const home = path.join(root, 'extension');
  const venv = path.join(home, 'devkit-0.2.3');
  const jar = path.join(venv, 'cocoemu-server.jar');
  const portablePython = path.join(home, 'runtimes', 'python-3.12.14', pyBinary);
  const portableJava = path.join(home, 'runtimes', 'jdk-21', javaBinary);
  const results = {code: 0, stdout: '', stderr: ''};
  const exists = file => fs.stat(file).then(stat => stat.isFile(), () => false);
  const sha = buffer => createHash('sha256').update(buffer).digest('hex');
  const calls = [];
  let virtualEnvCreates = 0;
  let installs = 0;
  async function archive(folder, executable) {
    await fs.mkdir(path.dirname(path.join(root, folder, executable)), {recursive: true});
    await fs.writeFile(path.join(root, folder, executable), '');
    const archive = path.join(root, folder.split('/')[0] + '.tar.gz');
    const result = await processResult(command('tar'), ['-czf', archive, '-C', root, folder.split('/')[0]]);
    assert.equal(result.code, 0, result.stderr);
    return fs.readFile(archive);
  }
  const pythonArchive = await archive('python', pyBinary);
  const jdkArchive = await archive(javaHome, javaBinary);
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/SHA256SUMS')) {
      const glibc = process.platform !== 'linux' || !!process.report.getReport().header.glibcVersionRuntime;
      const asset = platformAssets(process.platform, process.arch, !glibc).python;
      return new Response(sha(pythonArchive) + '  ' + asset + '\n');
    }
    if (url.includes('api.adoptium.net')) return Response.json([{binary: {package: {
      link: 'https://github.com/java.tar.gz', checksum: sha(jdkArchive),
    }}}]);
    return new Response(url.endsWith('/java.tar.gz') ? jdkArchive : pythonArchive);
  };

  const run = async (tool, args, options) => {
    if (/^tar(?:\.exe)?$/i.test(path.basename(tool.file))) return processResult(tool, args, options);
    if (!path.isAbsolute(tool.file) || !tool.file.startsWith(root + path.sep) || !await exists(tool.file)) {
      return {...results, code: 1};
    }
    if (args.includes('--list-targets')) {
      return path.basename(tool.file) === venvCocas ? {...results, stdout: 'Available targets: cdm8, cdm16'} : {...results, code: 1};
    }
    if (args.includes('--list-modules')) return {...results, stdout: 'jdk.compiler@21.0.1'};
    if (args.some(arg => arg.includes('cocoemu_server_wrapper'))) {
      return await exists(jar) ? {...results, stdout: jar + '\n'} : {...results, code: 1};
    }
    if (args.includes('venv')) {
      virtualEnvCreates++;
      await fs.mkdir(path.join(venv, venvBin), {recursive: true});
      await fs.writeFile(path.join(venv, venvBin, venvPython), '');
    }
    if (args.includes('pip') && args.includes('install')) {
      installs++;
      await fs.writeFile(path.join(venv, venvBin, venvCocas), '');
      await fs.writeFile(jar, '');
    }
    return results;
  };
  const tools = createToolchain(home, () => ({}), run, fetchImpl);
  const [first, second] = await Promise.all([tools.prepare(), tools.prepare({java: true})]);
  assert.equal(first.python.file, portablePython);
  assert.equal(first.java, undefined);
  assert.equal(second.java.file, portableJava);
  assert.equal(second.jar, jar);
  const reused = await tools.prepare({java: true});
  assert.equal(reused.cocas.file, path.join(venv, venvBin, venvCocas));
  assert.equal(virtualEnvCreates, 1);
  assert.equal(installs, 1);
  assert.equal(calls.length, 4);
});

'use strict';

const fs = require('node:fs/promises');
const {createReadStream, createWriteStream} = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');

const PYTHON_TAG = '20260924';
const PYTHON_VERSION = '3.12.14';
const PYTHON_BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download/' + PYTHON_TAG;
const TRUSTED = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'api.adoptium.net']);

function platformAssets(platform, arch, musl = false) {
  const os = {win32: 'windows', darwin: 'mac', linux: musl ? 'alpine-linux' : 'linux'}[platform];
  const cpu = {x64: 'x86_64', arm64: 'aarch64'}[arch];
  if (!os || !cpu) throw new Error('Automatic runtime setup supports Windows, macOS and Linux on x64 or ARM64.');
  const vendor = {win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: musl ? 'unknown-linux-musl' : 'unknown-linux-gnu'}[platform];
  return {python: 'cpython-' + PYTHON_VERSION + '+' + PYTHON_TAG + '-' + cpu + '-' + vendor + '-install_only.tar.gz',
    java: 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=' + (arch === 'x64' ? 'x64' : 'aarch64') +
      '&image_type=jdk&os=' + os + '&vendor=eclipse'};
}

async function get(url, fetchImpl, timeout) {
  const signal = AbortSignal.timeout(timeout);
  for (let attempt = 0; attempt < 6; attempt++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !TRUSTED.has(parsed.hostname) || parsed.port || parsed.username || parsed.password) {
      throw new Error('Unexpected runtime download host: ' + parsed.hostname);
    }
    let response;
    try {
      response = await fetchImpl(parsed.href, {redirect: 'manual', signal});
    } catch (error) {
      throw new Error('Could not reach ' + parsed.hostname + ' to download CocoVS tools: ' + error.message, {cause: error});
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error('Runtime download redirect has no destination.');
      url = new URL(next, parsed).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Runtime download failed (HTTP ' + response.status + ' from ' + parsed.hostname + ').');
    }
    return response;
  }
  throw new Error('Too many redirects while downloading a runtime.');
}

function checksumFor(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\da-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match?.[2] === filename) return match[1].toLowerCase();
  }
  throw new Error('No SHA-256 checksum published for ' + filename + '.');
}

const mib = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MiB';

async function downloadArchive(link, filename, expected, fetchImpl, onOutput = () => {}) {
  if (!/^[\da-f]{64}$/i.test(expected ?? '')) throw new Error('Invalid SHA-256 checksum for runtime archive.');
  const response = await get(link, fetchImpl, 8 * 60_000);
  const maxBytes = 512 * 1024 * 1024;
  const length = Number(response.headers.get('content-length'));
  const total = length > 0 && !response.headers.get('content-encoding') ? length : undefined;
  let size = 0;
  let lastProgress = Date.now();
  if (total) onOutput('  Archive size: ' + mib(total) + '.\n');
  const limit = new Transform({transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) return callback(new Error('Runtime archive is larger than 512 MB.'));
    const now = Date.now();
    if (now - lastProgress >= 5000) {
      lastProgress = now;
      onOutput('  Downloaded ' + mib(size) + (total ? ' / ' + mib(total) : '') + '.\n');
    }
    callback(null, chunk);
  }});
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(filename, {flags: 'wx'}));
  onOutput('  Download complete (' + mib(size) + '). Verifying SHA-256.\n');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== expected.toLowerCase()) throw new Error('Runtime archive checksum mismatch.');
  onOutput('  SHA-256 verified.\n');
}

function managedTools(home, run, fetchImpl = globalThis.fetch) {
  const platform = process.platform;
  const root = path.resolve(home, 'runtimes');
  const pythonRoot = path.join(root, 'python-' + PYTHON_VERSION);
  const javaRoot = path.join(root, 'jdk-21');
  const python = path.join(pythonRoot, platform === 'win32' ? 'python.exe' : 'bin/python3');
  const java = path.join(javaRoot, platform === 'win32' ? 'bin/java.exe' : 'bin/java');
  const assets = () => {
    const report = platform === 'linux' ? process.report?.getReport() : undefined;
    const musl = platform === 'linux' && !report?.header?.glibcVersionRuntime &&
      !report?.sharedObjects?.some(file => /libc\.so\.6$/.test(file));
    return platformAssets(platform, process.arch, musl);
  };

  async function installArchive(spec, destination, executable, probe, onOutput) {
    await fs.mkdir(root, {recursive: true});
    const realRoot = await fs.realpath(root);
    const stage = await fs.mkdtemp(path.join(realRoot, '.runtime-'));
    const archive = path.join(stage, 'download' + (spec.link.endsWith('.zip') ? '.zip' : '.tar.gz'));
    const unpacked = path.join(stage, 'unpacked');
    const binary = path.relative(destination, executable);
    try {
      await fs.mkdir(unpacked);
      onOutput('  Downloading archive from ' + new URL(spec.link).hostname + '.\n');
      await downloadArchive(spec.link, archive, spec.checksum, fetchImpl, onOutput);
      onOutput('  Extracting archive.\n');
      const tar = {file: platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', args: []};
      const extracted = await run(tar, ['-xf', archive, '-C', unpacked], {timeout: 180_000, onOutput});
      if (extracted.code) throw new Error('Could not extract runtime archive: ' + extracted.stderr.trim());
      onOutput('  Checking extracted executable.\n');
      const entries = await fs.readdir(unpacked, {withFileTypes: true});
      const folders = entries.filter(entry => entry.isDirectory()).map(entry => path.join(unpacked, entry.name));
      const candidates = [unpacked, ...folders, ...folders.map(directory => path.join(directory, 'Contents', 'Home'))];
      for (const candidate of candidates) {
        const tool = {file: path.join(candidate, binary), args: []};
        if (!await probe(tool)) continue;
        if (await probe({file: executable, args: []})) return;
        const backup = path.join(stage, 'previous');
        let hadPrevious = false;
        try {
          try { await fs.rename(destination, backup); hadPrevious = true; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await fs.rename(candidate, destination);
        } catch (error) {
          if (await probe({file: executable, args: []})) return;
          if (hadPrevious) await fs.rename(backup, destination);
          throw error;
        }
        return;
      }
      throw new Error('No usable executable found in the runtime archive.');
    } finally {
      // stage is a fresh directory created directly under the canonical runtime directory.
      await fs.rm(stage, {recursive: true, force: true});
    }
  }

  async function installPython(probe, onOutput = () => {}) {
    const filename = assets().python;
    onOutput('Preparing portable Python ' + PYTHON_VERSION + ' (' + platform + '/' + process.arch + ').\n');
    onOutput('  Fetching the published archive checksum.\n');
    const response = await get(PYTHON_BASE + '/SHA256SUMS', fetchImpl, 30_000);
    const checksum = checksumFor(await response.text(), filename);
    await installArchive({link: PYTHON_BASE + '/' + filename, checksum}, pythonRoot, python, probe, onOutput);
  }

  async function installJava(probe, onOutput = () => {}) {
    onOutput('Preparing Eclipse Temurin JDK 21 (' + platform + '/' + process.arch + ').\n');
    onOutput('  Looking up the archive and checksum via Adoptium.\n');
    const response = await get(assets().java, fetchImpl, 30_000);
    const entries = await response.json();
    const spec = entries?.[0]?.binary?.package;
    if (typeof spec?.link !== 'string') throw new Error('No Temurin JDK 21 download found for this platform.');
    await installArchive(spec, javaRoot, java, probe, onOutput);
  }

  return {python, java, installPython, installJava};
}

module.exports = {checksumFor, downloadArchive, managedTools, platformAssets};

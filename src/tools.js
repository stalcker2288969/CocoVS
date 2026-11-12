'use strict';

const {execFile} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {managedTools} = require('./managed-tools');

const DEVKIT = 'cdm-devkit==0.2.3';
const PYTHON_TEST = 'import sys; raise SystemExit(sys.version_info < (3, 10))';
const JAVA_TEST = ['--list-modules'];
const isJdk = result => result.code === 0 && Number(/^jdk\.compiler@(\d+)/m.exec(result.stdout)?.[1]) >= 17;
const COCAS_MAIN = 'from cocas.main import main; raise SystemExit(main())';
const JAR_PATH = 'from importlib.util import find_spec; from pathlib import Path; print(Path(next(iter(find_spec("cocoemu_server_wrapper").submodule_search_locations))) / "jar" / "cocoemu-server.jar")';

function command(file, args = []) {
  return {file, args};
}

function processResult(tool, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(tool.file, [...tool.args, ...args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error(tool.file + ': ' + error.message, {cause: error}));
        return;
      }
      resolve({code: error?.code ?? 0, stdout, stderr});
    });
    if (options.onOutput) {
      child.stdout?.on('data', options.onOutput);
      child.stderr?.on('data', options.onOutput);
    }
  });
}

async function findWorking(candidates, args, accept = result => result.code === 0, run = processResult) {
  for (const tool of candidates) {
    if (!tool?.file) continue;
    try {
      const result = await run(tool, args, {timeout: 5000});
      if (accept(result)) return tool;
    } catch { /* Try the next installation. */ }
  }
  return undefined;
}

function subdirectories(base) {
  try {
    return fs.readdirSync(base, {withFileTypes: true})
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => path.join(base, entry.name))
      .sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
  } catch {
    return [];
  }
}

function venvTool(home, name) {
  return path.join(home, process.platform === 'win32' ? 'Scripts' : 'bin',
    name + (process.platform === 'win32' ? '.exe' : ''));
}

function createToolchain(home, readSettings, run = processResult, fetchImpl) {
  const venv = path.join(home, 'devkit-0.2.3');
  const managedPython = command(venvTool(venv, 'python'));
  const runtimes = managedTools(home, run, fetchImpl);
  let queue = Promise.resolve();

  const userBin = path.join(os.homedir(), '.local', 'bin');
  const brew = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];

  async function findPython(configured) {
    const candidates = process.platform === 'win32'
      ? [command('py.exe', ['-3']), command('python.exe')]
      : [command('python3'), command('python')];
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      const installations = [
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
        path.join(process.env.LOCALAPPDATA, 'Python'),
        path.join(process.env.APPDATA || os.homedir(), 'uv', 'python'),
      ];
      for (const installation of installations) {
        for (const directory of subdirectories(installation).reverse()) {
          candidates.push(command(path.join(directory, 'python.exe')));
        }
      }
    }
    for (const directory of [...brew, userBin]) candidates.push(command(path.join(directory, 'python3')));
    return findWorking([command(configured), ...candidates, command(runtimes.python), managedPython], ['-I', '-c', PYTHON_TEST], undefined, run);
  }

  async function inspect() {
    const settings = readSettings();
    const python = await findPython(settings.pythonPath);
    const cocas = await findWorking([
      command(settings.cocasPath), command(venvTool(venv, 'cocas')), command('cocas'),
      ...[...brew, userBin].map(directory => command(path.join(directory, 'cocas'))),
      process.platform === 'win32' && process.env.APPDATA &&
        command(venvTool(path.join(process.env.APPDATA, 'uv', 'tools', 'cdm-devkit'), 'cocas')),
      python && path.isAbsolute(python.file) && command(path.join(path.dirname(python.file),
        process.platform === 'win32' ? 'Scripts/cocas.exe' : 'cocas')),
      python && command(python.file, [...python.args, '-c', COCAS_MAIN]),
    ], ['--list-targets'], result => result.code === 0 && /\bcdm8\b/.test(result.stdout), run);
    const javaCandidates = [command(settings.javaPath)];
    if (process.env.JAVA_HOME) javaCandidates.push(command(path.join(process.env.JAVA_HOME, 'bin', 'java')));
    if (process.platform === 'win32' && process.env.ProgramFiles) {
      const androidJdks = path.join(process.env.ProgramFiles, 'Android', 'openjdk');
      for (const base of [androidJdks, path.join(process.env.ProgramFiles, 'Eclipse Adoptium'), path.join(process.env.ProgramFiles, 'Java')]) {
        for (const directory of subdirectories(base).reverse()) javaCandidates.push(command(path.join(directory, 'bin', 'java.exe')));
      }
    }
    javaCandidates.push(command('java'), ...brew.map(directory => command(path.join(directory, 'java'))));
    if (process.platform === 'darwin') {
      for (const directory of ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library/Java/JavaVirtualMachines')]) {
        for (const jdk of subdirectories(directory).reverse()) javaCandidates.push(command(path.join(jdk, 'Contents', 'Home', 'bin', 'java')));
      }
      for (const prefix of ['/opt/homebrew', '/usr/local']) {
        javaCandidates.push(command(path.join(prefix, 'opt', 'openjdk@21', 'bin', 'java')));
      }
    } else if (process.platform === 'linux') {
      for (const jdk of subdirectories('/usr/lib/jvm').reverse()) javaCandidates.push(command(path.join(jdk, 'bin', 'java')));
    }
    const java = await findWorking([...javaCandidates, command(runtimes.java)], JAVA_TEST, isJdk, run);
    return {python, cocas, java};
  }

  async function findJar(python, cocas) {
    const settings = readSettings();
    if (settings.cocoemuJar && fs.statSync(settings.cocoemuJar, {throwIfNoEntry: false})?.isFile()) return settings.cocoemuJar;
    const executable = cocas?.file ?? settings.cocasPath;
    const prefix = executable && path.isAbsolute(executable) ? path.dirname(path.dirname(executable)) : undefined;
    const candidates = [managedPython, prefix && command(venvTool(prefix, 'python')), python];
    const probe = await findWorking(candidates, ['-I', '-c', JAR_PATH],
      result => result.code === 0 && fs.statSync(result.stdout.trim(), {throwIfNoEntry: false})?.isFile(), run);
    return probe && (await run(probe, ['-I', '-c', JAR_PATH])).stdout.trim();
  }

  async function portablePython(onOutput) {
    const tool = command(runtimes.python);
    const probe = candidate => findWorking([candidate], ['-I', '-c', PYTHON_TEST], undefined, run);
    if (!await probe(tool)) await runtimes.installPython(probe, onOutput);
    if (!await probe(tool)) throw new Error('The portable Python runtime did not start.');
    return tool;
  }

  async function installDevkit(python, onOutput) {
    fs.mkdirSync(home, {recursive: true});
    const pip = await findWorking([managedPython], ['-I', '-m', 'pip', '--version'], undefined, run);
    if (!pip) {
      let created = await run(python, ['-I', '-m', 'venv', venv], {onOutput});
      if (created.code && python.file !== runtimes.python) {
        onOutput('System Python could not create a virtual environment. Using portable Python.\n');
        const portable = await portablePython(onOutput);
        created = await run(portable, ['-I', '-m', 'venv', venv], {onOutput});
      }
      if (created.code) throw new Error(created.stderr || created.stdout || 'Creating the Python environment failed.');
    }
    onOutput('Installing cdm-devkit ' + DEVKIT.split('==')[1] + '...\n');
    const installed = await run(managedPython, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', DEVKIT],
      {onOutput, timeout: 300_000});
    if (installed.code) throw new Error(installed.stderr || installed.stdout || 'Installing cdm-devkit failed.');
  }

  function prepare({java = false, onOutput = () => {}} = {}) {
    const next = queue.then(async () => {
      let status = await inspect();
      const python = status.python ?? await portablePython(onOutput);
      let jar = java && await findJar(python, status.cocas);
      if (!status.cocas || java && !jar) {
        await installDevkit(python, onOutput);
        status = await inspect();
        if (!status.cocas) throw new Error('cdm-devkit installed, but cocas did not respond.');
        if (java) jar = await findJar(status.python, status.cocas);
      }
      status.python ??= python;
      if (java) {
        if (!jar) throw new Error('Cannot find the Cocoemu JAR in cdm-devkit.');
        const probe = candidate => findWorking([candidate], JAVA_TEST, isJdk, run);
        if (!status.java) {
          await runtimes.installJava(probe, onOutput);
          status.java = await probe(command(runtimes.java));
          if (!status.java) throw new Error('The portable JDK did not start.');
        }
        status.jar = jar;
      }
      return status;
    });
    queue = next.catch(() => {});
    return next;
  }

  return {inspect, prepare, findJar};
}

module.exports = {command, createToolchain, findWorking, processResult};

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
const DEBUG16_PROBE = 'from cocas.main import main; from cocas.assembler.targets import IVaryingLengthSegment; assert callable(IVaryingLengthSegment.update_surroundings)';
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

function executablePath(file) {
  if (!file || path.isAbsolute(file)) return file;
  if (file.includes('/') || file.includes('\\')) return path.resolve(file);
  const names = process.platform === 'win32' && !path.extname(file) ? [file + '.exe', file] : [file];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* Continue searching PATH. */ }
    }
  }
  return undefined;
}

function launcherPython(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(4096);
    const text = bytes.toString('utf8', 0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    const shebang = /^#![ \t]*([^\r\n]+)/.exec(text)?.[1].trim();
    if (!shebang) return undefined;
    // pip uses a short shell trampoline when the Python path contains spaces.
    const shim = /^'''exec' (?:"([^"]+)"|([^ \t\r\n]+)) "\$0" "\$@"/m.exec(text);
    const interpreter = shim ? shim[1] ?? shim[2] : shebang;
    const direct = /^(.+[\\/]python(?:\d+(?:\.\d+)*)?(?:\.exe)?)(?:[ \t].*)?$/i.exec(interpreter)?.[1];
    const env = /(?:^|\/)env[ \t]+(?:-S[ \t]+)?(python(?:\d+(?:\.\d+)*)?)(?:[ \t]|$)/.exec(interpreter)?.[1];
    return path.isAbsolute(direct ?? '') ? direct : env && executablePath(env);
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function assemblerPythons(cocas) {
  if (!cocas?.file) return [];
  if (cocas.args.at(-2) === '-c' && cocas.args.at(-1) === COCAS_MAIN) {
    return [command(cocas.file, cocas.args.slice(0, -2))];
  }
  const executable = executablePath(cocas.file);
  if (!executable) return [];
  const files = new Set([executable]);
  try { files.add(fs.realpathSync(executable)); } catch { /* The configured path may be unavailable. */ }
  const candidates = new Set();
  for (const file of files) {
    candidates.add(launcherPython(file));
    const bin = path.dirname(file);
    for (const name of process.platform === 'win32' ? ['python.exe'] : ['python', 'python3']) {
      candidates.add(path.join(bin, name));
    }
  }
  return [...candidates].filter(Boolean).map(file => command(file));
}

function findDebug16Python(cocas, fallbacks, run = processResult) {
  return findWorking([...assemblerPythons(cocas), ...fallbacks], ['-E', '-c', DEBUG16_PROBE], undefined, run);
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

  function findAssembler(settings, python) {
    return findWorking([
      command(settings.cocasPath), command(venvTool(venv, 'cocas')), command('cocas'),
      ...[...brew, userBin].map(directory => command(path.join(directory, 'cocas'))),
      process.platform === 'win32' && process.env.APPDATA &&
        command(venvTool(path.join(process.env.APPDATA, 'uv', 'tools', 'cdm-devkit'), 'cocas')),
      python && path.isAbsolute(python.file) && command(path.join(path.dirname(python.file),
        process.platform === 'win32' ? 'Scripts/cocas.exe' : 'cocas')),
      python && command(python.file, [...python.args, '-c', COCAS_MAIN]),
    ], ['--list-targets'], result => result.code === 0 && /\bcdm8\b/.test(result.stdout), run);
  }

  async function inspectAssembler() {
    const settings = readSettings();
    return await findAssembler(settings) ?? await findAssembler(settings, await findPython(settings.pythonPath));
  }

  async function inspect() {
    const settings = readSettings();
    const python = await findPython(settings.pythonPath);
    const cocas = await findAssembler(settings, python);
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
    const candidates = [managedPython, ...assemblerPythons(cocas ?? command(settings.cocasPath)), python];
    const probe = await findWorking(candidates, ['-E', '-c', JAR_PATH],
      result => result.code === 0 && fs.statSync(result.stdout.trim(), {throwIfNoEntry: false})?.isFile(), run);
    return probe && (await run(probe, ['-E', '-c', JAR_PATH])).stdout.trim();
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
      onOutput('Creating the cdm-devkit Python environment at ' + venv + '.\n');
      let created = await run(python, ['-I', '-m', 'venv', venv], {onOutput});
      if (created.code && python.file !== runtimes.python) {
        onOutput('System Python could not create a virtual environment. Using portable Python.\n');
        const portable = await portablePython(onOutput);
        created = await run(portable, ['-I', '-m', 'venv', venv], {onOutput});
      }
      if (created.code) throw new Error(created.stderr || created.stdout || 'Creating the Python environment failed.');
    } else {
      onOutput('Reusing the cdm-devkit Python environment at ' + venv + '.\n');
    }
    onOutput('Installing cdm-devkit ' + DEVKIT.split('==')[1] + '...\n');
    const installed = await run(managedPython, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', DEVKIT],
      {onOutput, timeout: 300_000});
    if (installed.code) throw new Error(installed.stderr || installed.stdout || 'Installing cdm-devkit failed.');
    onOutput('cdm-devkit installed. Checking the tools again.\n');
  }

  function prepare({java = false, debug16 = false, verbose = false, onOutput = () => {}} = {}) {
    const log = message => onOutput('[Toolchain] ' + message + '\n');
    const next = queue.then(async () => {
      let detailed = verbose || debug16;
      if (detailed) log('Checking Python and CoCAS' + (java ? ', plus JDK 17+ for Cocoemu.' : '.'));
      let status = await inspect();
      detailed ||= !status.python || !status.cocas || java && !status.java;
      if (detailed) {
        log(status.python ? 'Python: ' + status.python.file : 'Python 3.10+ not found. Preparing portable Python.');
        log(status.cocas ? 'CoCAS: ' + status.cocas.file : 'CoCAS not found.');
      }
      const python = status.python ?? await portablePython(onOutput);
      if (!status.python) log('Portable Python ready: ' + python.file);
      const debugPython = () => findDebug16Python(status.cocas, [status.python, managedPython], run);
      if (debug16) log('Checking whether Python can load CoCAS for CdM-16 debug symbols.');
      let interpreter = debug16 && await debugPython();
      if (java && detailed) log('Looking for the Cocoemu JAR.');
      let jar = java && await findJar(interpreter || python, status.cocas);
      if (!status.cocas || java && !jar || debug16 && !interpreter) {
        detailed = true;
        if (java && !jar) log('Cocoemu JAR not found. Installing cdm-devkit.');
        if (debug16 && status.cocas && !interpreter) {
          log('Preparing a compatible CoCAS Python environment for CdM-16 debugging.');
        }
        await installDevkit(python, onOutput);
        status = await inspect();
        if (!status.cocas) throw new Error('cdm-devkit installed, but cocas did not respond.');
        if (debug16) interpreter = await debugPython();
        if (java) jar = await findJar(interpreter || status.python, status.cocas);
      }
      status.python ??= python;
      if (debug16) {
        if (!interpreter) throw new Error('Could not load the CoCAS Python module for CdM-16 debugging. Check Output → CocoVS for toolchain details.');
        status.debugPython = interpreter;
        log('CdM-16 debug Python: ' + interpreter.file);
      }
      if (java) {
        if (!jar) throw new Error('Cannot find the Cocoemu JAR in cdm-devkit.');
        if (detailed) log('Cocoemu JAR: ' + jar);
        const probe = candidate => findWorking([candidate], JAVA_TEST, isJdk, run);
        if (!status.java) {
          log('JDK 17+ not found. Installing a portable JDK.');
          await runtimes.installJava(probe, onOutput);
          status.java = await probe(command(runtimes.java));
          if (!status.java) throw new Error('The portable JDK did not start.');
        }
        if (detailed) log('JDK ready: ' + status.java.file);
        status.jar = jar;
      }
      if (detailed) log('Toolchain ready.');
      return status;
    }).catch(error => {
      log('Setup failed: ' + error.message.split(/\r?\n/)[0]);
      throw error;
    });
    queue = next.catch(() => {});
    return next;
  }

  return {inspect, inspectAssembler, prepare, findJar};
}

module.exports = {command, createToolchain, findDebug16Python, findWorking, processResult};

'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const {command, processResult} = require('./tools');
const {findCdmbot, jsonResult} = require('./cdmbot');
const {locateProject, inferTarget} = require('./project');
const {getLaunchProfile} = require('./launch-profile');
const {exposeCdmbot} = require('./cdmbot-launcher');

const VERSION = '0.2.3';
const environmentPython = home => path.join(home, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const managedCdmbotPython = home => home && environmentPython(path.join(home, 'cdmbot-' + VERSION));

function cdmbotManager(home, readSettings, toolchain, run = processResult, locate = findCdmbot) {
  let installation;
  async function capabilities(python) {
    if (!python) return undefined;
    try {
      const result = await run(python, ['-I', '-m', 'cdmbot', 'capabilities', '--json'], {timeout: 10000});
      const report = JSON.parse(result.stdout);
      return result.code === 0 && report.api === 1 && report.automatic_packages === true && report.template_constants === true &&
        report.unified_manifest === true && report.language_versions?.includes('1.0') && Array.isArray(report.commands) ? report : undefined;
    } catch { return undefined; }
  }
  async function find() {
    const configured = readSettings();
    const candidates = [configured && command(configured), home && command(managedCdmbotPython(home))];
    for (const candidate of candidates) if (await capabilities(candidate)) return candidate;
    const discovered = await locate(configured);
    return await capabilities(discovered) ? discovered : undefined;
  }
  function install(onOutput = () => {}, signal) {
    installation ??= (async () => {
      if (!home) throw new Error('Extension storage is unavailable.');
      const status = await toolchain.prepare({onOutput});
      await fs.mkdir(home, {recursive: true});
      const staging = await fs.mkdtemp(path.join(home, '.cdmbot-install-'));
      const destination = path.join(home, 'cdmbot-' + VERSION);
      const backup = path.join(home, '.cdmbot-previous');
      try {
        onOutput('Creating a private cdmbot environment...\n');
        const created = await run(status.python, ['-I', '-m', 'venv', staging], {onOutput, signal, timeout: 120000});
        if (created.code) throw new Error(created.stderr || created.stdout);
        const python = command(environmentPython(staging));
        const wheel = path.join(__dirname, '../runtime/cdmbot-' + VERSION + '-py3-none-any.whl');
        const installed = await run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', wheel + '[managed-java]'],
          {onOutput, signal, timeout: 300000});
        if (installed.code) throw new Error(installed.stderr || installed.stdout);
        if (!await capabilities(python)) throw new Error('Installed cdmbot failed its capability check.');
        signal?.throwIfAborted();
        const previous = await fs.stat(destination).catch(() => undefined);
        if (previous) await fs.rename(destination, backup);
        try { await fs.rename(staging, destination); }
        catch (error) { if (previous) await fs.rename(backup, destination); throw error; }
        if (previous) await fs.rm(backup, {recursive: true, force: true});
        onOutput('cdmbot ' + VERSION + ' is ready: ' + managedCdmbotPython(home) + '\n');
        return command(managedCdmbotPython(home));
      } finally { await fs.rm(staging, {recursive: true, force: true}); }
    })().finally(() => { installation = undefined; });
    return installation;
  }
  return {find, install, capabilities};
}

function registerDevelopment(context, vscode, toolchain, output, showError) {
  const home = context.globalStorageUri?.fsPath;
  const manager = cdmbotManager(home, () => vscode.workspace.getConfiguration('cocovs').get('cdmbotPythonPath'), toolchain);
  const changes = new vscode.EventEmitter();
  context.subscriptions.push(changes);
  function trusted() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running cdmbot.');
  }
  function install() {
    return vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'CocoVS: Installing cdmbot', cancellable: true},
      async (_progress, token) => {
        const abort = new AbortController();
        const listener = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
          const python = await manager.install(chunk => output.append(String(chunk)), abort.signal);
          const {directory, launcher} = await exposeCdmbot(home, python.file);
          const delimiter = path.delimiter;
          const key = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
          const entries = (process.env[key] ?? '').split(delimiter).filter(entry => entry !== directory);
          process.env[key] = [directory, ...entries].join(delimiter);
          context.environmentVariableCollection?.prepend(key, directory + delimiter);
          output.appendLine('Terminal command is ready: ' + launcher + '\nOpen a new terminal to use cdmbot.');
          return python;
        }
        finally { listener.dispose(); }
      });
  }
  async function ensure() {
    const found = await manager.find();
    if (found) return found;
    const choice = await vscode.window.showInformationMessage('Development commands need cdmbot ' + VERSION + '. Install it and enable the terminal command?', 'Install cdmbot');
    if (choice !== 'Install cdmbot') return undefined;
    const python = await install();
    changes.fire();
    return python;
  }
  function current(packages = false) {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme === 'file') {
      const boundary = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.fileName);
      const project = locateProject(document.fileName, boundary);
      const library = packages && locateProject(document.fileName, boundary, 'cdm-package.json');
      if (project || library) return {location: project ?? library};
      const settings = vscode.workspace.getConfiguration('cocovs', document.uri);
      const profile = getLaunchProfile(context.globalState, document.fileName);
      return {location: document.fileName, workspace: boundary,
        target: profile?.target ?? inferTarget(document.fileName, document.languageId, settings.get('target')),
        architecture: profile?.architecture ?? settings.get('architecture', 'vonNeumann')};
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.uri.scheme === 'file') return {location: folder.uri.fsPath};
    throw new Error('Open a saved assembly file or local project folder.');
  }
  async function invoke(args, selection) {
    if (selection) {
      if (args[0] === 'pub') args.push('--path', selection.location);
      else args.push(selection.location);
      if (selection.workspace) {
        args.push('--workspace', selection.workspace, '--target', selection.target);
        if (args[0] === 'analyze') args.push('--architecture', selection.architecture);
      }
    }
    const python = await ensure();
    if (!python) return undefined;
    const {report} = await jsonResult(python, ['-m', 'cdmbot', ...args, '--json'], {timeout: 300000});
    if (report.passed === false && report.error) throw new Error(report.error);
    return report;
  }
  const actions = {
    'cocovs.installCdmbot': async () => { await install(); changes.fire(); vscode.window.showInformationMessage('cdmbot ' + VERSION + ' is ready.'); },
    'cocovs.analyze': async () => {
      const report = await invoke(['analyze'], current());
      if (!report) return;
      const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
      const text = ['# CdM code analysis', '', '| File | Lines | Code | Comments | Instruction lines |', '| --- | ---: | ---: | ---: | ---: |',
        ...report.files.map(row => '| ' + [row.file, row.lines, row.code, row.comments, row.instruction_lines].map(escape).join(' | ') + ' |'),
        '', '**Syntax:** ' + (report.passed ? 'passed' : 'errors found'), '', ...report.diagnostics.map(value => '```text\n' + value + '\n```')].join('\n');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language: 'markdown', content: text}));
    },
    'cocovs.addPackageFromGit': async () => {
      const name = await vscode.window.showInputBox({prompt: 'Package name', validateInput: value => /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? undefined : 'Use a lowercase package name.'});
      if (!name) return;
      const source = await vscode.window.showInputBox({prompt: 'HTTPS Git URL or local repository; leave empty to use the package registry'});
      if (source === undefined) return;
      const selection = current(true);
      const args = ['pub', 'add', name];
      if (source) {
        const ref = await vscode.window.showInputBox({prompt: 'Git tag or branch', value: 'main'});
        if (!ref) return;
        args.push('--git', source, '--ref', ref);
      }
      const registry = vscode.workspace.getConfiguration('cocovs').get('packageRegistry');
      if (!source && registry) args.push('--registry', registry);
      const report = await invoke(args, selection);
      if (report) { output.appendLine(JSON.stringify(report, null, 2)); vscode.window.showInformationMessage('Package installed. Import sources with # @include "@' + name + '/path.asm".'); }
    },
    'cocovs.getPackages': () => invoke(['pub', 'get', ...registryArgs()], current(true)),
    'cocovs.updatePackages': () => invoke(['pub', 'update', ...registryArgs()], current(true)),
    'cocovs.removePackage': async () => {
      const selection = current(true);
      const report = await invoke(['pub', 'list'], selection);
      if (!report) return;
      const name = await vscode.window.showQuickPick(Object.keys(report.dependencies), {placeHolder: 'Dependency to remove'});
      if (name) await invoke(['pub', 'remove', name], selection);
    },
    'cocovs.browsePackages': async () => {
      const selection = current(true);
      const registry = registryArgs();
      const report = await invoke(['pub', 'search', ...registry]);
      if (!report) return;
      if (report.warning) { output.appendLine(report.warning); vscode.window.showWarningMessage(report.warning); }
      const selected = await vscode.window.showQuickPick(Object.entries(report.packages).map(([label, card]) => ({label,
        description: [typeof card.publisher === 'object' ? card.publisher?.name : card.publisher, card.version, card.targets?.join(', ')].filter(Boolean).join(' · '),
        detail: [card.description ?? card.source?.git ?? card.git, card.publisher?.description].filter(Boolean).join(' — ')})),
      {placeHolder: 'Search packages by name, description or publisher', matchOnDescription: true, matchOnDetail: true});
      if (selected) {
        const added = await invoke(['pub', 'add', selected.label, ...registry], selection);
        if (!added) return;
        vscode.window.showInformationMessage('Package installed. Use # @include "@' + selected.label + '/lib.asm".');
      }
    },
  };
  function registryArgs() {
    const location = vscode.workspace.getConfiguration('cocovs').get('packageRegistry');
    return location ? ['--registry', location] : [];
  }
  actions['cocovs.addPackage'] = actions['cocovs.browsePackages'];
  for (const [name, action] of Object.entries(actions)) context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try {
      trusted();
      if (name !== 'cocovs.installCdmbot' && !await vscode.workspace.saveAll(false)) return;
      output.show(true);
      await action();
    }
    catch (error) { output.appendLine(error.message); showError(error); }
  }));
  return {manager, ensure, onDidInstall: changes.event};
}

module.exports = {cdmbotManager, managedCdmbotPython, registerDevelopment};

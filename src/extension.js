'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {build, artifactPaths} = require('./build');
const {registerEditor} = require('./editor');
const {createJob} = require('./jobs');
const {ASSEMBLY, MANIFEST, TARGETS, confined, loadProject, locateProject, resolveSources, syncConfigs} = require('./project');
const {runProgram} = require('./runtime');
const {registerSetup} = require('./setup');
const {DebugAdapter} = require('./debug-adapter');
const {createDebugWorker} = require('./debug-worker');
const {memoryView} = require('./memory-view');
const {registerTesting} = require('./testing');

const OFFICIAL = 'cdm-processors.vscode-cdm-extension';
const NAME = 'CocoVS';
const LOCAL_DEBUG = ['cdm8', 'cdm16'];

function activate(context) {
  registerEditor(context);
  registerTesting(context);
  const updateMemory = memoryView(context);
  const output = vscode.window.createOutputChannel(NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection('cocovs');
  const active = new Set();
  const reported = new Map();
  context.subscriptions.push(output, diagnostics);
  const showError = error => vscode.window.showErrorMessage('CocoVS: ' + error.message.split(/\r?\n/)[0]);
  const {setup, toolchain} = registerSetup(context, output, showError);
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cocovs-debug', {
    resolveDebugConfiguration(_folder, config) {
      if (!config.request) return {...config, ...localDebugConfig()};
      return config;
    },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
      if (config.request === 'launch' && !config.artifacts) {
        try {
          const selectedFolder = folder ?? activeLaunchFolder();
          const launch = await withProgress('build for debug', async options => {
            await saveSources();
            const job = await currentJob(selectedFolder, false);
            if (!LOCAL_DEBUG.includes(job.config.target)) throw new Error('Local debugging is unavailable for ' + job.config.target + '.');
            return withBuild(job, {...options, localDebug: true, java: job.config.target === 'cdm16'}, artifacts => localDebugConfig(job, artifacts));
          }, token);
          if (!launch) return undefined;
          config = {...launch, ...config, root: launch.root, target: launch.target, artifacts: launch.artifacts};
        } catch (error) {
          output.appendLine(error.message);
          showError(error);
          return undefined;
        }
      }
      const uri = config.root ? vscode.Uri.file(config.root) : folder?.uri;
      config.maxSteps ??= vscode.workspace.getConfiguration('cocovs', uri).get('maxSteps');
      return config;
    },
  }));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cocovs-debug', {
    createDebugAdapterDescriptor(session) {
      requireTrust();
      const messages = new vscode.EventEmitter();
      const adapter = new DebugAdapter(message => messages.fire(message), async target => {
        if (target === 'cdm16') {
          const status = await toolchain.prepare({java: true, onOutput: chunk => output.append(String(chunk))});
          return createDebugWorker(status.java, status.jar);
        }
        const detected = await toolchain.inspect();
        const status = detected.python ? detected :
          await toolchain.prepare({onOutput: chunk => output.append(String(chunk))});
        return createDebugWorker(status.python);
      }, state => updateMemory(session, state));
      return new vscode.DebugAdapterInlineImplementation({
        onDidSendMessage: messages.event,
        handleMessage: message => { void adapter.handleMessage(message); },
        dispose() { adapter.dispose(); messages.dispose(); },
      });
    },
  }));

  function requireTrust() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run the assembler or simulator.');
  }

  function editorFolder(document = vscode.window.activeTextEditor?.document) {
    return (document && vscode.workspace.getWorkspaceFolder(document.uri)) ??
      vscode.workspace.workspaceFolders?.[0];
  }

  async function currentJob(folder, task, projectPath) {
    const activeDocument = vscode.window.activeTextEditor?.document;
    const doc = !folder || (activeDocument && vscode.workspace.getWorkspaceFolder(activeDocument.uri)?.uri.toString() === folder.uri.toString())
      ? activeDocument : undefined;
    const uri = doc?.uri;
    if (!task && uri && uri.scheme !== 'file') throw new Error('Save the assembly file locally first.');
    if (folder && folder.uri.scheme !== 'file') throw new Error('Open a workspace with a local filesystem.');
    const settings = vscode.workspace.getConfiguration('cocovs', folder?.uri ?? uri);
    let workspace = folder?.uri.fsPath;
    if (projectPath) {
      const root = await fs.realpath(workspace);
      workspace = confined(root, await fs.realpath(confined(workspace, projectPath)));
    }
    return createJob({file: uri?.fsPath, languageId: doc?.languageId, workspace, task,
      target: settings.get('target'), architecture: settings.get('architecture'), address: settings.get('address')});
  }

  function publish(job, problems) {
    const key = artifactPaths(job).image;
    const byFile = new Map();
    for (const item of problems) {
      if (!Number.isSafeInteger(item.line) || item.line < 1) continue;
      const file = path.resolve(job.root, item.file);
      const line = item.line - 1;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 10000),
        item.message || 'CoCAS diagnostic', item.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'CoCAS';
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(diagnostic);
    }
    const affected = new Set([...(reported.get(key)?.keys() ?? []), ...byFile.keys()]);
    if (byFile.size) reported.set(key, byFile);
    else reported.delete(key);
    for (const file of affected) {
      const values = [...reported.values()].flatMap(project => project.get(file) ?? []);
      const uri = vscode.Uri.file(file);
      if (values.length) diagnostics.set(uri, values);
      else diagnostics.delete(uri);
    }
  }

  function localDebugConfig(job, artifacts) {
    const defaults = {name: 'CocoVS: Debug', type: 'cocovs-debug', request: 'launch'};
    return job ? {...defaults, root: job.root, target: job.config.target, architecture: job.config.architecture, artifacts} : defaults;
  }

  async function debug(job, artifacts, folder, external) {
    if (LOCAL_DEBUG.includes(job.config.target) && !external) {
      if (!await vscode.debug.startDebugging(folder, localDebugConfig(job, artifacts))) throw new Error('Could not start the CocoVS debugger. Check Debug Console.');
      return;
    }
    if (!vscode.extensions.getExtension(OFFICIAL)) {
      const choice = await vscode.window.showInformationMessage('Install CdM Processors for step debugging.', 'Install');
      if (choice !== 'Install') return;
      await vscode.commands.executeCommand('workbench.extensions.installExtension', OFFICIAL);
    }
    const {target, architecture, address, environment} = job.config;
    const started = await vscode.debug.startDebugging(folder, {
      name: 'CocoVS: Debug', type: 'cdm', request: 'launch', target, architecture, address: address ?? 'ws://localhost:7001',
      environment: target === 'cdm16' ? environment : 'external', artifacts,
    });
    if (!started) throw new Error('Could not start CdM debugging. Check the Debug Console and launch settings.');
  }

  async function saveSources() {
    requireTrust();
    if (!await vscode.workspace.saveAll(false)) throw new Error('Save the workspace files before building.');
  }

  async function withBuild(job, options, onBuilt) {
    const key = artifactPaths(job, path.join(await fs.realpath(job.root), 'build')).image;
    if (active.has(key)) throw new Error('A build or run is already active for this output.');
    active.add(key);
    try {
      const target = job.config.target;
      options.signal.throwIfAborted();
      const status = target === 'custom' ? {} : await toolchain.prepare({java: options.java, onOutput: options.onOutput});
      options.signal.throwIfAborted();
      const result = await build(job, status.cocas, {...options, python: status.python});
      publish(job, result.problems);
      if (!result.ok) throw new Error(result.message);
      options.onOutput('Built ' + result.artifacts.image + '\nSources: ' + result.artifacts.combined + '\n');
      return await onBuilt(result.artifacts, status);
    } finally {
      active.delete(key);
    }
  }

  async function perform(mode, folder, task, projectPath, options) {
    await saveSources();
    const job = await currentJob(folder, task, projectPath);
    const target = job.config.target;
    if ((mode === 'debug' || mode === 'debugExternal') && !['cdm8', 'cdm8e', 'cdm16'].includes(target)) {
      throw new Error('CdM Processors debugging supports CdM-8, CdM-8e and CdM-16. Use a project runner for this target.');
    }
    const java = mode === 'debug' && target === 'cdm16' || mode === 'run' && !job.config.runner && /^cdm16e?$/.test(target);
    return withBuild(job, {...options, java, localDebug: mode === 'debug' || task}, async (artifacts, status) => {
      if (mode === 'debug' || mode === 'debugExternal') await debug(job, artifacts, folder, mode === 'debugExternal');
      if (mode === 'run') {
        const state = await runProgram(job, artifacts, status, {
          ...options, maxSteps: vscode.workspace.getConfiguration('cocovs', vscode.Uri.file(job.root)).get('maxSteps'),
        });
        if (state) {
          options.onOutput(JSON.stringify(state, null, 2) + '\n');
          const message = 'CocoVS: ' + state.reason + ' after ' + state.steps + ' instruction(s).';
          if (state.reason === 'halt') vscode.window.showInformationMessage(message);
          else vscode.window.showWarningMessage(message);
        }
      }
    });
  }

  function withProgress(mode, action, parentToken) {
    output.show(true);
    output.appendLine('\n' + mode.toUpperCase());
    return vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'CocoVS: ' + mode, cancellable: true},
      (_progress, token) => {
        const controller = new AbortController();
        const listener = token.onCancellationRequested(() => controller.abort());
        const parent = parentToken?.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested || parentToken?.isCancellationRequested) controller.abort();
        return action({onOutput: chunk => output.append(String(chunk)), signal: controller.signal})
          .catch(error => { if (!controller.signal.aborted) throw error; })
          .finally(() => { listener.dispose(); parent?.dispose(); });
      });
  }

  function activeLaunchFolder() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? vscode.workspace.getWorkspaceFolder(uri) : editorFolder();
  }

  function runCommand(mode) {
    return withProgress(mode, options => perform(mode, activeLaunchFolder(), false, '', options));
  }

  function resolveTask(task) {
    const folder = task.scope;
    if (!folder?.uri || folder.uri.scheme !== 'file') return undefined;
    task.execution = new vscode.CustomExecution(async definition => {
      const write = new vscode.EventEmitter();
      const close = new vscode.EventEmitter();
      const controller = new AbortController();
      const append = chunk => write.fire(String(chunk).replace(/\r?\n/g, '\r\n'));
      return {
        onDidWrite: write.event, onDidClose: close.event,
        open() {
          perform('build', folder, true, definition.project, {onOutput: append, signal: controller.signal})
            .then(() => close.fire(0), error => { append(error.message + '\n'); close.fire(1); })
            .finally(() => { write.dispose(); close.dispose(); });
        },
        close() { controller.abort(); },
      };
    });
    return task;
  }

  function localFolder(document) {
    const folder = editorFolder(document);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local folder in VS Code first.');
    return folder.uri.fsPath;
  }

  async function init() {
    requireTrust();
    const root = localFolder();
    const file = path.join(root, MANIFEST);
    if (!(await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; }))) {
      const target = await vscode.window.showQuickPick(TARGETS, {placeHolder: 'Processor target'});
      if (!target) return;
      const config = {entry: 'main.asm', target, architecture: 'vonNeumann', environment: target === 'cdm8e' ? 'external' : 'emulator', extraSources: []};
      if (target === 'custom') {
        config.assembler = {command: './tools/assembler', args: ['-o', '$' + '{image}', '$' + '{sources}']};
        config.instructions = [];
      }
      await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', {flag: 'wx'});
      await fs.writeFile(path.join(root, 'main.asm'), target === 'custom' ? '' : 'asect 0\nstart:\n    halt\nend\n',
        {flag: 'wx'}).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    syncConfigs(root, loadProject(root));
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  function sync(document = vscode.window.activeTextEditor?.document) {
    requireTrust();
    const workspace = localFolder(document);
    const inWorkspace = document && vscode.workspace.getWorkspaceFolder(document.uri);
    const root = (inWorkspace && locateProject(document.fileName, workspace)) ?? workspace;
    const config = loadProject(root);
    resolveSources(root, config);
    syncConfigs(workspace, config, root);
  }

  const actions = {
    'cocovs.setup': () => setup(), 'cdmProject.init': init, 'cdmProject.sync': () => sync(),
    'cdmProject.build': () => runCommand('build'), 'cocovs.run': () => runCommand('run'), 'cdmProject.debug': () => runCommand('debug'),
    'cocovs.debugExternal': () => runCommand('debugExternal'),
  };
  for (const [name, action] of Object.entries(actions)) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { await action(); } catch (error) { output.appendLine(error.message); showError(error); }
    }));
  }
  context.subscriptions.push(vscode.tasks.registerTaskProvider('cocovs', {provideTasks: () => [], resolveTask}));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (!vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('cdmProject', document.uri).get('autoSyncOnSave')) return;
    if (!ASSEMBLY.test(document.fileName) && path.basename(document.fileName) !== MANIFEST) return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || !locateProject(document.fileName, folder.uri.fsPath)) return;
    try { sync(document); } catch (error) { showError(error); }
  }));
}

module.exports = {activate};

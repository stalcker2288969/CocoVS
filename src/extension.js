'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {build, artifactPaths} = require('./build');
const {registerEditor} = require('./editor');
const {createJob} = require('./jobs');
const {ASSEMBLY, MANIFEST, PROJECT_BUILD, PROJECT_DEBUG, TARGETS, confined, loadProject, locateProject,
  resolveSources, syncConfigs} = require('./project');
const {runProgram} = require('./runtime');
const {registerSetup} = require('./setup');
const {DebugAdapter} = require('./debug-adapter');
const {createDebugWorker} = require('./debug-worker');
const {memoryView} = require('./memory-view');
const {registerTesting} = require('./testing');
const {fileKey} = require('./live-check');

const OFFICIAL = 'cdm-processors.vscode-cdm-extension';
const NAME = 'CocoVS';
const LOCAL_DEBUG = ['cdm8', 'cdm16'];

function activate(context) {
  const output = vscode.window.createOutputChannel(NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection('cocovs');
  const active = new Set();
  const reported = new Map();
  const pendingReports = new Set();
  let live = new Map();
  let updateMemory;
  context.subscriptions.push(output, diagnostics);
  const showError = error => vscode.window.showErrorMessage('CocoVS: ' + error.message.split(/\r?\n/)[0]);
  const {setup, toolchain} = registerSetup(context, output, showError);
  context.subscriptions.push(vscode.tasks.registerTaskProvider('cocovs', {provideTasks: () => [], resolveTask}));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cocovs-debug', {
    resolveDebugConfiguration(_folder, config) {
      if (!config.request) return {...config, ...localDebugConfig()};
      if (config.name === PROJECT_DEBUG && config.root && config.preLaunchTask === PROJECT_BUILD) {
        // Older generated profiles contain a task, static target settings and artifact paths.
        config = {...config};
        for (const key of ['preLaunchTask', 'artifacts', 'architecture', 'target']) delete config[key];
      }
      return config;
    },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
      if (config.request === 'launch' && !config.artifacts) {
        try {
          const selectedFolder = folder ?? activeLaunchFolder();
          const launch = await withProgress('build for debug', async options => {
            await saveSources();
            let job;
            if (config.name === PROJECT_DEBUG && config.root) {
              const root = await fs.realpath(config.root);
              if (selectedFolder) confined(await fs.realpath(selectedFolder.uri.fsPath), root);
              job = createJob({workspace: root, task: true});
            } else {
              job = await currentJob(selectedFolder, false);
            }
            if (!LOCAL_DEBUG.includes(job.config.target)) throw new Error('Local debugging is unavailable for ' + job.config.target + '.');
            return withLocalDebugBuild(job, options);
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
      }, state => updateMemory?.(session, state));
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

  function groupProblems(root, problems) {
    const byFile = new Map();
    for (const item of problems) {
      if (!Number.isSafeInteger(item.line) || item.line < 1) continue;
      const file = path.resolve(root, item.file);
      const key = fileKey(file);
      if (!byFile.has(key)) byFile.set(key, {file, items: []});
      byFile.get(key).items.push(item);
    }
    return byFile;
  }

  function updateDiagnostics(affected) {
    for (const [key, {file}] of affected) {
      const issues = [...(live.get(key)?.items ?? []),
        ...[...reported.values()].flatMap(report => report.issues.get(key)?.items ?? [])];
      const document = vscode.workspace.textDocuments?.find(doc => doc.uri.scheme === 'file' && fileKey(doc.fileName) === key);
      const seen = new Set();
      const values = [];
      for (const item of issues) {
        const line = document ? Math.min(item.line - 1, document.lineCount - 1) : item.line - 1;
        const source = document?.lineAt(line);
        const start = source ? Math.min(item.column ?? source.firstNonWhitespaceCharacterIndex, source.text.length) : item.column ?? 0;
        const end = source?.text.length ?? 10000;
        const id = JSON.stringify([line, item.message, !!item.warning]);
        if (seen.has(id)) continue;
        seen.add(id);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, start, line, end),
          item.message || 'CoCAS diagnostic', item.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'CoCAS';
        values.push(diagnostic);
      }
      const uri = vscode.Uri.file(file);
      if (values.length) diagnostics.set(uri, values);
      else diagnostics.delete(uri);
    }
  }

  function publishLive(problems) {
    const previous = live;
    live = groupProblems('.', problems);
    updateDiagnostics(new Map([...previous, ...live]));
  }

  function publish(job, report, problems) {
    const key = artifactPaths(job).image;
    report.issues = groupProblems(job.root, problems);
    const affected = new Map([...(reported.get(key)?.issues ?? []), ...report.issues]);
    if (report.issues.size) reported.set(key, report);
    else reported.delete(key);
    updateDiagnostics(affected);
  }

  function invalidateBuild(file) {
    const key = fileKey(file);
    for (const report of pendingReports) if (report.sources.has(key)) report.stale = true;
    const affected = new Map();
    for (const [image, report] of reported) {
      if (!report.sources.has(key)) continue;
      for (const [key, value] of report.issues) affected.set(key, value);
      reported.delete(image);
    }
    updateDiagnostics(affected);
  }

  function localDebugConfig(job, artifacts) {
    const defaults = {name: 'CocoVS: Debug', type: 'cocovs-debug', request: 'launch', stopOnEntry: true};
    return job ? {...defaults, root: job.root, target: job.config.target, architecture: job.config.architecture, artifacts} : defaults;
  }

  function withLocalDebugBuild(job, options, onReady = launch => launch) {
    return withBuild(job, {...options, localDebug: true, java: job.config.target === 'cdm16'},
      artifacts => onReady(localDebugConfig(job, artifacts)));
  }

  async function debugExternal(job, artifacts, folder) {
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
    const report = {sources: new Set([...job.sources, MANIFEST].map(file => fileKey(path.resolve(job.root, file))))};
    pendingReports.add(report);
    try {
      const target = job.config.target;
      options.signal.throwIfAborted();
      const status = target === 'custom' ? {} : await toolchain.prepare({
        java: options.java, debug16: target === 'cdm16' && options.localDebug, onOutput: options.onOutput,
      });
      options.signal.throwIfAborted();
      const result = await build(job, status.cocas, {...options, python: status.python,
        debugPython: status.debugPython, language: vscode.env?.language});
      if (!report.stale) publish(job, report, result.problems);
      if (!result.ok) throw new Error(result.message + (result.details ? '\n\nCoCAS output:\n' + result.details : ''));
      options.onOutput('Built ' + result.artifacts.image + '\nSources: ' + result.artifacts.combined + '\n');
      return await onBuilt(result.artifacts, status);
    } finally {
      pendingReports.delete(report);
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
    if (mode === 'debug' && LOCAL_DEBUG.includes(target)) {
      return withLocalDebugBuild(job, options, async launch => {
        if (!await vscode.debug.startDebugging(folder, launch)) {
          throw new Error('Could not start the CocoVS debugger. Check Debug Console.');
        }
      });
    }
    const java = mode === 'run' && !job.config.runner && /^cdm16e?$/.test(target);
    return withBuild(job, {...options, java, localDebug: task}, async (artifacts, status) => {
      if (mode === 'debug' || mode === 'debugExternal') await debugExternal(job, artifacts, folder);
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
    const folders = vscode.workspace.workspaceFolders;
    const folder = task.scope === vscode.TaskScope.Workspace && folders?.length === 1 ? folders[0] : task.scope;
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
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (!vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('cdmProject', document.uri).get('autoSyncOnSave')) return;
    if (!ASSEMBLY.test(document.fileName) && path.basename(document.fileName) !== MANIFEST) return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || !locateProject(document.fileName, folder.uri.fsPath)) return;
    try { sync(document); } catch (error) { showError(error); }
  }));
  for (const [feature, initialize] of [
    ['Editor', () => registerEditor(context, {toolchain, publishLive, invalidateBuild})],
    ['Testing', () => registerTesting(context)],
    ['Memory view', () => { updateMemory = memoryView(context); }],
  ]) {
    try { initialize(); }
    catch (error) { output.appendLine(feature + ': ' + (error.stack ?? error.message)); }
  }
}

module.exports = {activate};

'use strict';

const path = require('node:path');
const vscode = require('vscode');
const {ASSEMBLY, inferTarget, loadProject, locateProject, resolveSources} = require('./project');
const {MANIFEST_PATTERN, IGNORE, findCdmbot, jsonResult, editCdmbot, exactCasePattern} = require('./cdmbot');

function registerTesting(context) {
  const controller = vscode.tests.createTestController('cocovs-cdmbot', 'CocoVS · cdmbot');
  const projects = new Map();
  const metadata = new WeakMap();
  let timer;
  let generation = 0;
  let python;
  const settings = uri => vscode.workspace.getConfiguration('cocovs', uri);
  const tool = () => python ??= findCdmbot(settings().get('cdmbotPythonPath')).then(found => {
    if (!found) python = undefined;
    return found;
  });

  function item(parent, id, label, uri, data) {
    let value = parent.get(id);
    if (!value || value.uri?.toString() !== uri?.toString()) {
      value = controller.createTestItem(id, label, uri);
      parent.add(value);
    }
    metadata.set(value, data);
    return value;
  }

  async function refresh() {
    clearTimeout(timer);
    if (!vscode.workspace.isTrusted) return;
    const revision = ++generation;
    const manifests = await vscode.workspace.findFiles(MANIFEST_PATTERN, IGNORE);
    const interpreter = manifests.length ? await tool() : undefined;
    const discovery = await Promise.all(manifests.map(async uri => {
      try {
        if (!interpreter) throw new Error('Install cdmbot or set cocovs.cdmbotPythonPath.');
        return {uri, suites: await editCdmbot(interpreter, 'discover', uri.fsPath)};
      } catch (error) { return {uri, suites: [], error: error.message}; }
    }));
    if (revision !== generation) return;
    const retained = new Set();
    for (const {uri, suites, error} of discovery) {
      if (!suites) continue;
      const id = uri.toString();
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      const label = path.relative(folder?.uri.fsPath ?? path.dirname(uri.fsPath), uri.fsPath);
      const project = {file: uri.fsPath, root: path.dirname(uri.fsPath), suites};
      const root = item(controller.items, id, folder ? folder.name + ' · ' + label : label, uri, {project});
      root.error = error;
      project.item = root;
      project.checks = item(root.children, id + ':checks', 'Project checks', uri, {project, checks: true});
      projects.set(id, project);
      retained.add(id);
      const suiteIds = new Set([project.checks.id]);
      for (const suite of suites) {
        const suiteId = JSON.stringify([id, suite.name]);
        const suiteUri = vscode.Uri.file(suite.file);
        suite.item = item(root.children, suiteId, suite.name, suiteUri, {project, suite});
        suite.item.error = suite.error;
        suiteIds.add(suiteId);
        const caseIds = new Set();
        for (const test of suite.cases ?? []) {
          const caseId = JSON.stringify([suiteId, test.name]);
          test.item = item(suite.item.children, caseId, test.name, suiteUri, {project, suite, test});
          test.item.range = new vscode.Range(test.line, 0, test.line, 0);
          caseIds.add(caseId);
        }
        suite.item.children.forEach(child => { if (!caseIds.has(child.id)) suite.item.children.delete(child.id); });
      }
      root.children.forEach(child => { if (!suiteIds.has(child.id)) root.children.delete(child.id); });
    }
    for (const id of projects.keys()) {
      if (retained.has(id)) continue;
      controller.items.delete(id);
      projects.delete(id);
    }
  }

  function describe(run, test, state, message, seconds) {
    if (state === 'passed') run.passed(test, seconds === undefined ? undefined : seconds * 1000);
    else if (state === 'skipped') run.skipped(test);
    else {
      const detail = new vscode.TestMessage(message);
      if (test.uri && test.range) detail.location = new vscode.Location(test.uri, test.range);
      run[state](test, detail, seconds === undefined ? undefined : seconds * 1000);
    }
  }

  function reportSuite(run, suite, selected, report) {
    if (report.error) describe(run, suite.item, 'errored', report.error);
    const results = new Map((report.cases ?? []).map(test => [test.name, test]));
    for (const test of selected) {
      const entry = results.get(test.name);
      if (entry?.error || report.error) describe(run, test.item, 'errored', entry?.error ?? report.error, entry?.seconds);
      else if (!entry || !entry.started) describe(run, test.item, 'skipped');
      else if (entry.passed) describe(run, test.item, 'passed', '', entry.seconds);
      else describe(run, test.item, 'failed', entry.failures.join('\n'), entry.seconds);
    }
  }

  async function runTests(request, token) {
    if (!vscode.workspace.isTrusted) return;
    const run = controller.createTestRun(request);
    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    try {
      const interpreter = await tool();
      if (!interpreter) throw new Error('Install cdmbot or set cocovs.cdmbotPythonPath.');
      if (token.isCancellationRequested || !await vscode.workspace.saveAll(false)) return;
      const include = new Set(request.include ?? [...projects.values()].map(project => project.item));
      const exclude = new Set(request.exclude ?? []);
      const selected = test => {
        let included = false;
        for (let item = test; item; item = item.parent) {
          if (exclude.has(item)) return false;
          if (include.has(item)) included = true;
        }
        return included;
      };
      for (const project of projects.values()) {
        const suites = project.suites.map(suite => ({suite, cases: (suite.cases ?? []).filter(test => selected(test.item))}))
          .filter(({suite, cases}) => cases.length || selected(suite.item) && !suite.cases?.length);
        const checks = selected(project.checks);
        const filtered = suites.some(({suite, cases}) => cases.length !== suite.cases?.length) ||
          [...exclude].some(test => metadata.get(test)?.project === project && test !== project.checks);
        if ((!suites.length && !checks) || token.isCancellationRequested) continue;
        const tests = suites.flatMap(({suite, cases}) => cases.length ? cases.map(test => test.item) : [suite.item]);
        if (checks) tests.push(project.checks);
        const uri = vscode.Uri.file(project.file);
        const jobs = Math.min(32, Math.max(1, Math.trunc(settings(uri).get('cdmbotJobs', 4))));
        const flags = ['--json', '--jobs', String(jobs)];
        const options = {cwd: project.root, signal: abort.signal, timeout: 300_000};
        for (const test of tests) { run.enqueued(test); run.started(test); }
        try {
          let whole;
          if (checks && filtered) {
            run.skipped(project.checks);
            run.appendOutput('Project checks were skipped because coverage requires the whole project.\r\n');
          } else if (checks) {
            const {report, stderr} = await jsonResult(interpreter, ['-m', 'cdmbot', 'project', project.file, ...flags], options);
            whole = report;
            if (stderr) run.appendOutput(stderr.replace(/\r?\n/g, '\r\n'));
            const failures = report.checks.filter(check => check.failure).map(check => check.name + ': ' + check.failure);
            describe(run, project.checks, failures.length ? 'failed' : 'passed', failures.join('\n'));
            if (report.coverage?.summary) {
              const {file_percent: file, line_percent: line, comment_percent: comment} = report.coverage.summary;
              run.appendOutput('Coverage: files ' + (file ?? 'n/a') + ', lines ' + (line ?? 'n/a') +
                ', comments ' + (comment ?? 'n/a') + ' (%)\r\n');
            }
          }
          for (const {suite, cases} of suites) {
            if (token.isCancellationRequested) { for (const test of cases) run.skipped(test.item); continue; }
            const filter = cases.length === suite.cases?.length ? [] :
              cases.flatMap(test => ['--case', exactCasePattern(test.name)]);
            try {
              const report = whole?.suites?.[suite.name] ??
                (await jsonResult(interpreter, ['-m', 'cdmbot', suite.program, suite.file, ...flags, ...filter], options)).report;
              reportSuite(run, suite, cases, report);
            } catch (error) {
              for (const item of cases.length ? cases.map(test => test.item) : [suite.item]) {
                describe(run, item, abort.signal.aborted ? 'skipped' : 'errored', error.message);
              }
            }
          }
        } catch (error) {
          for (const test of tests) describe(run, test, abort.signal.aborted ? 'skipped' : 'errored', error.message);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) void vscode.window.showErrorMessage('CocoVS: ' + error.message);
    } finally {
      cancellation.dispose();
      run.end();
    }
  }

  async function existing(uri) {
    try { await vscode.workspace.fs.stat(uri); }
    catch (error) { if (error.code === 'FileNotFound' || error.code === 'ENOENT') return undefined; throw error; }
    return vscode.workspace.openTextDocument(uri);
  }

  async function changeFiles(entries) {
    const edit = new vscode.WorkspaceEdit();
    for (const {uri, document, version, text} of entries) {
      if (document) {
        if (document.version !== version || document.isDirty) throw new Error('The YAML changed. Save it and try again.');
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      } else {
        edit.createFile(uri);
        edit.insert(uri, new vscode.Position(0, 0), text);
      }
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not apply the YAML changes.');
    for (const {uri} of entries) {
      if (!await (await vscode.workspace.openTextDocument(uri)).save()) throw new Error('Could not save ' + uri.fsPath);
    }
  }

  async function createSuite(interpreter) {
    const active = vscode.window.activeTextEditor?.document;
    const folder = active && vscode.workspace.getWorkspaceFolder(active.uri) || vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a workspace folder first.');
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{asm,cdm8,cdm16}'), IGNORE);
    const choices = files.map(uri => ({label: path.relative(folder.uri.fsPath, uri.fsPath), uri}));
    if (active && ASSEMBLY.test(active.fileName)) choices.sort((a, b) => Number(b.uri.fsPath === active.fileName) - Number(a.uri.fsPath === active.fileName));
    const program = await vscode.window.showQuickPick(choices, {placeHolder: 'Select the executable assembly entry point'});
    if (!program) return;
    const name = await vscode.window.showInputBox({prompt: 'Suite name', validateInput: value =>
      /^[a-zA-Z][\w-]*$/.test(value) ? undefined : 'Use letters, digits, underscores or hyphens, starting with a letter.'});
    if (!name) return;
    const root = locateProject(program.uri.fsPath, folder.uri.fsPath) ?? folder.uri.fsPath;
    const uri = vscode.Uri.file(path.join(root, 'project.yaml'));
    const alternate = vscode.Uri.file(path.join(root, 'project.yml'));
    const manifest = await existing(uri) ?? await existing(alternate);
    const manifestUri = manifest?.uri ?? uri;
    const suiteUri = vscode.Uri.file(path.join(root, 'tests', name + '.yaml'));
    if (await existing(suiteUri)) throw new Error('A suite YAML with that name already exists.');
    const configRoot = locateProject(program.uri.fsPath, root);
    const config = configRoot && loadProject(configRoot);
    const architecture = config?.target ?? inferTarget(program.uri.fsPath, undefined, settings(program.uri).get('target', 'cdm8'));
    if (!['cdm8', 'cdm16'].includes(architecture)) throw new Error('cdmbot supports CdM-8 and CdM-16.');
    const relative = (base, file) => path.relative(base, file).split(path.sep).join('/');
    const entry = relative(root, program.uri.fsPath);
    const sources = resolveSources(root, {entry, extraSources: config?.extraSources})
      .filter(file => file !== entry).map(file => relative(path.dirname(suiteUri.fsPath), path.join(root, file)));
    const version = manifest?.version;
    const result = await editCdmbot(interpreter, 'suite', manifestUri.fsPath, [name, entry,
      relative(root, suiteUri.fsPath), architecture, config?.architecture === 'harvard' ? 'harvard' : 'unified', ...sources]);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(suiteUri.fsPath)));
    await changeFiles([{uri: suiteUri, text: result.suite}, {uri: manifestUri, document: manifest, version, text: result.manifest}]);
    await vscode.window.showTextDocument(suiteUri);
  }

  async function addCase(interpreter, item) {
    let suite = metadata.get(item)?.suite;
    if (!suite) {
      const options = [...projects.values()].flatMap(project => project.suites.map(suite =>
        ({label: suite.name, description: path.relative(project.root, suite.file), suite})));
      suite = (await vscode.window.showQuickPick(options, {placeHolder: 'Select a cdmbot suite'}))?.suite;
    }
    if (!suite) return;
    const name = await vscode.window.showInputBox({prompt: 'Test case name', validateInput: value =>
      value.trim() && !suite.cases?.some(test => test.name === value.trim()) ? undefined : 'Enter a unique case name.'});
    if (!name?.trim()) return;
    const uri = vscode.Uri.file(suite.file);
    if (!vscode.workspace.getWorkspaceFolder(uri)) throw new Error('Open the folder containing this suite before editing it.');
    const document = await vscode.workspace.openTextDocument(uri);
    const version = document.version;
    const text = await editCdmbot(interpreter, 'case', suite.file, [name.trim()]);
    await changeFiles([{uri, document, version, text}]);
    await vscode.window.showTextDocument(uri);
  }

  function command(name, action) {
    return vscode.commands.registerCommand(name, async item => {
      try {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use cdmbot.');
        if (!await vscode.workspace.saveAll(false)) return;
        const interpreter = await tool();
        if (!interpreter) throw new Error('Install cdmbot or set cocovs.cdmbotPythonPath.');
        await action(interpreter, item);
        await refresh();
      } catch (error) { void vscode.window.showErrorMessage('CocoVS: ' + error.message); }
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh().catch(() => {}); }, 200);
  }

  controller.refreshHandler = refresh;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml}');
  context.subscriptions.push(controller, controller.createRunProfile('Run with cdmbot', vscode.TestRunProfileKind.Run, runTests, true),
    watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule), vscode.workspace.onDidGrantWorkspaceTrust(schedule),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('cocovs.cdmbotPythonPath')) { python = undefined; schedule(); }
    }),
    command('cocovs.createTestSuite', createSuite), command('cocovs.addTestCase', addCase),
    {dispose() { clearTimeout(timer); generation++; }});
  schedule();
}

module.exports = {registerTesting};

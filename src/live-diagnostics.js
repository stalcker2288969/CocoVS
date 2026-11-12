'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {checkSyntax, fileKey} = require('./live-check');
const {ASSEMBLY, MANIFEST, resolveSources} = require('./project');

function registerLiveDiagnostics(context, vscode, {selector, projectInfo, toolchain, publishLive, invalidateBuild}) {
  const {workspace, window} = vscode;
  let timer;
  let current;
  let detection;
  let checkedAt = 0;
  const isAssembly = document => document.uri.scheme === 'file' && selector.includes(document.languageId);
  const isManifest = document => document.uri.scheme === 'file' && path.basename(document.fileName) === MANIFEST;
  const enabled = document => isAssembly(document) && workspace.getConfiguration('cocovs', document.uri).get('liveDiagnostics', true);

  function assembler() {
    if (!workspace.isTrusted) return undefined;
    if (!detection || Date.now() - checkedAt > 15_000) {
      checkedAt = Date.now();
      detection = toolchain.inspectAssembler().catch(() => undefined);
    }
    return detection;
  }

  async function validate(signal) {
    const documents = new Map(workspace.textDocuments.filter(doc => isAssembly(doc) || doc.uri.scheme === 'file' &&
      ASSEMBLY.test(doc.fileName)).map(doc => [fileKey(doc.fileName), doc]));
    const read = file => documents.get(fileKey(file))?.getText() ?? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const jobs = new Map();
    function addJob(root, config, target) {
      const key = JSON.stringify([fileKey(root), config.entry, config.extraSources ?? [], target]);
      if (jobs.has(key)) return jobs.get(key);
      const sources = resolveSources(root, config, {read, onError() {}}).map(relative => {
        const file = path.join(root, relative);
        return {file, text: ASSEMBLY.test(file) ? read(file) : undefined};
      });
      jobs.set(key, {root, target, sources});
      return jobs.get(key);
    }
    for (const {document} of window.visibleTextEditors) {
      if (!enabled(document)) continue;
      try {
        const {root, config, target} = projectInfo(document);
        if (target === 'custom') continue;
        const entry = path.relative(root, document.fileName);
        const project = config && addJob(root, config, target);
        if (!project?.sources.some(source => fileKey(source.file) === fileKey(document.fileName))) {
          addJob(root, {entry}, target);
        }
      } catch { /* A file or workspace folder may have been removed. */ }
    }
    const tool = jobs.size ? await assembler() : undefined;
    if (signal.aborted) return;
    const problems = await Promise.all([...jobs.values()].map(job =>
      checkSyntax(job, tool, {signal, language: vscode.env.language}).catch(() => [])));
    if (!signal.aborted) publishLive(problems.flat());
  }

  function schedule() {
    clearTimeout(timer);
    current?.abort();
    if (!window.visibleTextEditors.some(editor => enabled(editor.document))) {
      publishLive([]);
      return;
    }
    const {signal} = current = new AbortController();
    timer = setTimeout(() => {
      void validate(signal).catch(() => { if (!signal.aborted) publishLive([]); });
    }, 350);
  }

  function changed(document) {
    if (!isAssembly(document) && !isManifest(document) &&
        !(document.uri.scheme === 'file' && ASSEMBLY.test(document.fileName))) return;
    invalidateBuild(document.fileName);
    schedule();
  }

  context.subscriptions.push(
    {dispose() { clearTimeout(timer); current?.abort(); }},
    window.onDidChangeVisibleTextEditors(schedule),
    workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) changed(event.document); }),
    workspace.onDidSaveTextDocument(changed),
    workspace.onDidCloseTextDocument(document => {
      if (isAssembly(document) || isManifest(document)) schedule();
    }),
    workspace.onDidGrantWorkspaceTrust(schedule),
    workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('cocovs')) return;
      detection = undefined;
      schedule();
    }),
  );
  schedule();
}

module.exports = {registerLiveDiagnostics};

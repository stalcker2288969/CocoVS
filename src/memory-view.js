'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {confined} = require('./project');
const labelKey = label => JSON.stringify([label.file, label.name]);

function memoryView(context) {
  let panel;
  let last;
  const snapshots = new Map();
  const autoOpened = new Set();
  const assets = vscode.Uri.joinPath(context.extensionUri, 'media');
  const pins = new Map();
  const colors = new Map();
  const pending = new Map();

  function selected() {
    return snapshots.get(vscode.debug.activeDebugSession?.id) ?? last;
  }

  function pinned(root) {
    if (!pins.has(root)) pins.set(root, new Set(context.workspaceState.get('cocovs.pins:' + root, [])));
    return pins.get(root);
  }

  function palette(root) {
    if (!colors.has(root)) colors.set(root, context.workspaceState.get('cocovs.memoryColors:' + root, {labels: {}}));
    return colors.get(root);
  }

  async function persist(root, key, value) {
    const update = (pending.get(root) ?? Promise.resolve()).catch(() => {}).then(() => context.workspaceState.update(key, value));
    pending.set(root, update);
    render();
    try { await update; }
    finally { if (pending.get(root) === update) pending.delete(root); }
  }

  function render() {
    if (!panel?.visible) return;
    const snapshot = selected();
    void panel.webview.postMessage({type: 'memory', snapshot, pinned: snapshot ? [...pinned(snapshot.root)] : [],
      colors: snapshot ? palette(snapshot.root) : undefined});
  }

  async function interact(message) {
    if (message.type === 'ready') { render(); return; }
    const snapshot = selected();
    if (!snapshot?.root || snapshot.session !== message.session || !['pin', 'reveal', 'color'].includes(message.type)) return;
    const label = snapshot.dataLabels.find(item => labelKey(item) === message.key);
    if (message.type === 'color') {
      if (!label && message.key !== 'stack' || message.color !== null && !/^#[\da-f]{6}$/i.test(message.color)) return;
      const current = palette(snapshot.root);
      const next = {...current, labels: {...current.labels}};
      if (message.key === 'stack') next.stack = message.color;
      else if (message.color) next.labels[message.key] = message.color;
      else delete next.labels[message.key];
      colors.set(snapshot.root, next);
      await persist(snapshot.root, 'cocovs.memoryColors:' + snapshot.root, next);
      return;
    }
    if (!label) return;
    if (message.type === 'pin') {
      const values = pinned(snapshot.root);
      if (message.pinned === true) values.add(message.key);
      else values.delete(message.key);
      await persist(snapshot.root, 'cocovs.pins:' + snapshot.root, [...values]);
      return;
    }
    const root = await fs.realpath(snapshot.root);
    const file = confined(root, await fs.realpath(confined(root, path.resolve(root, label.file))));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const line = Math.max(0, Math.min(document.lineCount - 1, (label.definitionLine ?? label.line) - 1));
    const column = Math.max(0, Math.min(document.lineAt(line).text.length, label.column ?? 0));
    await vscode.window.showTextDocument(document, {viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Range(line, column, line, column + label.name.length)});
  }

  function open(preserveFocus = false) {
    if (panel) {
      if (!preserveFocus) panel.reveal(panel.viewColumn, false);
      render();
      return;
    }
    const view = vscode.window.createWebviewPanel('cocovsMemory', 'CocoVS RAM', {
      viewColumn: vscode.ViewColumn.Beside, preserveFocus,
    }, {enableScripts: true, localResourceRoots: [assets]});
    panel = view;
    const stylesheet = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'memory.css'));
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'memory.js'));
    const source = view.webview.cspSource;
    view.webview.html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + source + '; script-src ' + source + ';">' +
      '<link rel="stylesheet" href="' + stylesheet + '"><title>CocoVS RAM</title></head><body>' +
      '<header><h1 id="processor-name">CocoVS Debug</h1><p id="status" role="status">Start a local CdM-8 or CdM-16 debug session.</p></header>' +
      '<section class="registers" aria-labelledby="register-heading"><h2 id="register-heading">Registers</h2>' +
      '<div id="control-registers" class="control-registers"></div><div id="general-registers" class="general-registers"></div></section>' +
      '<section class="watches" aria-labelledby="watches-heading">' +
      '<details id="watch-section" open><summary id="watches-heading">Data labels</summary><div class="watch-tools">' +
      '<input id="watch-search" type="search" aria-label="Find labels by name or type" placeholder="Find by name or type">' +
      '<label>Format <select id="watch-format"><option value="auto">Auto</option><option value="hex">Hex</option>' +
      '<option value="unsigned">Unsigned</option><option value="signed">Signed</option><option value="text">Text</option></select></label></div></details>' +
      '<p id="watch-empty">No linked data labels.</p><div class="scroll"><table id="watches" hidden><thead><tr>' +
      '<th scope="col">Label</th><th scope="col">Address</th><th scope="col">Type</th><th scope="col">Value</th><th scope="col">Actions</th></tr></thead>' +
      '<tbody id="watch-rows"></tbody></table></div></section>' +
      '<details id="ram-section" open><summary>RAM</summary><div class="watch-tools">' +
      '<label>Stack color <input id="stack-color" type="color" value="#aa7ad9"></label></div>' +
      '<div class="ram-nav" id="ram-nav" hidden>' +
      '<button id="ram-prev" type="button" aria-label="Previous RAM page">‹</button>' +
      '<label>Address <input id="ram-address" value="0x0000" size="8"></label>' +
      '<button id="ram-next" type="button" aria-label="Next RAM page">›</button></div>' +
      '<div class="scroll"><table aria-label="RAM bytes in hexadecimal" id="ram"></table></div>' +
      '<footer><span class="legend changed">Changed</span><span class="legend pc">PC</span><span class="legend sp">SP</span></footer></details>' +
      '<script src="' + script + '"></script></body></html>';
    const messages = view.webview.onDidReceiveMessage(message => {
      void interact(message).catch(error => vscode.window.showErrorMessage('CocoVS: ' + error.message));
    });
    const state = view.onDidChangeViewState(render);
    view.onDidDispose(() => {
      messages.dispose();
      state.dispose();
      if (panel === view) panel = undefined;
    });
  }

  context.subscriptions.push(vscode.commands.registerCommand('cocovs.openMemory', () => open()),
    vscode.debug.onDidChangeActiveDebugSession(render),
    vscode.debug.onDidTerminateDebugSession(session => {
      snapshots.delete(session.id);
      autoOpened.delete(session.id);
      render();
    }),
    {dispose() { panel?.dispose(); }},
  );

  return (session, state) => {
    const snapshot = {...state, session: session.id};
    snapshots.set(session.id, snapshot);
    last = snapshot;
    if (state.status === 'paused' && !autoOpened.has(session.id)) {
      autoOpened.add(session.id);
      if (vscode.workspace.getConfiguration('cocovs', session.workspaceFolder?.uri).get('openMemoryOnDebug')) open(true);
    }
    render();
  };
}

module.exports = {memoryView};

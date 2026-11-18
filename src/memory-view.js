'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {confined} = require('./project');
const labelKey = label => JSON.stringify([label.file, label.name]);
const titles = {overview: 'CocoVS RAM', registers: 'CocoVS Registers', labels: 'CocoVS Data Labels', ram: 'CocoVS Memory Grid'};
const sections = ['registers', 'labels', 'ram'];

function memoryView(context) {
  const panels = new Map();
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

  function renderPanel(kind, panel) {
    if (!panel.visible) return;
    const snapshot = selected();
    if (kind === 'registers' && snapshot) {
      const {session, target, pc, sp, ps, registers, steps, architecture, status} = snapshot;
      void panel.webview.postMessage({type: 'memory', snapshot: {session, target, pc, sp, ps, registers, steps, architecture, status}});
      return;
    }
    void panel.webview.postMessage({type: 'memory', snapshot, pinned: snapshot ? [...pinned(snapshot.root)] : [],
      colors: snapshot ? palette(snapshot.root) : undefined});
  }

  function render() {
    for (const [kind, panel] of panels) renderPanel(kind, panel);
  }

  async function interact(message) {
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

  function open(kind, viewColumn = vscode.ViewColumn.Beside, preserveFocus = false) {
    const existing = panels.get(kind);
    if (existing) {
      if (!preserveFocus) existing.reveal();
      renderPanel(kind, existing);
      return existing;
    }
    const type = kind === 'overview' ? 'cocovsMemory' : 'cocovsMemory.' + kind;
    const view = vscode.window.createWebviewPanel(type, titles[kind], {viewColumn, preserveFocus},
      {enableScripts: true, localResourceRoots: [assets]});
    panels.set(kind, view);
    const messages = view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') renderPanel(kind, view);
      else if (message?.type === 'split' && kind === 'overview') split();
      else if (message) void interact(message).catch(error => vscode.window.showErrorMessage('CocoVS: ' + error.message));
    });
    const state = view.onDidChangeViewState(() => renderPanel(kind, view));
    view.onDidDispose(() => {
      messages.dispose();
      state.dispose();
      panels.delete(kind);
    });
    view.webview.html = panelContent(view, assets, kind);
    return view;
  }

  function split() {
    const overview = panels.get('overview');
    const anchor = overview ?? panels.values().next().value;
    let column = anchor?.viewColumn ?? vscode.ViewColumn.Beside;
    for (const kind of sections) {
      const view = open(kind, column, true);
      if (column === vscode.ViewColumn.Beside) column = view.viewColumn ?? column;
    }
    overview?.dispose();
  }

  async function choosePanel() {
    const choices = sections.map(kind => ({label: titles[kind], kind}));
    const selected = await vscode.window.showQuickPick(choices, {placeHolder: 'Select a CocoVS debug panel'});
    if (selected) open(selected.kind);
  }

  context.subscriptions.push(vscode.commands.registerCommand('cocovs.openMemory', () => { open('overview'); }),
    vscode.commands.registerCommand('cocovs.splitMemory', split),
    vscode.commands.registerCommand('cocovs.openMemoryPanel', choosePanel),
    vscode.debug.onDidChangeActiveDebugSession(render),
    vscode.debug.onDidTerminateDebugSession(session => {
      snapshots.delete(session.id);
      autoOpened.delete(session.id);
      render();
    }),
    {dispose() { for (const panel of panels.values()) panel.dispose(); }},
  );

  return (session, state) => {
    const snapshot = {...state, session: session.id};
    snapshots.set(session.id, snapshot);
    last = snapshot;
    if (state.status === 'paused' && !autoOpened.has(session.id)) {
      autoOpened.add(session.id);
      if (!panels.size && vscode.workspace.getConfiguration('cocovs', session.workspaceFolder?.uri).get('openMemoryOnDebug')) {
        open('overview', vscode.ViewColumn.Beside, true);
      }
    }
    render();
  };
}

function panelContent(view, assets, kind) {
  const stylesheet = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'memory.css'));
  const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'memory.js'));
  const source = view.webview.cspSource;
  const overview = kind === 'overview';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + source + '; script-src ' + source + ';">' +
    '<link rel="stylesheet" href="' + stylesheet + '"><title>' + titles[kind] + '</title></head><body>' +
    '<header><div><h1 id="processor-name">CocoVS Debug</h1><p id="status" role="status">Start a local CdM-8 or CdM-16 debug session.</p></div>' +
    (overview ? '<button type="button" id="split-view">Split into tabs</button>' : '') + '</header>' +
    (overview || kind === 'registers' ? '<section class="registers" aria-labelledby="register-heading"><h2 id="register-heading">Registers</h2>' +
    '<div id="control-registers" class="control-registers"></div><div id="general-registers" class="general-registers"></div></section>' : '') +
    (overview || kind === 'labels' ? '<section class="watches" aria-labelledby="watches-heading">' +
    '<details id="watch-section" open><summary id="watches-heading">Data labels</summary><div class="watch-tools">' +
    '<input id="watch-search" type="search" aria-label="Find labels by name or type" placeholder="Find by name or type">' +
    '<label>Format <select id="watch-format"><option value="auto">Auto</option><option value="hex">Hex</option>' +
    '<option value="unsigned">Unsigned</option><option value="signed">Signed</option><option value="text">Text</option></select></label></div></details>' +
    '<p id="watch-empty">No linked data labels.</p><div class="scroll"><table id="watches" hidden><thead><tr>' +
    '<th scope="col">Label</th><th scope="col">Address</th><th scope="col">Type</th><th scope="col">Value</th><th scope="col">Actions</th></tr></thead>' +
    '<tbody id="watch-rows"></tbody></table></div></section>' : '') +
    (overview || kind === 'ram' ? '<details id="ram-section" open><summary>RAM</summary><div class="watch-tools">' +
    '<button id="stack-color" type="button">Stack color</button></div>' +
    '<div class="ram-nav" id="ram-nav" hidden>' +
    '<button id="ram-prev" type="button" aria-label="Previous RAM page">‹</button>' +
    '<label>Address <input id="ram-address" value="0x0000" size="8"></label>' +
    '<button id="ram-next" type="button" aria-label="Next RAM page">›</button></div>' +
    '<div class="scroll"><table aria-label="RAM bytes in hexadecimal" id="ram"></table></div>' +
    '<footer><span class="legend changed">Changed</span><span class="legend pc">PC</span><span class="legend sp">SP</span></footer></details>' : '') +
    (kind !== 'registers' ? '<dialog id="color-dialog" aria-labelledby="color-title"><form id="color-form">' +
    '<h2 id="color-title">Choose a color</h2>' +
    '<div id="color-plane" role="group" tabindex="0" aria-label="Saturation and brightness. Adjust with arrow keys.">' +
    '<span id="color-cursor" aria-hidden="true"></span></div>' +
    '<label class="color-hue">Hue <input id="color-hue" type="range" min="0" max="359" value="0"></label>' +
    '<div id="color-swatches" class="color-swatches"></div>' +
    '<div class="color-value"><span id="color-preview" aria-hidden="true"></span>' +
    '<label>Hex color <input id="color-value" type="text" maxlength="7" spellcheck="false" placeholder="#569cd6"></label></div>' +
    '<p id="color-error" role="alert"></p><div class="color-actions">' +
    '<button id="color-reset" type="button">Reset</button><button id="color-cancel" type="button">Cancel</button>' +
    '<button type="submit">Apply</button></div></form></dialog>' : '') +
    '<script src="' + script + '"></script></body></html>';
}

module.exports = {memoryView};

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {MANIFEST, locateProject, readJsonc} = require('./project');
const {FORMAT_FILE, FORMAT_DEFAULTS, formatAssembly, formatSettings} = require('./formatter');

function registerFormatter(context, languages) {
  const reported = new Map();

  function folderFor(document) {
    if (!document || document.uri.scheme !== 'file') return {};
    const boundary = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.fileName);
    const project = locateProject(document.fileName, boundary);
    return {boundary, project};
  }

  function editsFor(document, onSave = false) {
    const {boundary, project} = folderFor(document);
    const root = project ?? (boundary && locateProject(document.fileName, boundary, FORMAT_FILE));
    const settingsFile = root && path.join(root, FORMAT_FILE);
    let settings;
    try {
      if (project && readJsonc(path.join(project, MANIFEST), {})?.target === 'custom') return [];
      settings = settingsFile ? formatSettings(readJsonc(settingsFile, {})) : FORMAT_DEFAULTS;
      reported.delete(settingsFile);
    } catch (error) {
      const message = 'CocoVS formatting: ' + error.message;
      if (reported.get(settingsFile) !== message) {
        reported.set(settingsFile, message);
        void vscode.window.showWarningMessage(message);
      }
      return [];
    }
    if (onSave && !settings.formatOnSave) return [];

    const before = document.getText();
    const after = formatAssembly(before, settings);
    if (before === after) return [];
    const updated = after.split(/\r?\n/);
    return before.split(/\r?\n/).flatMap((line, index) => {
      const formatted = updated[index];
      if (line === formatted) return [];
      let start = 0;
      while (start < line.length && line[start] === formatted[start]) start++;
      let suffix = 0;
      while (suffix < Math.min(line.length, formatted.length) - start &&
          line[line.length - 1 - suffix] === formatted[formatted.length - 1 - suffix]) suffix++;
      return [vscode.TextEdit.replace(new vscode.Range(index, start, index, line.length - suffix),
        formatted.slice(start, formatted.length - suffix))];
    });
  }

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(languages, {
      provideDocumentFormattingEdits: document => editsFor(document),
    }),
    vscode.workspace.onWillSaveTextDocument(event => {
      const {document} = event;
      if (document.uri.scheme === 'file' && languages.includes(document.languageId)) {
        event.waitUntil(Promise.resolve().then(() => editsFor(document, true)));
      }
    }),
    vscode.commands.registerCommand('cocovs.createFormatterConfig', async () => {
      const {boundary, project} = folderFor(vscode.window.activeTextEditor?.document);
      const root = project ?? boundary ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        void vscode.window.showWarningMessage('CocoVS: Open an assembly file or project folder first.');
        return;
      }
      const file = path.join(root, FORMAT_FILE);
      try {
        await fs.writeFile(file, JSON.stringify(FORMAT_DEFAULTS, null, 2) + '\n', {flag: 'wx'});
      } catch (error) {
        if (error.code !== 'EEXIST') {
          void vscode.window.showErrorMessage('CocoVS: ' + error.message);
          return;
        }
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
  );
}

module.exports = {registerFormatter};

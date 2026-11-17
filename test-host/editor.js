'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const fileKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cocovs-vscode-'));
  try {
    const extension = vscode.extensions.getExtension('cdm-project-community.cdm-project-tools');
    assert.ok(extension, 'CocoVS must be installed in the Extension Host');

    for (const [target, mnemonic, operands, lastRegister] of [
      ['cdm8', 'ldi', 'r0, 42', 'r3'], ['cdm8e', 'ldi', 'r0, 42', 'r3'],
      ['cdm16', 'ldw', 'r0, r1, r2', 'r7'], ['cdm16e', 'ldw', 'r0, r1, r2', 'r7'],
    ]) {
      const file = path.join(root, 'Test With Spaces.' + target + '.asm');
      const partial = '    ' + mnemonic.slice(0, 2);
      const instruction = '    ' + mnemonic + ' ' + operands;
      await fs.writeFile(file, ['asect 0', instruction, partial, '    ' + mnemonic + ' r', '    halt', 'end'].join('\n'));
      const document = await vscode.workspace.openTextDocument(file);
      assert.equal(document.languageId, 'cocovs-assembly');
      const editor = await vscode.window.showTextDocument(document);
      const {uri} = editor.document;
      const complete = (line, column) => vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
        uri, new vscode.Position(line, column));
      const operations = await complete(2, partial.length);
      assert.ok(operations.items.some(item => item.label === mnemonic), target + ' mnemonic completion');
      const registers = await complete(3, 6 + mnemonic.length);
      assert.ok(registers.items.some(item => item.label === lastRegister), target + ' register completion');

      for (const [clause, alias, condition] of [['stays', '>=u', 'hs'], ['is', '<s', 'lt'], ['until', '!=', 'ne']]) {
        const input = '    ' + clause + ' ' + alias + ' # keep';
        await editor.edit(edit => edit.replace(document.lineAt(2).range, input));
        const items = await complete(2, input.indexOf(' #'));
        const item = items.items.find(item => item.filterText === alias);
        assert.ok(item, target + ' ' + clause + ' comparison completion');
        assert.equal(item.insertText, condition);
        await editor.edit(edit => edit.replace(item.range, item.insertText));
        assert.equal(document.lineAt(2).text, '    ' + clause + ' ' + condition + ' # keep');
      }

      const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(1, 5));
      assert.ok(hover.some(item => item.contents.some(content => content.value?.includes(mnemonic + '('))), target + ' hover');
      const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider',
        uri, new vscode.Position(1, instruction.length));
      const signature = help?.signatures[help.activeSignature];
      assert.ok(signature?.label.match(new RegExp('^' + mnemonic + '[ (]')), target + ' signature help');
      assert.equal(help.activeParameter, operands.split(',').length - 1);
    }
    const packageDirectory = path.join(root, '.cdm', 'packages', 'memoryze8');
    await fs.mkdir(packageDirectory, {recursive: true});
    await fs.writeFile(path.join(root, 'cdm-packages.json'), '{"version":1,"dependencies":{"memoryze8":"*"}}');
    await fs.writeFile(path.join(root, 'cdm-packages.lock.json'), '{"version":1,"packages":{"memoryze8":{}}}');
    await fs.writeFile(path.join(packageDirectory, 'cdm-package.json'), '{"name":"memoryze8","version":"0.1.0","description":"Memory helpers"}');
    await fs.writeFile(path.join(packageDirectory, 'lib.asm'), '# @include "memory.mlb"\nend\n');
    await fs.writeFile(path.join(packageDirectory, 'memory.mlb'), '# Store one byte\n# @param ADDRESS Destination\n# @param VALUE Byte value\n# @return mem[ADDRESS] = VALUE\n# @changed r0, r1, PS, mem[ADDRESS]\n*setmem/2\n    ldi r0, $1\n    ldi r1, $2\n    st r0, r1\n');
    const file = path.join(root, 'packages.cdm8.asm');
    const include = '# @include "@memoryze8/lib.asm"';
    await fs.writeFile(file, [include, 'asect 0', '    setmem result, 42', 'result: dc 0', 'end'].join('\n'));
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    const {uri} = document;
    const complete = position => vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, position);
    const macros = await complete(new vscode.Position(2, 7));
    const macro = macros.items.find(item => item.label === 'setmem');
    assert.match(macro.detail, /setmem\(ADDRESS, VALUE\)/);
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(2, 7));
    assert.ok(hover.some(item => item.contents.some(content => /Arguments[\s\S]*Byte value/.test(content.value?.replaceAll('&nbsp;', ' ')))), 'Package hover documents each argument');
    const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', uri, new vscode.Position(2, 19));
    assert.equal(help.signatures[help.activeSignature].parameters[help.activeParameter].label, 'VALUE');
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, new vscode.Position(2, 7));
    assert.equal(fileKey(definitions[0].uri.fsPath), fileKey(path.join(packageDirectory, 'memory.mlb')));
    const includeDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, new vscode.Position(0, 18));
    assert.equal(fileKey(includeDefinitions[0].uri.fsPath), fileKey(path.join(packageDirectory, 'lib.asm')));
    const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', uri);
    assert.ok(links.some(link => link.target && fileKey(link.target.fsPath) === fileKey(path.join(packageDirectory, 'lib.asm'))));
    await editor.edit(edit => edit.replace(document.lineAt(0).range, '# @include "@'));
    const packages = await complete(new vscode.Position(0, 13));
    assert.ok(packages.items.some(item => item.label === '@memoryze8/'));
    await editor.edit(edit => edit.replace(document.lineAt(0).range, '# @include "@memoryze8/'));
    const files = await complete(new vscode.Position(0, 23));
    assert.ok(files.items.some(item => item.label === 'memory.mlb'));
    const templateFile = path.join(root, 'template.cdm8.asm');
    await fs.writeFile(templateFile, 'tplate BufferTemplate\nfirst: ds 3\nsecond: ds 5\nasect 0\n    addsp -BufferTemplate._\n    ldi r0, BufferTemplate.second\nend\n');
    const templateDocument = await vscode.workspace.openTextDocument(templateFile);
    await vscode.window.showTextDocument(templateDocument);
    const templateItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', templateDocument.uri,
      new vscode.Position(4, templateDocument.lineAt(4).text.length));
    assert.ok(templateItems.items.some(item => item.label === 'BufferTemplate._'));
    const templateHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', templateDocument.uri, new vscode.Position(4, 18));
    assert.ok(templateHover.some(item => item.contents.some(content => content.value?.includes('8'))));
    const templateDefinition = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', templateDocument.uri, new vscode.Position(5, 22));
    assert.equal(templateDefinition[0].range.start.line, 2);
    if (process.env.COCOVS_PIP_COCAS) {
      assert.ok(vscode.workspace.isTrusted, 'Assembler diagnostics require a trusted test workspace');
      const settings = vscode.workspace.getConfiguration('cocovs');
      await settings.update('cocasPath', process.env.COCOVS_PIP_COCAS, vscode.ConfigurationTarget.Global);
      await settings.update('liveDiagnostics', true, vscode.ConfigurationTarget.Global);
      const waitForDiagnostics = predicate => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listener.dispose();
          reject(new Error('Template diagnostics did not update: ' + JSON.stringify(vscode.languages.getDiagnostics(templateDocument.uri))));
        }, 15000);
        const check = () => {
          const issues = vscode.languages.getDiagnostics(templateDocument.uri).filter(issue => issue.source === 'CoCAS');
          if (!predicate(issues)) return;
          clearTimeout(timer);
          listener.dispose();
          resolve();
        };
        const listener = vscode.languages.onDidChangeDiagnostics(check);
        check();
      });
      const invalid = waitForDiagnostics(issues => issues.some(issue => /BufferTemplate.missing/.test(issue.message)));
      const templateEditor = vscode.window.activeTextEditor;
      await templateEditor.edit(edit => edit.replace(templateDocument.lineAt(4).range, '    addsp -BufferTemplate.missing'));
      await invalid;
      const valid = waitForDiagnostics(issues => issues.length === 0);
      await templateEditor.edit(edit => edit.replace(templateDocument.lineAt(4).range, '    addsp -BufferTemplate._'));
      await valid;
      await settings.update('liveDiagnostics', false, vscode.ConfigurationTarget.Global);
    }
    assert.ok(extension.isActive);
    await vscode.commands.executeCommand('cocovs.showSuggestions');
  } finally {
    await fs.rm(root, {recursive: true, force: true, maxRetries: 3});
  }
}

module.exports = {run};

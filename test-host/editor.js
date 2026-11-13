'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

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

      const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(1, 5));
      assert.ok(hover.some(item => item.contents.some(content => content.value?.includes(mnemonic + '('))), target + ' hover');
      const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider',
        uri, new vscode.Position(1, instruction.length));
      const signature = help?.signatures[help.activeSignature];
      assert.ok(signature?.label.match(new RegExp('^' + mnemonic + '[ (]')), target + ' signature help');
      assert.equal(help.activeParameter, operands.split(',').length - 1);
    }
    assert.ok(extension.isActive);
    await vscode.commands.executeCommand('cocovs.showSuggestions');
  } finally {
    await fs.rm(root, {recursive: true, force: true, maxRetries: 3});
  }
}

module.exports = {run};

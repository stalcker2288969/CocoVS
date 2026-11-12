'use strict';

const vscode = require('vscode');
const {createToolchain} = require('./tools');

const LINKS = {
  'Download Logisim files': 'https://github.com/cdm-processors/cdm-devkit/releases',
};

function registerSetup(context, output, showError) {
  const toolchain = createToolchain(context.globalStorageUri.fsPath, () => {
    const settings = vscode.workspace.getConfiguration('cocovs');
    const paths = Object.fromEntries(['pythonPath', 'javaPath', 'cocasPath', 'cocoemuJar'].map(key => [key, settings.get(key)]));
    const officialPath = vscode.workspace.getConfiguration('cdm').inspect('assembler.path')?.globalValue;
    if (!paths.cocasPath && officialPath) paths.cocasPath = officialPath;
    return paths;
  });
  let installation;
  let checking;

  async function setup(initial = false) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to check the toolchain.');
    const status = await toolchain.inspect();
    const missing = [!status.python && 'Python 3.10+', !status.cocas && 'cdm-devkit'].filter(Boolean);
    if (initial && !missing.length) return;
    const actions = [];
    if (missing.length) actions.push('Install required tools');
    if (!initial) actions.push('Set up CdM-16 tools', 'Open toolchain settings', 'Download Logisim files');
    const message = missing.length ? 'CocoVS can set up ' + missing.join(' and ') + ' automatically.' : 'CocoVS toolchain is ready.';
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (Object.hasOwn(LINKS, choice)) await vscode.env.openExternal(vscode.Uri.parse(LINKS[choice]));
    if (choice === 'Open toolchain settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:cdm-project-community.cdm-project-tools');
    }
    if (choice === 'Install required tools' || choice === 'Set up CdM-16 tools') {
      const java = choice === 'Set up CdM-16 tools';
      output.show(true);
      installation ??= vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: 'CocoVS: Setting up tools'}, () => toolchain.prepare({
        java, debug16: java, verbose: true, onOutput: chunk => output.append(String(chunk)),
      }))
        .finally(() => { installation = undefined; });
      await installation;
      vscode.window.showInformationMessage('CocoVS toolchain is ready.');
    }
  }

  function firstSetup() {
    const key = 'cocovs.toolchainChecked';
    if (!vscode.workspace.isTrusted || context.globalState.get(key)) return;
    checking ??= setup(true).then(() => context.globalState.update(key, true)).catch(showError)
      .finally(() => { checking = undefined; });
  }

  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(firstSetup));
  firstSetup();
  return {setup, toolchain};
}

module.exports = {registerSetup};

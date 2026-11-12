'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {registerLiveDiagnostics} = require('../src/live-diagnostics');

test('live diagnostics use unsaved editor buffers and clear when the line is fixed', {timeout: 5000}, async t => {
  const root = path.resolve(__dirname, '../examples/multi-file');
  const fileName = path.join(root, 'main.asm');
  let buffer = 'asect 0\nldi r0, 2, 3\nend\n';
  let enabled = true;
  const document = {fileName, languageId: 'cocovs-assembly', uri: {scheme: 'file'}, getText: () => buffer};
  const handlers = {};
  const event = name => handler => {
    handlers[name] = handler;
    return {dispose() {}};
  };
  const vscode = {
    env: {language: 'en'},
    window: {visibleTextEditors: [{document}], onDidChangeVisibleTextEditors: event('visible')},
    workspace: {
      textDocuments: [document], isTrusted: false,
      getConfiguration: () => ({get: () => enabled}),
      onDidChangeTextDocument: event('change'), onDidSaveTextDocument: event('save'),
      onDidCloseTextDocument: event('close'), onDidGrantWorkspaceTrust: event('trust'),
      onDidChangeConfiguration: event('config'),
    },
  };
  const context = {subscriptions: []};
  t.after(() => context.subscriptions.forEach(subscription => subscription.dispose()));
  const invalidations = [];
  let publish;
  const next = () => new Promise(resolve => { publish = resolve; });
  const first = next();
  registerLiveDiagnostics(context, vscode, {
    selector: ['cocovs-assembly'], projectInfo: () => ({root, target: 'cdm8'}),
    toolchain: {inspectAssembler() { assert.fail('Restricted Mode must not run CoCAS'); }},
    publishLive: problems => publish(problems), invalidateBuild: file => invalidations.push(file),
  });
  assert.deepEqual(await first, [{file: fileName, line: 2, warning: false, message: 'ldi: expected 2 arguments, got 3.'}]);

  buffer = 'asect 0\nldi r0, 2\nend\n';
  const fixed = next();
  handlers.change({document, contentChanges: [{}]});
  assert.deepEqual(await fixed, []);
  assert.deepEqual(invalidations, [fileName]);

  enabled = false;
  const disabled = next();
  handlers.config({affectsConfiguration: name => name === 'cocovs'});
  assert.deepEqual(await disabled, []);
});

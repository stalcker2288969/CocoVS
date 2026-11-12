'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {build} = require('../src/build');
const {createJob} = require('../src/jobs');
const {callAt, signature} = require('../src/signatures');
const {command} = require('../src/tools');
const snippets = require('../languages/snippets.json');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.COCOVS_TEST_TEMP ?? os.tmpdir(), 'cocovs-features-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('folder imports are deterministic and ignore non-source files and subfolders', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'lib', 'nested'), {recursive: true});
  for (const file of ['lib/z.asm', 'lib/a.asm', 'lib/macros.mlb', 'lib/nested/hidden.asm', 'lib/README.md']) {
    await fs.writeFile(path.join(root, file), '');
  }
  const file = path.join(root, 'main.asm');
  await fs.writeFile(file, '# @include "lib/*"\n# @include "lib/a.asm"\nasect 0\nhalt\nend\n');
  assert.deepEqual(createJob({file}).sources, ['main.asm', 'lib/a.asm', 'lib/macros.mlb', 'lib/z.asm']);
});

test('signature documentation tracks arguments and ignores commas in literals', () => {
  assert.deepEqual(signature({name: 'copy', kind: 'macro', arity: 2,
    documentation: 'Copy one byte.\n@param src Source address\n@param dst Destination address\n@returns r0 Copy of the byte\n@changed PS Flags'}), {
    label: 'copy(src, dst)', summary: 'Copy one byte.', returns: 'r0 Copy of the byte', changed: 'PS Flags', dataType: undefined,
    params: [{name: 'src', description: 'Source address'}, {name: 'dst', description: 'Destination address'}],
  });
  const line = 'label: copy "a,b", ';
  assert.equal(callAt(line, line.length).active, 1);
  assert.equal(callAt('    jsr copy_byte', 17).target, 'copy_byte');
});

test('CoCAS builds default control snippets and exports exact lengths for linked data labels', {
  skip: process.env.COCOVS_INTEGRATION !== '1',
}, async t => {
  const root = await fixture(t);
  const defaultBody = name => snippets[name].body.join('\n').replace(/\$\{\d+:([^}]+)\}/g, '$1')
    .replaceAll('$1', 'r0').replaceAll('$0', '# body');
  await fs.mkdir(path.join(root, 'lib'));
  await fs.writeFile(path.join(root, 'lib/data.asm'), 'rsect data\nexternal_text> dc "Text"\nend\n');
  const file = path.join(root, 'main.asm');
  await fs.writeFile(file, [
    '# @include "lib/*"', 'external_text: ext', 'asect 0', 'ldi r0, 0', defaultBody('While'), defaultBody('For'),
    defaultBody('If else'), 'ldi r0, external_text', 'halt', 'scratch: ds 2+1', 'number: dc 10, 255',
    'message:', 'dc "Привет", 0, "A\\x42"', 'end', '',
  ].join('\n'));
  const job = createJob({file});
  const result = await build(job, command(process.env.COCOVS_COCAS ?? 'cocas'));
  assert.equal(result.ok, true, result.message);
  const combined = await fs.readFile(result.artifacts.combined, 'utf8');
  assert.match(combined, /--- main\.asm ---/);
  assert.match(combined, /--- lib\/data\.asm ---/);
  assert.equal(combined.split('\n').filter(line => line === 'end').length, 1);
  const metadata = JSON.parse(await fs.readFile(result.artifacts.debug, 'utf8'));
  const labels = Object.fromEntries(metadata.dataLabels.map(label => [label.name, label]));
  assert.equal(labels.scratch.length, 3);
  assert.equal(labels.number.length, 2);
  assert.equal(labels.message.length, Buffer.byteLength('Привет') + 3);
  assert.equal(labels.message.text, true);
  assert.equal(labels.external_text.length, 4);
  assert.equal(labels.external_text.file, 'lib/data.asm');
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {planRename} = require('../src/rename');
const {lintRoutines} = require('../src/routine-lint');

test('rename updates linked exports and ext operands without changing shadows, comments or literals', () => {
  const main = {file: 'main.asm', text: 'value: ext\nasect 0\n    jsr value # value\n    dc "value", value+1\nend'};
  const lib = {file: 'lib/math.asm', text: 'rsect code\nvalue>\n    br value\nrsect other\nvalue:\n    br value\nend'};
  const harness = {file: 'tests/harness.asm', text: 'asect 0\nvalue: ext\n    jsr value\nend'};
  const other = {file: 'lib/other.asm', text: 'rsect other\nvalue:\n    br value\nend'};
  const sources = [main, lib, harness, other];
  const plan = planRename(sources, main.file, {line: 2, character: 8}, 'calculate');
  assert.deepEqual(plan.edits.map(({file, line, column}) => [file, line, column]), [
    ['main.asm', 0, 0], ['main.asm', 2, 8], ['main.asm', 3, 16],
    ['lib/math.asm', 1, 0], ['lib/math.asm', 2, 7],
    ['tests/harness.asm', 1, 0], ['tests/harness.asm', 2, 8],
  ]);
  assert.throws(() => planRename(sources, main.file, {line: 2, character: 8}, 'r0'), /valid label/);
  assert.throws(() => planRename([...sources, {file: 'duplicate.asm', text: 'rsect another\nvalue>\nend'}],
    main.file, {line: 2, character: 8}, 'calculate'), /exactly one linked export/);
  assert.throws(() => planRename([...sources, {file: 'macro.mlb', text: '*run_value/0\njsr value\n'}],
    main.file, {line: 2, character: 8}, 'calculate'), /macro/);
});

test('routine warnings respect both branches and saved registers, flags, and declared return registers', () => {
  const code = [
    'asect 0', '# @return r0 Result', 'checked:', 'push r1', 'if', 'tst r0', 'is z', 'then',
    '    ldi r1, 20', '    pop r1', 'else', '    ldi r2, 15', 'fi', 'ldi r0, 1', 'rts', 'end',
  ].join('\n');
  const warnings = lintRoutines(code, 'cdm8');
  assert.deepEqual(warnings.map(warning => warning.code), ['cocovs.stack', 'cocovs.changed']);
  assert.match(warnings[0].message, /1 byte/);
  assert.match(warnings[1].message, /ps, r2\.$/);
  assert.deepEqual(lintRoutines('asect 0\n# @changed ps\n# @return r0\nchecked:\npush r1\nadd r1, r0\npop r1\nrts\nend', 'cdm8'), []);
  assert.match(lintRoutines('asect 0\nchecked:\npush r1\nrts\nend', 'cdm16')[0].message, /2 byte/);
  assert.deepEqual(lintRoutines('asect 0\n# @changed none\nchecked:\npups\ncmp r1, r0\npops\nrts\nend', 'cdm16'), []);
  assert.match(lintRoutines('# @changed none\n*check/0\nldi r1, 9\n', 'cdm8', undefined, true)[0].message, /r1/);
});

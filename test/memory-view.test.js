'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('RAM view lays out 256 cells and marks modified bytes and processor pointers', () => {
  const cells = [];
  const headers = [];
  let rows = 0;
  const status = {textContent: ''};
  const element = () => {
    const classes = new Set();
    const children = [];
    const listeners = new Map();
    return {classes, children, isConnected: true, appendChild: child => children.push(child), focus() {},
      style: {setProperty() {}},
      addEventListener: (event, handler) => listeners.set(event, handler),
      fire: (event, detail) => listeners.get(event)?.(detail), setAttribute() {}, classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
    }};
  };
  const table = {
    createTHead: () => ({insertRow: () => ({appendChild: header => headers.push(header)})}),
    createTBody: () => ({insertRow() {
      rows++;
      return {appendChild: header => headers.push(header), insertCell: () => {
        const item = element();
        cells.push(item);
        return item;
      }};
    }}),
  };
  const control = element();
  const general = element();
  const watchRows = element();
  watchRows.replaceChildren = () => { watchRows.children.length = 0; };
  const watchFormat = {value: 'auto', addEventListener() {}};
  const watchTable = {};
  const watchEmpty = {};
  const search = {...element(), value: ''};
  const watchSection = {...element(), open: true};
  const ramSection = {...element(), open: true};
  const ramAddress = {...element(), value: '0x0000'};
  const stackPicker = element();
  const colorDialog = element();
  colorDialog.showModal = () => { colorDialog.open = true; };
  colorDialog.close = () => { colorDialog.open = false; colorDialog.fire('close'); };
  const colorValue = element();
  const colorPlane = {...element(), getBoundingClientRect: () => ({left: 10, top: 20, width: 200, height: 100}),
    setPointerCapture() {}};
  const colorHue = element();
  const colorPreview = element();
  const colorTitle = element();
  const colorForm = element();
  const colorSwatches = element();
  const colorReset = element();
  const colorError = element();
  const sent = [];
  let handle;
  const script = fs.readFileSync(path.join(__dirname, '../media/memory.js'), 'utf8');
  vm.runInNewContext(script, {
    TextDecoder,
    acquireVsCodeApi: () => ({postMessage: message => sent.push(message)}),
    document: {
      getElementById: id => ({ram: table, status, 'control-registers': control, 'general-registers': general,
        'watch-rows': watchRows, 'watch-format': watchFormat, watches: watchTable, 'watch-empty': watchEmpty,
        'watch-search': search, 'watch-section': watchSection, 'ram-section': ramSection, 'ram-address': ramAddress,
        'color-dialog': colorDialog, 'color-value': colorValue, 'color-title': colorTitle, 'color-form': colorForm,
        'color-error': colorError, 'color-swatches': colorSwatches, 'color-reset': colorReset,
        'color-cancel': element(), 'stack-color': stackPicker,
        'color-plane': colorPlane, 'color-hue': colorHue, 'color-preview': colorPreview})[id],
      createElement: element,
    },
    window: {addEventListener: (_event, listener) => { handle = listener; }},
  });
  assert.equal(sent[0].type, 'ready');
  assert.equal(rows, 16);
  assert.equal(cells.length, 256);
  assert.equal(headers.at(-1).textContent, 'F0');

  const first = {session: 'one', ram: '00'.repeat(256), pc: 0, sp: 255, ps: 0, registers: [0, 65, 127, 128],
    steps: 0, architecture: 'vonNeumann', status: 'paused', dataLabels: [
      {name: 'buffer', address: 1, length: 1, kind: 'ds', file: 'main.asm', line: 2},
      {name: 'message', address: 2, length: 4, kind: 'dc', text: true, file: 'main.asm', line: 3},
    ]};
  const formats = index => general.children[index].children[1].children
    .filter((_element, index) => index % 2 === 1).map(element => element.textContent);
  const flags = () => control.children[1].children[2].children.map(flag => flag.children[1].textContent);
  const render = (snapshot, pinned, colors) => handle({data: {type: 'memory', snapshot, pinned, colors}});
  render(first);
  assert.ok(cells[0].classes.has('pc'));
  assert.ok(cells[255].classes.has('sp'));
  assert.equal(cells[1].textContent, '00');
  assert.deepEqual(formats(0), ['0x00', 'NUL', '0', '0', '00000000']);
  assert.deepEqual(formats(1), ['0x41', 'A', '65', '65', '01000001']);
  assert.deepEqual(formats(2), ['0x7F', 'DEL', '127', '127', '01111111']);
  assert.deepEqual(formats(3), ['0x80', '\u2014', '-128', '128', '10000000']);
  assert.deepEqual(flags(), ['0', '0', '0', '0']);
  const second = {...first, pc: 1, ps: 9, registers: [255, 65, 127, 128],
    ram: '00ff' + '00'.repeat(254), steps: 1, status: 'running'};
  render(second);
  assert.ok(!cells[0].classes.has('pc'));
  assert.ok(cells[1].classes.has('pc'));
  assert.ok(cells[1].classes.has('changed'));
  assert.equal(cells[1].title, '0x01 · 0xFF · 255');
  assert.deepEqual(formats(0), ['0xFF', '\u2014', '-1', '255', '11111111']);
  assert.deepEqual(flags(), ['1', '0', '0', '1']);
  assert.ok(general.children[0].classes.has('changed'));
  assert.ok(!general.children[1].classes.has('changed'));
  const detailsAt = index => watchRows.children[index].children[3].children[0];
  assert.equal(detailsAt(0).children[1].textContent, 'FF');
  assert.ok(watchRows.children[0].children[3].classes.has('changed'));
  assert.equal(control.children[0].children[1].textContent, '0x01');
  assert.equal(control.children[1].children[1].textContent, '0x09');
  assert.equal(control.children[2].children[1].textContent, '0xFF');
  render({...second, status: 'ended'});
  assert.ok(cells[1].classes.has('changed'));
  assert.match(status.textContent, /^Ended/);
  assert.ok(general.children[0].classes.has('changed'));

  render({...first, session: 'two', architecture: 'harvard', rom: '0000' + '54657874' + '00'.repeat(250)});
  assert.equal(detailsAt(1).children[1].textContent, '"Text"');
  assert.equal(watchRows.children[1].children[2].textContent, 'str');
  assert.equal(watchRows.children[1].children[1].textContent, '0x02 ROM');
  assert.ok(!cells[0].classes.has('pc'));
  assert.ok(!cells[1].classes.has('changed'));
  assert.match(status.textContent, /PC 0x00 \(ROM\)/);
  assert.ok(!general.children[0].classes.has('changed'));

  const labelNames = () => watchRows.children.map(row => row.children[0].textContent);
  const actions = () => watchRows.children[0].children[4].children;
  search.value = 'str';
  search.fire('input');
  assert.deepEqual(labelNames(), ['message']);
  assert.equal(detailsAt(0).open, true);
  detailsAt(0).open = false;
  detailsAt(0).fire('toggle');
  actions()[1].fire('click');
  assert.equal(detailsAt(0).textContent, '"Text"');
  assert.equal(actions().length, 3);
  assert.equal(sent.at(-1).type, 'pin');
  watchSection.open = !watchSection.open;
  watchSection.fire('toggle');
  search.value = 'unmatched';
  search.fire('input');
  assert.deepEqual(labelNames(), ['message']);
  actions()[2].fire('click');
  assert.equal(sent.at(-1).type, 'reveal');
  assert.equal(sent.at(-1).key, JSON.stringify(['main.asm', 'message']));
  actions()[1].fire('click');
  assert.deepEqual(labelNames(), []);

  search.value = 'i16';
  watchSection.open = !watchSection.open;
  watchSection.fire('toggle');
  const wide = {...first, session: 'wide', target: 'cdm16', pc: 0x0200, sp: 0xffff,
    registers: Array(8).fill(0), ram: '00'.repeat(512) + 'efbe' + '00'.repeat(65536 - 514),
    dataLabels: [{name: 'score', address: 512, length: 2, kind: 'dw', dataType: 'i16', file: 'main.cdm16', line: 12}]};
  render(wide);
  assert.deepEqual(labelNames(), ['score']);
  assert.equal(detailsAt(0).children[1].textContent, '-16657');
  assert.equal(general.children.length, 8);
  ramSection.open = false;
  ramSection.fire('toggle');
  ramAddress.value = '0x0200';
  ramAddress.fire('change');
  assert.equal(cells[0].textContent, '00');
  ramSection.open = true;
  ramSection.fire('toggle');
  assert.equal(headers.at(-1).textContent, '02F0');
  assert.equal(cells[0].textContent, 'EF');
  assert.ok(cells[0].classes.has('pc'));
  const colorKey = JSON.stringify(['main.cdm16', 'score']);
  actions()[0].fire('click');
  assert.equal(colorDialog.open, true);
  assert.equal(colorTitle.textContent, 'Color for score');
  colorPlane.fire('pointerdown', {button: 0, pointerId: 1, clientX: 210, clientY: 20});
  colorHue.value = '120';
  colorHue.fire('input');
  assert.equal(colorValue.value, '#00ff00');
  colorPlane.fire('keydown', {key: 'ArrowDown', shiftKey: true, preventDefault() {}});
  assert.equal(colorValue.value, '#00e600');
  colorValue.value = 'bad';
  colorForm.fire('submit', {preventDefault() {}});
  assert.match(colorError.textContent, /#569cd6/);
  assert.equal(colorDialog.open, true);
  colorValue.value = '#12AABB';
  colorValue.fire('input');
  assert.equal(colorHue.value, '186');
  colorForm.fire('submit', {preventDefault() {}});
  assert.equal(colorDialog.open, false);
  assert.equal(sent.at(-1).type, 'color');
  assert.equal(sent.at(-1).key, colorKey);
  assert.equal(sent.at(-1).color, '#12aabb');
  stackPicker.fire('click');
  colorPlane.fire('pointerdown', {button: 0, pointerId: 1, clientX: 10, clientY: 20});
  colorForm.fire('submit', {preventDefault() {}});
  assert.equal(sent.at(-1).key, 'stack');
  assert.equal(sent.at(-1).color, '#ffffff');
  stackPicker.fire('click');
  colorSwatches.children[0].fire('click');
  assert.equal(sent.at(-1).key, 'stack');
  assert.equal(sent.at(-1).color, '#569cd6');
  stackPicker.fire('click');
  colorReset.fire('click');
  assert.equal(sent.at(-1).color, null);
  render({...wide, sp: 0x0201, stackBytes: 2}, [], {labels: {[colorKey]: '#12aabb'}, stack: '#cca011'});
  assert.ok(cells[0].classes.has('colored-label'));
  assert.ok(cells[1].classes.has('colored-label'));
  assert.ok(cells[1].classes.has('stack-byte'));
  assert.ok(cells[2].classes.has('stack-byte'));
  assert.ok(!cells[2].classes.has('colored-label'));
  assert.ok(!cells[3].classes.has('stack-byte'));
});

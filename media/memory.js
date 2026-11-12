'use strict';

const vscode = acquireVsCodeApi();
const table = document.getElementById('ram');
const statusLine = document.getElementById('status');
const cells = [];
const watchFormat = document.getElementById('watch-format');
const watchRows = document.getElementById('watch-rows');
const watchTable = document.getElementById('watches');
const watchEmpty = document.getElementById('watch-empty');
const processor = document.getElementById('processor-name');
const watchSearch = document.getElementById('watch-search');
const watchSection = document.getElementById('watch-section');
const ramSection = document.getElementById('ram-section');
const ramNav = document.getElementById('ram-nav');
const stackPicker = document.getElementById('stack-color');
const defaultStackColor = '#aa7ad9';
let palette = {labels: {}};
const ramAddress = document.getElementById('ram-address');
const preferences = vscode.getState?.() ?? {};
const collapsed = new Set();
let pinned = new Set();
let watchViews = [];
let watchKey;
let previous;
let comparison;
let page = 0;

const hex = (value, width = 2) => value.toString(16).toUpperCase().padStart(width, '0');
const bits = (value, width) => value.toString(2).padStart(width, '0');
const isByte = value => Number.isInteger(value) && value >= 0 && value <= 255;
const asciiControl = 'NUL SOH STX ETX EOT ENQ ACK BEL BS HT LF VT FF CR SO SI DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN EM SUB ESC FS GS RS US'.split(' ');
const flags = [['C', 8, 'Carry'], ['V', 4, 'Overflow'], ['Z', 2, 'Zero'], ['N', 1, 'Negative']];

function ascii(value) {
  if (value < 32) return asciiControl[value];
  if (value === 32) return 'SPC';
  if (value < 127) return String.fromCharCode(value);
  return value === 127 ? 'DEL' : '\u2014';
}

function append(parent, tag, label = '', className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = label;
  parent.appendChild(element);
  return element;
}

function controlRegister(parent, name, className) {
  const card = append(parent, 'div', '', 'register-card');
  append(card, 'span', name, 'register-label');
  const value = append(card, 'code', '\u2014', 'control-value');
  if (className) value.classList.add(className);
  return {card, value};
}

const control = document.getElementById('control-registers');
const pcRegister = controlRegister(control, 'PC', 'pc');
const psRegister = controlRegister(control, 'PS');
const spRegister = controlRegister(control, 'SP', 'sp');
const flagList = append(psRegister.card, 'div', '', 'flags');
const flagElements = flags.map(([label, mask, title]) => {
  const flag = append(flagList, 'span', '', 'flag');
  flag.title = title;
  append(flag, 'span', label);
  return {flag, value: append(flag, 'code', '\u2014'), mask};
});

const general = document.getElementById('general-registers');
function createRegisterView(index) {
  const card = append(general, 'div', '', 'register-card');
  append(card, 'span', 'r' + index, 'register-label');
  const entries = append(card, 'dl', '', 'register-formats');
  const values = ['Hex', 'ASCII', 'Signed', 'Unsigned', 'Binary'].map(label => {
    append(entries, 'dt', label);
    return append(entries, 'dd', '\u2014');
  });
  return {card, values};
}
const registerViews = Array.from({length: 4}, (_, index) => createRegisterView(index));

const head = table.createTHead().insertRow();
head.appendChild(document.createElement('th'));
for (let column = 0; column < 16; column++) {
  const header = document.createElement('th');
  header.scope = 'col';
  header.textContent = column.toString(16).toUpperCase();
  head.appendChild(header);
}

const body = table.createTBody();
const rowHeaders = [];
for (let row = 0; row < 16; row++) {
  const line = body.insertRow();
  const header = document.createElement('th');
  header.scope = 'row';
  header.textContent = hex(row * 16);
  rowHeaders.push(header);
  line.appendChild(header);
  for (let column = 0; column < 16; column++) {
    const cell = line.insertCell();
    cell.textContent = '\u00b7\u00b7';
    cells.push(cell);
  }
}

function updateRegisters({pc, sp, ps, registers}, before) {
  const width = registers.length === 8 ? 4 : 2;
  while (registerViews.length < registers.length) registerViews.push(createRegisterView(registerViews.length));
  registerViews.forEach((view, index) => { view.card.hidden = index >= registers.length; });
  for (const [view, value, prior] of [[pcRegister, pc, before?.pc], [spRegister, sp, before?.sp], [psRegister, ps, before?.ps]]) {
    view.value.textContent = '0x' + hex(value, width);
    view.card.classList.toggle('changed', prior !== undefined && prior !== value);
  }
  for (const {flag, value, mask} of flagElements) {
    const set = (ps & mask) !== 0;
    value.textContent = set ? '1' : '0';
    flag.classList.toggle('flag-set', set);
    flag.classList.toggle('changed', before !== undefined && set !== ((before.ps & mask) !== 0));
  }
  for (const [index, register] of registers.entries()) {
    const view = registerViews[index];
    const range = width === 4 ? 65536 : 256;
    const values = ['0x' + hex(register, width), ascii(register), register < range / 2 ? register : register - range,
      register, bits(register, width * 4)];
    view.values.forEach((element, format) => { element.textContent = String(values[format]); });
    view.card.classList.toggle('changed', before !== undefined && before.registers[index] !== register);
  }
}

function watchValue(bytes, format) {
  if (format === 'text') {
    const text = new TextDecoder().decode(Uint8Array.from(bytes));
    return '"' + text.replace(/[\x00-\x1f\x7f"\\]/g, character => {
      const escapes = {'\0': '\\0', '\n': '\\n', '\r': '\\r', '\t': '\\t', '"': '\\"', '\\': '\\\\'};
      return escapes[character] ?? '\\x' + hex(character.charCodeAt(0));
    }) + '"';
  }
  return bytes.map(value => format === 'hex' ? hex(value) : format === 'signed' && value >= 128 ? value - 256 : value).join(' ');
}

const labelKey = label => JSON.stringify([label.file, label.name]);

function typedValue(bytes, type) {
  if (type === 'str') return watchValue(bytes, 'text');
  if (type === 'u8' || type === 'i8') return watchValue(bytes, type === 'u8' ? 'unsigned' : 'signed');
  if (type === 'u16' || type === 'i16') {
    const words = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const word = bytes[i] | bytes[i + 1] << 8;
      words.push(type === 'i16' && word >= 32768 ? word - 65536 : word);
    }
    if (bytes.length % 2) words.push('0x' + hex(bytes.at(-1)) + ' (1 byte)');
    return words.join(' ');
  }
  return watchValue(bytes, 'hex');
}

function action(parent, label, title, callback) {
  const button = append(parent, 'button', label);
  button.type = 'button';
  button.title = title;
  button.setAttribute?.('aria-label', title);
  button.addEventListener?.('click', callback);
  return button;
}

function updateWatches(snapshot, before) {
  if (!watchRows) return;
  const query = watchSearch?.value.trim().toLowerCase() ?? '';
  const labels = (snapshot.dataLabels ?? []).filter(label =>
    pinned.has(labelKey(label)) || watchSection.open && query.split(/\s+/).every(word => {
      const kind = label.dataType ?? (label.text ? 'str' : 'bytes');
      const alias = kind === 'str' ? 'text string' : /16$/.test(kind) ? 'word' : 'byte';
      return (label.name + ' ' + label.kind + ' ' + kind + ' ' + alias).toLowerCase().includes(word);
    }));
  labels.sort((a, b) => Number(pinned.has(labelKey(b))) - Number(pinned.has(labelKey(a))));
  watchTable.hidden = labels.length === 0;
  watchEmpty.hidden = !watchSection.open || labels.length !== 0;
  watchEmpty.textContent = snapshot.dataLabels?.length ? 'No labels match this view.' : 'No linked data labels.';
  const key = JSON.stringify([snapshot.session, labels, [...pinned], palette.labels]);
  if (key !== watchKey) {
    watchKey = key;
    watchRows.replaceChildren();
    watchViews = labels.map(label => {
      const {name, address, length, kind, text, dataType = text ? 'str' : 'bytes', file, line} = label;
      const id = labelKey(label);
      const isPinned = pinned.has(id);
      const rom = kind !== 'ds' && typeof snapshot.rom === 'string';
      const row = append(watchRows, 'tr');
      append(row, 'td', name).title = file + ':' + (label.definitionLine ?? line);
      append(row, 'td', '0x' + hex(address, snapshot.target === 'cdm16' ? 4 : 2) + (rom ? ' ROM' : ''));
      const type = append(row, 'td', dataType, 'watch-type');
      type.title = dataType + ' · ' + kind.toUpperCase() + ' · ' + length + (length === 1 ? ' byte' : ' bytes');
      type.setAttribute('aria-label', type.title);
      const cell = append(row, 'td');
      let details;
      if (!isPinned) {
        details = append(cell, 'details', '', 'watch-value');
        details.open = !collapsed.has(id);
        const summary = append(details, 'summary');
        summary.setAttribute('aria-label', 'Value of ' + name);
        append(summary, 'span', 'Value');
        details.addEventListener('toggle', () => {
          if (!details.isConnected) return;
          if (details.open) collapsed.delete(id);
          else collapsed.add(id);
        });
      }
      const value = append(details ?? cell, 'code', '', 'watch-value-content');
      const buttons = append(row, 'td', '', 'watch-actions');
      const tint = palette.labels[id];
      row.style?.setProperty('--label-color', tint ?? '');
      row.classList.toggle('colored-label', !!tint);
      const picker = append(buttons, 'input', '', 'color-picker');
      picker.type = 'color';
      picker.value = tint ?? '#569cd6';
      picker.title = 'Color for ' + name;
      picker.setAttribute('aria-label', picker.title);
      picker.addEventListener('change', () =>
        vscode.postMessage({type: 'color', session: snapshot.session, key: id, color: picker.value}));
      if (tint) action(buttons, '×', 'Clear color of ' + name, () =>
        vscode.postMessage({type: 'color', session: snapshot.session, key: id, color: null}));
      const pin = action(buttons, isPinned ? 'Unpin' : 'Pin', (isPinned ? 'Unpin ' : 'Pin ') + name, () => {
        if (pinned.has(id)) pinned.delete(id);
        else pinned.add(id);
        vscode.postMessage({type: 'pin', session: snapshot.session, key: id, pinned: pinned.has(id)});
        updateWatches(previous, comparison);
      });
      pin.setAttribute?.('aria-pressed', String(isPinned));
      action(buttons, '↗', 'Go to definition of ' + name, () =>
        vscode.postMessage({type: 'reveal', session: snapshot.session, key: id}));
      return {cell, value, address, length, dataType, region: rom ? 'rom' : 'ram'};
    });
  }
  for (const {cell, value, address, length, dataType, region} of watchViews) {
    const offset = address * 2;
    const encoded = snapshot[region]?.slice(offset, offset + length * 2) ?? '';
    const prior = before?.[region]?.slice(offset, offset + length * 2);
    const bytes = encoded.match(/../g)?.map(byte => parseInt(byte, 16)) ?? [];
    const mode = watchFormat.value;
    value.textContent = mode === 'auto' ? typedValue(bytes, dataType) : watchValue(bytes, mode);
    cell.classList.toggle('changed', prior !== undefined && prior !== encoded);
  }
}

function renderRam(snapshot, before) {
  if (ramSection && !ramSection.open) return;
  const wide = snapshot.target === 'cdm16';
  const width = wide ? 4 : 2;
  if (ramNav) ramNav.hidden = !wide;
  if (ramAddress && document.activeElement !== ramAddress) ramAddress.value = '0x' + hex(page, width);
  const labelColors = [];
  for (const label of snapshot.dataLabels ?? []) {
    const tint = palette.labels[labelKey(label)];
    if (!tint || snapshot.rom && label.kind !== 'ds') continue;
    const end = Math.min(page + cells.length, label.address + label.length);
    for (let address = Math.max(page, label.address); address < end; address++) {
      labelColors[address - page] ??= tint;
    }
  }
  const mask = wide ? 0xffff : 0xff;
  const stackColor = palette.stack ?? defaultStackColor;
  for (let index = 0; index < cells.length; index++) {
    const address = page + index;
    const byte = snapshot.ram.slice(address * 2, address * 2 + 2).toUpperCase();
    const cell = cells[index];
    if (index % 16 === 0) rowHeaders[index / 16].textContent = hex(address, width);
    cell.textContent = byte;
    cell.title = '0x' + hex(address, width) + ' \u00b7 0x' + byte + ' \u00b7 ' + parseInt(byte, 16);
    cell.classList.toggle('changed', !!before && before.ram.slice(address * 2, address * 2 + 2).toUpperCase() !== byte);
    cell.classList.toggle('pc', snapshot.architecture === 'vonNeumann' && address === snapshot.pc);
    cell.classList.toggle('sp', address === snapshot.sp);
    const inStack = ((address - snapshot.sp) & mask) < (snapshot.stackBytes ?? 0);
    cell.classList.toggle('stack-byte', inStack || address === snapshot.sp);
    cell.classList.toggle('colored-label', !!labelColors[index]);
    cell.style?.setProperty('--label-color', labelColors[index] ?? '');
    cell.style?.setProperty('--stack-color', stackColor);
  }
}

function changePage(address) {
  if (!previous || previous.target !== 'cdm16') return;
  page = Math.floor(Math.min(65535, Math.max(0, address)) / 256) * 256;
  if (ramAddress) ramAddress.value = '0x' + hex(page, 4);
  renderRam(previous, comparison);
}

function storeView() {
  vscode.setState?.({watchOpen: watchSection.open, ramOpen: ramSection?.open ?? true});
}
if (ramSection) ramSection.open = preferences.ramOpen !== false;
ramSection?.addEventListener('toggle', () => { storeView(); if (previous) renderRam(previous, comparison); });
const refreshWatches = () => { if (previous) updateWatches(previous, comparison); };
watchFormat?.addEventListener('change', refreshWatches);
watchSearch?.addEventListener('input', refreshWatches);
watchSection.open = preferences.watchOpen ?? !preferences.hideUnpinned;
watchSection.addEventListener('toggle', () => { storeView(); refreshWatches(); });
document.getElementById('ram-prev')?.addEventListener('click', () => changePage(page - 256));
document.getElementById('ram-next')?.addEventListener('click', () => changePage(page + 256));
ramAddress?.addEventListener('change', () => {
  const text = ramAddress.value.trim().replace(/^0x/i, '');
  changePage(/^[\da-f]{1,4}$/i.test(text) ? parseInt(text, 16) : page);
});

stackPicker?.addEventListener('change', () => {
  if (previous) vscode.postMessage({type: 'color', session: previous.session, key: 'stack', color: stackPicker.value});
});

window.addEventListener('message', ({data}) => {
  const snapshot = data?.type === 'memory' && data.snapshot;
  if (!snapshot) return;
  const wide = snapshot.target === 'cdm16';
  const size = wide ? 65536 : 256;
  const {ram, pc, sp, ps, registers, steps, architecture} = snapshot;
  const valid = wide ? value => Number.isInteger(value) && value >= 0 && value < size : isByte;
  if (typeof ram !== 'string' || ram.length !== size * 2 || !/^[\da-f]+$/i.test(ram) || ![pc, sp, ps].every(valid) ||
      !Array.isArray(registers) || registers.length !== (wide ? 8 : 4) || !registers.every(valid)) return;

  const before = previous?.session === snapshot.session ? previous : undefined;
  if (!before) {
    page = 0;
    collapsed.clear();
  }
  const changed = !before || steps !== before.steps || ram !== before.ram;
  if (changed) comparison = before;
  if (!before || steps !== before.steps || pc !== before.pc || sp !== before.sp || ps !== before.ps ||
      registers.some((value, index) => value !== before.registers[index])) updateRegisters(snapshot, before);

  pinned = new Set(data.pinned ?? []);
  const nextPalette = data.colors ?? {labels: {}};
  const recolored = JSON.stringify(nextPalette) !== JSON.stringify(palette);
  palette = nextPalette;
  if (stackPicker) stackPicker.value = palette.stack ?? defaultStackColor;
  if (changed || recolored || pc !== before?.pc || sp !== before?.sp || snapshot.stackBytes !== before?.stackBytes) {
    renderRam(snapshot, comparison);
  }
  previous = snapshot;
  updateWatches(snapshot, comparison);
  if (processor) processor.textContent = wide ? 'CdM-16' : 'CdM-8';
  const state = {paused: 'Paused', running: 'Running', ended: 'Ended'}[snapshot.status];
  statusLine.textContent = state + ' \u00b7 ' + steps.toLocaleString() + ' instructions' +
    (architecture === 'harvard' ? ' \u00b7 PC 0x' + hex(pc, wide ? 4 : 2) + ' (ROM)' : '');
});

vscode.postMessage({type: 'ready'});

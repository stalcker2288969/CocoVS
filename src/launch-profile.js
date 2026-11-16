'use strict';

const path = require('node:path');
const TARGETS = ['cdm8', 'cdm16', 'cdm8e', 'cdm16e'];
const ARCHITECTURES = ['vonNeumann', 'harvard'];

function profileKey(file) {
  const absolute = path.resolve(file);
  return 'cocovs.launchProfile:' + (process.platform === 'win32' ? absolute.toLowerCase() : absolute);
}

function getLaunchProfile(state, file) {
  const value = state?.get(profileKey(file));
  return TARGETS.includes(value?.target) && ARCHITECTURES.includes(value?.architecture) ? value : undefined;
}

async function chooseLaunchProfile(state, file, defaults, pick, force = false) {
  const previous = getLaunchProfile(state, file);
  if (previous && !force) return previous;
  const current = previous ?? defaults;
  const ordered = (values, first) => [first, ...values.filter(value => value !== first)].filter(value => values.includes(value));
  const target = await pick(ordered(TARGETS, current.target).map(value => ({
    label: value, value,
    description: value === 'cdm8e' ? 'Отладка через CdM Processors / Logisim' :
      value === 'cdm16e' ? 'Запуск в Cocoemu; локальная отладка недоступна' : 'Встроенный запуск и отладка',
  })), {title: 'CocoVS: ' + path.basename(file), placeHolder: 'Выбери процессор для этого файла', ignoreFocusOut: true});
  if (!target) return undefined;
  const architecture = await pick(ordered(ARCHITECTURES, current.architecture).map(value => ({
    label: value === 'harvard' ? 'Harvard' : 'von Neumann', value,
    description: value === 'harvard' ? 'Раздельная память команд и данных' : 'Общая память команд и данных',
  })), {title: 'CocoVS: ' + path.basename(file), placeHolder: 'Выбери архитектуру памяти', ignoreFocusOut: true});
  if (!architecture) return undefined;
  const profile = {target: target.value, architecture: architecture.value};
  await state.update(profileKey(file), profile);
  return profile;
}

module.exports = {getLaunchProfile, chooseLaunchProfile};

'use strict';

const path = require('node:path');
const {sourceLine} = require('./symbols');

function plainOutput(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function friendlyMessage(message, language, source) {
  const ru = /^ru(?:-|$)/i.test(language ?? '');
  const line = message.split(/\r?\n/)[0].trim();
  if (/\b(?:input|token)\s+['"]<EOF>['"]|\bunexpected end of (?:file|input)\b/i.test(line)) {
    const expectsEnd = /\bexpecting\b.*\bEnd\b/i.test(line);
    const hasEnd = source?.split(/\r?\n/).some(raw => /^\s*end\.?\s*$/.test(sourceLine(raw)));
    if (expectsEnd && source !== undefined && !hasEnd) {
      return ru ? 'Неожиданный конец файла. Добавь end в конце этого модуля, включая файлы из # @include.' :
        'Unexpected end of file. Add end at the bottom of this module, including files loaded with # @include.';
    }
    return ru ? 'Неожиданный конец файла. Проверь незакрытые блоки (fi, wend, until, mend) и директиву end.' :
      'Unexpected end of file. Check for an unclosed block (fi, wend, until, mend) and the final end directive.';
  }
  const operands = /^(?:(\S+): )?expected (.+?) (?:arguments?|operands?(?:\(s\))?), (?:but )?found (\d+)\.?$/i.exec(line);
  if (operands) {
    const [, instruction, expected, found] = operands;
    const prefix = instruction ? instruction + ': ' : '';
    return ru ? prefix + 'неверное число аргументов. Ожидалось ' + expected.replace(/ or /g, ' или ') +
      ', указано ' + found + '.' :
      prefix + 'expected ' + expected + (expected === '1' ? ' argument, got ' : ' arguments, got ') + found + '.';
  }
  const unknown = /^Unknown instruction "([^"]+)"/i.exec(line);
  if (unknown) return ru ? 'Неизвестная команда «' + unknown[1] + '». Проверь название и целевой процессор.' :
    'Unknown instruction "' + unknown[1] + '". Check its spelling and the selected processor.';
  const label = /^Label "([^"]+)" not found/i.exec(line);
  if (label) return ru ? 'Метка «' + label[1] + '» не найдена. Проверь её имя и подключение файла, где она объявлена.' :
    'Label "' + label[1] + '" was not found. Check its spelling and whether the defining module is included.';
  const external = /^Unresolved ext "([^"]+)"/i.exec(line);
  if (external) {
    const name = external[1];
    return ru ? 'Для внешней метки «' + name + '» нет экспорта. Проверь объявление ' + name + '> и подключение модуля.' :
      'No export for external label "' + name + '". Check the ' + name + '> declaration and include its module.';
  }
  const duplicate = /^Duplicate label "([^"]+)" declaration/i.exec(line);
  if (duplicate && ru) return 'Метка «' + duplicate[1] + '» объявлена повторно. Проверь определения в этой секции.';
  const token = /^(?:extraneous|mismatched) input (.+?) expecting\b/i.exec(line);
  if (token) return ru ? 'Неожиданный элемент ' + token[1] + '. Проверь команду, аргументы и запятые на этой строке.' :
    'Unexpected ' + token[1] + '. Check the instruction, its operands, and comma placement.';
  return message;
}

function describeProblems(problems, root, sources, language) {
  const seen = new Set();
  const contents = new Map(sources.map(source => [path.resolve(source.file), source.text]));
  return problems.flatMap(problem => {
    const file = path.resolve(root, problem.file);
    const key = JSON.stringify([file, problem.line, problem.message, problem.warning]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{...problem, message: problem.warning ? problem.message :
      friendlyMessage(problem.message, language, contents.get(file))}];
  });
}

module.exports = {describeProblems, friendlyMessage, plainOutput};

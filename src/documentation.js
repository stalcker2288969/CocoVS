'use strict';

const DATA_TYPES = {
  str: 'UTF-8 string',
  u8: 'Unsigned bytes',
  i8: 'Signed bytes',
  u16: 'Unsigned 16-bit words (little-endian)',
  i16: 'Signed 16-bit words (little-endian)',
  hex: 'Hexadecimal bytes',
  bytes: 'Raw bytes shown in hexadecimal',
};

function dataAnnotation(text) {
  const type = /^@type[ \t]*:[ \t]*(\w+)[ \t]*$/im.exec(text)?.[1].toLowerCase();
  return Object.hasOwn(DATA_TYPES, type) ? type : undefined;
}

module.exports = {DATA_TYPES, dataAnnotation};


'use strict';

const docs = {};
function describe(names, description, ...forms) {
  const details = typeof description === 'string' ? {summary: description} : description;
  for (const name of names.split(' ')) docs[name] = {...details, forms};
}

describe('ldi', {
  summary: 'Load an immediate value or label address.',
  returns: 'destination receives the 16-bit value.',
}, 'destination, value');
describe('move', 'Copy a register and update the condition flags.', 'source, destination');

for (const [name, data, memory] of [
  ['ldw', 'a 16-bit word', 'data memory'], ['ldb', 'a zero-extended byte', 'data memory'],
  ['ldsb', 'a sign-extended byte', 'data memory'], ['lcw', 'a 16-bit word', 'instruction memory'],
  ['lcb', 'a zero-extended byte', 'instruction memory'], ['lcsb', 'a sign-extended byte', 'instruction memory'],
]) {
  describe(name, {
    summary: 'Read from ' + memory + '. The indexed form adds base and index.',
    returns: 'destination receives ' + data + '.',
  }, 'addressRegister, destination', 'baseRegister, indexRegister, destination');
}
describe('ld', 'Load a 16-bit word from data memory. Alias for ldw.', 'addressRegister, destination');
describe('ldc', 'Load a 16-bit word from instruction memory. Alias for lcw.', 'addressRegister, destination');
describe('st', 'Store a 16-bit word to data memory. Alias for stw.', 'addressRegister, source');
describe('stw', 'Store a 16-bit word to data memory. The indexed form adds base and index.',
  'addressRegister, source', 'baseRegister, indexRegister, source');
describe('stb', 'Store the low byte of the source to data memory. The indexed form adds base and index.',
  'addressRegister, source', 'baseRegister, indexRegister, source');

for (const [name, effect, register] of [
  ['lsw', 'Load a word from', 'destination'], ['lsb', 'Load a zero-extended byte from', 'destination'],
  ['lssb', 'Load a sign-extended byte from', 'destination'], ['ssw', 'Store a word to', 'source'],
  ['ssb', 'Store the low byte to', 'source'],
]) {
  const offsets = name.endsWith('w') ? 'even, −128 to 126' : '−64 to 63';
  describe(name, effect + ' data memory at fp + byteOffset (' + offsets + ').', register + ', byteOffset');
}

const binary = ['first, second', 'first, second, destination'];
describe('add', {
  summary: 'Add the operands and update the condition flags.',
  inputs: {
    first: 'first register value',
    second: 'second register value',
    destination: 'output register in the three-register form',
    register: 'register to update in the immediate form',
    immediate: 'constant value to add',
  },
  returns: 'The low 16 bits of the sum go to second in the two-register form, to destination in the three-register form, or back to register in the immediate form.',
}, ...binary, 'register, immediate');
describe('sub', 'Subtract the second operand from the first. The two-register form writes to the second register. The immediate form updates its register in place.',
  ...binary, 'register, immediate');
describe('addc', 'Add first + second + C. The two-register form writes to the second register.', ...binary);
describe('subc', 'Compute first − second + C − 1. The two-register form writes to the second register.', ...binary);
for (const [name, effect] of [['and', 'AND'], ['or', 'OR'], ['xor', 'XOR']]) {
  describe(name, 'Apply bitwise ' + effect + '. The two-register form writes to the second register.', ...binary);
}
describe('bic', 'Clear bits of the first operand where the second operand has set bits. The two-register form writes to the second register.', ...binary);
describe('bis', 'Compute bitwise OR and write to the destination. Alias for or.', 'first, second, destination');
describe('cmp', 'Compare the operands by subtraction and update the condition flags without storing the result.',
  'first, second', 'register, immediate');
describe('bit', 'Test the bitwise AND of two registers and update the condition flags.', 'first, second');
describe('tst', 'Update the condition flags from the value of a register.', 'register');
describe('clr', 'Set a register to zero and update the condition flags.', 'destination');
describe('inc', 'Increment a register and update the condition flags.', 'register');
describe('dec', 'Decrement a register and update the condition flags.', 'register');
for (const [name, effect] of [
  ['neg', 'Negate a 16-bit value'], ['not', 'Invert all 16 bits'],
  ['sxt', 'Sign-extend the low byte'], ['scl', 'Clear the upper byte'],
]) {
  describe(name, effect + '. With one register, the result is written back to it.', 'register', 'source, destination');
}
for (const [name, effect] of [
  ['shl', 'Shift left'], ['shr', 'Shift right, filling with zeros'], ['shra', 'Shift right, preserving the sign'],
  ['rol', 'Rotate left'], ['ror', 'Rotate right'], ['rcl', 'Rotate left through carry'], ['rcr', 'Rotate right through carry'],
]) {
  describe(name, effect + ' by a constant count from 0 to 8. The default count is 1.',
    'register', 'source, destination', 'register, count', 'source, destination, count');
}

describe('jsr', 'Call a subroutine and push the 16-bit return address onto the stack.', 'targetAddress', 'targetRegister');
describe('jsrr', 'Call the subroutine at the address held in a register.', 'targetRegister');
describe('rts popc', 'Pop the program counter from the stack to resume execution at that address.', '');
describe('rti', 'Return from an interrupt by restoring PC and PS from the stack.', '');
describe('push', 'Decrement SP by 2 and write a 16-bit value onto the stack.', 'source', 'immediate');
describe('pop', 'Load a word from the top of the stack, then advance SP by 2.', 'destination');
describe('save', 'Push a register and record it for the matching restore directive.', 'source');
describe('restore', 'Pop a word into the register recorded by save, or into the supplied destination.', '', 'destination');
describe('addsp', 'Adjust SP by a register value or by an even immediate byte offset.', 'offsetRegister', 'byteOffset');
for (const [suffix, register] of [['sp', 'SP'], ['pc', 'PC'], ['ps', 'PS'], ['ssp', 'shadow SP']]) {
  describe('ld' + suffix, 'Copy ' + register + ' into a general-purpose register.', 'destination');
  describe('st' + suffix, 'Copy a general-purpose register into ' + register + '.', 'source');
}
describe('pupc', 'Push PC onto the stack.', '');
describe('pusp', 'Push SP onto the stack.', '');
describe('pups', 'Push PS onto the stack.', '');
describe('posp', 'Replace SP with the word at the top of the stack.', '');
describe('pops', 'Pop a word from the stack into PS.', '');
describe('halt', 'Stop the processor.', '');
describe('wait', 'Wait for an interrupt or exception.', '');
describe('nop', 'Advance to the next instruction without changing registers, memory, or flags.', '');
describe('ei', 'Enable interrupts.', '');
describe('di', 'Disable interrupts.', '');
describe('int', 'Trigger a software interrupt using vector 0–511.', 'vector');
describe('reset', 'Perform a software reset using the selected vector. The default is 0.', '', 'vector');
describe('syscall', 'Invoke the system-call interrupt (vector 7).', '');
describe('swp swpw', 'Atomically exchange a 16-bit register value with the word at the supplied memory address.', 'addressRegister, register');
describe('swpb', 'Atomically exchange a register byte with the byte at the supplied memory address.', 'addressRegister, register');

describe('br btrue banything', 'Jump unconditionally to the target address.', 'targetAddress');
describe('bfalse', 'Never take the branch.', 'targetAddress');
for (const [names, condition] of [
  ['beq bz', 'equal (Z = 1)'], ['bne bnz', 'not equal (Z = 0)'],
  ['bhs bcs', 'unsigned higher or equal (C = 1)'], ['blo bcc', 'unsigned lower (C = 0)'],
  ['bhi', 'unsigned higher (C = 1 and Z = 0)'], ['bls', 'unsigned lower or equal (C = 0 or Z = 1)'],
  ['bge', 'signed greater or equal'], ['blt', 'signed less'], ['bgt', 'signed greater'], ['ble', 'signed less or equal'],
  ['bmi', 'negative (N = 1)'], ['bpl', 'non-negative (N = 0)'],
  ['bvs', 'overflow (V = 1)'], ['bvc', 'no overflow (V = 0)'],
]) {
  describe(names, 'Jump to the target address if the condition is ' + condition + '.', 'targetAddress');
}

describe('align', 'Pad the current section to the next multiple of a positive byte alignment. The default is 2.', '', 'alignment');
describe('define', 'Define a named constant.', 'name, value');
describe('ds', 'Reserve the specified number of zero-filled bytes.', 'byteCount');
describe('dc', 'Emit initialized data. Numeric values occupy 16 bits, while strings emit their bytes.', 'value, ...');
describe('dw', 'Emit one or more initialized 16-bit words.', 'word, ...');
describe('db', 'Emit initialized bytes from byte constants or strings.', 'value, ...');

module.exports = docs;

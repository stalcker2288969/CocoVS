# Eight little-endian words; fixed addresses simplify byte assertions.
# Code and data are well below the stack at 0x8000.
asect 0x0400
# @type: u16
numbers> dw 1000, 2000, 3000, 4000, 5000, 0, 0, 0
# @type: u16
count> dw 5
# @type: u16
total> ds 2
end

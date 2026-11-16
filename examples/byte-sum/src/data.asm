# A fixed RAM window makes byte-level assertions easy to read.
# Code ends below 0xC0; the stack begins at 0xF0 and grows down.
asect 0xC0
# @type: u8
numbers> dc 3, 5, 8, 13, 21, 0, 0, 0
# @type: u8
count> dc 5
# @type: u8
total> ds 1
end

# @include "lib/routines.asm"
# @include "lib/*"

test_lable: ext
asect 0

# Start lable
# @param r0 Input
# @return r0 Result
# @changed r1, PS Modified registers or memory
start:
    ldi r0, text
    jsr test_lable  # some discript
    halt            # other descript

# @type: str
text:
    dc "Hello World"
end

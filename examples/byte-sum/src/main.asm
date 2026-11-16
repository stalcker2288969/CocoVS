# @include "lib/sum.asm"
# @include "data.asm"
sum_bytes: ext
numbers, count, total: ext

# Program: sum count bytes, write the result to total, halt.
# r2 also keeps the result for inspection and automated tests.
asect 0
main:
    setsp 0xF0
    ldi r0, numbers
    ldi r1, count
    ld r1, r1
    jsr sum_bytes
    ldi r0, total
    st r0, r2
    halt
end

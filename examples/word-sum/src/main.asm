# @include "lib/sum.asm"
# @include "data.asm"
sum_words: ext
numbers, count, total: ext

# CdM-16 reset stub for CocoVS / Cocoemu.
asect 0
    dc main, 0
asect 0x0200
main:
    ldi r7, 0x8000
    stsp r7
    ldi r0, numbers
    ldi r1, count
    ldw r1, r1
    jsr sum_words
    ldi r0, total
    stw r0, r2
    halt
end

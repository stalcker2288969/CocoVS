rsect word_routines

# Sum unsigned words modulo 65536; an empty array returns zero.
# @param r0 Even byte address of the first word
# @param r1 Word count (caller guarantees a valid memory range)
# @return r2 Low 16 bits of the sum
# @changed r0, r1, r3, PS Pointer, count, temporary and flags
# r4-r7 are preserved. jsr/rts balance SP. Input memory is read-only.
sum_words>
    clr r2
    while
        tst r1
    stays nz
        ldw r0, r3
        add r3, r2
        add r0, 2
        dec r1
    wend
    rts
end

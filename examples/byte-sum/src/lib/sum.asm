rsect byte_routines

# Sum unsigned bytes modulo 256; an empty array returns zero.
# @param r0 Address of the first byte
# @param r1 Number of bytes (caller guarantees a valid memory range)
# @return r2 Low byte of the sum
# @changed r0, r1, r3, PS Pointer, count, temporary and flags
# SP is balanced by jsr/rts. Input memory is never written.
sum_bytes>
    clr r2
    while
        tst r1
    stays nz
        ld r0, r3
        add r3, r2
        inc r0
        dec r1
    wend
    rts
end

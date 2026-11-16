# CdM-8, von Neumann. Sum 5 + 4 + 3 + 2 + 1 = 15.
# No project is needed. Run this file or click Debug above main.
# Final state: r0 = 0, r1 = 15, SP = 0xF0, total = 15, halt.
asect 0
main:
    setsp 0xF0
    ldi r0, 5
    clr r1
    while
        tst r0
    stays nz
        add r0, r1
        dec r0
    wend
    ldi r2, total
    st r2, r1
    halt

# @type: u8
total: ds 1
end

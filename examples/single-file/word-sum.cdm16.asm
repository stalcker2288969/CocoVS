# CdM-16, von Neumann. Words occupy two bytes; pointers advance by 2.
# Boot stub for CocoVS / Cocoemu. SP stays at 0x8000 (no calls here).
# Final: r1 = 0, r2 = 6000, total = 0x1770 (bytes 70 17), halt.
asect 0
    dc main, 0
asect 0x0200
main:
    ldi r7, 0x8000
    stsp r7
    ldi r0, numbers
    ldi r1, 3
    clr r2
    while
        tst r1
    stays nz
        ldw r0, r3
        add r3, r2
        add r0, 2
        dec r1
    wend
    ldi r0, total
    stw r0, r2
    halt

align 2
# @type: u16
numbers: dw 1000, 2000, 3000
# @type: u16
total: ds 2
end

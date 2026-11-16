# CdM-8, von Neumann. The same byte has two interpretations.
# 0xFA is 250 unsigned and -6 signed; the other operand is 5.
# cmp r0, r1 sets flags from r0 - r1 (first operand minus second).
# Final: r2 = 1 (250 > 5), r3 = 1 (-6 < 5), SP = 0xF0, halt.
asect 0
main:
    setsp 0xF0
    ldi r0, 0xFA
    ldi r1, 5
    clr r2
    clr r3
    if
        cmp r0, r1
    is hi
    then
        ldi r2, 1
    fi
    # Compare again: instructions in the previous branch may change flags.
    if
        cmp r0, r1
    is lt
    then
        ldi r3, 1
    fi
    halt
end

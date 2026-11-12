rsect routines

# Summary
# @param r0 Input
# @return r0 Result
# @changed r0, PS Modified registers or memory
test_lable>
    ldi r0, 42
    rts

load_lable>
    dc 10
end

# CdM-8

The base CPU has four 8-bit general registers, `r0` to `r3`, and an 8-bit address space. A byte can represent 0–255 unsigned or −128–127 signed. Arithmetic results wrap to 8 bits. Use the course reference and actual CPU revision for opcode details.

| Syntax | Effect |
| --- | --- |
| `ldi r0, value` | Load a constant or label address. |
| `ld r0, r1` / `st r0, r1` | Read `mem[r0]` into r1 / write r1 to `mem[r0]`. |
| `ldc r0, r1` | Read from instruction memory when supported by the selected revision. |
| `move r0, r1` | Copy r0 to r1. |
| `add r0, r1` / `sub r0, r1` | Write r0 + r1 / r0 − r1 into r1. |
| `cmp r0, r1` | Set flags from r0 − r1 without a register write. |
| `inc r0` / `dec r0` | Increase or decrease r0 by one. |
| `ldsa r0, offset` | Put SP + offset into r0. Follow with `ld` to read the slot. |
| `setsp value` / `addsp value` | Set SP or adjust it by a constant. |

Use `dc` for initialized bytes and `ds` for storage. Increment the pointer by 1 for each byte. Base CdM-8 has no native multiplication or division. Check a macro or subroutine definition before calling `mul`, `div`, `sum`, or `ldv`.

## Flags and stack

After `cmp a, b`, `beq/bne` use Z. Use `blt/bge/bgt/ble` for signed comparisons and `blo/bhs/bhi/bls` for unsigned comparisons. Signed less-than checks N ≠ V. `bmi` checks only N. Check intervening instructions for flag changes.

The stack grows toward smaller addresses. `push` decrements SP by 1 before writing, `pop` reads before incrementing SP by 1. `jsr` saves the return PC and `rts` restores it. Track the return address and any saved registers when addressing a stack slot. In the usual reset configuration SP starts at 0, so the first push uses `0xFF`. Reserve space to keep the stack clear of code and data.

## Example

Save as `sum8.asm`. Start at address 0 and expect r0 = 0 and r1 = 7 at `halt`. The loop sums 3 + 2 + 1, then the nonzero branch adds one. CoCAS expands the structured blocks into ordinary branches. If a course task forbids these blocks, use explicit labels and conditional branches.

```asm
asect 0
    ldi r0, 3
    ldi r1, 0
    while
        tst r0
    stays nz
        add r0, r1
        dec r0
    wend
    if
        tst r1
    is nz
        inc r1
    else
        ldi r1, 1
    fi
    halt
end
```

- [CdM-8 instructions and flag conditions](https://ccfit.nsu.ru/~fat/Platforms/3%20CdM-8%20instructions.pdf)
- [CdM-8 subroutines and stack](https://www.ccfit.nsu.ru/~fat/Platforms/5%20Subroutines%20and%20stack.pdf)

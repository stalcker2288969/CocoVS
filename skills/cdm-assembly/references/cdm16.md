# CdM-16

CdM-16 has eight 16-bit general registers (`r0`–`r7`) and a 16-bit byte address space. CoCAS recognizes `fp` as r7. A word is two bytes and CoCAS writes numerical `dw` data little-endian. Use `db` for byte data and `ds` for a count of bytes. Keep word data, the stack pointer, and instruction addresses even.

| Syntax | Effect |
| --- | --- |
| `ldw ra, rd` / `stw ra, rs` | Load a word from the address in ra / store a word to that address. |
| `ldb ra, rd` / `ldsb ra, rd` | Load a byte, with zero extension / sign extension. |
| `stb ra, rs` | Store the low byte of rs. |
| `lcw`, `lcb`, `lcsb` | Read a word or a zero/sign-extended byte from instruction memory. |
| `ldw base, index, dst` | Read from base + index, where the index is a byte offset. |
| `add a, b, d` / `sub a, b, d` | Put a + b / a − b in d. The two-register forms put the result in the second register. |
| `add r0, 1` / `sub r0, 1` | Update r0. Check the assembler's range for other immediates. |
| `lsw rN, offset` / `ssw rN, offset` | Load/store a word at fp + byte offset. Set up and preserve fp according to the project ABI. |

Use byte stride 2 to iterate over an array of words. `stsp rN` sets SP. `push` moves SP down by 2 and writes a word, `pop` reads then moves SP up by 2. `jsr` pushes the return address and CoCAS `rts` returns by popping the PC. Base CdM-16 implements multiplication and division in software.

## Startup and example

Use the target system's reset template. The upstream CdM-16 starter declares a reset vector with `dc main, 0` at address 0. The following example uses the boot stub tested with Cocoemu via CocoVS. It is intended for that von Neumann configuration. Keep the startup template when modifying an existing board project.

Save as `sum16.asm`. Expect r1 = 6, memory word `out = 6`, SP = `0x8000`, and stop reason `halt`.

```asm
asect 0
    br start
asect 0x0200
start:
    ldi r7, 0x8000
    stsp r7
    ldi r0, 3
    ldi r1, 0
    while
        tst r0
    stays nz
        add r0, r1
        dec r0
    wend
    ldi r2, out
    stw r2, r1
    halt
align 2
out: dw 0
end
```

- [CdM-16 tooling, emulator, and upstream templates](https://github.com/cdm-processors/cdm-devkit)

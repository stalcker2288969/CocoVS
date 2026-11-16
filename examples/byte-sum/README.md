# Byte-array sum — CdM-8

Open this folder in VS Code, then [src/main.asm](src/main.asm). Use **CocoVS: Run** or F5. [cdm-project.json](cdm-project.json) selects CdM-8, von Neumann memory, and local emulation. Output goes into this folder's `build/`.

## Layout

- [src/main.asm](src/main.asm): entry point, SP initialization, function call, and result storage.
- [src/lib/sum.asm](src/lib/sum.asm): exported `sum_bytes` routine.
- [src/data.asm](src/data.asm): input data and output in a fixed RAM window.
- [project.yaml](project.yaml): cdmbot structure, syntax, and coverage checks.
- [tests/sum.yaml](tests/sum.yaml): five independent input/output cases.

`sum_bytes>` exports the function; `sum_bytes: ext` imports it into the main module. CocoVS passes additional modules to CoCAS through `# @include`. Each module has its own `end` directive.

## Contract and result

Input: `r0` is the array address and `r1` is its byte count. Output: `r2` is the sum modulo 256. The function changes `r0`, `r1`, `r2`, `r3`, and flags. `jsr/rts` balance the stack; input memory is not written. This example's buffer accepts 0–8 bytes.

RAM layout: `numbers = 0xC0` (8 bytes), `count = 0xC8`, `total = 0xC9`. The stack starts at `0xF0` and grows downward; code is below the data region. A normal run computes `3 + 5 + 8 + 13 + 21 = 50`. At `halt`, expect `r2 = 50`, `total = 50`, and `SP = 0xF0`.

## Automated tests

Find `project.yaml → byte_sum` in **Testing**. Run the project or select a case. cdmbot setup is described in the [testing guide](../../docs/testing.md#prerequisites).

```sh
cdmbot project project.yaml
cdmbot src/main.asm tests/sum.yaml --case wraparound
```

| Case | Input | Result |
| --- | --- | --- |
| `normal` | 3, 5, 8, 13, 21 | 50 |
| `empty` | count = 0 | 0; the loop executes zero times |
| `one_unsigned_byte` | 200 | 200 |
| `wraparound` | 250, 10 | 4; carry beyond the byte is discarded |
| `full_capacity` | 1, 2, 3, 4, 5, 6, 7, 8 | 36 |

Each case checks `r2`, the output byte, preservation of the input buffer/count, and SP. `setup.input` replaces initial RAM data without rewriting assembly. Do not set `count > 8`: the routine does not validate the buffer size. Coverage thresholds are 66% of files (the data module does not execute) and 80% of mapped instruction lines.

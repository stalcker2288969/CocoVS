# Word-array sum — CdM-16

Open this folder in VS Code, then [src/main.asm](src/main.asm). Use **CocoVS: Run** or F5. [cdm-project.json](cdm-project.json) selects CdM-16 and von Neumann memory. Execution needs Cocoemu and JDK 17+, which CocoVS can prepare. Output goes into this folder's `build/`.

## Layout

- [src/main.asm](src/main.asm): reset vector `dc main, 0` at address 0; code starts at `0x0200` and initializes SP.
- [src/lib/sum.asm](src/lib/sum.asm): exported `sum_words` function.
- [src/data.asm](src/data.asm): input words and output in RAM.
- [project.yaml](project.yaml): structure, syntax, and coverage checks.
- [tests/sum.yaml](tests/sum.yaml): five cases, including carry handling and ABI preservation.

The function is imported as `sum_words: ext` and exported as `sum_words>`. CocoVS links modules through `# @include`; cdmbot uses the suite's `build.sources` list.

## Contract and memory

Input: `r0` is an even byte address; `r1` is the word count (0–8 for this buffer). Output: `r2` is the sum modulo 65536. The routine changes `r0`–`r3` and PS, preserving `r4`–`r7`. `jsr` pushes a two-byte return address; `rts` removes it. Before the call, the main module sets `r7 = SP = 0x8000`.

Each element occupies **two bytes**, so the pointer advances by 2. `numbers = 0x0400` (16 bytes), `count = 0x0410` (one word), `total = 0x0412` (one word). Words are little-endian: low byte first. A normal run sums 1000, 2000, 3000, 4000, and 5000. At `halt`, expect `r2 = 15000`, `SP = 0x8000`, and output bytes `98 3A`.

## Automated tests

Find `project.yaml → word_sum` in **Testing**. Set `cocovs.cdmbotPythonPath` if automatic detection fails. The JDK must be available to cdmbot itself, for example through `JAVA_HOME`; see the [testing guide](../../docs/testing.md#prerequisites).

```sh
cdmbot project project.yaml
cdmbot src/main.asm tests/sum.yaml --case carry_between_bytes
```

| Case | Input words | Result |
| --- | --- | --- |
| `normal` | 1000, 2000, 3000, 4000, 5000 | 15000 |
| `empty` | count = 0 | 0 |
| `one_word` | 65535 | 65535 |
| `wraparound` | 65535, 2 | 1 |
| `carry_between_bytes` | 255, 1, 256 | 512; bytes `00 02` |

In `setup.input`, scalar `count: 5` encodes one 16-bit word. **Lists always contain bytes**: `[255, 255, 2, 0]` encodes words 65535 and 2. Expected memory is also expressed as bytes. Cases check the sum, SP, preserved `r4`–`r6`, and the input array/count. The limit is 1000 instructions. Coverage thresholds are 66% of files and 70% of CoCAS-mapped instruction lines; this is not branch coverage, and the data-only module does not execute.

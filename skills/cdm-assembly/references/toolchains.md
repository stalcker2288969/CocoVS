# Toolchains and syntax

| Tool | Role and dialect |
| --- | --- |
| CoCAS (`cocas`, from `cdm-devkit`) | CLI macroassembler and linker. The examples here use 0.2.3. Use `cocas -T` to check targets. Version 0.2.3 lists `cdm8`, `cdm8e`, `cdm16`, `cdm16e`. Pass `-t` explicitly because the CLI defaults to CdM-16. An extended target needs a matching CPU and emulator. |
| CocoIDE | Educational CdM-8 environment from the NSU course. Its macroassembler supports structured constructs such as `if/is/else/fi`, `while/stays/wend`, and `do/until`. Use the course examples and the installed version to check directive and macro spelling. |
| CdM-16 LLVM toolchain | The CdM-16 LLVM project documents a CoCAS route and a route using an integrated assembler with GNU-style syntax. Follow the selected target and ABI. Verify the syntax against the actual assembler before porting a CoCAS program. |
| Cocoemu, Logisim | Execute the memory image. Check the exact CPU model, ROM/RAM layout, reset behavior, and available peripherals. |
| CocoVS | Project and editor integration. Read [project overlays](project-overlays.md) for project-specific build inputs. |

CdM is a family of educational microprogrammed load/store CPUs. The PC tracks instruction fetch, SP tracks the stack, and PS holds status flags. In a von Neumann configuration, instructions and data share memory. In a Harvard configuration, read code-image constants through the instruction-memory load and write results to RAM. Check where the image is loaded and how the specific board starts the CPU.

## CoCAS source and outputs

- Use `#` comments, comma-separated operands, and labels such as `loop:`. Use decimal or `0x` literals. `ldi r0, value` loads the immediate value. If `value` is a label, the loaded number is its address.
- Use `asect address` for a fixed-address section, `rsect name` for a relocatable section, and `end` to finish the module. Upstream templates also use `end.`. Use `ds N` to allocate N bytes and `align 2` for even alignment. Read the CPU reference for data directives.
- Export with `routine>` and import with `routine: ext`. Pass the defining source or object to the same link command.
- CoCAS expands macros and structured control flow, encodes the module, then links sections and resolves symbolic addresses. Diagnose macro and parser errors before link errors. For runtime failures inspect PC, SP, flags, and the memory layout.
- CoCAS 0.2.3 writes raw bytes to `.bin` and a textual Logisim image to `.img`. Put bare `--debug` after the input list to request debug information. Use `-c` to assemble without linking.

```sh
cocas -T
cocas -t cdm8 -o sum8.bin sum8.asm
cocas -t cdm16 -o sum16.img sum16.asm --debug
cocas -t cdm8 -c -o helpers.obj helpers.asm
cocas -t cdm8 -o program.bin main.asm helpers.obj
```

Example link input for CdM-8. Put the two modules in separate files and expect `r0 = 42` with the original SP at `halt`.

```asm
# main.asm
answer: ext
asect 0
    setsp 0
    jsr answer
    halt
end
```

```asm
# helpers.asm
rsect helpers
answer>
    ldi r0, 42
    rts
end
```

## CoCAS macros

An inline definition starts with `macro name/arity`, uses parameters such as `$1` and `$2`, and ends with `mend`. CoCAS 0.2.3 rejects a trailing period in `macro name/arity.`. In a separate `.mlb`, use `* name/arity` followed by the body. The library example below has no `mend`. Pass the library explicitly, for example `cocas -t cdm8 -o use.bin use.asm helpers.mlb`.

```asm
* incmem/2
    ld $1, $2
    inc $2
    st $1, $2
```

## Primary sources

- [Coco-de-Mer architecture and tools](https://github.com/cdm-processors)
- [CoCAS source and devkit](https://github.com/cdm-processors/cdm-devkit)
- [NSU Computing Platforms course and CocoIDE downloads](https://www.ccfit.nsu.ru/~fat/Platforms/)
- [CdM-16 LLVM toolchain design](https://github.com/ylab-nsu/cdm16-llvm-neo/wiki/SAD)

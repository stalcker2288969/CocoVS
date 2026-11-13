# Project overlays

CocoVS and the user's base libraries extend the CdM development workflow. Check the project's build command, sources, and macro definitions before relying on features from these layers.

## CocoVS

- Read `cdm-project.json` and the extension's `docs/guide.md`. Inspect the entry file, target, architecture, and extra sources. When the project uses `# @include "lib.asm"`, CocoVS collects the module and supplies it to CoCAS. For direct CoCAS calls, pass modules and libraries explicitly.
- Preserve separate modules and use the matching import/export declarations. A combined listing can help diagnose missing sources. The actual build configuration determines which files and symbols reach the linker.
- Use the project's Build or Run command when checking its full workflow. When a diagnostic depends on operand types or instruction availability, cross-check the actual assembler and target. A hover entry alone cannot prove that a spelling is accepted.

## Memory and stack helpers

Classify each macro parameter as a register, address expression, value, or offset. Use `ldi` for an address expression and `ld` for a register holding an address. On CdM-8, convert a stack offset with `ldsa` before using a macro that expects an address register.

A safe interface for `incmem/2` requires an address register and a different scratch register. It keeps the address, writes the incremented byte back, and changes the scratch register and the arithmetic flags. The fixed address, scratch-register, and implicit-register variants can have different contracts even if they share a name.

```asm
macro incmem/2
    ld $1, $2
    inc $2
    st $1, $2
mend

asect 0
    ldi r0, counter
    incmem r0, r1
    halt
counter: dc 41
end
```

Expect `counter = 42` and `r1 = 42` after `halt` in the standard CdM-8 von Neumann configuration. When documenting a project macro, preserve its actual operand order and write down inputs, outputs, changed registers, memory, flags, and SP. Test the nested expansion and same-register inputs if the interface permits them.

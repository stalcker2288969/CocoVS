---
name: cdm-assembly
description: "Write, explain, debug, and port Coco-de-Mer assembly and macros for CdM-8 and CdM-16. Use for cdm8, cdm8e, cdm16, cdm16e, CoCAS, CocoIDE, Cocoemu, Logisim, CocoVS, and requests about ассемблер CdM, стек, регистры, флаги, or макросы."
---

# Program Coco-de-Mer processors

1. Identify the CPU target and revision, the assembler and version, the memory layout, and the boot convention. Read the existing build command, configuration, startup code, and assignment restrictions. An `.asm` extension does not identify the dialect. For a new standalone example with a specified CPU, use CoCAS and state the execution configuration. Ask for clarification only when missing details change the answer materially.
2. Classify unfamiliar syntax before using it. Find the instruction in the target ISA, the pseudo-instruction or directive in the assembler, or the macro in the actual project dependencies. Treat highlighting and editor hovers as clues. CocoVS and the user's base libraries are layers over CdM.
3. Read the relevant references below. Match the user's language when answering. Preserve the syntax, symbol names, and ABI of existing code.
4. State the inputs, outputs, clobbered registers, flags, and memory. For subroutines, state the calling convention and balance SP on every return path. For macros, trace parameter substitution and nested expansion. Check aliasing between address and scratch registers. Test two expansions when the macro declares labels.
5. Track each value as an address or as data. Record byte or word width and signedness. After a comparison, write down which operand was subtracted from which and which flags the branch uses. For loops, check zero and one iteration. When porting, recheck entry vectors, data sizes, pointer steps, stack slots, and ABI.
6. Assemble with the exact target and dialect. Run with a step limit in the matching environment and verify output registers, memory, SP, and stop reason. Report assembly and runtime verification separately. If execution is unavailable, give the expected state and identify it as an expectation.

| Task | Read |
| --- | --- |
| Choose an assembler, use directives, build modules or macro libraries, debug a build | [Toolchains and syntax](references/toolchains.md) |
| Write or debug CdM-8 code | [CdM-8](references/cdm8.md) |
| Write or debug CdM-16 code | [CdM-16](references/cdm16.md) |
| Work with CocoVS or user-defined macros | [Project overlays](references/project-overlays.md) |

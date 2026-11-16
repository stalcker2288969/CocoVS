# CocoVS examples

The examples below use **CoCAS** and **von Neumann** memory (`unified` in cdmbot). They need no Logisim circuit or external server. CdM-8 runs in the built-in emulator; CdM-16 uses Cocoemu and JDK 17+.

| Example | Processor | What it demonstrates | Expected result |
| --- | --- | --- | --- |
| [Countdown](single-file/countdown.cdm8.asm) | CdM-8 | One file, `while/stays`, storing a result in RAM | `r1 = 15`, `total = 15` |
| [Signed comparisons](single-file/comparisons.cdm8.asm) | CdM-8 | Unsigned `hi` and signed `lt` after `cmp` | `r2 = 1`, `r3 = 1` |
| [Word sum](single-file/word-sum.cdm16.asm) | CdM-16 | Reset vector, two-byte words, `ldw/stw` | `r2 = 6000`, `total = 6000` |
| [Byte-sum project](byte-sum/README.md) | CdM-8 | Three modules, `ext`, subroutine calls, five tests | `r2 = 50`, RAM `0xC9 = 50` |
| [Word-sum project](word-sum/README.md) | CdM-16 | Three modules, ABI, little-endian data, five tests | `r2 = 15000`, RAM `0x0412 = 98 3A` |

## Run a standalone file

1. Open `examples` in VS Code and choose a file from [single-file](single-file/).
2. Use **CocoVS: Run** or the **▶ Debug** link above `main`.
3. On the first launch, select the processor from the table and **von Neumann**. CocoVS remembers the choice per file. Change it with **CocoVS: Configure File Execution**.
4. While debugging, inspect registers and the `total` label in **CocoVS RAM**, where present. Every example stops at `halt`; a 1000-instruction limit is sufficient.

Standalone files need no manifest. Their output goes into `single-file/build/`.

## Run a project and its tests

Open [byte-sum](byte-sum/) or [word-sum](word-sum/) as a VS Code folder, then open `src/main.asm`. **CocoVS: Run** and F5 use `cdm-project.json`. The routine and data modules are linked through `# @include` comments.

For tests, use an installed **cdmbot** environment. If automatic detection fails, set `cocovs.cdmbotPythonPath` to the Python where `python -m cdmbot --help` works. CdM-16 tests also need JDK 17+ available to cdmbot, for example through `JAVA_HOME`. `cocovs.javaPath` configures CocoVS execution; cdmbot uses its own environment. See the [testing guide](../docs/testing.md#prerequisites).

1. Open **Testing** and refresh discovery if the list is empty.
2. Find the project by `project.yaml` and expand `byte_sum` or `word_sum`.
3. Run the whole project to check structure, syntax, test cases, and coverage thresholds.
4. Select one case for a focused run. Project-wide coverage checks are skipped for filtered runs.
5. To see a failure, change the byte project's `normal` expected register result from 50 to 51 in `tests/sum.yaml`. Run it and inspect the mismatch, then restore the correct value.

From the corresponding project folder:

```sh
cdmbot project project.yaml
cdmbot src/main.asm tests/sum.yaml --case empty
```

`cdm-project.json` controls the extension's build/run workflow. `project.yaml` controls cdmbot discovery and project checks. In `tests/sum.yaml`, `build.sources` explicitly lists the other modules: cdmbot does not process `# @include` comments. Suite paths are relative to the YAML file.

`setup.input` injects data by assembly label; `expect` checks registers and RAM bytes. `preserve_registers` checks the stack/ABI and `preserve_memory` protects the input buffer. `max_steps` detects nonterminating loops. Coverage comes from CoCAS's debug map, not branch instrumentation. Only two of the three modules contain executed code, so the examples use a 66% file threshold.

## Other examples

[multi-file](multi-file/) is the earlier compact module-import example. [sorting](sorting/) contains the existing sorting program. Start with the documented examples above for a complete workflow with automated tests.

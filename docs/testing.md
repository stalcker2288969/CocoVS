# Automated testing with cdmbot

CocoVS integrates cdmbot with VS Code's **Testing** view. The [byte-sum](../examples/byte-sum/README.md) and [word-sum](../examples/word-sum/README.md) projects each contain five cases plus structure, syntax, and coverage checks.

## Prerequisites

Use **CocoVS: Install or Update cdmbot** to install the bundled development version and enable its terminal command in the user PATH. Existing explicit Python paths and test-only installations remain supported. Automatic package discovery from includes requires cdmbot 0.2.1 or newer. See [development tools and packages](cdmbot-development.md).

Open a trusted local folder containing a cdmbot project. Use a Python environment where `python -m cdmbot --help` works. If CocoVS cannot detect it, set `cocovs.cdmbotPythonPath` to that environment's Python executable.

CdM-16 tests also require JDK 17+ and Cocoemu from a compatible `cdm-devkit` installation in the cdmbot environment. Make the JDK available to cdmbot, for example through `JAVA_HOME`. `cocovs.javaPath` configures the extension's runtime; it does not configure cdmbot's separate runtime. CocoVS toolchain setup does not by itself install cdmbot into your test environment.

## Project layout

```text
byte-sum/
  cdm-project.json
  project.yaml
  src/
    main.asm
    data.asm
    lib/sum.asm
  tests/
    sum.yaml
```

| File | Purpose |
| --- | --- |
| `cdm-project.json` | CocoVS processor, memory architecture, entry file, and extra sources |
| `project.yaml` | cdmbot discovery, source inventory, syntax/structure checks, and coverage thresholds |
| `tests/sum.yaml` | Test architecture, linked sources, initial state, execution limits, and expectations |

CocoVS discovers `project.yaml` and `project.yml` manifests with a `suites` section, excluding `.git`, `node_modules`, and `build`. Project paths are relative to the project manifest; `build.sources` paths are relative to the suite file.

```yaml
version: 1
source_roots: [src]
suites:
  byte_sum:
    program: src/main.asm
    suite: tests/sum.yaml
syntax:
  all_modules:
    architecture: cdm8
    directories: [src]
structure:
  files: [src/main.asm, src/data.asm, src/lib/sum.asm, tests/sum.yaml]
thresholds:
  file_percent: 66
  line_percent: 80
```

Keep generated output outside `source_roots`, so combined build listings do not enter the coverage inventory.

## Test cases and assertions

This excerpt uses the [byte-sum memory layout](../examples/byte-sum/README.md): array at `0xC0`, count at `0xC8`, output at `0xC9`.

```yaml
version: 1
architecture: cdm8
memory_model: unified
build:
  sources: [../src/lib/sum.asm, ../src/data.asm]
defaults:
  setup:
    registers: {sp: 0xF0}
  run: {until: halt, max_steps: 1000}
  preserve_registers: [sp]
  preserve_memory: [{address: 0xC0, length: 9}]
cases:
  wraparound:
    setup:
      input: {numbers: [250, 10], count: 2}
    expect:
      registers: {r2: 4}
      memory: {0xC9: 4}
```

- `setup.input` injects data at linked assembly labels before execution without editing source files.
- `expect.registers` and `expect.memory` check results. Memory addresses and values describe bytes.
- `preserve_registers` compares against initial values; include `sp` to catch stack imbalance.
- `preserve_memory` protects input buffers or other regions from changes.
- `run.max_steps` catches nonterminating loops; `until: halt` requires the expected stop reason.

Use `architecture: cdm8` or `cdm16`. The `unified` memory model corresponds to CocoVS's `vonNeumann`; both tools also support `harvard`. On CdM-16 an integer in `setup.input` represents one native word, but a list always contains bytes. `[255, 255, 2, 0]` encodes little-endian words 65535 and 2. Expected word-sized memory also needs bytes, such as `memory: {0x0412: [1, 0]}`.

cdmbot 0.2.1 discovers modules referenced by `# @include` in the main source, including catalog packages. Additional modules can also be listed in `build.sources`. The sources and suite must use matching processor and memory configurations.

## Run tests in VS Code

1. Open an example project folder, or a workspace containing it.
2. Open **Testing** and refresh discovery if necessary.
3. Expand the project and suite to see cases and **Project checks**.
4. Run the whole project for structure, syntax, and coverage checks, or select a suite/case for a focused run.
5. Select a case to open its YAML location; read failures and coverage summaries in the test output.

`cocovs.cdmbotJobs` controls concurrency (1–32). Project coverage checks are skipped for filtered runs because they require the entire project.

To try a failure, change the byte-sum `normal` case's expected `r2` from 50 to 51 and run it. The test reports a mismatch. Restore 50 afterward.

## Run tests from a terminal

From either example project's folder, in the environment containing cdmbot:

```sh
cdmbot project project.yaml
cdmbot src/main.asm tests/sum.yaml --case empty
```

The equivalent module form is `python -m cdmbot`. Add `--json` for a machine-readable report or `--jobs 1` for sequential execution.

## Add or change a suite

**CocoVS: Create cdmbot Test Suite** generates a suite with a smoke case and can populate linked sources from the CocoVS project. **CocoVS: Add cdmbot Test Case** adds a named case. Edit inputs, assertions, limits, or case removal in YAML.

Coverage uses CoCAS's debug source map; it is not branch coverage. A data-only module does not execute. In the example projects, two of three source files execute, so the file threshold is 66%. The byte project uses an 80% line threshold and the word project uses 70%, based on mapped instructions. Assertions still check every case's result, input preservation, and stack state.

For tests of the extension itself, see [development](development.md#tests).

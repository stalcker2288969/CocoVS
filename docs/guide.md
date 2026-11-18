# CocoVS user guide

CocoVS provides CdM-8/CdM-16 assembly editing, CoCAS builds, local execution, source debugging, and RAM inspection in desktop Visual Studio Code.

Start with the [example catalog](../examples/README.md). See [automated testing](testing.md) for cdmbot and [development and publishing](development.md) for building the extension itself.

## Installation and toolchain setup

1. Install **CocoVS — CdM Assembly** from Extensions, or use **Extensions: Install from VSIX...** with a downloaded package.
2. Open a trusted local folder or a saved assembly file. Building, running, and debugging require workspace trust.
3. Run **CocoVS: Set Up Toolchain**, or start a build. CocoVS reuses compatible tools and can prepare its own Python environment with `cdm-devkit`.

Watch **Output → CocoVS** for detection, installation, assembler output, and execution results. CdM-16 setup also reports its debug Python, Cocoemu JAR, and JDK preparation.

One VSIX supports Windows, macOS, and Linux on x64 and ARM64. CdM-16/CdM-16e execution requires JDK 17+; CocoVS can download Temurin 21 if needed. Automatic setup requires access to the download services and a system `tar` command. Supply absolute paths through `cocovs.pythonPath`, `cocovs.cocasPath`, `cocovs.javaPath`, and `cocovs.cocoemuJar` when using your own tools.

Completion, hover documentation, and signature help work without a toolchain. CoCAS is needed for assembler diagnostics and builds.

## Run a standalone file

Open a saved `.asm` file and run **CocoVS: Run**, or use the editor's play button. A project manifest and `launch.json` are not required. You can open one file or a folder containing independent programs.

```asm
asect 0
main:
    ldi r0, 42
    halt
end
```

On the first build, run, or debug launch, choose the processor and memory architecture:

- **von Neumann** (`vonNeumann`): shared instruction and data memory.
- **Harvard** (`harvard`): separate instruction and data memory.

CocoVS remembers the selection by the file's full path in local extension storage, including across VS Code restarts. Other files can have different settings. **CocoVS: Configure File Execution** changes the active file's selection. Cancelling either picker cancels the launch.

The initial processor suggestion comes from a suffix such as `demo.cdm16.asm`, the language mode, or `cocovs.target`. The initial memory architecture comes from `cocovs.architecture`. A saved file profile takes precedence; a containing project's manifest takes precedence over file profiles.

### Local build output

Standalone output is placed in `build/` beside the source, regardless of the open workspace folder:

```text
sorting/
  sort.asm
  build/
    sort.img
    sort.dbg.json
    sort.combined.asm
    sort.ram.bin
```

The RAM dump is produced by a local **Run**. The workspace boundary still controls dependency resolution. A project with `cdm-project.json` writes `build/out.*` in that project's root instead.

### Entry-point debug links

The **▶ Debug** CodeLens appears above a label named by `run label`. Without `run`, CocoVS recognizes `main`, `_main`, `start`, `_start`, `program`, `init`, `entry`, `_entry`, and `reset`. Macro-local labels, external declarations, and data declarations are excluded from these suggestions.

The link builds and debugs its file even if another editor is active. The processor starts normally; the link does not assign an arbitrary PC to the label. For a file in a project, the configured project entry program is launched. The label and tooltip use Russian when the VS Code display language is Russian, and English otherwise.

## Processor support

| Target | Local execution | Debugging |
| --- | --- | --- |
| CdM-8 | Built-in Python emulator | Built-in debugger |
| CdM-8e | Configure a project runner | External CdM Processors / Logisim |
| CdM-16 | Cocoemu and JDK 17+ | Built-in debugger |
| CdM-16e | Cocoemu and JDK 17+ | No built-in debugger |
| Custom processor | Configure your assembler and runner | Use your processor's tools |

Debug links are hidden for CdM-16e and custom processors. `cocovs.maxSteps` limits local execution. Use Logisim or a custom runner for hardware peripherals, external interrupts, or a specific circuit.

The [tested CdM-16 examples](../examples/word-sum/README.md) use a reset vector (`dc main, 0`) at address 0, aligned words, and an initialized stack. Select the processor and memory model matching your source.

## Multi-file projects

Open a folder and run **CocoVS: Create or Initialize Project**. For a new project it creates `src/main.asm`, `cdm-project.json`, a smoke suite, a build task, and an F5 profile for supported debuggers. Choose an existing folder or create a new folder, and select an application or a library. It shares both templates with `cdmbot create` and its `init` alias. Existing `main.asm` or `src/main.asm` files are preserved.

```json
{
  "entry": "src/main.asm",
  "target": "cdm8",
  "architecture": "vonNeumann",
  "environment": "emulator",
  "extraSources": []
}
```

An include comment adds a separate source module to the CoCAS invocation:

```asm
# @include "lib/routines.asm"
sum_bytes: ext
```

Include paths are relative to the file containing the directive. `extraSources` paths are relative to the manifest. CoCAS assembles `.asm` files as separate modules, accepts `.mlb` macro libraries, and links `.obj`, `.o`, and `.lib` inputs. Import a symbol with `name: ext`; export it with `name>` in its defining module. Each source module retains its own `end` directive.

`# @include "lib/*"` includes assembly and macro-library sources directly inside a folder in filename order. Nested folders need their own directives. See [byte-sum](../examples/byte-sum/README.md) and [word-sum](../examples/word-sum/README.md) for complete projects.

A successful build also writes `out.combined.asm` to the project's `build/` directory. Standalone builds use `<source-name>.combined.asm` in the local `build/`. This listing shows module boundaries and binary inputs. CoCAS still builds the original modules, preserving source locations. A custom assembler can access the listing through `${combined}`.

## Editing and navigation

Choose **CocoVS Assembly** in **Change Language Mode** if another extension claims `.asm` files. Completion depends on processor, instruction, operand position, and comma-separated arguments. For example, `ldi` suggests a register first and a label second. Selecting an exported CoCAS label can add a missing `name: ext` declaration automatically.

Use **CocoVS: Show Assembly Suggestions**, `Ctrl+Space`, or `Cmd+Shift+.` on macOS. Include completion suggests files and folders after `# @include "`. Hover and signature help work independently of live diagnostics.

Installed packages also appear in include completion. Type `# @include "@` to choose a package, then select `lib.asm` or a specific `.mlb` source. For example, `# @include "@memoryze8/lib.asm"` loads the package's included macro libraries. Completion shows their signatures and documentation, and `Ctrl+Click` or F12 on the include path opens the installed source. Package and lock-file changes refresh library symbols and semantic highlighting.

`Ctrl+Click` or F12 opens definitions, including imported ones. The editor provides an outline, include links, and semantic highlighting. In the default dark theme, labels are typically teal, control flow orange, macros and directives such as `run` purple, and other instructions yellow. Exact colors depend on the theme.

Comments directly above a label or macro appear in hover documentation. Use `@param`, `@return` (or `@returns`), and `@changed` to describe arguments, results, and modified registers, flags, or memory. `Ctrl+Shift+Space` opens signature help.

### Structure templates

`tplate` defines a byte layout. `Person._` is its total size and `Person.age` is a field offset. For example, `name: ds 10`, `age: ds 1`, and `id: ds 3` occupy 14 bytes. Reserve a stack frame with `addsp -Person._` and release it with `addsp Person._`. A static instance uses `person: ds Person._`. Template declarations describe the layout, while these reservations allocate the storage.

CocoVS completes qualified template members, opens their definitions with F12 and shows size or offset information on hover. Symbolic layouts are evaluated by CoCAS. CocoVS 0.9.3 and cdmbot 0.2.2 correct CoCAS 0.2.3 template handling in subtracted expressions and storage directives. CdM-16 word fields and stack frames require even addresses and sizes.

### Snippets and comparisons

| Shortcut | Snippet |
| --- | --- |
| `Ctrl+Alt+W` | `while` loop |
| `Ctrl+Alt+F` | Register-based counted loop |
| `Ctrl+Alt+I` | `if/else` block |
| `Ctrl+Alt+D` | Documentation block (`discript` / `describe`) |

After `is`, `stays`, or `until`, type a comparison and accept completion with Enter or Tab. The editor inserts a CoCAS condition code. Suffix `s` means signed; `u` means unsigned. Typing only `>`, `>=`, `<`, or `<=` offers both variants. Inside a snippet placeholder, invoke completion with `Ctrl+Space` if needed.

| Relation | Signed | Unsigned |
| --- | --- | --- |
| `>` | `>s` → `gt` | `>u` → `hi` |
| `>=` | `>=s` → `ge` | `>=u` → `hs` |
| `<` | `<s` → `lt` | `<u` → `lo` |
| `<=` | `<=s` → `le` | `<=u` → `ls` |
| `==` | `eq` | `eq` |
| `!=` | `ne` | `ne` |

These relations describe `cmp left, right` as `left relation right`. After `cmp r0, r1`, accepting `>=u` in `stays >=u` inserts `stays hs`, continuing while unsigned `r0 >= r1`. Do not change comparison flags before testing them. Ordinary codes such as `z`, `nz`, `hi`, and `lo` remain available. These operators are editor abbreviations: accept completion before assembling so the source contains a valid CoCAS condition.

### Diagnostics and refactoring

The **References** CodeLens above a label or macro counts its uses in the linked sources. Select the count to open the matching locations in the editor. Turn these counts off with `cocovs.referenceCodeLens`.

Use **Find All References** on a label, macro name, or include path to find its uses in the linked sources. Macro overloads are resolved by argument count. A standalone file uses its own include tree or the tree of its unique open entry file in the workspace. **Show Call Hierarchy** on a routine or macro lists callers and callees. Select an `@include` path to see which files include it, or select the `@include` keyword to start from the current file. The hierarchy shows direct calls and statically named macro invocations. Register-indirect calls and labels resolved only during macro expansion are omitted.

For a macro with `@param` documentation or a documented instruction, a hint can appear in the next empty operand slot after a space or comma. The hint disappears as soon as you type an operand. Turn these hints off with `cocovs.inlayHints`.

CoCAS checks syntax after a short typing delay, including unsaved buffers and included modules. Errors appear in the editor and **Problems**. Set `cocovs.liveDiagnostics` to `false` to disable live assembler checks. Link errors are reported during a build.

F2 renames simple labels, `ext` declarations, exports, and source references across linked modules. CocoVS also checks sources referenced by cdmbot suites. Renaming stops for ambiguous references, conflicts, macro use that prevents safe analysis, or labels referenced in `setup.input`. Open a CocoVS or cdmbot project to rename exports across modules.

**Problems** can warn about stack imbalance on return paths and undocumented side effects in routines/macros. A result register declared with `@return` is considered documented. Analysis covers recognized instructions and static control flow for CdM-8 and CdM-16.

## Formatting

CoCAS sources are formatted on save by default with four spaces per indent level. Section headers such as `asect` and startup declarations such as `run main` remain at the outer level; routine bodies and structured blocks are indented. Inline comments align within adjacent groups. Blank lines, labels, and block boundaries separate groups. **Format Document** applies the same style manually.

**CocoVS: Create Formatter Configuration** creates or opens `cocovs-format.json` in the project root, or in the workspace/file folder without a project. Settings are read from the project or a containing formatter configuration within the workspace boundary. Missing options use defaults.

```json
{
  "formatOnSave": true,
  "indentSize": 4,
  "indentStyle": "spaces",
  "alignInlineComments": true,
  "commentColumn": 0
}
```

`indentStyle` accepts `spaces` or `tabs`. `commentColumn: 0` selects alignment automatically; a positive value specifies a minimum one-based column. Longer code moves comments farther right. `formatOnSave: false` disables save formatting while keeping manual formatting available. Formatting applies to CoCAS targets.

## Debugging and RAM

For CdM-8/CdM-16, use F5, **CocoVS: Debug**, or the entry-point CodeLens. Select **CocoVS CdM-8 / CdM-16** if asked for a debugger. The debugger supports breakpoints, source/instruction stepping, step into, and step out.

**CocoVS RAM** opens at the first stop with registers, flags, and memory. Changed bytes are highlighted. Click the **RAM** heading to collapse the table. On CdM-16, **Address** selects a 256-byte page. Open it manually with **CocoVS: Open RAM View**; `cocovs.openMemoryOnDebug` controls automatic opening.

Click **Split into tabs** in **CocoVS RAM**, or run **CocoVS: Split RAM View into Tabs**, to open **Registers**, **Data Labels**, and **Memory Grid** as separate editor tabs. Drag a tab into another editor group or, in VS Code 1.88 or later, outside the window to put it on another monitor. The tabs follow the active CocoVS debug session. Run **CocoVS: Open Debug Panel...** to reopen an individual tab or **CocoVS: Open RAM View** for the combined view.

In **Data labels**, search by name, directive (`dc`, `ds`, `db`, `dw`), or type. Pin labels to keep them visible; the triangle beside a value collapses an unpinned label. The **Type** column and tooltip show type, directive, and byte length. Each label has an action to open its declaration and a palette to color its memory. **Stack color** controls the stack pointer and active stack region. Colors are remembered for the project. In Harvard mode, ROM labels do not color RAM bytes.

A comment above a declaration selects its **Auto** display type:

```asm
# @type: str
text:
    dc "Hello World"
```

| Type | Display |
| --- | --- |
| `str` | UTF-8 text with escaped control characters |
| `u8`, `i8` | Unsigned and signed bytes |
| `u16`, `i16` | Unsigned and signed little-endian 16-bit words |
| `hex`, `bytes` | Hexadecimal bytes |

After `# @`, completion offers documentation tags; after `@type:`, display types. After `@param`, `@return`, `@returns`, or `@changed`, it suggests processor registers. **Format** changes the display for all labels. In Harvard mode, initialized constants are read from ROM and `ds` storage from RAM.

Use **CocoVS: Debug via CdM Processors** for an external Logisim debugger; its launch configuration supplies the circuit and server address. CdM-8e uses this external workflow. Refresh older generated CdM-16 profiles with **CocoVS: Generate Build and Debug Configuration**.

## Automated tests

cdmbot also provides project creation, builds, execution, source statistics, syntax analysis, and packages. Run **CocoVS: Install or Update cdmbot** to install the tool and enable its terminal command, then **Analyze Code with cdmbot**, **Create or Initialize Project**, or **Browse Assembly Packages**. See the [development-tool workflow](cdmbot-development.md). The Testing view supports legacy suites.

CocoVS discovers cdmbot `project.yaml` / `project.yml` manifests with a `suites` section in **Testing**. Run a project, suite, or case, with links to YAML locations. **Project checks** reports structure, syntax, and coverage thresholds; coverage needs a full project run.

**CocoVS: Create cdmbot Test Suite** generates a suite and smoke case. **CocoVS: Add cdmbot Test Case** adds a case. Edit inputs and assertions in YAML. `cocovs.cdmbotPythonPath` selects an environment with cdmbot; `cocovs.cdmbotJobs` controls concurrency. Follow the [testing guide](testing.md) for setup and complete examples.

## Custom processors and runners

The `custom` target delegates assembly and execution to your tools. The assembler must write output to `${image}`; the runner receives that file. Your tools define the format and circuit loading process.

```json
{
  "entry": "game.asm",
  "target": "custom",
  "instructions": ["load", "store", "draw", "jmp"],
  "imageExtension": ".bin",
  "assembler": {
    "command": "python",
    "args": ["${project}/tools/assemble.py", "--output", "${image}", "${sources}"]
  },
  "runner": {
    "command": "python",
    "args": ["${project}/tools/run_circuit.py", "${project}/game.circ", "${image}"]
  }
}
```

These scripts are placeholders for your assembler and circuit launcher. `${sources}` must be a separate argument; it expands to multiple input paths. Other placeholders include `${project}`, `${entry}`, `${image}`, `${debug}`, and `${combined}`. Paths with spaces are passed as individual arguments. For manual loading, run **CocoVS: Build** and load `build/out.bin` yourself.

## Development and publishing

For Node.js requirements, extension tests, VSIX packaging, and updating the existing Marketplace listing, see [development and publishing](development.md). Documentation-only changes do not require a version bump or new package.

Application dependencies belong in the `dependencies` object of `cdm-project.json`. Restore automatically migrates an existing `cdm-packages.json` after validation, retaining the exact revisions in `cdm-packages.lock.json`. The `languageVersion` field selects the toolchain compatibility profile, currently `"1.0"`. See the [manifest and compatibility workflow](cdmbot-development.md#assembly-compatibility).

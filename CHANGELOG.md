# Changelog

## 1.0.1

- Show a clickable reference count above code labels, data labels and macros, with references from linked files.

## 1.0.0

- Find references and browse call hierarchies across linked source files, including macro overloads and include chains.
- Show an inline argument hint only while the next operand slot is empty.
- Keep local references available when a linked external definition is missing, and select template names at the correct source position.
- Check all build output paths before replacing artifacts and keep recovery copies if a failed update cannot be rolled back.

## 0.9.9

- Show inline hints for the next empty argument of documented macros and instructions.
- Find references to assembly symbols and included files, and browse static calls and include chains in Call Hierarchy.

## 0.9.8

- Show the exact decimal value when hovering over a binary or hexadecimal literal in assembly source.

## 0.9.7

- Split the RAM view into movable Registers, Data Labels, and Memory Grid tabs that follow the active CocoVS debug session.
- Keep the RAM address and data label filter and format when VS Code recreates a panel's content.

## 0.9.6

- Clean up the emulator if debugging ends during startup.
- Keep package and analysis commands associated with the original file, including files outside the workspace.
- Allow project initialization to be retried if writing a template file fails.
- Run only the repository test suite, excluding build output and local checkouts.
- Exercise live CoCAS diagnostics in the VS Code Extension Host on all CI platforms.

## 0.9.5

- Store application dependencies in cdm-project.json and migrate legacy dependency manifests after a successful restore.
- Check languageVersion compatibility for projects and direct or transitive packages, including cached and native builds.
- Offer one Create or Initialize Project command with shared CLI templates for applications and libraries in new or existing folders.
- Bundle cdmbot 0.2.3 with unified manifests, transactional migration and compatibility profiles.

## 0.9.4

- Discover the Python interpreter embedded in Windows pip CoCAS launchers, including paths with spaces.
- Apply template compatibility fixes to live diagnostics when CoCAS is installed outside the managed environment.
- Verify template errors appear and clear for unsaved buffers in the VS Code Extension Host.

## 0.9.3

- Complete sizes (`Name._`) and qualified fields for any declared template, with hover documentation and definition navigation.
- Resolve CoCAS template constants in negative expressions and storage reservations during builds and syntax checks.
- Bundle cdmbot 0.2.2 with the same template compatibility correction for CLI builds and tests.

## 0.9.2

- Complete installed package names and source paths inside `@include`, including nested standalone files.
- Open package includes through Ctrl+Click and F12 using the same locked paths as the build.
- Show imported macro signatures, argument documentation, results and changed registers in completion and hover.
- Refresh library symbols and semantic highlighting when downloaded packages or their lock files change.

## 0.9.1

- Bundle cdmbot 0.2.1 and enable its terminal command in the user PATH during installation.
- Share application templates between Initialize Project and cdmbot create, including processor startup and smoke tests.
- Browse a Git-hosted catalog with one metadata folder per package, descriptions and publishers.
- Automatically restore packages referenced by existing `# @include "@name/file.asm"` directives on build and run.
- Support registry dependencies and package commands inside library projects while preserving exact lock files.

## 0.8.18

- Bundle cdmbot 0.2.0 with installation into private extension storage and development API detection.
- Add code analysis, project creation, and assembly package search/add/restore/update/remove commands.
- Use compatible cdmbot builds when available, retaining the original CoCAS backend and legacy test commands.
- Resolve locked `@package/path.asm` imports for applications, standalone files, completion, and diagnostics.

## 0.8.17

- Add three documented standalone CdM-8/CdM-16 examples and two multi-module projects with ten cdmbot cases.
- Demonstrate input injection, register and RAM assertions, preserved memory, stack checks, coverage and selected-case runs.
- Ship example READMEs and YAML test suites in the VSIX.
- Exclude generated example build outputs from the packaged assembly sources.

## 0.8.16

- Place standalone build artifacts beside the source file, in its local `build/` directory.
- Name the extension CocoVS — CdM Assembly and add CdM search keywords.
- Include editor and debugger screenshots in the README.
- Translate the debug CodeLens label and tooltip according to the VS Code display language (Russian or English).

## 0.8.15

- Remember processor and memory architecture per standalone assembly file; configure them on first launch or with Configure File Execution.
- Add a debug CodeLens above `run` entry labels and conventional entry names such as `main`, `start`, `program` and `init`.
- Launch the file selected by the debug CodeLens independently of the active editor.

## 0.8.14

- Keep section indentation after `run main`, including routine bodies and structured blocks.
- Highlight `run` as a directive in both syntax and semantic highlighting.

## 0.8.13

- Complete symbolic comparisons after `is`, `stays` and `until`, with explicit signed (`s`) and unsigned (`u`) variants that insert CoCAS condition codes.

## 0.8.12

- Show each data label and its type in the hover tooltip for every RAM byte it covers.
- Keep completion, hover and signature help available independently of live assembler diagnostics.
- Add a Show Assembly Suggestions command for use when a keyboard shortcut is unavailable.
- Show hover and parameter hints for documented instructions shared by CdM-8 and CdM-8e.
- Keep reporting local operand errors if the assembler's temporary directory cannot be created.
- Limit VSIX contents to the extension, documentation and examples.

## 0.8.11

- Use the same hover layout for CdM-8 and CdM-16 instructions, including all supported operand forms.

## 0.8.10

- Add instruction descriptions and operand syntax for CdM-16 and CdM-16e in hover and signature help.

## 0.8.9

- Fix the carry flag after CdM-8 `cmp` so unsigned conditions work in local execution and debugging.

## 0.8.8

- Show toolchain detection, installation and download progress in the CocoVS output, including CdM-16 debug Python, Cocoemu and JDK checks.

## 0.8.7

- Locate the Python environment behind CoCAS launchers and prepare a managed fallback for CdM-16 debugging.

## 0.8.6

- Register CocoVS build tasks before initializing the editor, testing and debugger memory view.
- Resolve workspace-level build tasks in single-folder workspaces.

## 0.8.5

- Added a full color picker for memory labels and the stack that fits within the debugger pane.
- Enabled automatic completion when opening assembly files and when typing in quoted include paths.

## 0.8.4

- Show syntax errors from unsaved CdM source files and their included modules in the editor and Problems view.
- Hide minimap headings generated from assembly folding markers.

## 0.8.3

- Added clearer CoCAS diagnostics with file and line information, including help for missing end directives and unresolved labels.
- Kept the original assembler output available without repeated diagnostics or terminal color codes.

## 0.8.2

- Filtered completions by instruction, operand type and comma-delimited position.
- Enabled quick suggestions for CdM Processors language modes and added a macOS completion shortcut.
- Replaced the system color picker with a palette that fits inside the debugger panel.
- Reject invalid operand counts and assembler error messages before replacing the previous successful build.
- Use the same local build and launch path for F5 and CocoVS: Debug.

## 0.8.1

- Added the transparent CocoVS robot mascot as the extension icon.
- Added repository and issue tracker metadata for the Marketplace listing.

## 0.8.0

- Added cdmbot suites, test cases and project checks to the Testing view.
- Added cross-module label renaming and diagnostics for stack imbalance and undocumented changes.
- Added RAM colors for data labels and the active stack.

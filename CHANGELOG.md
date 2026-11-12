# Changelog

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

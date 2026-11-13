<img src="media/icon.png" alt="CocoVS logo" width="128">

# CocoVS

CocoVS brings Coco-de-Mer assembly editing, CoCAS builds, source-level debugging, and a live RAM view to Visual Studio Code. It supports single assembly files, projects with multiple source files, and custom processors.

## Features

- Complete mnemonics, operands, macros, labels, and `@include` paths. View instruction signatures and documentation as you edit.
- Format assembly, jump to definitions, rename linked labels, and see CoCAS diagnostics in the **Problems** panel.
- Build and run programs through CoCAS. Use `cdm-project.json` to configure the target, memory architecture, and source files for a project.
- Step through CdM-8 and CdM-16 source, set breakpoints, and inspect registers, the stack, and RAM. Hover over a RAM byte to see its address, value, and any data labels with their types.
- Run cdmbot test suites from the VS Code **Testing** view.

## Quick start

1. Install **CocoVS** from the VS Code Extensions view. For a downloaded package, use **Extensions: Install from VSIX...**.
2. Open or save an `.asm` file, or open the [multi-file example](examples/multi-file).
3. Select **CocoVS: Run** in the Command Palette, or press **F5** to debug. CocoVS can set up the required tools when prompted. Building and running require a trusted workspace.

```asm
asect 0
start:
    ldi r0, 42
    halt
end
```

Use `example.cdm16.asm` to select CdM-16 for a standalone file. For a plain `.asm` file, the **CocoVS: Target** setting supplies the default when the project and language mode do not specify a target.

### Assembly suggestions on macOS

If another extension selects a different language for `.asm` files, use **Change Language Mode** and select **CocoVS Assembly**. Press **Cmd+Shift+.** or run **CocoVS: Show Assembly Suggestions** from the Command Palette. Mnemonic completion, hover documentation, and signature help work without a toolchain. Install CoCAS to enable assembler diagnostics.

## Processor support

| Target | Run | Debug |
| --- | --- | --- |
| CdM-8 | Built-in emulator | Built-in debugger |
| CdM-8e | Project runner | CdM Processors |
| CdM-16 | Cocoemu | Built-in debugger |
| CdM-16e | Cocoemu | Project tools |
| Custom processor | Project runner | Project tools |

CocoVS runs in desktop VS Code on Windows, macOS, and Linux. Automatic toolchain setup supports x64 and ARM64. See the [Russian user guide](docs/guide.md) and [changelog](CHANGELOG.md).

## Development

Use Node.js 22 or later.

```sh
npm ci
npm test
npm run package
```

Set `COCOVS_INTEGRATION=1` to run tests with CoCAS, cdmbot, and Cocoemu. The [user guide](docs/guide.md) includes toolchain and Marketplace publishing instructions.

Licensed under [MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.txt).

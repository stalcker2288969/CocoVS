# Development and publishing

This page covers the extension itself. To assemble or test a CdM program, see the [user guide](guide.md), [testing guide](testing.md), and [examples](../examples/README.md).

## Source setup

Use Node.js 22 or later and npm. From the repository root:

```sh
npm ci
npm test
```

The extension uses JavaScript directly; no TypeScript compilation step is required. Repeat `npm ci` after dependency changes. Documentation-only edits do not require a version bump or new VSIX.

## Tests

`npm test` uses Node's test runner. Integration tests are disabled by default. To enable them, provide CoCAS, compatible Python, Cocoemu, and JDK 17+, then set `COCOVS_INTEGRATION=1`.

| Variable | Purpose |
| --- | --- |
| `COCOVS_PYTHON` | Python executable for installed tools and cdmbot discovery |
| `COCOVS_COCAS` | CoCAS executable |
| `COCOVS_JAVA` | Java executable from a JDK |
| `COCOVS_JAR` | Cocoemu server JAR |
| `COCOVS_SKIP_CDMBOT` | Set to `1` to skip tests requiring cdmbot |
| `COCOVS_TEST_TEMP` | Existing directory for temporary test fixtures |

Example in PowerShell, after configuring the tools:

```powershell
$env:COCOVS_INTEGRATION = '1'
npm test
```

The examples have a focused integration check:

```sh
node --test --test-concurrency=1 test/examples.test.js
```

This also uses `COCOVS_INTEGRATION`. It checks outputs and stack state, runs cdmbot suites and selected cases, and verifies detection of an incorrect expectation. cdmbot's CdM-16 backend also needs a discoverable JDK, for example through `JAVA_HOME`.

### VS Code Extension Host

To test editor APIs in a real VS Code instance:

```sh
npm install --no-save --package-lock=false @vscode/test-electron@2.5.2
npm run test:host
```

`COCOVS_VSCODE` selects an installed executable. Otherwise the runner downloads VS Code; `COCOVS_VSCODE_VERSION` selects its version. On Linux without a display, use `xvfb-run -a npm run test:host`.

The [CI workflow](../.github/workflows/ci.yml) runs on Windows, macOS, and Linux, sets up Node/Python/Java, runs tests, and uploads a VSIX from its Linux job. Its current configuration skips tests requiring cdmbot.

## Package a release

For an extension update, choose the requested version or increment the patch version. Keep `package.json`, `package-lock.json`, and `CHANGELOG.md` consistent.

```sh
npm version patch --no-git-tag-version
npm test
npm run package
```

`npm run package` runs `vsce package --no-dependencies` and writes `cdm-project-tools-<version>.vsix` in the repository root. If npm is unavailable but dependencies are installed:

```sh
node node_modules/@vscode/vsce/vsce package --no-dependencies
```

The `files` allowlist in `package.json` controls package contents. Include docs, source modules, YAML suites, and screenshots, excluding generated example `build/` outputs. Check the archive's version and changed files before sharing it.

Install with **Extensions: Install from VSIX...**, or replace `<version>` in this CLI example with the actual version:

```sh
code --install-extension ./cdm-project-tools-<version>.vsix --force
```

Reload the window if VS Code requests it.

## Update the Marketplace listing

The public title comes from `displayName` in `package.json`; the short description and tags come from `description` and `keywords`. The README supplies the Details page. Local edits or local VSIX installation do not publish changes to other users.

Build and verify a release, then open [Marketplace publisher management](https://marketplace.visualstudio.com/manage). Select publisher `cdm-project-community` and update the existing extension with the new VSIX. Keep `name` and `publisher` to update the same listing.

With the public GitHub `repository` setting, vsce rewrites relative README image/content links to GitHub URLs. Push linked docs and screenshots to the referenced branch before relying on those URLs in the published listing.

See the official [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for authentication and Marketplace requirements.

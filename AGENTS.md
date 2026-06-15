# Parcel AI Agent Instructions

## Build, test, and lint commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Build the shared extension bundle | `make extension` | Runs `make -C src`, formats source with Prettier, and writes generated assets to `src/dist/`. |
| Build the Chrome bundle | `make chrome` | Rebuilds `src/dist/` and syncs it into `chrome/`. |
| Build the Firefox bundle | `make firefox` | Rebuilds `src/dist/`, syncs it into `firefox/`, rewrites the manifest for Firefox, and switches module content scripts to the `.es6.js` shim. |
| Format source | `make prettier` | Formats `test/*.{js,json}` and then runs `make -C src prettier`, which writes all `src/**/*.{js,json,less,css,html,xhtml}`. |
| Clean generated artifacts | `make clean` | Removes `src/dist/`, `chrome/`, `firefox/`, and top-level `dist/`. |
| Run all tests | `make test` | Runs the full test suite with `node --test` across all `test/*.test.js` files (browser mock, helpers, native host, plaintext, schema, selectors, targets). |
| Run individual test groups | `make test-native`, `make test-browser-mock`, `make test-modules`, `make test-application`, `make test-syntax` | Native-host integration tests; Chrome-API mock tests; shared-module unit tests; application tests; syntax tests respectively. |

Do not use `src/publicsuffix` as Parcel test guidance unless the task explicitly targets that vendored subtree.

## High-level architecture

- `src/` is the canonical source tree. `src/dist/`, `chrome/`, and `firefox/` are generated outputs; edit source files under `src/`, not generated bundles.
- The browser-side runtime is split into three main pieces:
  - `src/js/agent.js` is the MV3 background/service-worker coordinator. It owns native messaging, bootstraps the native host, validates config with `ConfigSchema`, caches entry lists, and brokers runtime ports.
  - `src/js/integration.js` is the content script injected into all frames at `document_start`. It detects fill targets, opens the inline/context popup, fills fields, and handles the broadcast "best target" autofill path.
  - `src/js/popup.js` is the toolbar/context popup UI. It requests matches and decrypted plaintext from the background worker, relays fill commands back into the active frame, and stores per-origin/per-container history in `chrome.storage.local`.
- Shared behavior lives in `src/js/helpers.js`, `src/js/plaintext.js`, `src/js/schema.js`, `src/js/selectors.js`, and `src/js/targets.js`. The intended config extension points are `additionalSelectors` and `additionalTargets`.
- Shadow DOM support is deliberate: `src/js/shadow.js` patches `attachShadow`, and cross-shadow lookups are expected to go through `Helpers.shadowSelector()` / `Helpers.shadowSelectorAll()`.
- The native side is split in two:
  - the repo-root `parcel-host` bootstrap host, which verifies signatures and loads the bundled script,
  - `src/parcel-host`, the signed host implementation that reads `~/.password-store`, filters entries against `.parcel.json`, and decrypts only paths that were previously whitelisted by `action_list`.
- Tests live under `test/` and exercise both Node-side modules (using direct `import`) and the native host (using isolated temporary environments with mocked GPG). A reusable Chrome API mock lives in `test/chrome-api-mock.js` to support testing extension-facing code in Node.

## Key conventions

- Follow `CONSTITUTION.md` when making architectural choices: no third-party runtime/build dependencies, no transpilation or bundling that obscures shipped source, no compiled native host, no network access, and no user-file writes outside the host's own config/log bootstrap behavior.
- Preserve source/distribution parity. The maintained JS/HTML/CSS in `src/` is meant to stay close to what ships, so avoid introducing build tooling that transforms the code into a materially different artifact.
- Keep browser portability explicit. Firefox-specific behavior is handled in packaging (`Makefile`) and tiny shims like `src/js/integration.es6.js`; do not fork large logic files just for Firefox.
- Extend config-driven behavior through the schema-backed selector/target system before adding ad hoc special cases. New fill/extraction behavior should usually mean updating `targets.js`, `selectors.js`, and the schemas/defaults that validate them.
- Treat `src/publicsuffix` as a vendored upstream subtree. Ignore it for normal Parcel work unless the task is specifically about PSL data or its tooling.
- Run `make prettier` after making any changes to ensure that they comply with the project's formatting conventions.
- Always verify that the full `make test` suite passes before considering a task complete.

## Security considerations

- The most critical constraints are documented in `CONSTITUTION.md`.
- A more detailed overview of the security model, threat surface, and mitigations can be found in `SECURITY.md`.
- The results of security reviews are summarised in `security-review/findings.md`, with individual reports available in the `security-review/reviews` subdirectory.

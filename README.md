# Parcel

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE.md)

Parcel is a browser extension that securely searches, displays, and automatically fills credentials from a [pass](https://www.passwordstore.org/)-style password store directly into web forms. It complements `pass`; it does not replace it.

Parcel is designed with security as its highest priority: the extension has **no network access**, **no third-party dependencies**, and **no compiled native host**. All communication between the browser and your GPG-encrypted password store happens through a signed, auditable bash native-messaging host. Further details are available in [SECURITY.md](SECURITY.md).

---

## Features

- **Native `pass` integration** — Works with your existing `~/.password-store` without modifying files or imposing a new data format.
- **Secure native-messaging host** — A plaintext bash host script, signed and verified with GPG before every execution. The browser extension is *incapable* of reading non-whitelisted files, even if fully compromised.
- **Fully auditable** — The code that runs in your browser is identical to the code in this repository, and fully available for inspection. There are no packing, minification etc. tools used in the build process.
- **Heuristic autofill** — One-click fill from the toolbar popup, to fill the most likely target. Alternatively, click on the desired field to fill from the inline popup for precise control.
- **Shadow DOM support** — Full support for modern web components and shadow roots.
- **Cross-browser** — Supports both Chrome (Manifest V3) and Firefox with a unified source tree.
- **Zero network access** — No telemetry, no analytics, no update checks, no external services.
- **Container/tab isolation** — Per-origin history isolation, with support for Firefox Multi-Account Containers.
- **Read-only by design** — Parcel never creates, edits, or deletes password store files.

---

## Architecture

Parcel is split into two halves:

1. **Browser extension** (`src/`) — Injected content scripts, a background service worker, and a popup UI. Built with vanilla JavaScript, HTML, and CSS; no transpilers or bundlers.
2. **Native host** (`parcel-host` + `src/parcel-host`) — A GPG-signed bash bootstrap (`parcel-host`) that verifies and loads the main host script (`src/parcel-host`), which reads, filters, and decrypts password entries.


### Prerequisites

- **jq** >= 1.5
- **gpg** >= 2.2.20
- An existing `pass`-style password store

If you wish to run the test suite, you will also need the following:

- **Node.js**
- **JSDom** and **Prettier** (`npm install`)

### Key components

| File | Role |
|------|------|
| `src/js/agent.js` | Background service worker. Manages native messaging, config validation, entry caching, and runtime port brokering. |
| `src/js/integration.js` | Content script injected at `document_start`. Detects fill targets, opens inline/context popups, and handles autofill. |
| `src/js/popup.js` | Toolbar and context-popup UI. Requests matches and decrypted credentials from the agent, relays fill commands. |
| `src/js/helpers.js` | Shared utilities, including shadow-DOM selectors and cross-frame helpers. |
| `src/js/schema.js` | Schema–based validation for configuration, selectors, and targets. |
| `src/js/selectors.js` | DOM selectors for detecting login, password, TOTP, and other credential fields. |
| `src/js/targets.js` | Field-target bindings that map credentials to detected form fields. |
| `src/js/shadow.js` | Patches `attachShadow` to ensure cross-shadow lookups work correctly. |
| `src/parcel-host` | Signed bash script that reads `~/.password-store`, filters against `.parcel.json`, and decrypts whitelisted entries. |
| `parcel-host` | Bootstrap host that verifies GPG signatures and launches `src/parcel-host`. |

---

## Installation from source

Parcel would normally be installed directly from the Chrome or Mozilla addon webstores. However, if you would prefer to install your own local copy, please follow the steps below.

If you do install directly from source, please be aware that you will not receive automatic updates, and Parcel cannot notify you of new releases. It is recommended that you subscribe to release notifications from this repository so that you can update manually as needed.

### Build the extension

```bash
# Build everything (shared bundle + Chrome + Firefox)
make all

# Build only the Chrome extension
make chrome

# Build only the Firefox extension
make firefox

# Clean generated artifacts
make clean
```

### Load into the browser

**Chrome:**
1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select the `chrome/` directory.

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select `firefox/manifest.json`.

### Install the native host

Parcel uses a native-messaging host to communicate with `gpg` and your password store. The bootstrap host (`parcel-host`) must be registered with your browser and placed somewhere on your `$PATH` (or referenced absolutely in the host manifest).

See your browser's native-messaging documentation for manifest location details:
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)

The first time the bootstrap host runs, it creates a default configuration file at `~/.config/parcel/parcelrc` if one does not already exist. You can customize `gpg` and `jq` paths, valid signers, and other options there.

### Configure entry visibility

Create a `.parcel.json` file at the root of your password store (`~/.password-store/.parcel.json`) to control which entries Parcel can see. If this file is absent, all entries are visible.

Example:

```json
{
  "rules": [
    { "pattern": "websites/.*" },
    { "pattern": "work/.*" },
    { "pattern": "temp/.*", "ignore": true }
  ]
}
```

---

## Usage

1. Click the **Parcel toolbar icon** (or press `Ctrl+Shift+F` / `Cmd+Shift+F`) to open the popup.
2. Search for the credential you want to fill.
3. Click an entry to trigger **heuristic autofill** into the best-matching form field on the page.
4. For more precise control, click directly on the field that you wish to fill, and Parcel will display an inline popup to allow you to select the desired credential.

---

## Configuration

Parcel uses two separate configuration files: one for the bootstrap host environment (`parcelrc`), and one for the main host script and extension behaviour (`.parcel.json`).

### parcelrc

`parcelrc` is a bash startup script read by the bootstrap host (`parcel-host`) before it enters its main loop. This sets environment-level options such as binary paths and signer trust.

**Location:** `~/.config/parcel/parcelrc`
If this file does not exist, the bootstrap host creates a commented template on first run.

| Option | Default | Description |
|--------|---------|-------------|
| `VALID_SIGNERS` | Release signing keys | Space-separated list of GPG key fingerprints that are trusted to sign the main host script. |
| `PATH` | Inherited | Additional directories to prepend to the host's `PATH` (e.g. `/opt/homebrew/bin` on macOS). |
| `GPG` | `gpg` | Path to the GPG binary. |
| `JQ` | `jq` | Path to the `jq` binary. |
| `LOGFILE` | `~/.local/log/parcel-host.log` | Destination for host error and audit logging. Plaintext credentials are never written here. |
| `PASSWORD_STORE_DIR` | `~/.password-store` | Root directory of your `pass` password store. |
| `HOST_HASH` | *(none)* | Optional SHA-256 hash of the main host script. When set, the bootstrap host will refuse to execute updated scripts until you update this value after review. |

Example `parcelrc`:

```bash
VALID_SIGNERS="88FF14D6294AF4036B7F00FF676A3C09E2E47A72"
PATH="$PATH:/opt/homebrew/bin"
GPG="gpg"
JQ="/usr/local/bin/jq"
LOGFILE="$HOME/.local/log/parcel-host.log"
PASSWORD_STORE_DIR="$HOME/.password-store"
HOST_HASH="b7b76abadd3f13e6bcf554c39547d44ae19a299c8fc2e73ae8cbccd9a34d9b40"
```

### .parcel.json

`.parcel.json` is a JSON file read by the main host script (`src/parcel-host`). It controls which password entries are visible to Parcel, how they are displayed, and several extension-level behaviours. The file is reloaded automatically when it changes.

**Location:** `$PASSWORD_STORE_DIR/.parcel.json`
If absent, the host treats it as `{}` and injects a default `rules` array of `[{ "pattern": "." }]` (i.e. all entries visible).

#### Rules

The `rules` array controls which password-store entries Parcel can see. Rules are evaluated in order: an entry is visible if it matches at least one non-ignored include pattern and does not match any ignore pattern.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `pattern` | string (regex) | *required* | Regex matched against the entry name (relative to the store root, without `.gpg`). |
| `ignore` | boolean | `false` | If `true`, entries matching this rule are excluded. |
| `class` | string | `"login"` | Classification of the entry (only `"login"` is currently supported). |
| `color` | string | `"333333"` | Hex colour for the entry's tag in the popup. |
| `tag` | string | *(none)* | Optional label shown next to the entry in the popup. |
| `strip` | string (regex) | *(none)* | Regex matching portions of the entry name to hide in the popup. |

#### Other options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `allowLinks` | boolean | `false` | If `true`, includes symlinked password entries in the entry list. |
| `allowExternalLinks` | boolean | `false` | If `true` (and `allowLinks` is also `true`), includes symlinks that point outside the password store directory. |
| `auditDecrypt` | boolean | `false` | If `true`, logs every decryption attempt (success or failure) to the host log file. |
| `cacheTTL` | number | `10` | Seconds the extension caches the entry list before re-querying the host. |
| `decryptTimeout` | number | `60` | Seconds before a decryption request is aborted. |
| `decryptBucket` | integer | `24` | Token-bucket capacity for decryption rate limiting (one token per GPG decrypt). |
| `decryptRate` | number | `0.006667` (24 per hour) | Token refill rate in tokens per second for decryption rate limiting. |
| `disableContextPopup` | boolean | `false` | If `true`, disables the inline / context popup. |
| `fillRelated` | boolean | `true` | If `true`, automatically fills related fields (e.g. username when filling password). |
| `historyLength` | integer | `40` | Maximum number of recent entries to keep in per-origin history. |
| `saveHistory` | boolean | `true` | If `true`, remembers recently used entries per origin. |
| `additionalSelectors` | array | *(none)* | Custom DOM selectors to augment or override built-in field detection. |
| `additionalTargets` | array | *(none)* | Custom target mappings for extracting and filling credential data. |
| `targets` | array | Built-in set | Complete replacement for the built-in target extraction rules. |

Example `.parcel.json`:

```json
{
  "rules": [
    { "pattern": "websites/.*" },
    { "pattern": "work/.*", "tag": "work", "color": "0055aa" },
    { "pattern": "archive/.*", "ignore": true }
  ],
  "auditDecrypt": true,
  "cacheTTL": 30,
  "saveHistory": true,
  "historyLength": 20
}
```

---

## Contributing

We welcome contributions! Please see [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidelines.

---

## License

Parcel is released under the [ISC License](LICENSE.md).

```
Copyright (c) 2025-2026 Erayd LTD
```

---

## Governance

Parcel is maintained by Steve Gilberd and Max Baz. Official releases are signed with one of the following GPG keys:

- Steve Gilberd: `88FF14D6294AF4036B7F00FF676A3C09E2E47A72`
- Max Baz: `56C3E775E72B0C8B1C0C1BD0B5DB77409B11B601`
- Parcel release signing key #1: `82ED663067C6017BAA4BC752EB670BF2B1131683`
- Parcel release signing key #2: `B0908ED59A96C9882BED9A942A51761511A30253`

See [`CONSTITUTION.md`](CONSTITUTION.md) for governance details and amendment procedures.



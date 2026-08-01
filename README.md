# ![Parcel](https://github.com/user-attachments/assets/baadf80e-a3cf-4f5a-a408-b66712c24d64)

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE.md)
[![Install on Mozilla Firefox](https://img.shields.io/badge/Install-Firefox-FF7139.svg?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-GB/firefox/addon/parcel-pm/)
[![Install on Google Chrome](https://img.shields.io/badge/Install-Chrome-4285F4.svg?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/parcel/ciifpadakeohfnnneflckhojbldkkllp)

Parcel is a browser extension that securely searches, displays, and automatically fills credentials from a [pass](https://www.passwordstore.org/)-style password store directly into web forms. It complements `pass`; it does not replace it.

Parcel is designed with security as its highest priority: the extension **does not access the network**, has **no third-party dependencies**, and uses a **plaintext native host**. All communication between the browser and your GPG-encrypted password store happens through a signed, auditable bash native-messaging host. Further details are available in [SECURITY.md](SECURITY.md).

![Popup UI demo](https://github.com/user-attachments/assets/f758380e-96fd-4710-bf70-2f0a72101d25)

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
- **TOTP / 2FA autofill** — Generate and fill RFC 6238 TOTP codes from a base32 secret or `otpauth://` URI stored in a pass entry.
- **Passkey (WebAuthn / FIDO2) support** — Register and authenticate with ES256 passkeys whose private keys live in GPG-encrypted pass entries and never enter the browser.

---

## Architecture

Parcel is split into two halves:

1. **Browser extension** (`src/`) — Injected content scripts, a background service worker, and a popup UI. Built with vanilla JavaScript, HTML, and CSS; no transpilers or bundlers.
2. **Native host** (`parcel-host` + `src/parcel-host`) — A GPG-signed bash bootstrap (`parcel-host`) that verifies and loads the main host script (`src/parcel-host`), which reads, filters, and decrypts password entries.


### Prerequisites

- **jq** >= 1.5
- **gpg** >= 2.2.20
- **openssl** >= 1.1.1 (for passkey support)
- An existing `pass`-style password store

If you wish to run the test suite, you will also need the following:

- **Node.js**
- **JSDom** and **Prettier** (`make install-deps`)

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
| `src/js/main-world/shadow.js` | Patches `attachShadow` to ensure cross-shadow lookups work correctly. |
| `src/js/webauthn.js` | Shared passkey helpers: base64url codecs, a minimal CBOR encoder, and builders for clientDataJSON / attestation structures. |
| `src/js/main-world/webauthn.js` | MAIN-world interceptor for `navigator.credentials.create` / `.get`, bridging WebAuthn ceremonies into the extension with a native fallback. |
| `src/parcel-host` | Signed bash script that reads `~/.password-store`, filters against `.parcel.json`, and decrypts whitelisted entries. |
| `parcel-host` | Bootstrap host that verifies GPG signatures and launches `src/parcel-host`. |

---

## Installation

The easiest way to install Parcel is directly from your browser's webstore:

- **[Mozilla Firefox — Parcel](https://addons.mozilla.org/en-GB/firefox/addon/parcel-pm/)** (recommended)
- **[Google Chrome — Parcel](https://chromewebstore.google.com/detail/parcel/ciifpadakeohfnnneflckhojbldkkllp)** (recommended)

After installing from the webstore, you will still need to set up the [native host](#install-the-native-host) and [configure entry visibility](#configure-entry-visibility). Skip to those sections now.

> **Note:** If you install from the webstore you will receive automatic updates. If you prefer to run a local build from source, follow the steps below instead.

### Installation from source

If you would prefer to install your own local copy, please follow the steps below.

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

Example host manifests for both browsers are provided in the `example/` directory (`com.github.erayd.parcel.chrome.json` and `com.github.erayd.parcel.firefox.json`). Copy the relevant one to your browser's native-messaging directory, adjust the `path` to point at your installed `parcel-host` binary, and rename it to `com.github.erayd.parcel.json`.

The first time the bootstrap host runs, it creates a default configuration file at `~/.config/parcel/parcelrc` if one does not already exist. You can customize `gpg` and `jq` paths, valid signers, and other options there.

> **Note:** If you use **Chromium Snap** or a **Flatpak** browser, the standard setup above will not work because the browser runs in a sandbox. See [Using Parcel with Chromium Snap & Flatpak browsers](#using-parcel-with-chromium-snap--flatpak-browsers) for container-specific instructions. Firefox Snap works with the standard setup.

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
| `HOST_HASH` | *(none)* | Optional SHA-256 hash of `src/parcel-host` (run `sha256sum src/parcel-host`). When set, the bootstrap host will refuse to execute updated scripts until you update this value after review. |

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

**Location:** `$PASSWORD_STORE_DIR/.parcel.json` If absent, the host treats it as `{}` and injects default rules of `[{ "pattern": "^passkeys/", "class": "passkey" }, { "pattern": "." }]` (passkey entries under the default `passkeyDir` are classed as passkeys; everything else is visible as logins).

*Note that if you do not configure a `passkey` rule, you will not be able to log in using passkeys.*

#### Rules

The `rules` array controls which password-store entries Parcel can see. Rules are evaluated in order: an entry is visible if it matches at least one non-ignored include pattern and does not match any ignore pattern.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `pattern` | string (regex) | *required* | Regex matched against the entry name (relative to the store root, without `.gpg`). |
| `ignore` | boolean | `false` | If `true`, entries matching this rule are excluded. |
| `class` | string | `"login"` | `"login"` (fillable credential) or `"passkey"` (WebAuthn credential, excluded from filling; see [Passkeys](#passkeys-webauthn--fido2)). `"browser-passkey"` is a site-policy rule (not an entry class) that defers a site's ceremonies to the browser (see [Passkey conflicts](#passkey-conflicts-with-other-password-managers)). |
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
| `gitInPasskeyCommand` | boolean | `false` | If `true`, the save command shown when creating a passkey includes a `git add` and `git commit` for the new entry. |
| `historyLength` | integer | `40` | Maximum number of recent entries to keep in per-origin history. |
| `handlePasskeys` | boolean | `true` | If `false`, disables passkey support entirely. |
| `passkeyDir` | string | `passkeys` | Directory under which passkey entries are created (see [Passkey entry format](#passkey-entry-format)), and classed as `passkey` by the default rules. |
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

## Using Parcel with Chromium Snap & Flatpak browsers

Chromium installed via **Snap** and browsers installed via **Flatpak** run in isolated containers. This means the browser cannot directly see or execute the native host binary, your `~/.password-store` directory, or `gpg` on the host system.

The Flatpak solution below uses `flatpak-spawn` to cause `parcel-host` to run **on the host system** — not inside the sandbox. This means all of Parcel's existing security protections (GPG signature verification, whitelist enforcement, rate limiting, audit logging) apply unchanged.

### Flatpak browsers (Firefox, ungoogled-chromium, Brave, etc.)

Flatpak browsers can use `flatpak-spawn --host` to launch `parcel-host` on the host system. An example wrapper script is provided in `example/parcel-flatpak-wrapper.sh`.

**Setup steps:**

1. Install `parcel-host` on the host system as per the [standard instructions](#install-the-native-host).

2. Create a directory inside the Flatpak browser's visible config:

   ```bash
   # Example for Firefox Flatpak — replace the app ID for other browsers
   APP_ID="org.mozilla.firefox"
   mkdir -p ~/.var/app/$APP_ID/config/parcel
   ```

3. Copy the wrapper script into this directory and make it executable:

   ```bash
   cp example/parcel-flatpak-wrapper.sh \
       ~/.var/app/$APP_ID/config/parcel/parcel-flatpak-wrapper.sh
   chmod +x ~/.var/app/$APP_ID/config/parcel/parcel-flatpak-wrapper.sh
   ```

   If `parcel-host` is not in the default `PATH` on your host, edit the wrapper and set `PARCEL_HOST_PATH` to the full path (e.g. `/usr/local/bin/parcel-host`).

4. Grant the Flatpak browser permission to talk to the host via `flatpak-spawn`:

   ```bash
   flatpak override --user --talk-name=org.freedesktop.Flatpak $APP_ID
   ```

   You can also do this graphically using [Flatseal](https://flathub.org/apps/com.github.tchx84.Flatseal) — add `org.freedesktop.Flatpak` to the **Session Bus Talk Names** list (there is no need to enable the D-Bus session bus socket itself).

5. Create the native messaging manifest in the browser's config directory. The location and template file depend on the browser:

   ```bash
   # Firefox Flatpak:
   MANIFEST_DIR=~/.var/app/$APP_ID/.mozilla/native-messaging-hosts
   MANIFEST_TEMPLATE=example/com.github.erayd.parcel.flatpak.firefox.json

   # Chromium-based Flatpak (ungoogled-chromium, Brave, etc.):
   # MANIFEST_DIR=~/.var/app/$APP_ID/config/chromium/NativeMessagingHosts
   # MANIFEST_TEMPLATE=example/com.github.erayd.parcel.flatpak.chrome.json

   mkdir -p "$MANIFEST_DIR"
   cp "$MANIFEST_TEMPLATE" \
       "$MANIFEST_DIR/com.github.erayd.parcel.json"
   ```

6. Edit the manifest: replace `USER` with your username and `BROWSER_APP_ID` with your browser's Flatpak app ID (e.g. `org.mozilla.firefox` for Firefox, `io.github.ungoogled_software.ungoogled_chromium` for ungoogled-chromium). The `path` field should point to the wrapper script created in step 3. Separate manifest templates are provided for Firefox and Chrome.

7. Restart the browser and install the Parcel extension.

### Chromium Snap

The Chromium Snap does **not** support native messaging — it does not implement the xdg-desktop-portal WebExtensions portal, and there is no mechanism for the browser to launch the host binary on the system outside the sandbox ([Launchpad bug 1741074](https://bugs.launchpad.net/ubuntu/+source/chromium-browser/+bug/1741074)).

Until Snap upstream adds native messaging support for Chromium, the recommended alternatives are:

- **Use the Flatpak version** of Chromium or another Chromium-based browser (see [Flatpak browsers](#flatpak-browsers-firefox-ungoogled-chromium-brave-etc) above).
- **Use a `.deb`-installed browser** instead of the Snap (e.g. `apt install google-chrome-stable` or switch to a PPA).

---

## TOTP / 2FA support

Parcel can generate time-based one-time passwords (TOTP, [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238)) from a secret stored in a pass entry and fill them into the page's OTP input field — just like a regular password. Token generation uses the browser's built-in [WebCrypto API](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) (HMAC-SHA1); no third-party library is involved.

### Storing a TOTP secret

Parcel recognises TOTP secrets in two formats:

**1. Raw base32 secret**

Store the base32 secret on its own line prefixed with one of the recognised keywords (`totp:`, `otp:`, `otc:`, `code:`, `2fa:`, `authenticator:`, `two-factor:`, `two_factor:`):

```
myAmazingPassword
login: user@example.com
totp: JBSWY3DPEHPK3PXP
```

**2. `otpauth://` URI**

Store a standard [otpauth](https://github.com/google/google-authenticator/wiki/Key-Uri-Format) URI. This is the format exported by most authenticator apps:

```
myAmazingPassword
login: user@example.com
totp: otpauth://totp/Example:user?secret=JBSWY3DPEHPK3PXP&period=30&digits=6
```

When an `otpauth://` URI is detected, Parcel extracts the `secret`, `period`, and `digits` parameters to generate the token. The `secret` parameter is required; `period` defaults to `30` and `digits` defaults to `6`.

### How it works

| Step | What happens |
|------|--------------|
| **Field detection** | Built-in selectors match common TOTP input fields. |
| **Secret extraction** | The `totp` target pattern reads the secret from the pass entry's plaintext. If the entry contains an `otpauth://` URI, the `totp-url` fallback target is used instead, which parses the URI for parameters. |
| **Token generation** | `Helpers.generateTOTP()` computes the HMAC-SHA1-based TOTP using WebCrypto, returning the token along with timing metadata (`refreshAt`, `generatedAt`, `interval`). |

---

## Passkeys (WebAuthn / FIDO2)

Parcel can act as a passkey authenticator for websites. Passkey private keys are stored in GPG-encrypted pass entries and are **never** exposed to the browser — the extension forwards ceremony requests to the native host, which performs the cryptography with `openssl` and returns only the signature (or, for new credentials, the newly generated public key).

### How it works

| Step | What happens |
|------|--------------|
| **Interception** | A small MAIN-world script (`src/js/main-world/webauthn.js`) intercepts `navigator.credentials.create()` / `.get()` calls for `publicKey` credentials. If Parcel cannot handle the request (support disabled, ceremony unsupported, or consent declined), the call falls back to the browser's native implementation. |
| **Consent popup** | Every ceremony requires explicit consent: an inline popup shows the requesting site's origin and the passkey entries registered for its relying-party ID. No signature is ever produced without you selecting a credential. |
| **Cryptography** | The native host decrypts the chosen passkey entry (whitelist and rate-limit-gated like any other decryption) and signs the assertion with `openssl`. The private key material stays on the host side. |
| **Response** | The extension assembles the WebAuthn credential object (with a real CBOR attestation for registrations) and returns it to the page. |

User verification is reported to the site as satisfied: consent is given interactively, and decryption itself requires your GPG key passphrase (or PIN/biometric via your GPG agent).

### Passkey entry format

Passkeys live under `<passkeyDir>/<rpId>/<account>.gpg` in your password store (`passkeys/<rpId>/<account>.gpg` with the default `passkeyDir` configuration):

```
#!parcel-passkey v1
rpId: example.com
credentialId: <base64url>
algorithm: ES256
userHandle: <base64url>
userName: alice
userDisplayName: Alice A
publicKey: <128 hex chars; uncompressed P-256 x||y coordinates>
privateKey:
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

The host validates the `#!parcel-passkey v1` marker, the `rpId` (which must match the requesting site's relying-party ID), and any `allowCredentials` restriction sent by the site before signing.

External storage is supported via symlinks: point `passkeyDir` at a symlink's in-store location (subject to the `allowLinks` / `allowExternalLinks` policy). A `passkeyDir` containing literal `..` segments names entries the store scan can never list, so such passkeys can be created but not used for assertions.

### Registering a new passkey

When a site asks to create a passkey, Parcel generates a fresh ES256 keypair on the host, encrypts a complete `#!parcel-passkey v1` entry to the recipients of the applicable `.gpg-id` file (walking up from the suggested directory, exactly like `pass` does), and displays the armored result in the popup along with the suggested entry path.

Parcel **never writes to your password store** — you save the entry yourself, out-of-band. The popup shows a complete, self-contained shell command (`mkdir -p` plus a quoted heredoc) which you can review, copy and run verbatim:

```bash
mkdir -p '/home/user/.password-store/passkeys/example.com' && cat > '/home/user/.password-store/passkeys/example.com/alice.gpg' <<'PARCEL_PASSKEY_EOF'
-----BEGIN PGP MESSAGE-----
... armored entry content ...
-----END PGP MESSAGE-----
PARCEL_PASSKEY_EOF
```

The **Copy command** button copies the whole snippet. Alternatively, click **Download .gpg file** and move the downloaded file into place, e.g. `mv ~/Downloads/alice.gpg ~/.password-store/passkeys/example.com/alice.gpg`. Either way the entry is saved **verbatim** as the `.gpg` file (do *not* re-encrypt it with `pass insert`) — the armored content is already encrypted to your store's `.gpg-id` recipients.

If you use `git` to track or synchronise your password store, remember to `git add` and commit the new `.gpg` file so it is picked up by your usual workflow.

Only after the entry exists will the site accept assertions from that credential. If you decline partway through (or never save the entry), discard the ceremony on the site and nothing persists.

### Limitations

- **Algorithm**: ES256 (ECDSA over P-256 with SHA-256) only.
- **Attestation**: registrations use `fmt: "none"` self-attestation; Parcel cannot prove authenticator provenance to sites that require it.
- **Counter**: the signature counter is always zero (multi-device-style credential; clone-detection is not available).
- Sites that require hardware-bound attestation or Ed25519 will need to fall back to a platform authenticator.
- **Duplicate registrations**: Parcel cannot honour `excludeCredentials` (credential IDs live inside the encrypted entries, so they cannot be checked without decrypting every candidate before consent). The create consent view instead lists any passkeys you already hold for the site, so you can spot a duplicate registration before creating another.
- **Allow-list privacy**: on `get()` ceremonies where the site supplies `allowCredentials`, Parcel cannot pre-filter candidates (credential IDs are stored inside the encrypted entries, so filtering would require decrypting every candidate before obtaining consent). The consent popup is therefore shown whenever any passkey exists for the relying party — even if none match the allow-list — and the allow-list is enforced by the host at signing time. A site that supplies only foreign credential IDs can thereby observe that you hold Parcel passkeys for it (see [SECURITY.md](SECURITY.md#passkey-ceremonies)).

### Passkey conflicts with other password managers

Passkey-capable password managers (1Password, Bitwarden, etc.) all intercept the same two functions — `navigator.credentials.create()` and `.get()` — and only one extension can own them per page. Parcel's policy is *first come, first served, and never a fight*:

- If Parcel's interceptor installs first, it installs its shim as **non-configurable** properties, so a later-loading extension (or hostile page script) cannot silently replace it. Parcel then owns passkey ceremonies for that page.
- If another extension got there first — whether it locked the API or merely wrapped it — Parcel **backs off entirely**: it does not poll, does not re-define, and does not try to work around the other extension's lock. A warning is logged to the page console.

When Parcel backs off **and you have Parcel passkeys stored for that site**, an in-page notice appears once per site explaining the conflict, with the option to dismiss it permanently for that site. Sites configured with a `browser-passkey` rule, or when passkeys are disabled (`"handlePasskeys": false`), are never alerted on — an explicit choice is not a conflict.

To resolve a conflict, decide which provider should serve passkeys, then either disable passkeys in the other extension, or set `"handlePasskeys": false` / a `browser-passkey` rule in `.parcel.json` for the sites in question. For example, to always use the browser's built-in passkey handler for `github.com` (e.g. a TPM-resident credential) while keeping Parcel for everything else, use `{ "pattern": "^github\\.com$", "class": "browser-passkey" }`. Unlike ordinary rules (whose `pattern` is matched against entry names), a `browser-passkey` rule's `pattern` is matched against the site's relying-party ID.

Set `"handlePasskeys": false` in `.parcel.json` to disable passkey support entirely.

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



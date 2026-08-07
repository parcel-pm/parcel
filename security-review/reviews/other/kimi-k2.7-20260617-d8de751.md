# Security Review: Parcel

**Reviewer:** GitHub Copilot / Kimi K2.7
**Date:** 2026-06-17
**Commit reviewed:** `d8de751e4fc4629f2c8e0a2cede24b63e819ade1`

## Prompt

This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Save this review to security-review-copilot-kimi_K2.7-20260617-d8de751.md.

## Executive Summary

Parcel is an intentionally minimal, read-only browser bridge to a `pass`-style GPG-encrypted password store. Its architecture is strongly defensive: the native host (not the extension) enforces filesystem and decryption boundaries, the shipped source is human-auditable, there are no third-party runtime dependencies, and the extension deliberately avoids networking, file writes, and arbitrary execution.

The codebase is small: ~2,000 lines across the main browser scripts plus a ~320-line plaintext bash native host. This review found **no critical vulnerabilities** and **no high-severity issues** in the current commit. All findings from the previous automated review have been addressed. A small number of residual observations remain; most are accepted architectural trade-offs (already documented in `SECURITY.md` and `CONSTITUTION.md`) and one is a minor hardening opportunity.

## Trust Model & Attack Surfaces

The following boundaries constrain what an attacker can do at each layer:

| Layer | Privilege | Key Assets | Primary Risk |
|-------|-----------|------------|--------------|
| Website / content page | Untrusted | User attention, DOM events | Phishing, clickjacking, exfiltration of filled values, fingerprinting |
| Browser extension content scripts | Higher than page, lower than host | Port messages, DOM access | Compromised extension can fill fields, request decryptions of *already-whitelisted* entries, interact with pages |
| Service worker (`agent.js`) | Higher than content scripts | Native messaging port, cached entry list, storage | Can relay decrypt requests to host; cannot read filesystem directly |
| Native host bootstrap (`parcel-host`) | High: executes outside browser sandbox; sourced as executable code from extension | Signed host script, `parcelrc` | Signature/hash verification before executing the inner host |
| Native host (`src/parcel-host`) | Same as bootstrap | GPG keyring, password store files | Enforces whitelist-based entry visibility, rate limiting, audit logging, path validation |

The most important security property is that filesystem access is mediated by `src/parcel-host`: even a fully compromised extension cannot decrypt arbitrary files, because the whitelist is evaluated on the host side and the allowed-path cache (`ALLOWED_FILES`) is populated only by the host's own `action_list` routine.

## Methodology

- Manual source review of `src/js/agent.js`, `src/js/integration.js`, `src/js/popup.js`, `src/js/helpers.js`, `src/js/schema.js`, `src/js/plaintext.js`, `src/js/shadow.js`, `src/js/targets.js`, `src/js/selectors.js`, `src/manifest.json`, `parcel-host`, and `src/parcel-host`.
- Read `CONSTITUTION.md`, `SECURITY.md`, and prior `security-review/findings.md`.
- Inspected the test suite under `test/` for security-relevant coverage.
- Searched for dangerous patterns: `eval`, `innerHTML`, unsanitized injection sinks, dynamic `setAttribute("on...")`, arbitrary network access, weak/random token generation, and unsafe origin checks.

## Items Reviewed and Verified

### 1. Native host bootstrap and script integrity

The bootstrap host (`parcel-host`) receives the inner host script and its detached signature over native messaging. Before execution it:

1. Verifies the GPG signature in a temporary keyring (`--no-default-keyring --keyring "..."`), so the user's keyring is not polluted.
2. Extracts the primary fingerprint from `VALIDSIG` status output.
3. Checks the fingerprint against the user-configured `VALID_SIGNERS` list in `parcelrc`.
4. If `HOST_HASH` is set, SHA-256 hashes the script and compares it to the pin.

**Findings:**

- `set -e` is used, but `parcel_error` is implemented as a helper that optionally exits; paths that fail signature verification call `parcel_error "..."` without an exit code. The function returns from `action_install`, and the caller in `main` does not detect this as a fatal error; it merely exits the current `main` invocation because `ACTION=install` triggers `return 2`, causing the outer loop to re-evaluate `PARCEL_HOST`. If `PARCEL_HOST` is still empty after a failed install, the loop restarts with `PARCEL_HOST=""` and waits for a new message. This is **not exploitable**: the empty/invalid script value is never stored in `PARCEL_HOST` because `action_install` returns before assigning it. The failure is, however, logged somewhat indirectly. This is a minor diagnostic clarity issue, not a security bug.
- GPG is invoked with `--trust-model always`. In combination with `--auto-key-import`, this accepts self-signatures on auto-imported keys. Because the code only accepts signers from the user-controlled `VALID_SIGNERS` list, an attacker who can replace the extension's host script and signature would still need a key whose fingerprint is in `VALID_SIGNERS`. This is acceptable.
- `HOST_HASH` comparison is a simple string equality of hex digits. If the user mistypes it, the host refuses to run and emits the actual hash. This is the intended behavior.

### 2. Filesystem access and whitelist enforcement

`src/parcel-host` derives the allowed file list from `$PASSWORD_STORE_DIR/.parcel.json` rules. The entries are matched by `jq` regex tests on the relative entry path. Only `.gpg` files found by `find` are candidates. The resulting list is stored in the bash array `ALLOWED_FILES`, and `action_decrypt` rejects any requested path not present in that array.

**Findings:**

- Path traversal is effectively blocked: even if an attacker sends `path = "../../../etc/passwd"`, that path cannot be in `ALLOWED_FILES` because the `find` command is rooted at `PASSWORD_STORE_DIR` and only emits paths under it.
- The path-whitelist check is string equality against the exact paths returned by `find -L` / `readlink -f`. No normalization of the requested path occurs before comparison, so a symlink path requested by the extension must exactly match a whitelisted path. This is a valid security choice because the extension sees the same `path` values returned by `action_list`.
- Symlink policy is conservative: `allowLinks` defaults to `false`; `allowExternalLinks` defaults to `false` and requires `allowLinks`. When links are disabled, symlinked entries are filtered from `action_list` and `validate_decrypt_path_policy` rejects symlinked paths. This matches the documented trade-off in `SECURITY.md`.
- `find` excludes hidden directories (`$PASSWORD_STORE_DIR/.*` and `$PASSWORD_STORE_DIR/**/.*`), preventing entries placed in `.git` or other dot-directories from being exposed. Good.

### 3. Decryption rate limiting and audit logging

A token-bucket rate limiter is implemented in `src/parcel-host`. It computes elapsed time with millisecond precision (falling back to whole seconds on macOS) and refills at the configured `decryptRate`. The bucket capacity is `decryptBucket * 1000` and each decryption costs `1000` tokens.

Audit logging (`auditDecrypt: true`) writes `[timestamp] DECRYPT intent origin path: message` to the configured log file. Control characters are stripped from the four variable fields using `${var//[[:cntrl:]]/}`.

**Findings:**

- The previous review noted unbounded field lengths; this commit limits the displayed fields via schema-level `maxLength` constraints and host-side control-character stripping. There is no explicit byte-length cap on the audit line, but the fields originate from host-derived data (`FILE_PATH`) or extension-provided data (`INTENT`, `ORIGIN`) that are validated by the extension schema (`decryptTimeout` numeric, `intent` not freeform in schema but passed as a string). The practical log-bloating risk is low.
- Rate limits are enforced in the host, so a compromised extension cannot bypass them by modifying the extension code. Setting `decryptBucket` or `decryptRate` to `0` disables limiting; this is documented.
- The rate-limiter uses integer arithmetic with `awk` for floating-point rate comparison. This is adequate for the threat model.

### 4. Content script / page interaction

`src/js/integration.js` runs as an MV3 content script in every frame at `document_start`. It:

- Opens runtime ports to the service worker (`auth`, `integration`, `trigger`).
- Listens for clicks on form fields and, if the field matches a target selector, opens an iframe popup.
- Validates target eligibility with `checkVisibility`, read-only/disabled checks, and blacklist selectors.
- Fills fields by setting `.value` and `.setAttribute("value", ...)` and dispatching synthetic `Event` objects (not `KeyboardEvent`/untrusted events that would expose keycodes).

**Findings:**

- `fillField` uses `el.value` and `el.setAttribute("value", ...)` for non-SELECT elements. Modern React / Vue sites often use controlled components that ignore direct property assignment. Parcel mitigates this by dispatching `keydown`, `keypress`, `keyup`, `input`, and `change` events, then re-checking and re-setting the value after a 10ms timeout. This is a sensible heuristic and does not introduce security issues.
- The `Element.prototype.attachShadow` patch in `src/js/shadow.js` runs in the `MAIN` world and is visible to pages. This is a deliberate trade-off to support shadow DOM forms. It does not execute untrusted code.
- `window.addEventListener("message", ...)` in `integration.js` only handles `{ action: "parcel-frame-id" }` and checks that `ev.source` corresponds to an actual `iframe` before assigning `_parcelFrameId`. No other postMessage actions are accepted. Good.
- The popup iframe is created with `attachShadow({ mode: "closed" })` and loads `chrome-extension://.../html/popup.html?token=...&frameId=...`. The `token` is one-time (or "broadcast") and the popup validates that it is not embedded in a frame (`token === "broadcast" && window !== window.top`).
- The `trigger-popup` handler correlates iframe coordinates using `_parcelFrameId`. Because `_parcelFrameId` is assigned only from a verified postMessage source, a malicious child frame cannot spoof another frame's ID.

### 5. Service worker (`agent.js`)

`agent.js` is the MV3 service worker. It installs the native host, caches configuration, caches the entry list, and brokers runtime ports.

**Findings:**

- Native calls are serialized through `#currentNativeCall` to avoid the Chrome native-messaging race condition. Each call uses a unique `crypto.randomUUID()` token, and responses are dispatched via EventTarget events keyed by token. This prevents response confusion/cross-talk.
- The popup auth model uses single-use tokens generated in the content script and registered through an `auth` port. The worker remembers tokens in `#authorisedTokens` and removes them on first use. The "broadcast" token is accepted for the toolbar popup and is intentionally reusable. This model is appropriate for the threat model: a malicious page cannot guess `crypto.randomUUID()` tokens.
- In `agent.js` line 384, the popup-bridge regex is `^popup-bridge:(.+?):(\d+)$`. The token portion `.+?` is non-greedy; combined with the trailing `:\d+`, this correctly parses strings like `popup-bridge:<token>:<frameId>`. A token containing colons would cause the frameId parse to fail or consume part of the token, but tokens are UUIDs without colons. Fine.
- `search()` processes user-provided search terms by splitting on whitespace and compiling each term as a regex. As noted in the previous review, a malicious user could enter a ReDoS pattern and DoS their own service worker. The maintainers declared this acceptable, and this review agrees: the search is client-only, cannot be triggered by a website, and the only affected principal is the user.

### 6. Configuration schema and defaults

`src/js/schema.js` implements a hand-written JSON-schema-like validator. `ConfigSchema` and `SelectorSchema` are applied to host-provided and user-provided config. Defaults for missing values are filled in before validation.

**Findings:**

- The schema rejects unknown properties. This is good for preventing typos and unexpected behavior.
- `additionalSelectors` and `additionalTargets` are appended to built-in defaults, allowing custom field detection and extraction without forking code. Custom selectors are filtered by `host`, so a malicious global selector cannot easily target a specific site without being in that site's content script context. However, global `additionalSelectors` operate on every origin; users should treat them as trusted config.
- `parcelrc` is required to have mode `0600`. The bootstrap refuses to load otherwise. Good.
- Default whitelist behavior: if `.parcel.json` is absent, the host defaults to `rules: [{ pattern: "." }]`, which exposes the entire password store. The popup shows a persistent warning. This is a documented, deliberate usability trade-off. Users are expected to create a whitelist.

### 7. Manifest and permissions

`src/manifest.json` declares:

- `permissions`: `nativeMessaging`, `storage`
- `host_permissions`: `<all_urls>`
- `content_scripts`: both run on `<all_urls>`, all frames, `document_start`
- `web_accessible_resources`: popup HTML, images, JS modules
- `content_security_policy`: `script-src 'self'; object-src 'self';`

**Findings:**

- The previous review noted the absence of an explicit CSP; this commit adds the minimal strict CSP above. It is appropriate because no inline scripts or external scripts are used.
- `<all_urls>` is required for the content script to detect login fields on arbitrary sites. The extension does not use `webRequest`, `tabs`, `clipboardRead`, or other high-risk permissions.
- `storage` is used only for `chrome.storage.local`; data is not synced and is isolated per profile (and per container on Firefox).
- `web_accessible_resources` exposes the extension ID to websites, enabling fingerprinting. This is a documented trade-off; narrowing the set would break the popup iframe.

### 8. Cryptographic helpers

`src/js/helpers.js` implements TOTP generation using `crypto.subtle` HMAC-SHA-1 and SHA-256 hashing. `Plaintext` extracts values via regex and supports TOTP URL transforms.

**Findings:**

- TOTP uses `crypto.subtle.importKey` with `extractable: false` and only `["sign"]`. Good.
- The TOTP URL parser uses `new URL(fillValue)` and reads `searchParams`. A malformed URL throws, which is caught and surfaced as an error. No injection risk.
- SHA-256 via `crypto.subtle` is standard.

### 9. Test coverage

The project has a comprehensive Node test suite using the built-in `node:test` runner and a custom Chrome API mock. Tests cover:

- Native host signature verification, hash pinning, path whitelisting, symlink policies, rate limiting, and audit logging (`test/native-host.test.js`).
- Service worker auth, token consumption, search, and public-suffix logic (`test/agent.test.js`).
- Content script target detection, field filling, popup wiring, and shadow DOM behavior (`test/integration.test.js`, `test/shadow.test.js`).
- Module-level helpers, schema validation, plaintext extraction, selectors, and targets.

**Findings:**

- Coverage is good for a project of this size. No obvious security-critical paths are untested.
- The tests use mocked GPG, so real signature verification paths are not exercised end-to-end in CI. This is acceptable because the bootstrap script is straightforward and the underlying GPG behavior is well-understood.

## Residual Observations

These are not new vulnerabilities but are worth noting in the context of the project's threat model.

### A. The origin-boundary warning uses `alert()` and allows override

When the user attempts to fill into an iframe whose origin differs from the top-level tab, the popup shows a browser `alert()` and lets the user proceed. As documented in `SECURITY.md`, this is deliberate: the target audience is power users. The risk is that an attacker who can frame a login form across origins may get credentials filled if the user clicks through the warning. This is mitigated by the fact that the user chose the entry and clicked through the warning. **No change recommended**, but the behavior should remain clearly documented.

### B. `agent.js` sends the full `config` object to content scripts

In the `decrypt` and fill paths, `agent.js` forwards `this.#config` to the content script. The content script is therefore trusted with the entire configuration, including regex patterns and selectors. This is acceptable because the content script is part of the same extension; a compromised content script is already inside the extension trust boundary. If the config ever contained secrets, this would be a concern, but it does not.

### C. `Plaintext.getPlaintext()` returns the raw decrypted entry

In `popup.js`, the detail view calls `this.#plaintext.getPlaintext()` and renders each line. Because the popup is an extension page with a strict CSP and no external scripts, this is safe. The content script never receives the raw plaintext for detail view; only fill-relevant values are sent.

### D. Minor: log line length still unbounded in principle

The audit log strips control characters but does not truncate `ORIGIN` or `INTENT` to a maximum byte length. In practice these are constrained by browser URL limits and the small set of intents (`fill`, `detail`), but a hard cap would add defense in depth. **Suggested hardening** (low priority): cap each audit field to a reasonable length (e.g., 2,048 bytes for `ORIGIN`, 64 bytes for `INTENT`) before writing to the log.

## Conclusion

Parcel's security posture is strong for its intended purpose. The architecture correctly places the highest-risk operations (filesystem access, GPG decryption, whitelist enforcement) outside the browser sandbox in a small, auditable bash host. The extension layer is constrained by manifest permissions, a strict CSP, and the fact that the host refuses operations outside user-configured rules.

No new vulnerabilities were identified in this review. The one minor hardening suggestion (audit-log field length caps) can be addressed at the maintainers' discretion.

## About This Review

This review was conducted automatically using GitHub Copilot with the Kimi K2.7 model. It is a static source-code review and does not include runtime exploitation testing. The review covers the commit named above; subsequent code changes may alter the conclusions.

# Parcel Security Review

**Reviewer:** Copilot / Kimi K2.6
**Date:** 2026-06-15
**Commit / Release reviewed:** `v1.0.0` (tag `1.0.0`, commit range `HEAD` at time of review)
**Scope:** Browser extension (`src/js/*`, `src/manifest.json`), bootstrap native host (`parcel-host`), main native host (`src/parcel-host`), build system (`Makefile`), and related documentation (`CONSTITUTION.md`, `SECURITY.md`).

## Prompt

This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Save this review to security-review-copilot-kimi_K2.6-20260615.md.

## Executive Summary

Parcel is a read-only browser-extension bridge to a local `pass`-style GPG-encrypted password store. Its security posture is intentionally austere: no third-party runtime dependencies, no transpilation or bundling, no network access, no file writes (outside a dedicated log and a one-time config template), and no compiled native host. The code that ships is the code in the repository. This design philosophy materially reduces supply-chain and obfuscation risks, but it also means the extension relies heavily on browser sandbox policies, GPG, and a whitelist-enforcing bash native host for its security guarantees.

This review finds **no critical vulnerabilities** in the current codebase. The architecture is coherent, the bootstrap host correctly isolates signature verification from the user's keyring, and the main host enforces path-based whitelisting before decryption. A handful of **low-to-moderate observations** are noted below, along with recommendations for hardening and operational clarity. None of these observations represent an immediate security breach on their own, and several are already documented as deliberate tradeoffs in `SECURITY.md`.

## Architecture & Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  Web Page (untrusted)                                       │
│  ──content scripts run in ISOLATED world, except shadow.js──┤
│                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐ │
│  │ shadow.js   │    │integration.js│    │  popup (page)   │ │
│  │ (MAIN world)│    │ (ISOLATED)   │    │  popup.html     │ │
│  └──────┬──────┘    └──────┬───────┘    └────────┬────────┘ │
│         │                  │                     │          │
│  ┌──────┴──────────────────┴─────────────────────┤          │
│  │           Agent (service worker)               │          │
│  │  ┌─────────────────────────────────────────┐   │          │
│  │  │  Native Messaging Host (parcel-host)    │   │          │
│  │  │  → GPG signature verification           │   │          │
│  │  │  → eval of src/parcel-host              │   │          │
│  │  │  → Reads ~/.password-store              │   │          │
│  │  │  → Enforces .parcel.json whitelist      │   │          │
│  │  └─────────────────────────────────────────┘   │          │
│  └────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### Key trust boundaries

1. **Web page ↔ Content scripts** — `shadow.js` runs in `world: "MAIN"` (required to patch `attachShadow`). All other extension scripts run in the isolated content-script world. Cross-world communication is mediated by custom DOM events (`parcel-shadow-click`).
2. **Content script ↔ Agent** — Chrome runtime ports with token-based auth. The agent maintains an `#authorisedTokens` set. Popup tokens are single-use once authorised.
3. **Agent ↔ Native host** — Chrome `runtime.connectNative`. Messages are length-prefixed JSON. The bootstrap host verifies GPG detached signatures and (optionally) HOST_HASH before `eval`-ing the main host script.
4. **Native host ↔ Filesystem** — The main host is constrained by `.parcel.json` rules and an in-memory `ALLOWED_FILES` array populated by `action_list`. Only whitelisted `.gpg` files under `PASSWORD_STORE_DIR` may be decrypted.

## Component Review

### 1. Bootstrap Host (`parcel-host`)

* **Responsibilities:** Native-messaging framing, GPG signature verification, optional HOST_HASH pinning, sourcing `parcelrc`, `eval`-ing the main host script.
* **Code visibility:** Plaintext bash. Complies with `CONSTITUTION.md` §1.3.2.
* **GPG verification flow:**
  1. Receives `script` + `signature` from agent via `action_install`.
  2. Creates a **temporary keyring** (`mktemp`) to avoid polluting the user's keyring (`--no-default-keyring --keyring "$KEYRING"`).
  3. Uses `--auto-key-import` to fetch keys from the signature packet. Because a temporary keyring is used, this is safe from persistent keyring pollution.
  4. Extracts `VALIDSIG` primary fingerprint and checks it against the configured `VALID_SIGNERS` list.
  5. If `HOST_HASH` is set, computes SHA-256 of the script and bails on mismatch.
  6. Stores the script in `PARCEL_HOST` and exits the loop; the outer `while true` then `eval`s it.
* **Temp file cleanup:** `rm -f "$KEYRING" "$KEYRING"~` is executed on both success and failure paths. **Observation:** if `gpg` itself creates additional auxiliary files (e.g., lock files with different suffixes), they may leak. This is a minor hygiene issue.
* **Error handling:** Uses `set -e`, but traps are not installed for `ERR` or `EXIT` to ensure temp file removal on abrupt termination. Given the bootstrap's simplicity and the explicit `rm` calls, this is acceptable but not ideal.

### 2. Main Host (`src/parcel-host`)

* **Responsibilities:** Config loading, entry listing, whitelist enforcement, rate-limited decryption, audit logging.
* **Config sourcing:** Reads `.parcel.json` via `jq`. If missing, defaults to a single `include: "."` rule (`defaultRules: true`), which exposes **all entries**.
* **Whitelist enforcement:** `action_list` builds an `ALLOWED_FILES` array of absolute paths. `action_decrypt` iterates this array with an exact string match (`[ "$ALLOWED" = "$FILE_PATH" ]`). This prevents path-traversal tricks provided the list entries are absolute. The list is constructed from `find -L` output and `readlink -f`, so symlinks are resolved to their real path before whitelist population.
* **Symlink policy:** `validate_decrypt_path_policy` walks path components looking for symlinks. If found, it verifies `allowLinks` and, for external links, `allowExternalLinks`. The host also checks whether a file is inside a symlinked directory. This is a robust defence against symlink-based exfiltration.
* **Rate limiting:** Token-bucket implementation (`check_decrypt_rate_limit`) uses `get_timestamp_ms` with millisecond precision (falls back to whole seconds on macOS). Default capacity is 24 tokens with refill at ~0.0067 t/s (~1 per 150 s). This effectively bounds the blast radius of a credential-exfiltration attack but does not prevent it outright. **Observation:** the `awk` zero-check (`awk -v rate="$RATE" 'BEGIN { exit !(rate == 0) }'`) is slightly fragile if `RATE` is provided as a string that `awk` might interpret differently, but `jq` returns it as a number string, so this is fine in practice.
* **Audit logging:** `audit_decrypt` strips control characters (`${VAR//[[:cntrl:]]/}`) before writing origin, path, intent, and result to the log fd. **Observation:** while control-character stripping mitigates log-forging via escape sequences, it does not prevent a compromised extension from passing a very long string that could bloat the log. A length cap is recommended.
* **GPG invocation:** Uses `--decrypt --quiet --batch --no-tty --yes --output -`. This is a safe non-interactive invocation. Decrypted plaintext is returned to the agent over native messaging.

### 3. Agent (`src/js/agent.js`)

* **Responsibilities:** Native host lifecycle, popup/content-script port brokering, caching, searching, config validation.
* **Native host lifecycle:**
  * Opens native port on construction.
  * On bootstrap event, fetches `parcel-host` and `parcel-host.asc` from extension package via `fetch(chrome.runtime.getURL(...))` and sends them to the bootstrap for `action_install`.
  * Uses a **semaphore** (`#currentNativeCall`) to avoid Chrome's native-messaging race condition where rapid successive messages may be dropped.
* **Token auth:** Popups send a `crypto.randomUUID()` token. The agent adds it to `#authorisedTokens` via an `auth` port, then validates it on the `popup` port before serving requests. Tokens are **single-use** (`delete` after auth). This is a clean, lightweight auth mechanism.
* **Broadcast handling:** The `broadcast` token bypasses single-use deletion (used for toolbar popup and integration best-target autofill). The agent verifies `token === "broadcast"` or membership in `#authorisedTokens`.
* **Entry caching:** Uses `changes_since` to avoid full `action_list` calls when the cache TTL has not expired and the filesystem has not changed. This is efficient and does not weaken security because the authoritative whitelist remains on the host.
* **Public suffix list:** Fetches `public_suffix_list.dat` from the extension package at runtime to determine the registrable domain for origin matching. No network request; the file is shipped with the extension.
* **Search behaviour:**
  * `search()` first limits results to entries whose path components match the origin hostname or a public-suffix slice.
  * History (stored as unsalted SHA-256 hashes) is merged and sorted by recency.
  * If `limit` is false (e.g., user clears the search field), all entries become searchable.
  * Search terms are compiled as `RegExp` with the `ui` flags. No input sanitisation is performed beyond `try/catch`. A malicious origin or compromised extension could send a regex with catastrophic backtracking. **Observation:** because search regexes run in the service worker (not the host) and operate only on entry names (not file contents), the denial-of-service impact is limited to the extension itself. Still, a length limit or ReDoS-aware validation on the `search` string would be a nice hardening measure.
* **Config validation:** Uses a hand-rolled `Schema` class (`schema.js`) against `ConfigSchema`. Invalid configs reject host startup.

### 4. Popup (`src/js/popup.js`)

* **Responsibilities:** UI rendering, search input handling, history management, detail view, fill relay.
* **Token isolation:** The popup receives its token from the query string (`?token=...`). If `token === "broadcast"` and `window !== window.top`, the script scrubs the page and throws. This prevents a malicious page from embedding the popup in an iframe and interacting with it.
* **History storage:** Keys are `history:${scopeHash}:${originHash}` where scope is the contextual identity (Firefox containers) or `"default"`. History items contain `{ path: sha256(entry.path), when: Date.now() }`. The path hash is unsalted and deterministic. **Observation:** as noted in `SECURITY.md`, this is a deliberate tradeoff—history is convenience metadata, not a secret. Adding salting would be obfuscation without real protection because the search space (entry names × origins) is small enough to brute-force even with salting. Users who care can disable history entirely (`saveHistory: false`).
* **Origin mismatch warning:** When filling from the detail view, the integration script reports the frame's origin back to the popup. If it differs from the tab origin, an `alert()` is shown but the user can still proceed. This is a documented deliberate tradeoff for power users.
* **XSS surface:** The popup uses `textContent` for dynamic text (entry names, paths, error messages) and sets `Element.textContent` in the custom elements (`ParcelPlaintextLine`, `ParcelValue`). The only HTML insertion is via template `<template>` elements cloned into shadow roots. There is no `innerHTML` assignment with user-controlled data. This surface is clean.
* **Clipboard:** `navigator.clipboard.writeText()` is used for copying values. Parcel intentionally does **not** clear the clipboard afterwards to avoid the `clipboardRead` permission. This is a documented tradeoff.

### 5. Integration / Content Script (`src/js/integration.js`)

* **Responsibilities:** Field detection, popup triggering, field filling, related-field discovery, event simulation.
* **Shadow DOM support:** Patches `attachShadow` in `shadow.js` (MAIN world) to tag hosts and relay click events. The integration script listens for `parcel-shadow-click` custom events and maps them back to the shadow target via UUID attributes.
* **Field detection:** Uses `targetSelectors` (built-in + `additionalSelectors` from config). Blacklist selectors are evaluated after positive selectors, so a field can be positively identified and then rejected. This is correct.
* **Visibility check:** `el.checkVisibility({ opacityProperty: true, visibilityProperty: true })` prevents filling hidden fields. This is good, though it does not protect against fields that are visually hidden via `clip`, `transform`, or off-screen positioning.
* **Field filling (`fillField`):**
  1. Dispatches `keydown`, `keypress`, `keyup`, `input`, `change` events (no `keyCode`).
  2. Sets `el.value` and `el.setAttribute("value", ...)`.
  3. Re-dispatches the events.
  4. If the value was reverted by page scripts, waits 10 ms and sets it again.
  5. Adds a green outline (`2px solid green`).
  * **Observation:** the 10 ms re-set is a pragmatic workaround for aggressive page event handlers, but it is a race condition. A page that defers its own reset via `setTimeout(..., 0)` could still win. This is an inherent limitation of content-script filling and is acceptable given Parcel's threat model.
  * **Type confusion safety:** `fillField` refuses to fill elements whose `type` is not `text`, `email`, `tel`, or `password`. This prevents accidentally filling a checkbox or button.
* **Event listener registration:** `document.addEventListener("click", ..., { capture: true, passive: true })`. Because it runs at `document_start` and uses capture, it will see clicks before most page handlers, but it does not call `stopPropagation()`, so it does not interfere with page functionality.
* **Untargeted clicks:** If the clicked element is not a fill target, the integration sends an `untargeted-click` message to the top frame, which may close the popup if the click was outside it. This is a UX feature with no security impact.

### 6. Build / Distribution Surface

* **Makefile:** Copies source to `chrome/` and `firefox/` with minor rewrites (manifest adjustments, `.es6.js` shim for Firefox module content scripts). No transpilation or bundling. This preserves source/distribution parity.
* **Manifest:**
  * `permissions`: `["nativeMessaging", "storage"]` — minimal.
  * `host_permissions`: `["<all_urls>"]` — required for universal form detection. This is a high-permission declaration, but it is necessary for the extension's purpose.
  * `web_accessible_resources`: Exposes `popup.html`, module JS, and images to any origin. This enables fingerprinting (any site can attempt to load `chrome-extension://<id>/img/logo-small.svg`). **Observation:** this is a documented tradeoff. The listed resources are required for the popup iframe to load in the content-script context.
* **Content Security Policy:** The review did not find an explicit CSP in `manifest.json`. Under Manifest V3, Chrome enforces a default CSP of `script-src 'self'; object-src 'self';` for service workers, and extension pages inherit a restrictive CSP. Because there are no inline scripts in `popup.html` (all JS is in module files), the default CSP is adequate. Adding an explicit CSP to `manifest.json` would improve defence in depth.

### 7. Cryptography

* **GPG:** Parcel delegates all encryption to GPG. The extension never handles private keys or ciphertext directly. This is correct.
* **TOTP:** Implemented in `Helpers.generateTOTP` using `crypto.subtle` HMAC-SHA1. Key import is non-extractable (`false, ["sign"]`). The implementation follows RFC 6238. The secret is base32-decoded by `Helpers.base32ToArrayBuffer`, which does not validate padding and will silently ignore trailing bits. **Observation:** this is standard behaviour for many TOTP implementations and is not a security issue unless malformed secrets are supplied.
* **Hashing:** SHA-256 via `crypto.subtle.digest`. Used for history keys and entry path hashing. No salt, by design.

## Findings

### F1. Log-bloating via unbounded audit-log fields
**Severity:** Low
**Location:** `src/parcel-host`, `audit_decrypt()`
**Description:** The audit log strips control characters but does not limit the length of `FILE_PATH`, `INTENT`, or `ORIGIN`. A compromised extension could submit extremely long strings in these fields, causing unbounded log growth.
**Recommendation:** Truncate audit fields to a reasonable maximum (e.g., 4,096 bytes) before logging.

### F2. No Content Security Policy declared in manifest
**Severity:** Low
**Location:** `src/manifest.json`
**Description:** The extension relies on the browser's default MV3 CSP. While the codebase contains no eval or inline scripts, an explicit `content_security_policy` declaration would provide a clear, auditable contract and protect against future regressions.
**Recommendation:** Add a strict CSP to `manifest.json`, e.g.:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self';"
}
```

### F3. Search regex ReDoS risk in service worker
**Severity:** Low
**Location:** `src/js/agent.js`, `search()`
**Description:** User-provided search terms are compiled as `RegExp(term, "ui")` without length limits or ReDoS checks. A crafted term such as `(a+)+$` against a long entry name could hang the service worker for a noticeable period.
**Recommendation:** Either limit the search term length (e.g., 200 characters) or use a regex execution timeout (e.g., via `RegExp.prototype.exec` in a separate task, although service workers make this awkward). Given that the extension is local-only and the impact is a transient UI hang, this is not urgent.

### F4. `shadow.js` runs in MAIN world and patches global prototype
**Severity:** Moderate (design-level)
**Location:** `src/js/shadow.js`
**Description:** To intercept shadow-root creation, `shadow.js` patches `Element.prototype.attachShadow` in the page's JavaScript realm. This means a malicious page can detect the patch, overwrite it before Parcel loads, or observe the `is-shadow` / `parcel-shadow-host` attributes being added. While Parcel does not rely on this patch for security (it is a convenience feature for UI detection), it increases the extension's detectability and exposes a small interference surface.
**Recommendation:** Document the detectability trade-off more prominently. Consider whether a MutationObserver-based fallback (in the isolated world) could reduce main-world footprint without significant functionality loss.

### F5. History hash is unsalted and deterministic
**Severity:** Low (documented tradeoff)
**Location:** `src/js/popup.js`, `chrome.storage.local`
**Description:** As noted in prior reviews, history keys and entry path hashes are unsalted SHA-256 values. An attacker with access to the browser profile's local storage can correlate hashes by brute-forcing the small space of entry names and origins.
**Status:** This is a deliberate tradeoff. The review concurs with the maintainers' rationale that salting would provide only marginal protection given the small search space, and that users who need confidentiality should disable history. No change recommended.

### F6. Default `.parcel.json` exposes all entries
**Severity:** Low (documented tradeoff)
**Location:** `src/parcel-host`, `load_config()`
**Description:** If `.parcel.json` is absent, the host defaults to `rules: [{pattern: "."}]`, exposing the entire password store. The popup shows a warning banner.
**Status:** Documented tradeoff for usability. Users are warned. No change recommended, but consider whether the warning could be more prominent (e.g., requiring a click-through on first use).

### F7. Extension can be fingerprinted via `web_accessible_resources`
**Severity:** Low (documented tradeoff)
**Location:** `src/manifest.json`
**Description:** Any website can probe for Parcel by attempting to load a `web_accessible_resource`. This reveals the extension's installed state and its stable extension ID.
**Status:** Documented tradeoff. Reducing the list would break the popup iframe. No change recommended.

### F8. `HOST_HASH` is opt-in and off by default
**Severity:** Low (documented tradeoff)
**Location:** `parcel-host` (bootstrap)
**Description:** Users who do not set `HOST_HASH` will automatically execute updated host scripts after signature verification. This is acceptable because signature verification is mandatory and uses a curated `VALID_SIGNERS` list, but hash pinning is a valuable defence-in-depth layer against a compromised release signing key.
**Status:** Documented tradeoff. The review supports the maintainers' recommendation that security-conscious users should enable `HOST_HASH`.

### F9. `action_install` exits with `return 2`, causing a host restart loop on repeated failure
**Severity:** Low
**Location:** `parcel-host`
**Description:** If `action_install` succeeds in verifying the script but then something else goes wrong later, the outer loop re-`eval`s `PARCEL_HOST`. If a malformed script causes a non-zero exit from `main`, the bootstrap reconnects and may receive another install request. Under normal circumstances this is harmless, but a persistent failure condition (e.g., a buggy host script that crashes immediately) could lead to a tight restart loop. Chrome native messaging may kill the host after repeated crashes, which is a self-limiting factor.
**Recommendation:** Consider adding a small backoff delay or a maximum restart counter in the bootstrap loop to reduce log spam and CPU usage in pathological failure scenarios.

## Deliberate Tradeoffs Revisited

| Tradeoff | Current Assessment |
|----------|--------------------|
| Plaintext bash host | Still sound. Auditable source outweighs the risk of a compiled binary. |
| No network access | Policy-level guarantee. Cannot be technically enforced without breaking the extension. Acceptable given the project's review governance. |
| Read-only | Enforced by absence of write APIs in both extension and host. Good. |
| All-URLs permission | Necessary for universal form filling. Acceptable. |
| No clipboard auto-clear | Avoids `clipboardRead` permission. Acceptable. |
| Absent whitelist → show all | Usability-first default. Warning banner mitigates risk. Acceptable but could be hardened with a first-run click-through. |

## Recommendations Summary

1. **Truncate audit-log fields** to a maximum length (e.g., 4,096 bytes) to prevent log-bloating.
2. **Add an explicit CSP** to `manifest.json` to codify the extension's script restrictions.
3. **Limit search term length** or consider a lightweight ReDoS guard in `Agent.search()`.
4. **Document shadow-root detectability** more prominently for users in high-threat environments.
5. **Consider a first-run whitelist warning click-through** instead of a passive banner.
6. **Add a restart-backoff or crash-limit** in the bootstrap host loop to reduce noise on persistent failure.

## Conclusion

Parcel's security architecture is principled, minimal, and well-aligned with its stated goals. The code is clean, the trust boundaries are clearly delineated, and the defensive mechanisms (GPG verification, whitelist enforcement, rate limiting, audit logging) layer sensibly. The findings in this review are minor hardening opportunities rather than structural weaknesses. The project remains suitable for its intended audience of security-conscious users who manage their own `pass` store.

---
*Review conducted in accordance with the Parcel project constitution and security review guidelines. The reviewer did not have access to the full text of prior security reviews and based findings solely on the current codebase and the public summary in `security-review/findings.md`.*


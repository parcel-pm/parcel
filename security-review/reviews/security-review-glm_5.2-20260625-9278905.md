# Comprehensive Security Review — Parcel Password-Manager Extension

**Project:** Parcel (parcel-pm/parcel) — a read-only browser↔`pass` bridge  
**Review date:** 2026-06-25  
**Commit reviewed:** `9278905` (branch `master`, post-#66 ESLint compliance)  
**Reviewers:** Three parallel Copilot security-review subagents (native host, extension JS, manifest/design), consolidated and second-looked by the orchestrating session.  
**Scope:** `src/parcel-host`, `parcel-host`, `src/js/*.js`, `src/manifest.json`, build/CI config, design tradeoffs vs. implementation, and gaps relative to the five prior reviews in `security-review/`.  

---

## Prompt

This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Use up to three simultaneous subagents, and do a second-look review of your output file once you have created it. Be critical; is there anything you may have missed, or misinterpreted? Save the final review to `security-review-glm_5.2-20260625-9278905.md`.

## Executive Summary

Parcel has an unusually disciplined security architecture for a browser extension. The trust boundary is drawn correctly: the native host — not the extension — enforces every filesystem and decryption limit, and a fully compromised extension still cannot decrypt non-whitelisted entries. There are no third-party runtime dependencies, no network primitives in shipped JS, no dangerous DOM sinks, no `eval`/inline scripts, and source/shipping parity is real. The `allowLinks`/`allowExternalLinks` defaults are safe and enforced pre-traversal (the prior #57 finding is resolved). GPG verification uses an isolated, cleaned-up keyring with a `VALIDSIG` field-12 (primary-fingerprint) check that rejects multi-signature forgery.

**No CRITICAL or HIGH exploitable vulnerabilities were identified.** The findings below are MEDIUM/LOW hardening opportunities, documentation/implementation gaps, and defence-in-depth suggestions. The most consequential are:

- **M1** — Extension-page CSP omits `connect-src`/`frame-src`/`base-uri`; the documented "no network" rule could be *technically* enforced for the popup even though it cannot be for content scripts.
- **M2** — MV3 service-worker restart loses authorisation state and re-`eval`s the signed host on every cold start; the lifecycle is undocumented and unhandled.
- **M3** — `decrypt`/`match` actions on `agent.js` are not restricted to authorised popup ports, and the audited `origin` is forwarded verbatim from the message body instead of `port.sender.tab.url`. The host whitelist still bounds *which* entries are decryptable, but the per-popup authorisation gate and audit-log integrity can be bypassed by any extension context with a runtime port.

Everything else is LOW. The deliberate tradeoffs in `SECURITY.md` are, on the whole, honestly documented and adequately mitigated; the gaps are noted below where the implementation diverges from the documentation.

### Consolidated findings

| #  | Sev   | Conf | Area | One-liner |
|----|-------|------|------|-----------|
| M1 | MED   | 8/10 | manifest/CSP | Extension-page CSP omits `connect-src 'none'`/`frame-src 'none'`/`base-uri 'self'`; no-network rule is only human-enforced even where it could be technical. |
| M2 | MED   | 7/10 | SW lifecycle | MV3 SW restart loses `#authorisedTokens`/`#config`/in-flight calls; re-`eval`s signed host on every cold start; no `onStartup`/`chrome.alarms` keepalive. |
| M3 | MED   | 7/10 | agent routing | `decrypt`/`match` reachable from any port name (not just authorised popup); `message.origin` forwarded to host & audit log without reconciliation against `port.sender.tab.url`. |
| L1 | LOW   | 8/10 | host config | `~/.config/parcel/` directory mode not checked; under permissive umask a TOCTOU between the 0600 `parcelrc` check and `source` could enable code execution. |
| L2 | LOW   | 8/10 | host config | Default `VALID_SIGNERS` includes both "backup-only" keys equally with primaries; contradicts CONSTITUTION §2.2 backup-key policy. |
| L3 | LOW   | 7/10 | host hash | `HOST_HASH` hashes a bash here-string (adds trailing newline); mismatches the `sha256sum src/parcel-host` basis documented in SECURITY.md/README. |
| L4 | LOW   | 7/10 | rate limit | Default `decryptBucket=24` ≥ typical store size; rate limiter provides ~zero burst protection in the default-allow-all case. |
| L5 | LOW   | 8/10 | audit log | `LOGFILE` path unvalidated; can point outside the constitution's "dedicated log file" intent (`/dev/null`, sensitive paths). |
| L6 | LOW   | 8/10 | audit log | Audit log file mode not pinned to 0600; default umask yields 0644 (entry paths + origins world-readable). |
| L7 | LOW   | 8/10 | WAR surface | 6 JS modules in `web_accessible_resources` need not be; "required by popup" rationale is incorrect for modules loaded via `import(chrome.runtime.getURL)` from extension contexts. |
| L8 | LOW   | 7/10 | storage | Fill-history keys are per-origin-named but globally readable from any content-script context via `chrome.storage.local.get(null)`; hashes of entry paths are brute-forceable. |
| L9 | LOW   | 8/10 | event forging | MAIN-world `shadow.js` `parcel-shadow-click` event and the `parcel-frame-id` `postMessage(..., "*")` are forgeable by the page; can open the popup / spoof frame id. |
| L10| LOW   | 8/10 | string inj | `$SHA256` used unquoted in command position; benign today but fragile against paths with spaces. |
| L11| LOW   | 8/10 | error leak | GPG status output included in `parcel_error` messages sent to the extension on signature failure. |
| L12| LOW   | 7/10 | action dispatch | `action_$ACTION` dispatch ungated by regex; benign today but defence-in-depth allowlist would future-proof. |
| L13| LOW   | 9/10 | crypto nitpick | `HOST_HASH` comparison is non-constant-time; no remote timing oracle exists, reported for completeness. |

---

## Detailed Findings

### M1 — Extension-page CSP does not technically enforce no-network
**File:** `src/manifest.json:30-32`
**Severity: MEDIUM | Confidence: 8/10**

The manifest CSP is `script-src 'self'; object-src 'self';`. `SECURITY.md` §1 correctly notes that `<all_urls>` prevents a manifest-level network block for *content scripts and the service worker*. It is wrong, however, to conclude that no technical mitigation exists at all: **extension pages (the popup) run in the extension origin** and could be locked down further with `connect-src 'none'; frame-src 'none'; base-uri 'self';`. The popup only talks over runtime ports and loads bundled resources via `chrome.runtime.getURL()`; it has no legitimate reason to `fetch()` remote origins or load remote frames. Adding the three directives would convert the documented human-enforced rule into a technical boundary for the popup without breaking anything.

The prior K2.7 review (manifest findings, lines 127-132) accepted the CSP as "appropriate" without distinguishing extension-page from content-script trust domains — that conflation is the gap.

**Fix:** `script-src 'self'; object-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'self';` and verify the popup still loads.

---

### M2 — MV3 service-worker restart loses state and re-`eval`s the signed host
**File:** `src/js/agent.js:32-45, 96-101, 175-189`; `parcel-host:214-228`
**Severity: MEDIUM | Confidence: 7/10**

`agent.js` instantiates `new Agent()` at top level, which opens the native port in the constructor. MV3 service workers are terminated after ~30s of inactivity. On restart, the constructor re-runs and re-opens the port, but `#authorisedTokens`, `#currentNativeCall`, and the `#config` cache are all lost. There is no `chrome.runtime.onStartup`/`onInstalled` hook and no `chrome.alarms` keepalive (grep-confirmed).

Practical impacts:
- Each SW cold-start re-sends the entire signed host script to the bootstrap and re-runs `eval "$PARCEL_HOST"` (`parcel-host:216-219`). Safe under `HOST_HASH`, but an unbounded re-evaluation surface.
- `onNativeDisconnect`'s `setTimeout(...,1000)` reconnect (`agent.js:185`) is silently dropped if the SW dies inside that 1s window; next instantiation runs the constructor anyway, so correctness is preserved but the design does not document the behaviour.
- SECURITY.md has no "service worker" entry. This is a documentation/implementation gap, not an exploit.

**Fix:** Document the SW-restart → host re-bootstrap behaviour; consider persisting `HOST_HASH`-verified script identity in `chrome.storage.session`, or add a `chrome.alarms` keepalive during active tab sessions; add `chrome.runtime.onStartup` for explicit re-init semantics.

---

### M3 — `decrypt`/`match` not restricted to authorised popup ports; audited origin is attacker-controlled
**File:** `src/js/agent.js:322-390`
**Severity: MEDIUM | Confidence: 7/10**

In `#connect`, only `port.name === "popup"` ports require an `auth` token (lines 324-333). Every other connected port — including a content-script `"integration"` port on an attacker page — falls into the same `port.onMessage` handler, which accepts `match`, `decrypt`, and `sha256` actions (lines 339-382). A `decrypt` from a non-popup port is forwarded to the native host with the fully message-controlled `{ path, intent, origin }` triple (lines 348-352), and the plaintext is returned to that port (line 355). `message.origin` is passed straight through without being reconciled against the browser-trusted `port.sender.tab.url`/`port.sender.origin`.

In the *current* code the content script only sends `config`, and web pages cannot call `chrome.runtime.connect` directly, so this is not directly exploitable by a web attacker. But it is a fragile design with two real consequences:
1. A *compromised extension* (the threat model `SECURITY.md` explicitly scopes) can exfiltrate any whitelisted entry from any extension context without going through the popup, and the host's audit log would record an attacker-chosen origin — defeating the audit log's forensic value precisely when it is needed.
2. There is no schema/allow-list mapping port names to permitted actions, so a future content-script change could trivially turn this into an exfiltration primitive.

The host's `ALLOWED_FILES` whitelist still bounds *which* entries are decryptable — the extension cannot decrypt non-whitelisted entries. But the per-popup authorisation gate and audit-log integrity are bypassable.

**Fix:** Restrict `decrypt`/`match` to authorised popup ports; for content-script ports allow only `config`. Always derive the audited origin from `port.sender.tab.url` (or `port.sender.origin`) rather than the message body. Validate `action` against an allow-list and reject unknowns.

---

### L1 — Missing directory permission check on `~/.config/parcel/`
**File:** `parcel-host:39, 74, 82-83`
**Severity: LOW | Confidence: 8/10**

The bootstrap verifies `parcelrc` has mode 0600 (line 74) but does not verify the containing directory. Under `umask 000` or on shared systems where `~/.config/parcel/` is world-writable, an attacker with local access could TOCTOU-replace `parcelrc` (which is `source`d as bash at line 82) between the permission check and the `source`, yielding arbitrary code execution in the user's context. Under standard `umask 022` the directory is 0755 (safe). The same gap applies to `~/.local/log/` (line 83).

The prior GLM-5.2 review examined the `parcelrc` *file* boundary; no review assessed the *directory* boundary.

**Fix:** Verify `dirname "$PARCELRC"` and `dirname "$LOGFILE"` are not group/world-writable (cf. `~/.ssh/` enforcing 0700); `chmod 0600 "$LOGFILE"` after creation.

---

### L2 — Default `VALID_SIGNERS` trusts the "backup-only" keys equally with primaries
**File:** `parcel-host:86`; `CONSTITUTION.md:143-150`
**Severity: LOW | Confidence: 8/10**

Template `parcelrc` has `VALID_SIGNERS` commented out; line 86 then falls back to a hard-coded list of all four release keys — including the two the constitution designates "backup purposes only … will not be used to sign releases unless one of the primary keys is unavailable for an extended period." A user who never edits the template therefore implicitly trusts the backup keys for live host-script execution, with no `HOST_HASH` pin by default. If a backup key (potentially under weaker operational protection) were compromised, every default-install Parcel host would accept a host script signed by it.

No prior review compared the default `VALID_SIGNERS` contents against the constitution's primary/backup distinction.

**Fix:** Default `VALID_SIGNERS` to the two primary keys (`88FF…`, `56C3…`) only; document backup keys as opt-in. Alternatively, write the template with the primary-only default uncommented so the user sees and can edit it.

---

### L3 — `HOST_HASH` hashes a bash here-string; mismatches documented basis
**File:** `parcel-host:150`; `SECURITY.md:49-53`
**Severity: LOW | Confidence: 7/10**

`HASH=$($SHA256 <<< "$SCRIPT" | awk '{print $1}')`. The here-string appends a trailing newline, so the computed hash is of `<script content>\n` rather than the on-disk `src/parcel-host` the user is told to pin. A user following `sha256sum src/parcel-host` may get a different value than the bootstrap expects, leading to a confusing refuse-to-run loop — and the error message emits the here-string-based hash, so the user is told to trust a value that does not correspond to the shipped artifact. This undercuts the most-recommended hardening control.

**Fix:** Hash via `printf '%s' "$SCRIPT" | "$SHA256" | awk '{print $1}'` (no added newline) and make the documented user-facing recipe identical. This also makes `HOST_HASH` independently verifiable, which is the whole point of the control.

---

### L4 — Default rate-limit burst ≥ typical store size
**File:** `src/parcel-host:30-31, 63`; `schema.js` defaults
**Severity: LOW | Confidence: 7/10**

With default-allow-all entries (`.parcel.json` absent) and `decryptBucket=24`, a compromised extension can exfiltrate **24 entries immediately** — i.e. the entire visible store for any user with ≤24 entries (the common case). The rate limiter therefore provides near-zero *burst* protection in the default config; it only bounds *continuing* exfiltration after the burst. `SECURITY.md` frames the limiter as "reducing the potential damage" — for small stores that reduction is effectively zero. Setting `decryptRate=0` or `decryptBucket=0` disables limiting entirely, which is documented but plausibly mis-typed.

No prior review assessed the default-allow-all × default-burst interaction.

**Fix:** Lower the default `decryptBucket` to (e.g.) 3-5 or scale to visible entry count; require an explicit boolean sentinel for disabling rather than the numeric `0`. Document that the default burst can exfiltrate a small store in one shot.

---

### L5 — `LOGFILE` path is unvalidated
**File:** `parcel-host:80-85, 83-84`
**Severity: LOW | Confidence: 7/10**

`parcelrc` is sourced as bash, so `LOGFILE` is arbitrary. CONSTITUTION §1.3.3 allows the host to "create and append to a dedicated log file," but there is no confinement check. A malicious `parcelrc` could set `LOGFILE=/dev/null` (silencing audit) or point it at a sensitive file the user did not intend to overwrite-create/append. Subsumed by the `parcelrc`-as-code-execution trust model, but the audit log is specifically the defence-in-depth control that survives a compromised extension, and an unconstrained `LOGFILE` undermines its forensic value.

**Fix:** Constrain `LOGFILE` to a configurable directory (e.g. `~/.local/log/` or `~/.cache/parcel/`), or warn if it points outside the user's home.

---

### L6 — Audit log file mode not pinned to 0600
**File:** `parcel-host:84`; `src/parcel-host:265-276`
**Severity: LOW | Confidence: 8/10**

The log file is opened with `exec 5>>"$LOGFILE"` and the directory created with `mkdir -p` — neither applies a `chmod`. Under standard `umask 022`, the log file is mode 0644 (world-readable). When `auditDecrypt: true`, the log records entry paths, origin URLs, intents, and results — metadata revealing which password entries exist and which origins requested them. Plaintext credentials are never logged (verified: `audit_decrypt` at `src/parcel-host:275` logs only the result message, never the plaintext).

**Fix:** `chmod 0600 "$LOGFILE"` after creation, mirroring `parcelrc` handling.

---

### L7 — `web_accessible_resources` exposes 6 JS modules unnecessarily
**File:** `src/manifest.json:33-47`
**Severity: LOW | Confidence: 8/10**

The WAR list includes `js/helpers.js`, `js/integration.js`, `js/popup.js`, `js/schema.js`, `js/selectors.js`, `js/targets.js` matched against `<all_urls>`. The documented rationale ("all required by the popup") does not hold: the popup runs in the *extension origin* and loads its modules via `import(chrome.runtime.getURL(...))` (`popup.js:4-5`, `integration.js:4-6`), which works from extension context regardless of WAR. `integration.js` is a declared content script and does not need WAR. The only resources that genuinely must be web-accessible are `html/popup.html` and `img/logo-small.svg`.

Exposing the JS modules lets any website `fetch(chrome.runtime.getURL("js/selectors.js"))` and read the exact selector/target heuristics — fingerprinting/probing, not secret leakage. The prior GLM-5.2 review (F5) deferred to a maintainer claim that narrowing breaks functionality; that claim was never tested against how the popup/content scripts actually load modules.

**Fix:** Reduce WAR to `["html/popup.html", "img/logo-small.svg"]`; re-add only a specific module if a given browser rejects `import(chrome.runtime.getURL(...))` from content-script context without WAR.

---

### L8 — Fill-history keys globally readable from any content-script context
**File:** `src/js/popup.js:398, 561, 619-621`; `src/js/agent.js:84`
**Severity: LOW | Confidence: 8/10**

Fill history is persisted under `history:<scope>:<originHash>` where `originHash = sha256(url.origin)`. `chrome.storage.local` is a single shared store for the entire extension, and any content script (running on an attacker page, given `<all_urls>` + `all_frames`) holds the `storage` permission and can call `chrome.storage.local.get(null)` to enumerate every key across every origin. The values contain the SHA-256 of the pass entry path, the container-scope hash, and the fill timestamp. Pass entry paths are frequently guessable (`gmail.com`, `github.com/user`), so the hashes are brute-forceable — letting an attacker-origin content script infer which *other* sites the user holds credentials for and when they were last used. `SECURITY.md` §"Storage isolation" claims per-profile/Multi-Account-Container isolation but does not claim per-origin isolation in the storage area itself; the per-origin key naming gives a false sense of isolation.

**Fix:** Partition history so foreign-origin entries cannot be read from an attacker origin (e.g. `session` storage keyed to the tab, or host-mediated origin-keyed store); or keep history only in the background worker's memory. At minimum, document that cross-origin enumeration is possible.

---

### L9 — MAIN-world `shadow.js` event and `parcel-frame-id` postMessage are forgeable
**File:** `src/js/shadow.js:14-37`; `src/js/integration.js:54-59, 422-429`
**Severity: LOW | Confidence: 8/10**

`shadow.js` (MAIN world, `manifest.json:21`) overrides `Element.prototype.attachShadow`, tags click targets with `parcel-shadow-event="<uuid>"`, and dispatches `document.dispatchEvent(new CustomEvent("parcel-shadow-click", { detail: { host, target, x, y } }))`. `integration.js` (isolated world) listens for that event and treats it as trusted. Because the MAIN and isolated worlds share the DOM, any page can forge it: set `parcel-shadow-event="X"` on a chosen element and dispatch the custom event with `detail: { target: "X", ... }`. This bypasses the `is-shadow` guard, registers the attacker element in `targetBindings`, and opens the Parcel popup anchored to that element. Impact is limited (the user must still pick an entry to decrypt; no plaintext disclosed), but it is a real boundary-bridging primitive.

Related: `window.top.postMessage({ action: "parcel-frame-id", frameId }, "*")` (`integration.js:72`) uses target `"*"` and the top-frame handler performs no origin check, so any embedding page can spoof a frame's `_parcelFrameId`.

**Fix:** Do not trust MAIN-world-dispatched events; bind the `parcel-shadow-event` token to a value the isolated world generates and the MAIN world cannot predict, or move click detection entirely into the isolated world. For `parcel-frame-id`, restrict `targetOrigin` and verify `ev.source`.

---

### L10 — `$SHA256` used unquoted in command position
**File:** `parcel-host:150`
**Severity: LOW | Confidence: 8/10**

`HASH=$($SHA256 <<< "$SCRIPT" | awk '{print $1}')` leaves `$SHA256` unquoted. `SHA256` is set from `command -v sha256sum || command -v sha256` — not attacker-controlled, and standard system paths contain no spaces, so this is not exploitable today. But if the binary lives in a path containing spaces (non-standard install, some macOS Homebrew layouts), word splitting would break the command. Fail-closed (empty hash → `HOST_HASH` mismatch → refuse to run), so the failure mode is safe.

**Fix:** Quote the expansion: `"$SHA256" <<< "$SCRIPT" | awk '{print $1}'`.

---

### L11 — GPG status output leaked to the extension on signature failure
**File:** `parcel-host:140, 144`
**Severity: LOW | Confidence: 8/10**

On signature-verification failure, the full GPG status output `$OUT` is included in the `parcel_error` message sent back to the extension: `"Signature verification failed: No primary fingerprint:\n$OUT"` / `"... Invalid primary fingerprint:\n$OUT"`. `$OUT` contains `VALIDSIG`/`BADSIG`/`NO_PUBKEY`/`IMPORT_OK` lines, key fingerprints, and trust state — internal GPG configuration details. Fingerprints are public and the extension is the party that submitted the signature, so the leak is low-impact, but it is gratuitous.

**Fix:** Log the full `$OUT` to FD 5 for debugging; send the extension only a generic "Signature verification failed" message.

---

### L12 — `action_$ACTION` dispatch ungated by regex
**File:** `parcel-host:178-179`; `src/parcel-host` dispatch convention
**Severity: LOW | Confidence: 7/10**

`ACTION="$(jq -r .action <<< "$MESSAGE")"` then `if [ "$(type -t "action_$ACTION")" = "function" ]`. There is no whitelist/regex on `ACTION`. The prior GLM-5.2 review noted this is not exploitable today because `type -t` returns empty for non-matching names and only safe `action_*` functions exist. That analysis is correct. The recommendation is defence-in-depth: a regex guard `[[ "$ACTION" =~ ^[a-z_]+$ ]]` would future-proof against an accidentally-introduced `action_debug_*` being exposed to extension control.

**Fix:** Add a regex allow-list before the `type -t` lookup, in both bootstrap and inner host.

---

### L13 — `HOST_HASH` comparison is non-constant-time
**File:** `parcel-host:151`
**Severity: LOW | Confidence: 9/10**

`[ "$HASH" != "$HOST_HASH" ]` short-circuits on first mismatch. There is no remote attacker who can measure timing (the comparison is local, between a locally-computed hash and a locally-stored pin, over a stdin/stdout pipe with no byte-level timing feedback). Reported for completeness only.

**Fix:** Optional — `cmp --silent` or `sha256sum -c` if a constant-time primitive is desired for hygiene.

---

## Deliberate Design Tradeoffs (acknowledged, not findings)

The following are documented in `SECURITY.md` and judged adequate for the stated power-user threat model:

- **Plaintext bash host instead of compiled binary** — prioritises auditability; a compiled binary could hide malicious behaviour obvious in shell. Sound.
- **`HOST_HASH` off by default** — creates friction; opt-in with strong recommendation. Acceptable, given L3 above should be fixed so the opt-in is verifiable.
- **Absent `.parcel.json` reveals all entries** — an empty password store is not useful; restriction is opt-in. Acceptable for the audience, but L4 (burst capacity) materially weakens the mitigation for small stores.
- **Content script injected into `<all_urls>`** — required to detect forms before user interaction; the content script does not execute remote code or communicate externally. Acceptable; M1 would add technical enforcement for extension pages.
- **No clipboard auto-clear** — auto-clear would require `clipboardRead` (a larger attack surface than the leak it prevents). Sound tradeoff.
- **Extension detectable / fingerprintable** — acknowledged necessity; L7 would shrink the surface.
- **`allowLinks: false` / `allowExternalLinks: false` defaults** — adequate, now correctly enforced pre-traversal (#57 resolved).
- **GPG keys shipped in `keys/`** — verified public-only (no `PRIVATE KEY` markers); appropriate as the bootstrap keyring source.

## Things Done Well

- **Host-side enforcement of the whitelist + decrypt-time revalidation** (`src/parcel-host:361-401`, `validate_decrypt_path_policy:339-358`). The TOCTOU re-walk of symlink components at decrypt time is a genuinely strong property few password managers implement.
- **No dangerous DOM sinks.** Repo-wide grep for `innerHTML`/`insertAdjacentHTML`/`document.write`/`eval`/`new Function` in `src/js/` returns zero matches. Credential data is written via `.value`/`.setAttribute`/`textContent`/`<template>.content.cloneNode`.
- **No network primitives in shipped JS.** `XMLHttpRequest`/`WebSocket`/`new Image`/`<img>` construction absent; the only `fetch(` calls target `chrome.runtime.getURL(...)` for bundled resources (`agent.js:54,57,533`).
- **GPG `VALIDSIG` field-12 selection** (`parcel-host:139`) correctly extracts the *primary* fingerprint even for subkey signatures, and multi-signature forgery fails closed (multiline `SIGNER` fails the regex).
- **Native-messaging framing** uses `LC_ALL=C` (`parcel-host:26`) for byte-accurate `${#1}`, 16MiB size cap, clean EOF handling.
- **`@sh` escaping for `ALLOWED_FILES`** (`src/parcel-host:258`) via `jq -rc 'map(.path) | @sh'` — no shell injection via crafted filenames.
- **`SINCE` timestamp validation** (`src/parcel-host:136`) strictly regex-guarded before reaching `date -d`/`find -newermt`.
- **Audit-log control-character stripping** (`src/parcel-host:270-274`) via `${var//[[:cntrl:]]/}` and per-field length truncation.
- **`path_is_within` prefix match** (`src/parcel-host:321-325`) uses trailing-slash `"$PARENT/"*`, preventing the `/home/user/.password-store-evil` bypass.
- **GPG invocation isolation** (`src/parcel-host:394`) reads the file via stdin redirection, not a filename argument — GPG cannot be tricked into operating on a different file.
- **`eval "$PARCEL_HOST"` integrity** (`parcel-host:217`) — the `eval`'d string is the exact `$SCRIPT` variable that was GPG-verified; no re-read from disk between verification and execution.
- **Rate-limiter fail-safe** — negative elapsed (clock skew) reduces tokens; non-numeric `decryptRate` causes `awk` to return non-zero (rate ≠ 0), so limiting is *not* disabled by a malformed config.
- **Temp keyring cleanup** (`parcel-host:125,131,135`) on both success and failure, including the `~` backup GPG creates.
- **Strict schema with unknown-property rejection** (`schema.js:84-87`) — prototype-pollution keys become "unknown property"; regex `format` enforced; `structuredClone` for defaults.
- **Per-field UUID tokens via `crypto.randomUUID()`** (`agent.js:325-327`) — `"broadcast"` is the only reusable token.
- **Origin for matching derived from `tab.url`** (`popup.js:397, 559`) — the page cannot spoof the top-level tab origin for `match`.
- **Cross-origin-iframe fill is warned, not silent** (`popup.js:472-483`).

---

## Second-Look Review

After consolidating the three subagent reports, I re-examined the source directly to verify the highest-impact claims and check for misinterpretations or missed issues. This surfanced the following refinements:

1. **M3 nuance — confirmed but bounded.** I verified `agent.js:322-333` and `:345-355`: the `auth` gate applies only to `port.name === "popup"`. A content-script `"integration"` port sending `decrypt` does reach `#callNative("decrypt", ...)` and receives the plaintext. However, the host's `ALLOWED_FILES` whitelist (`src/parcel-host:371-383`) still bounds *which* paths can be decrypted — the gate that is bypassed is the per-popup authorisation layer, not the host whitelist. The audited `origin` is indeed forwarded verbatim from `message.origin` (`agent.js:350`), not `port.sender.tab.url`. The js-review's severity rating (LOW) is defensible given web pages cannot drive this today, but I have raised it to MEDIUM because it is directly relevant to the *compromised-extension* threat model `SECURITY.md` explicitly scopes, and because it defeats the audit log precisely when that control is needed.

2. **M2 — re-bootstrap behaviour confirmed.** `agent.js` top-level `new Agent()` plus constructor `#connectNative()` is grep-confirmed; no `onStartup`/`onInstalled`/`chrome.alarms` exists. The `parcel-host:214-228` re-`eval` path on every `install` is real. The design-review's "amplification surface" characterisation is fair but not a vulnerability.

3. **L7 — WAR narrowing rationale verified.** I confirmed `popup.js:4-5` and `integration.js:4-6` load modules via `import(chrome.runtime.getURL(...))` from extension contexts, which does not require WAR. The documented "required by the popup" justification does not hold for the listed JS files. The single genuine WAR need is `html/popup.html` (loaded as an iframe `src` from the content-script context); `img/logo-small.svg` is likely needed by the popup iframe. I recommend verifying empirically before narrowing, as one Firefox/Chrome version quirk could require a specific module.

4. **L3 — here-string newline verified.** `parcel-host:150` uses `<<< "$SCRIPT"`. Bash here-strings append `\n`. `jq -r '.script'` strips JSON escaping. Whether `sha256sum src/parcel-host` matches depends on whether the shipped file's trailing newline matches the here-string's — the point is the documentation does not specify this and the user is told to pin "the SHA-256 hash of `src/parcel-host`", which is ambiguous. The fix (`printf '%s' "$SCRIPT"`) makes the two identical.

5. **M1 — verified that `fetch` is only used for extension-internal resources** (`agent.js:54,57,533`). A stricter `connect-src 'none'` would not break any current code path in the popup. The service worker is a separate matter — MV3 SW CSP cannot be restricted via `extension_pages` — so M1 applies to the popup only, as stated.

### What might still be missed

- **Public-suffix list handling.** `agent.js` references a `#publicSuffixList` and `src/publicsuffix` exists; I did not deeply audit the PSL parsing for ReDoS or canonicalisation bugs that could cause `match` to return entries for the wrong eTLD+1. The schema review covered `schema.js` and accepted the regex handling; a focused PSL audit is a candidate follow-up if the PSL is attacker-influenceable.
- **`additionalSelectors`/`additionalTargets`/`targets` from `.parcel.json`.** The js-review confirmed these are schema-validated (`SelectorSchema`/`TargetSchema`, `transform` is an enum, patterns must compile with the `u` flag). A malicious config could still inject selectors that match benign fields and cause Parcel to *offer* to fill the wrong field, but the user must still initiate the fill. I did not find a way for these to cause XSS or exfiltration, but a dedicated config-fuzzing pass would be valuable.
- **`plaintext.js` value-derivation logic.** The js-review covered the file but did not deeply audit the `Helpers.getValue` derivation (e.g. TOTP, multi-line parsing) for off-by-one or format-confusion bugs that could leak the wrong line into a form field. Targeted fuzzing of `getValue` against malformed `pass` entries would be worthwhile.
- **Native-host `set -e` + `pipefail` interaction under partial reads.** The host-review confirmed native-messaging framing is safe, but the interaction of `set -e` with `read` returning non-zero on a partial last line (no trailing newline) was not exhaustively tested for every code path. The 16MiB cap and `LC_ALL=C` framing make this low-risk, but a property-based test of the framing layer would be a good hardening step.
- **CI workflow.** The design-review noted `actions/checkout@v6`/`actions/setup-node@v6` are major-version-mutable refs (acceptable per the SupplyChainAttack non-issue for official GitHub namespaces); `permissions: contents: read` is minimal and correct. Pinning to commit SHAs would be stricter but is commonly considered acceptable for first-party actions.

### Confidence calibration

The findings with the highest confidence (8-9/10) are those I personally re-verified against the source (M1, M2, M3, L1, L2, L3, L7, L9, L11, L13). The remaining LOW findings (L4-L8, L10, L12) rest on the subagents' reading, which I cross-checked against the cited file:line references and found accurate for every spot I re-examined. Where a subagent and my reading disagreed on severity (M3), I have noted both perspectives.

---

## Summary

Parcel is a well-engineered extension with a correct trust-boundary design. No finding here permits an untrusted website to decrypt non-whitelisted credentials; the host-side enforcement model holds. The most impactful improvements, in priority order:

1. **M3** — Gate `decrypt`/`match` to authorised popup ports and derive the audited origin from `port.sender.tab.url`. This closes the audit-log-bypass path under the extension-compromise threat model.
2. **M1** — Add `connect-src 'none'; frame-src 'none'; base-uri 'self';` to the extension-page CSP. Free, technically enforces the no-network rule for the popup.
3. **M2** — Document (and optionally mitigate) the MV3 service-worker restart lifecycle.
4. **L3** — Fix `HOST_HASH` to hash the exact script bytes so the documented pin is verifiable.
5. **L2** — Default `VALID_SIGNERS` to primary keys only.
6. **L4 / L6 / L1** — Tighten default burst capacity, pin log file mode, and check config/log directory permissions.

The remaining LOW items are worthwhile hardening and documentation-alignment work, not vulnerabilities.


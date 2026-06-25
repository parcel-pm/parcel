# Security Review Findings

This document outlines the findings from security reviews conducted on the project, and the maintainers' responses to them. Duplicate findings, and findings that do not detail a security vulnerability (e.g. simply note designed behaviour as intended / acceptable) are not listed, but are still present in the full reports.

## [security-review-glm_5.2-20260625-9278905.md](reviews/security-review-glm_5.2-20260625-9278905.md)

Automated security review using GLM 5.2, conducted on June 25, 2026 against commit 9278905.

No CRITICAL or HIGH exploitable vulnerabilities were identified. The review surfaces three MEDIUM hardening opportunities (M1–M3) and thirteen LOW items (L1–L13). Findings already addressed in prior reviews are omitted here.

### M1 — Extension-page CSP omits `connect-src` / `frame-src` / `base-uri`

**Description:** The manifest CSP was `script-src 'self'; object-src 'self';`, which left the documented "no network" rule human-enforced even for the popup, where it could be a technical boundary. `SECURITY.md` correctly notes that `<all_urls>` prevents a manifest-level network block for content scripts and the service worker, but incorrectly extrapolated that to extension pages.

**Response:** Addressed in #68 by adding `connect-src 'none'; frame-src 'none'; base-uri 'self';` to the `extension_pages` CSP. The popup only talks over runtime ports and loads bundled resources, so the stricter directives do not break any code path.

### M2 — MV3 service-worker restart loses state and re-`eval`s the signed host

**Description:** `agent.js` instantiated `new Agent()` at top level with no `onStartup` / `onInstalled` hook and no `chrome.alarms` keepalive. On MV3 service-worker termination the constructor re-ran and re-opened the native port, but the reconnection path was implicit (a side-effect of the first port connection) rather than deterministic, and the lifecycle was undocumented.

**Response:** Addressed in #67 by adding `chrome.runtime.onStartup` and `onInstalled` listeners that call a new idempotent `#ensureNativeConnected()` helper. The `onNativeDisconnect` reconnect path now uses the same helper, giving deterministic reconnection semantics. The re-`eval` of the `HOST_HASH`-verified host script on each cold start is considered acceptable: the script is GPG-verified and hash-pinned before execution.

### M3 — `decrypt`/`match` reachable from non-popup ports; audited origin is attacker-controlled

**Description:** In `Agent.#connect`, only `port.name === "popup"` ports required an `auth` token. Every other connected port fell into the same `onMessage` handler, which accepted `match`, `decrypt`, and `sha256`. A compromised extension context could therefore exfiltrate any whitelisted entry via a non-popup port without going through the popup authorisation gate, and `message.origin` was forwarded to the host and audit log verbatim rather than being reconciled against `port.sender.tab.url`. The host's `ALLOWED_FILES` whitelist still bounded _which_ entries were decryptable, but the per-popup authorisation gate and audit-log integrity were bypassable under the compromised-extension threat model.

**Response:** Addressed in #69 by adding a port-name-to-action allow-list: `decrypt` and `match` are restricted to authorised popup ports, content-script (`integration`) ports are limited to `config` only, and unknown actions are rejected for all port types.

### L1 — Missing directory permission check on `~/.config/parcel/` and `~/.local/log/`

**Description:** The bootstrap enforces `parcelrc` mode `0600` but does not verify the mode of the containing directory. Under `umask 000` or on shared systems where `~/.config/parcel/` is world-writable, an attacker with local access could TOCTOU-replace `parcelrc` between the permission check and the `source`, yielding arbitrary code execution. The same gap applies to `~/.local/log/`. Under standard `umask 022` the directories are `0755` (safe).

**Response:** _pending..._

### L2 — Default `VALID_SIGNERS` trusts the "backup-only" keys equally with primaries

**Description:** Template `parcelrc` has `VALID_SIGNERS` commented out; the bootstrap then falls back to a hard-coded list of all four release keys — including two that `CONSTITUTION.md` designates "backup purposes only". A user who never edits the template therefore implicitly trusts the backup keys for live host-script execution, with no `HOST_HASH` pin by default.

**Response:** _pending..._

### L3 — `HOST_HASH` hashes a bash here-string, mismatching the documented basis

**Description:** `HOST_HASH` is computed via `<<< "$SCRIPT"` (here-string), which appends a trailing newline. The resulting hash does not correspond to the on-disk `src/parcel-host` the user is told to pin via `sha256sum`, leading to a confusing refuse-to-run loop and undermining the most-recommended hardening control.

**Response:** _pending..._

### L4 — Default rate-limit burst ≥ typical store size

**Description:** With default-allow-all entries (`.parcel.json` absent) and `decryptBucket=24`, a compromised extension can exfiltrate 24 entries immediately — i.e. the entire visible store for any user with ≤24 entries. The rate limiter therefore provides near-zero _burst_ protection in the default config; it only bounds _continuing_ exfiltration after the burst.

**Response:** _pending..._

### L5 — `LOGFILE` path is unvalidated

**Description:** `parcelrc` is sourced as bash, so `LOGFILE` is arbitrary. A malicious `parcelrc` could set `LOGFILE=/dev/null` (silencing audit) or point it at a sensitive file. This is subsumed by the `parcelrc`-as-code-execution trust model, but the audit log is the defence-in-depth control that survives a compromised extension, and an unconstrained `LOGFILE` undermines its forensic value.

**Response:** _pending..._

### L6 — Audit log file mode not pinned to 0600

**Description:** The log file is opened with `exec 5>>"$LOGFILE"` and the directory created with `mkdir -p` — neither applies a `chmod`. Under standard `umask 022`, the log file is mode `0644` (world-readable), exposing entry paths and origin URLs. Plaintext credentials are never logged.

**Response:** _pending..._

### L7 — `web_accessible_resources` exposes JS modules unnecessarily

**Description:** The WAR list includes `js/helpers.js`, `js/integration.js`, `js/popup.js`, `js/schema.js`, `js/selectors.js`, and `js/targets.js` matched against `<all_urls>`. The documented "required by the popup" rationale does not hold: the popup runs in the extension origin and loads its modules via `import(chrome.runtime.getURL(...))`, which works regardless of WAR. `integration.js` is a declared content script and does not need WAR. Only `html/popup.html` and `img/logo-small.svg` genuinely require web-accessibility. Exposing the JS modules lets any website fetch them and read the exact selector/target heuristics (fingerprinting, not secret leakage).

**Response:** _pending..._

### L8 — Fill-history keys globally readable from any content-script context

**Description:** Fill history is persisted under `history:<scope>:<originHash>` in `chrome.storage.local`, a single shared store. Any content script on an attacker page holds the `storage` permission and can call `chrome.storage.local.get(null)` to enumerate every key across every origin. Pass entry paths are frequently guessable, so the stored hashes are brute-forceable — letting an attacker-origin content script infer which other sites the user holds credentials for.

**Response:** _pending..._

### L9 — MAIN-world `shadow.js` event and `parcel-frame-id` postMessage are forgeable

**Description:** `shadow.js` dispatches a `parcel-shadow-click` custom event from the MAIN world, and `integration.js` in the isolated world treats it as trusted. Because the MAIN and isolated worlds share the DOM, any page can forge the event and open the Parcel popup anchored to a chosen element. Separately, `window.top.postMessage({ action: "parcel-frame-id", frameId }, "*")` uses target `"*"` with no origin check on the receiver, so any embedding page can spoof a frame's `_parcelFrameId`. Impact is limited (the user must still pick an entry to decrypt; no plaintext disclosed).

**Response:** _pending..._

### L10 — `$SHA256` used unquoted in command position

**Description:** `HASH=$($SHA256 <<< "$SCRIPT" | awk '{print $1}')` leaves `$SHA256` unquoted. `SHA256` is set from `command -v sha256sum || command -v sha256`, which is not attacker-controlled and standard system paths contain no spaces, so this is not exploitable today. If the binary lived in a path containing spaces, word splitting would break the command. Fail-closed (empty hash → `HOST_HASH` mismatch → refuse to run), so the failure mode is safe.

**Response:** _pending..._

### L11 — GPG status output leaked to the extension on signature failure

**Description:** On signature-verification failure, the full GPG status output (`$OUT`) is included in the `parcel_error` message sent back to the extension. `$OUT` contains `VALIDSIG`/`BADSIG`/`NO_PUBKEY`/`IMPORT_OK` lines, key fingerprints, and trust state — internal GPG configuration details. Fingerprints are public and the extension is the party that submitted the signature, so the leak is low-impact but gratuitous.

**Response:** _pending..._

### L12 — `action_$ACTION` dispatch ungated by regex

**Description:** `ACTION="$(jq -r .action <<< "$MESSAGE")"` is followed directly by `if [ "$(type -t "action_$ACTION")" = "function" ]` with no whitelist or regex on `ACTION`. This is not exploitable today because `type -t` returns empty for non-matching names and only safe `action_*` functions exist. A regex guard `[[ "$ACTION" =~ ^[a-z_]+$ ]]` would future-proof against an accidentally-introduced `action_debug_*` being exposed to extension control.

**Response:** _pending..._

### L13 — `HOST_HASH` comparison is non-constant-time

**Description:** `[ "$HASH" != "$HOST_HASH" ]` short-circuits on first mismatch. There is no remote attacker who can measure timing (the comparison is local, between a locally-computed hash and a locally-stored pin, over a stdin/stdout pipe with no byte-level timing feedback).

**Response:** _pending..._

## [security-review-copilot-gpt_5.4-20260617-8023edb.md](reviews/security-review-copilot-gpt_5.4-20260617-8023edb.md)

Automated security review using Copilot GPT 5.4, conducted on June 17, 2026 against commit 8023edb68ad9fbf7bb66e90e22f4993168d9664a.

This review idetified one new low-priority hardening opportunity.

### `allowLinks: false` does not stop symlink traversal during host scans

**Description:** The host's entry-list and cache-invalidation scans follow symlinks **before** applying the configured link policy, which could result in a DoS if a symlink within the password store points to a very large or busy directory.

**Response:** Addressed in #57 by applying the link policies before running traversal operations, plus a few other tightening measures.

## [security-review-copilot-glm_5.2-20260617-8023edb.md](reviews/security-review-copilot-glm_5.2-20260617-8023edb.md)

Automated security review using Copilot GLM 5.2, conducted on June 17, 2026 against commit 8023edb68ad9fbf7bb66e90e22f4993168d9664a.

Existing findings from the previous review are omitted, as they are already listed in the section for that review.

### Audit-log line assembly is unbounded in the MESSAGE slot when decryption fails with a long error

**Description:** The per-field length caps added in #56 bound each audit-log field individually, but the overall assembled log line is not capped. The failure-path `MESSAGE` values are host-defined constants (not attacker-controlled), and `auditDecrypt` is opt-in with rate-limited decryption gating entries, so the realistic log-growth risk is low.

**Response:** This is considered acceptable. The remaining risk is very low, and any resulting pollution should not impact the usability of the log in the event of an incident.

### A world or group writable `~/.config/parcel/` could be abused to replace the `0600`-permission `parcelrc`.

**Description:** The bootstrap enforces that `parcelrc` has `0600` permissions, but does not verify the mode or ownership of the containing directory. On shared systems or where a misconfigured package manager created `~/.config/parcel` group/world-writable, the `0600` check could be bypassed via a rename/rename-over replacement of the file.

**Response:** This is a very unlikely scenario. The finding is noted, but the only user who could achieve this and *still pass the 0600 check on `parcelrc` afterwards* is `root` (because chown `parcelrc` to the user is required, which non-`root` users cannot do). The status quo is therefore considered acceptable.

## [security-review-copilot-kimi_K2.7-20260617-d8de751.md](reviews/security-review-copilot-kimi_K2.7-20260617-d8de751.md)

Automated security review using Copilot / Kimi K2.7, conducted on June 17, 2026 against commit d8de751e4fc4629f2c8e0a2cede24b63e819ade1.

No security vulnerabilities were identified in this review. The review notes one low-priority hardening opportunity:

### Audit-log field length caps

**Description:** Audit log fields are stripped of control characters, but are not explicitly truncated to a maximum byte length. In practice the values are constrained by the caller, but an explicit cap would add defense-in-depth against accidental log bloat.

**Response:** This was already addressed in #56, but GitHub seems to have lost the commit after merging. Have re-merged it manually.

## [security-review-copilot-kimi_K2.6-20260615-293a1b2.md](reviews/security-review-copilot-kimi_K2.6-20260615-293a1b2.md)

Automated security review using Copilot / Kimi K2.6, conducted on June 15, 2026 against commit 293a1b26d76510e53a89608ceb4979c47260f5f9.

New findings are listed below. Existing findings from the previous review are omitted, as they are already listed in the section for that review.

### Log-bloating via unbounded audit-log fields

**Description:** The audit log strips control characters but does not limit the length of fields such as `FILE_PATH`, `INTENT`, or `ORIGIN`,
which could allow a compromised extension to cause unbounded log growth.

**Response:** Added length limits to these fields in #56.

### No Content Security Policy declared in manifest

**Description:** The extension relies on the browser's default MV3 CSP rather than an explicit declaration.

**Response:** Added CSP to manifest in #55.

### Search regex ReDoS risk in service worker

**Description:** User-provided search terms are compiled as regular expressions without length limits or ReDoS checks, which could
transiently hang the service worker.

**Response:** If the user wishes to DoS themselves via a typed regular expression, that's on them ;-). The status quo is therefore
acceptable.

### `shadow.js` runs in MAIN world and patches global prototype

**Description:** `shadow.js` patches `Element.prototype.attachShadow` in the page's JavaScript realm, which increases detectability and
exposes a small interference surface.

**Response:** This is considered an acceptable tradeoff. The patch supports core functionality, and alternatives have significant
performance penalties.

## [security-review-copilot-gpt_5.4-20260614-v1.0.0.md](reviews/security-review-copilot-gpt_5.4-20260614-v1.0.0.md)

Automated security review using Copilot GPT 5.4, conducted on June 14, 2026 against the v1.0.0 release.

There are no unaddressed findings remaining from this review.

### GPG auto-import lets rejected install attempts pollute the user's keyring

**Description:** `gpg --auto-key-import` pollutes the user's keyring with release keys when verifying the host signature.

**Response:** Resolved in #46 by using a temporary keyring for signature verification.

### Audit logs can be forged or polluted through unsanitized fields

**Description:** Some audit fields are passed from the extension directly to the audit log contents, which could allow an attacker to forge
or pollute audit log entries.

**Response:** Resolved in #48 by stripping control characters from audit log fields.

### "No network access" is a governance rule, not a technical containment boundary

**Description:** The "no network access" rule is a governance rule that relies on user compliance, and is not a technical containment
boundary.

**Response:** This is addressed in [SECURITY.md](../SECURITY.md), and is a deliberate tradeoff. It is not possible to technically enforce
no network access and also allow the extension to interact with the page. This is therefore enforced at a policy level during code review.

### Default visibility is intentionally permissive and increases blast radius

**Description:** If the user has not configured a whitelist, the extension will provide a default that shows all entries in the password
store.

**Response:** This is addressed in [SECURITY.md](../SECURITY.md), and is a deliberate tradeoff for the sake of usability. The popup will
display a persistent warning at the top (immediately above the search bar) until the user configures a whitelist.

### parcelrc is a trusted code-execution boundary and should be treated as such

**Description:** The `.parcelrc` file is sourced as executable code, in a similar manner to a `bashrc` file.

**Response:** This is deliberate, but has been hardened further in #50 by enforcing an 0600 permission on `parcelrc` and refusing to load if
this constraint is not met.

### Inline autofill across origin boundaries is warning-only

**Description:** The extension will warn (via `alert()`) if a user tries to fill into an origin that doesn't match the tab (e.g. iframe
login forms), but still allows users to proceed with filling anyway.

**Response:** This is deliberate. The target audience for this extension is security-conscious power users, and it is assumed that they are
competent enough to make their own choice regarding whether proceeding with the fill is an acceptable action. The protection approach here is
therefore to ensure that they are aware of the situation, and then get out of the way.

### `web_accessible_resources` is broader than necessary and enables easy fingerprinting

**Description:** The extension's `web_accessible_resources` is broader than necessary, which allows any website to detect the presence of
the extension and fingerprint users based on the extension's unique ID.

**Response:** The listed files are all required by the popup. Narrowing this list is not possbile without breaking the extension.
The resulting fingerprint surface is considered an acceptable tradeoff to allow the extension to function.

### History metadata is obscured, not truly secret

**Description:** The extension's history uses an unsalted hash of the origin / scope and the entry path. This allows an attacker with access
to local storage to brute-force which entries have been used on which origins.

**Response:** This is deliberate. The history is convenience metadata, not a secret, and adding salting or encryption would simply be an
obfuscation measuer that would give a false sense of security. Users who are concerned about this can disable history entirely via the
`saveHistory` configuration option.

### `HOST_HASH` resolution order is fragile on systems that rely on `parcelrc` `PATH` changes

**Description:** The bootstrap looks for the sha256 binary before loading `parcelrc`, which means that `parcelrc` cannot set the `PATH` for
this operation.

**Response:** Resolved in 49 by moving the sha256 setup to after `parcelrc` is loaded.


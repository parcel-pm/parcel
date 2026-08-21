# Security Review Findings

This document outlines the findings from security reviews conducted on the project, and the maintainers' responses to them. Duplicate findings, and findings that do not detail a security vulnerability (e.g. simply note designed behaviour as intended / acceptable) are not listed, but are still present in the full reports.

## [v1.0.6 / kimi-k3 + glm-5.2](reviews/v1.0.6/merged-glm-5.2.md)

Two-model security review using kimi-k3 and glm-5.2, merged August 19, 2026 against Parcel v1.0.6 (commit `03fec5a`, tag `v1.0.6`; release review — HEAD is at the tag, 0 commits ahead). Both models independently completed both phases of the review protocol including cross-verification.

No CRITICAL or HIGH vulnerabilities are exploitable in the v1.0.6 committed tree. The merged record carries seven findings: one CRITICAL (fixed in release, not exploitable in the shipped tree), one MEDIUM, and five LOW. Both models report `make test` passing 440/440 (31 suites, up from 407 in v1.0.5) and verified the committed `chrome/`/`firefox/` bundles byte-identical to `src/`. The central security event of the release is #144, which anchors the bootstrap's signer-extraction `grep` to the genuine `[GNUPG:] VALIDSIG` status-line prefix; both models agree the v1.0.6 tree is not vulnerable, verified live against GnuPG 2.4.9 with a malicious-UID key. Three findings are disputed between the models (F52C reachability, F57L & F58L finding-vs-residual); the editor recorded the canonical severities and both positions verbatim.

### F52C — `VALIDSIG` signer extraction was forgeable via an unanchored grep (CRITICAL; fixed in #144 / v1.0.6)

**Description:** The bootstrap signer check used unanchored `grep VALIDSIG | cut -f12`; a crafted GPG key whose UID embeds a `VALIDSIG <trusted-fpr> ...` substring would set `SIGNER_VALID=true` and trigger `eval` of attacker host code (TM2/TM3). Fixed in #144 by anchoring on `^\[GNUPG:] VALIDSIG`; the v1.0.6 tree is not vulnerable (both models agree). Pre-fix reachability through shipped v1.0.5 is disputed (kimi: rejected by the F41L multi-line containment accident; glm: reachable).

**Response:** <maintainer reponse pending>

### F53M — Concurrent host processes multiply the persisted rate-limiter budget (MEDIUM)

**Description:** F35M's persisted token bucket has no locking around `load_state → compute → save_state`; K parallel `connectNative()` processes each observe a full bucket and spend independently, multiplying the documented rate by K. Same TM2 class the limiter documents against. Whitelist and audit log still bound impact.

**Response:** <maintainer reponse pending>

### F54L — Unvalidated `otpauth://` `digits`/`period` → large-allocation DoS / timer churn in browser-side TOTP (LOW)

**Description:** `Helpers.generateTOTP` trusts `digits` verbatim; a store-controlled `otpauth://` URI with `digits=1e8` triggers a ~100 MB `padStart` allocation, hanging or OOM-crashing the popup (TM4). `period=0` defeats the `|| 30` default and drives 50 ms refresh churn. No credential or host impact.

**Response:** <maintainer reponse pending>

### F55L — `clientDataJSON.crossOrigin` hardcoded `false` for cross-origin-iframe ceremonies (LOW)

**Description:** `buildClientDataJSON` hardcodes `"crossOrigin": false`, so cross-origin-iframe ceremonies (#138) mislabel themselves as same-origin. The `origin` field remains correct and signature binding is host-enforced; impact is contingent on RP behaviour that inspects `crossOrigin`/`topOrigin`. No credential misdirection. TM0-adjacent interop defect.

**Response:** <maintainer reponse pending>

### F56L — No adversarial regression test for the #144 VALIDSIG-injection fix (LOW)

**Description:** The mock GPG emits no `GOODSIG` line, so no test crafts a malicious-UID line that would pass the old unanchored grep but fail the anchored one; reverting the #144 fix fails zero tests. Rated LOW (both models) rather than INFORMATIONAL because a silent regression re-opens host-code execution (TM5).

**Response:** <maintainer reponse pending>

### F57L — Schema unknown-property rejection is prototype-subvertible (LOW)

**Description:** The unknown-key gate tests `schema.properties[key]` for truthiness; since it's a plain object, keys like `__proto__`/`constructor`/`toString` resolve via `Object.prototype` and pass. Inert today (no dynamic config-key reads). Disputed: glm classifies residual (no reachable exploit), kimi reports LOW. TM4 / TM2-adjacent.

**Response:** <maintainer reponse pending>

### F58L — MetaSchema nested self-recursion never fires (LOW)

**Description:** `MetaSchema` self-recursion never validates nested property values — `Schema.validate` consumes `items` only in the array branch and `properties` only in the object branch, so malformed nested schemas (e.g. `maxLengh` typo) pass silently. Developer-time only; schemas are author-controlled. Disputed: glm residual, kimi LOW. TM0.

**Response:** <maintainer reponse pending>

## [v1.0.5 / kimi-k3 + deepseek-v4](reviews/v1.0.5/merged-glm-5.2.md)

Two-model security review using kimi-k3 and deepseek-v4, conducted on August 8, 2026 against Parcel v1.0.5 (commit `6b0f1a7`). Both models independently completed the two-phase review protocol including cross-verification.

No CRITICAL or HIGH vulnerabilities were identified. The review records one MEDIUM, seven LOW, and four INFORMATIONAL findings. Both models independently confirmed every finding from the other's exchange file (with two severity disagreements and one disputed-finding-vs-residual classification, recorded in the merged report). No regressions of prior fixes were found; `make test` passes 407/407.

### F40M — Popup authorisation gate bypassable by any extension context via the `"broadcast"` / self-issued `auth` token (MEDIUM)

**Description:** The F20M fix (#69) gate is silently bypassable: the literal string `"broadcast"` authenticates a `popup`-named port without token issuance, and any context can push self-chosen tokens into `#authorisedTokens` via an `auth`-named port with no `port.sender` validation. A compromised content script (TM2) can drive silent, UI-less `decrypt`/`match` of whitelisted entries with an attacker-chosen audit `origin`. The host whitelist and rate limiter still bound the blast radius.

**Response:** — Rejected; not a valid finding. This token is already documented in the code as a *correlation* identifier linking clicked fields to contextual fills; it's not intended as a defence against a compromised isolated-world extension script. The behaviour is precisely as intended and within the documented threat model.

### F41L — Multi-signer signature blob: signer extraction relies on fail-closed regex accident (LOW)

**Description:** If a detached-signature blob contains two signatures, `grep VALIDSIG`/`cut` yields a multi-line string that fails the textual containment check only because of the embedded newline. The control works today (fails closed) but rests on an emergent property rather than an explicit single-signer assertion; a refactor could change this silently. TM5.

**Response:** — Rejected; not a valid finding. Only a valid signature from a key listed in `VALID_SIGNERS` can pass this gate. By chance, this finding happened to expose an inability to properly handle multi-sig files (rejects when should approve) - this capability is added in #129.

### F42L — `passkeyDir` lacks `..`/absolute-path validation, weakening textual `.gpg-id` store containment (LOW)

**Description:** `passkey_op_create` rejects control characters and glob metacharacters in `passkeyDir` but not `..` or leading `/`. The `.gpg-id` walk reads out-of-store files because the containment test is purely textual (a `../`-containing path textually starts with `$STORE_ROOT/`). Recipient selection for a generated passkey can be taken from an out-of-store `.gpg-id`. Config-controlled precondition; narrow chain — hence LOW.

**Response:** — Fixed in #130; these are now checked and rejected.

### F43L — Firefox lacks `ancestorOrigins`: frame-id broadcast falls back to `"*"`, receiver applies no origin check (LOW)

**Description:** The F28T narrowing uses `location.ancestorOrigins` (Chrome-only). On Firefox the broadcast target falls back to `"*"`, and the receive handler checks only `ev.source` with no `ev.origin` validation, allowing a cross-origin embedder to forge/relabel iframe `_parcelFrameId`. Impact limited to popup-position confusion; fill delivery is token-bound. Coverage gap in F28T's mitigation, not a contradiction of the accepted core. TM1.

**Response:** — Status quo is acceptable. The only consequence of a successful attack is repositioning the Parcel UI, and Firefox lacks the necessary API surface to lock this down further. Cross-origin support is a legitimate and desired feature.

### F44L — Page-forged `parcel-webauthn-conflict` event surfaces a false conflict modal; can suppress genuine notices (LOW)

**Description:** `handlePasskeyConflict` trusts a forgeable DOM `CustomEvent`. A page can surface a false "another extension controls passkeys" modal and, on user dismissal, persist a per-origin `passkeyConflictDismissed` entry that suppresses genuine later conflict notices. No signature/decryption consequence — the ceremony path re-derives everything isolated-side. TM1.

**Response:** — Status quo is acceptable. The attacker could just as easily be hooking the *actual* API (producing a *real* conflict) with the same outcome. Either way, it's being tampered with, and we shouldn't touch it.

### F45L — Packaging `rsync` lacks `--delete`; stale files ship on ad-hoc builds (LOW)

**Description:** `make chrome`/`make firefox` sync with `rsync -av` (no `--delete`) and no destination pre-clean. Files removed/renamed in `src/` between manual builds persist in the output tree, weakening source↔distribution parity. The `release` target is safe (depends on `clean`), but the coupling is implicit. TM5.

**Response:** — Added `--delete` in #131.

### F46L — State-file fail-open lets a same-user process reset the rate-limiter bucket; writes follow symlinks (LOW)

**Description:** `load_state` returns an empty bucket on any unloadable state (missing, wrong permissions, invalid content, or symlink detection), and `check_decrypt_rate_limit` seeds a full 24-token burst. A same-UID hostile process (TM4) can trivially reset the rate limiter, softening the F35M persistence guarantee. Writes follow symlinks. No browser-reachable path; the actor already holds stronger primitives.

**Response:** — Rejected; this is out-of-scope for Parcel. The rate-limiter guards against a compromised *extension*. A bad actor with permission to perform this attack is already acting as the user, outside of both the browser and parcel-host's ability to contain.

### F47L — `action_changes_since` does not abort after rejecting an invalid `.since` (LOW)

**Description:** On an invalid `.since` timestamp, `action_changes_since` calls `parcel_error` but does not `return`, continuing into `date -d`/`find -newermt` with the unvalidated value. No injection (the value is a quoted argument); the malformed `find` fails closed (no changes reported). Best-effort robustness defect.

**Response:** — Rejected; this is cosmetic only. Added a `return 0` anyway for clarity.

### F48I — Unescaped `entry.path` in `querySelector` — store-controlled selector render break (INFORMATIONAL)

**Description:** `popup.js:1066` interpolates store-controlled `entry.path` into `querySelector` without `CSS.escape`. A pathological filename throws `SyntaxError`, breaking popup rendering for that origin. No code execution (querySelector cannot execute code); all other rendering sinks use `textContent`/`createTextNode`. TM4 (store-write access required).

**Response:** — `CSS.escape` added in #132.

### F49I — Unbounded `#authorisedTokens` / `targetBindings` growth via synthetic clicks (INFORMATIONAL)

**Description:** Each synthetic `click()` mints a UUID token into `#authorisedTokens`; bindings survive disconnect. A hostile page can grow these without bound (transient memory pressure; no disclosure). Bounded by per-frame lifetime. TM1.

**Response:** — Rejected; this isn't a practical attack vector and pages can already do many other things that cause a lot more memory pressure than this.

### F50I — Regression-test gaps over fixed security gates (INFORMATIONAL)

**Description:** Four fixed gates lack adversarial regression coverage: audit-field truncation assertions, hostile action-string dispatch tests, popup-side fill-`origin` field assertion, and per-container history isolation. Additionally, state-file symlink/fail-open paths are unexercised. All are defence-regression detectors, not live holes.

**Response:** — Noted. Test coverage for non-whitelisted port actions expanded in #132.

### F51I — `fill-value` and `frameOrigin`-undefined edge skip the destination-origin guard (INFORMATIONAL)

**Description:** The origin guard only fires when the message carries an `origin` key. The `fill-value` action never carries `origin`, and an undefined `frameOrigin` is dropped by structured-clone. No reachable exploit: `fill-value` values come from already-decrypted plaintext; the `frameOrigin`-undefined edge resolves before any real fill. The maintainer-rejected half of F36L.

**Response:** — Rejected; no practical exploit exists.

## [v1.0.4 / kimi-k3](reviews/v1.0.4/kimi-k3.md)

Automated security review using Copilot / Kimi K3, conducted on August 1, 2026 against Parcel v1.0.4 (commit 9df096d).

No CRITICAL or HIGH vulnerabilities were identified. The review records one MEDIUM finding (F35M) and one LOW finding (F36L), plus informational items (F37L, F38I, F39T). F35M was verified dynamically with a native-messaging harness driving the real host scripts.

### F35M — Decryption rate limiter is per-process; trivially reset by a compromised extension context (MEDIUM)

**Description:** The host's decryption token bucket is per-process: repeating the `install` action on a live connection re-`eval`s the host script and resets the bucket, and fresh `connectNative()` processes each start with a full bucket.

**Response:** Addressed in #116 by persisting token-bucket state to a dedicated state file.

### F36L — Popup-driven `fill` / `fill-value` messages omit `origin`, so the #106 destination-origin guard never applies to the primary fill path (LOW)

**Description:** The #106 destination-origin check only runs when the message carries an `origin` property; only the broadcast fallback supplies it, while the primary popup path's `fill` and `fill-value` messages do not, so the guard silently never runs there.

**Response:** The primary `fill` path is addressed in #118. The `fill-value` half is rejected; there is no exploit path for it.

### F37L — `scripts/pre-commit-gitleaks` downloads and executes the latest unpinned gitleaks binary (INFO/LOW)

**Description:** The opt-in developer pre-commit hook pipes the latest gitleaks release tarball straight into `tar -xz` with no version pin, checksum, or signature verification.

**Response:** Addressed in #123 by pinning gitleaks to a specific version / hash.

### F38I — Stale port-action comment in `agent.js` (INFO)

**Description:** The comment above `PORT_ACTIONS` says integration ports may request `config`/`sha256`, but the map grants `config` only.

**Response:** Addressed in commit 27dd6f2; comment now matches the allow-list (`integration` → `config` only).

### F39T — In-page popup host element is fully page-stylable/removable (INFO; inherent)

**Description:** The inline popups are appended to page DOM, so a page can remove, hide, or overlay the host element with a spoofed look-alike UI, deceiving even users who verify the displayed origin.

**Response:** Rejected; this is an inherent and obvious limitation of the page controlling its own environment, with no clear viable exploit path.

## [v1.0.2 / glm-5.2](reviews/v1.0.2/glm-5.2.md)

Automated security review using GLM 5.2, conducted on July 15, 2026 against Parcel v1.0.2 (commit 4d4bbc9).

No CRITICAL or HIGH vulnerabilities were identified. The review records two findings: one MEDIUM (F34M) and one LOW (F33T).

### F33T — `config` endpoint leaks the full config (incl. password-store home path) to unauthenticated integration ports (LOW)

**Description:** The agent's `config` handler returns the entire config object — including the host-injected `passdir` / `realPassdir` (revealing the OS home path / username) — to unauthenticated `integration` ports that never consume those fields. Reachable only under the compromised-extension threat model; information disclosure only, no credential exposure.

**Response:** Noted, and accepted as-is. Passdir can be inferred from entry locations anyway, and stripping this isn't worth the maintenance burden.

### F34M — Broadcast fill path performs no destination-origin validation; mid-decrypt navigation can exfiltrate a credential to a different origin (MEDIUM)

**Description:** The broadcast fill fallback delivers a decrypted credential to whichever content script is resident in the tab's root frame, with no destination-origin validation. Mid-decrypt cross-origin navigation could route a credential intended for origin A to a different origin B; the popup path's origin check is advisory-only.

**Response:** Addressed in #106 by verifying the current origin against the intended origin supplied by the popup.

## [20260625-9278905 / glm-5.2](reviews/other/glm-5.2-20260625-9278905.md)

Automated security review using GLM 5.2, conducted on June 25, 2026 against commit 9278905.

No CRITICAL or HIGH exploitable vulnerabilities were identified. The review surfaces three MEDIUM hardening opportunities (F18M–F20M) and thirteen LOW items (F21T, F22L, F23T–F32T). Findings already addressed in prior reviews are omitted here.

### F18M — Extension-page CSP omits `connect-src` / `frame-src` / `base-uri`

**Description:** The manifest CSP was `script-src 'self'; object-src 'self';`, which left the documented "no network" rule human-enforced even for the popup, where it could be a technical boundary. `SECURITY.md` correctly notes that `<all_urls>` prevents a manifest-level network block for content scripts and the service worker, but incorrectly extrapolated that to extension pages.

**Response:** Addressed in #68 by adding `connect-src 'none'; frame-src 'none'; base-uri 'self';` to the `extension_pages` CSP. The popup only talks over runtime ports and loads bundled resources, so the stricter directives do not break any code path.

### F19M — MV3 service-worker restart loses state and re-`eval`s the signed host

**Description:** `agent.js` instantiated `new Agent()` at top level with no `onStartup` / `onInstalled` hook and no `chrome.alarms` keepalive. On MV3 service-worker termination the constructor re-ran and re-opened the native port, but the reconnection path was implicit (a side-effect of the first port connection) rather than deterministic, and the lifecycle was undocumented.

**Response:** Addressed in #67 by adding `chrome.runtime.onStartup` and `onInstalled` listeners that call a new idempotent `#ensureNativeConnected()` helper. The `onNativeDisconnect` reconnect path now uses the same helper, giving deterministic reconnection semantics. The re-`eval` of the `HOST_HASH`-verified host script on each cold start is considered acceptable: the script is GPG-verified and hash-pinned before execution.

### F20M — `decrypt`/`match` reachable from non-popup ports; audited origin is attacker-controlled

**Description:** In `Agent.#connect`, only `port.name === "popup"` ports required an `auth` token. Every other connected port fell into the same `onMessage` handler, which accepted `match`, `decrypt`, and `sha256`. A compromised extension context could therefore exfiltrate any whitelisted entry via a non-popup port without going through the popup authorisation gate, and `message.origin` was forwarded to the host and audit log verbatim rather than being reconciled against `port.sender.tab.url`. The host's `ALLOWED_FILES` whitelist still bounded _which_ entries were decryptable, but the per-popup authorisation gate and audit-log integrity were bypassable under the compromised-extension threat model.

**Response:** Addressed in #69 by adding a port-name-to-action allow-list: `decrypt` and `match` are restricted to authorised popup ports, content-script (`integration`) ports are limited to `config` only, and unknown actions are rejected for all port types.

### F21T — Default `VALID_SIGNERS` trusts the "backup-only" keys equally with primaries

**Description:** Template `parcelrc` has `VALID_SIGNERS` commented out; the bootstrap then falls back to a hard-coded list of all four release keys — including two that `CONSTITUTION.md` designates "backup purposes only". A user who never edits the template therefore implicitly trusts the backup keys for live host-script execution, with no `HOST_HASH` pin by default.

**Response:** This behaviour is by design. A backup key must still be trusted in order to be *used*, should a situation arise where using a backup key is necessary. As such, they are included in the default set of trusted keys.

### F22L — `HOST_HASH` hashes a bash here-string, mismatching the documented basis

**Description:** `HOST_HASH` is computed via `<<< "$SCRIPT"` (here-string), which appends a trailing newline. The resulting hash does not correspond to the on-disk `src/parcel-host` the user is told to pin via `sha256sum`, leading to a confusing refuse-to-run loop and undermining the most-recommended hardening control.

**Response:** Resolved in #71 by ensuring the exact script bytes are hashed.

### F23T — Default rate-limit burst ≥ typical store size

**Description:** With default-allow-all entries (`.parcel.json` absent) and `decryptBucket=24`, a compromised extension can exfiltrate 24 entries immediately — i.e. the entire visible store for any user with ≤24 entries. The rate limiter therefore provides near-zero _burst_ protection in the default config; it only bounds _continuing_ exfiltration after the burst.

**Response:** This is incorrect; typical stores are considerably larger. The status quo is therefore acceptable.

### F24T — `LOGFILE` path is unvalidated

**Description:** `parcelrc` is sourced as bash, so `LOGFILE` is arbitrary. A malicious `parcelrc` could set `LOGFILE=/dev/null` (silencing audit) or point it at a sensitive file. This is subsumed by the `parcelrc`-as-code-execution trust model, but the audit log is the defence-in-depth control that survives a compromised extension, and an unconstrained `LOGFILE` undermines its forensic value.

**Response:** This value is set by the user, and `parcelrc` is implicitly a trusted file. If they point the log output somewhere stupid, that is their own fault. The threat is reduced by enforcing the 0600 permission on `parcelrc`.

### F25T — Audit log file mode not pinned to 0600

**Description:** The log file is opened with `exec 5>>"$LOGFILE"` and the directory created with `mkdir -p` — neither applies a `chmod`. Under standard `umask 022`, the log file is mode `0644` (world-readable), exposing entry paths and origin URLs. Plaintext credentials are never logged.

**Response:** It is acceptable for the permissions on this file not to be pinned. However 0600 is a more sensible default, and is now set on logfile creation.

### F26T — `web_accessible_resources` exposes JS modules unnecessarily

**Description:** The WAR list includes `js/helpers.js`, `js/integration.js`, `js/popup.js`, `js/schema.js`, `js/selectors.js`, and `js/targets.js` matched against `<all_urls>`. The documented "required by the popup" rationale does not hold: the popup runs in the extension origin and loads its modules via `import(chrome.runtime.getURL(...))`, which works regardless of WAR. `integration.js` is a declared content script and does not need WAR. Only `html/popup.html` and `img/logo-small.svg` genuinely require web-accessibility. Exposing the JS modules lets any website fetch them and read the exact selector/target heuristics (fingerprinting, not secret leakage).

**Response:** Most of these files are needed in WAR for the extension to function. Every single remaining file in WAR has been empirically verified to be necessary.

### F27T — Fill-history keys globally readable from any content-script context

**Description:** Fill history is persisted under `history:<scope>:<originHash>` in `chrome.storage.local`, a single shared store. Any content script on an attacker page holds the `storage` permission and can call `chrome.storage.local.get(null)` to enumerate every key across every origin. Pass entry paths are frequently guessable, so the stored hashes are brute-forceable — letting an attacker-origin content script infer which other sites the user holds credentials for.

**Response:** Local storage is scoped to the extension; only Parcel content-scripts can read it. The status quo is therefore acceptable.

### F28T — MAIN-world `shadow.js` event and `parcel-frame-id` postMessage are forgeable

**Description:** `shadow.js` dispatches a `parcel-shadow-click` custom event from the MAIN world, and `integration.js` in the isolated world treats it as trusted. Because the MAIN and isolated worlds share the DOM, any page can forge the event and open the Parcel popup anchored to a chosen element. Separately, `window.top.postMessage({ action: "parcel-frame-id", frameId }, "*")` uses target `"*"` with no origin check on the receiver, so any embedding page can spoof a frame's `_parcelFrameId`. Impact is limited (the user must still pick an entry to decrypt; no plaintext disclosed).

**Response:** The suggested fixes are nonsensical; there is no API which allows doing this from the isolated world. Additionally, any webpage can call `click()` on its own DOM elements (so forged events are a non-issue anyway, as the page can simply dispatch a real one). The target for `postMessage` has been narrowed in scope via `Location.ancestorOrigins`.

### F29L — `$SHA256` used unquoted in command position

**Description:** `HASH=$($SHA256 <<< "$SCRIPT" | awk '{print $1}')` leaves `$SHA256` unquoted. `SHA256` is set from `command -v sha256sum || command -v sha256`, which is not attacker-controlled and standard system paths contain no spaces, so this is not exploitable today. If the binary lived in a path containing spaces, word splitting would break the command. Fail-closed (empty hash → `HOST_HASH` mismatch → refuse to run), so the failure mode is safe.

**Response:** Fixed in #71.

### F30L — GPG status output leaked to the extension on signature failure

**Description:** On signature-verification failure, the full GPG status output (`$OUT`) is included in the `parcel_error` message sent back to the extension. `$OUT` contains `VALIDSIG`/`BADSIG`/`NO_PUBKEY`/`IMPORT_OK` lines, key fingerprints, and trust state — internal GPG configuration details. Fingerprints are public and the extension is the party that submitted the signature, so the leak is low-impact but gratuitous.

**Response:** Resolved in commit 0c9be39cdc6023f3c361b6621bea2e5984f46c20.

### F31L — `action_$ACTION` dispatch ungated by regex

**Description:** `ACTION="$(jq -r .action <<< "$MESSAGE")"` is followed directly by `if [ "$(type -t "action_$ACTION")" = "function" ]` with no whitelist or regex on `ACTION`. This is not exploitable today because `type -t` returns empty for non-matching names and only safe `action_*` functions exist. A regex guard `[[ "$ACTION" =~ ^[a-z_]+$ ]]` would future-proof against an accidentally-introduced `action_debug_*` being exposed to extension control.

**Response:** Added regex gate on action names in commit ffeae492ed1980232a8368bb4ba68083795447ea.

### F32T — `HOST_HASH` comparison is non-constant-time

**Description:** `[ "$HASH" != "$HOST_HASH" ]` short-circuits on first mismatch. There is no remote attacker who can measure timing (the comparison is local, between a locally-computed hash and a locally-stored pin, over a stdin/stdout pipe with no byte-level timing feedback).

**Response:** A constant-time comparison here is unnecessary; a timing attack on the hash is not a practical attack surface.

## [20260617-8023edb / gpt-5.4](reviews/other/gpt-5.4-20260617-8023edb.md)

Automated security review using Copilot GPT 5.4, conducted on June 17, 2026 against commit 8023edb68ad9fbf7bb66e90e22f4993168d9664a.

This review idetified one new low-priority hardening opportunity.

### F17L — `allowLinks: false` does not stop symlink traversal during host scans

**Description:** The host's entry-list and cache-invalidation scans follow symlinks **before** applying the configured link policy, which could result in a DoS if a symlink within the password store points to a very large or busy directory.

**Response:** Addressed in #57 by applying the link policies before running traversal operations, plus a few other tightening measures.

## [20260617-8023edb / glm-5.2](reviews/other/glm-5.2-20260617-8023edb.md)

Automated security review using Copilot GLM 5.2, conducted on June 17, 2026 against commit 8023edb68ad9fbf7bb66e90e22f4993168d9664a.

Existing findings from the previous review are omitted, as they are already listed in the section for that review.

### F15T — Audit-log line assembly is unbounded in the MESSAGE slot when decryption fails with a long error

**Description:** The per-field length caps added in #56 bound each audit-log field individually, but the overall assembled log line is not capped. The failure-path `MESSAGE` values are host-defined constants (not attacker-controlled), and `auditDecrypt` is opt-in with rate-limited decryption gating entries, so the realistic log-growth risk is low.

**Response:** This is considered acceptable. The remaining risk is very low, and any resulting pollution should not impact the usability of the log in the event of an incident.

### F16T — A world or group writable `~/.config/parcel/` could be abused to replace the `0600`-permission `parcelrc`.

**Description:** The bootstrap enforces that `parcelrc` has `0600` permissions, but does not verify the mode or ownership of the containing directory. On shared systems or where a misconfigured package manager created `~/.config/parcel` group/world-writable, the `0600` check could be bypassed via a rename/rename-over replacement of the file.

**Response:** This is a very unlikely scenario. The finding is noted, but the only user who could achieve this and *still pass the 0600 check on `parcelrc` afterwards* is `root` (because chown `parcelrc` to the user is required, which non-`root` users cannot do). The status quo is therefore considered acceptable.

## [20260617-d8de751 / kimi-k2.7](reviews/other/kimi-k2.7-20260617-d8de751.md)

Automated security review using Copilot / Kimi K2.7, conducted on June 17, 2026 against commit d8de751e4fc4629f2c8e0a2cede24b63e819ade1.

No security vulnerabilities were identified in this review. The review notes one low-priority hardening opportunity (F14L):

### F14L — Audit-log field length caps

**Description:** Audit log fields are stripped of control characters, but are not explicitly truncated to a maximum byte length. In practice the values are constrained by the caller, but an explicit cap would add defense-in-depth against accidental log bloat.

**Response:** This was already addressed in #56, but GitHub seems to have lost the commit after merging. Have re-merged it manually.

## [20260615-293a1b2 / kimi-k2.6](reviews/other/kimi-k2.6-20260615-293a1b2.md)

Automated security review using Copilot / Kimi K2.6, conducted on June 15, 2026 against commit 293a1b26d76510e53a89608ceb4979c47260f5f9.

New findings are listed below. Existing findings from the previous review are omitted, as they are already listed in the section for that review.

### F10L — Log-bloating via unbounded audit-log fields

**Description:** The audit log strips control characters but does not limit the length of fields such as `FILE_PATH`, `INTENT`, or `ORIGIN`,
which could allow a compromised extension to cause unbounded log growth.

**Response:** Added length limits to these fields in #56.

### F11L — No Content Security Policy declared in manifest

**Description:** The extension relies on the browser's default MV3 CSP rather than an explicit declaration.

**Response:** Added CSP to manifest in #55.

### F12T — Search regex ReDoS risk in service worker

**Description:** User-provided search terms are compiled as regular expressions without length limits or ReDoS checks, which could
transiently hang the service worker.

**Response:** If the user wishes to DoS themselves via a typed regular expression, that's on them ;-). The status quo is therefore
acceptable.

### F13T — `shadow.js` runs in MAIN world and patches global prototype

**Description:** `shadow.js` patches `Element.prototype.attachShadow` in the page's JavaScript realm, which increases detectability and
exposes a small interference surface.

**Response:** This is considered an acceptable tradeoff. The patch supports core functionality, and alternatives have significant
performance penalties.

## [v1.0.0 / gpt-5.4](reviews/v1.0.0/gpt-5.4.md)

Automated security review using Copilot GPT 5.4, conducted on June 14, 2026 against the v1.0.0 release.

There are no unaddressed findings remaining from this review.

### F1M — GPG auto-import lets rejected install attempts pollute the user's keyring

**Description:** `gpg --auto-key-import` pollutes the user's keyring with release keys when verifying the host signature.

**Response:** Resolved in #46 by using a temporary keyring for signature verification.

### F2M — Audit logs can be forged or polluted through unsanitized fields

**Description:** Some audit fields are passed from the extension directly to the audit log contents, which could allow an attacker to forge
or pollute audit log entries.

**Response:** Resolved in #48 by stripping control characters from audit log fields.

### F3T — "No network access" is a governance rule, not a technical containment boundary

**Description:** The "no network access" rule is a governance rule that relies on user compliance, and is not a technical containment
boundary.

**Response:** This is addressed in [SECURITY.md](../SECURITY.md), and is a deliberate tradeoff. It is not possible to technically enforce
no network access and also allow the extension to interact with the page. This is therefore enforced at a policy level during code review.

### F4T — Default visibility is intentionally permissive and increases blast radius

**Description:** If the user has not configured a whitelist, the extension will provide a default that shows all entries in the password
store.

**Response:** This is addressed in [SECURITY.md](../SECURITY.md), and is a deliberate tradeoff for the sake of usability. The popup will
display a persistent warning at the top (immediately above the search bar) until the user configures a whitelist.

### F5T — parcelrc is a trusted code-execution boundary and should be treated as such

**Description:** The `.parcelrc` file is sourced as executable code, in a similar manner to a `bashrc` file.

**Response:** This is deliberate, but has been hardened further in #50 by enforcing an 0600 permission on `parcelrc` and refusing to load if
this constraint is not met.

### F6T — Inline autofill across origin boundaries is warning-only

**Description:** The extension will warn (via `alert()`) if a user tries to fill into an origin that doesn't match the tab (e.g. iframe
login forms), but still allows users to proceed with filling anyway.

**Response:** This is deliberate. The target audience for this extension is security-conscious power users, and it is assumed that they are
competent enough to make their own choice regarding whether proceeding with the fill is an acceptable action. The protection approach here is
therefore to ensure that they are aware of the situation, and then get out of the way.

### F7T — `web_accessible_resources` is broader than necessary and enables easy fingerprinting

**Description:** The extension's `web_accessible_resources` is broader than necessary, which allows any website to detect the presence of
the extension and fingerprint users based on the extension's unique ID.

**Response:** The listed files are all required by the popup. Narrowing this list is not possbile without breaking the extension.
The resulting fingerprint surface is considered an acceptable tradeoff to allow the extension to function.

### F8T — History metadata is obscured, not truly secret

**Description:** The extension's history uses an unsalted hash of the origin / scope and the entry path. This allows an attacker with access
to local storage to brute-force which entries have been used on which origins.

**Response:** This is deliberate. The history is convenience metadata, not a secret, and adding salting or encryption would simply be an
obfuscation measuer that would give a false sense of security. Users who are concerned about this can disable history entirely via the
`saveHistory` configuration option.

### F9L — `HOST_HASH` resolution order is fragile on systems that rely on `parcelrc` `PATH` changes

**Description:** The bootstrap looks for the sha256 binary before loading `parcelrc`, which means that `parcelrc` cannot set the `PATH` for
this operation.

**Response:** Resolved in 49 by moving the sha256 setup to after `parcelrc` is loaded.


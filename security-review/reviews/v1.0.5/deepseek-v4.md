# Security Review — Parcel v1.0.5

## 1. Executive Summary

This review covers Parcel v1.0.5 (commit `6b0f1a7`, tree clean, HEAD == `v1.0.5` release tag). It is a comprehensive, independent audit of the extension and its signed bash native host, conducted under the two-phase protocol in `security-review/prompt.md`.

**Overall posture: strong.** The codebase is defensively hardened and the changes landed in v1.0.5 are, in the main, direct responses to prior findings that are now correctly in place: a persisted, validated rate-limiter state file (F35M, #116), frame-origin tracking for fill verification (F36L, #118), a strict state-file content validator (#125, #119), a TOCTOU/desync guard in entry listing (#122), a pinned gitleaks hook (F37L, #123), and lifecycle robustness (F19M, #117).

**Finding counts by severity:** 0 CRITICAL, 0 HIGH, 1 MEDIUM, 7 LOW, 3 INFORMATIONAL, plus a Residual/Hardening section. The single MEDIUM (port-authorisation self-issuance) was surfaced independently by the cross-model reviewer and confirmed here; several LOW items also originate from cross-verification (I record each as my own re-derived analysis). Most items overlap, to varying degrees, a documented and accepted tradeoff or the documented "compromised extension reads whitelisted entries" worst-case; I have been explicit about that boundary throughout.

**Single most important takeaway:** the native-host enforcement boundary holds. The extension cannot read non-whitelisted files, cannot obtain passkey private keys, and the rate limiter now survives process restarts. The residual items that merit attention are (a) the rate-limiter state file's deliberate fail-open, (b) the self-issuable extension-side port-authorisation token (documented as a correlation identifier, not a TM2 control), and (c) a robustness defect in `action_changes_since`. None of these, as far as I can trace, rises to a reachable credential-exfiltration, key-exfiltration, or boundary-bypass scenario.

## 2. Trust Model & Attack Surfaces

I examined every component by direct read of the current tree (no reliance on prior review text).

**Trust-boundary hierarchy (my own structural analysis):**

1. **The GPG master/private keys** (never touched by Parcel) and the encrypted store. The highest-value asset.
2. **The signed native host (`src/parcel-host`)** — the enforcement boundary. It holds the only capability to decrypt, and it alone enforces whitelist membership, symlink policy, rate limiting, rpId binding, and passkey consent. Its trust is established by the bootstrap's GPG signature verification + optional `HOST_HASH` pin.
3. **The bootstrap host (`parcel-host`)** — verifies (2) and provides the message loop. It is the first thing the (potentially hostile) extension talks to.
4. **The service worker (`agent.js`)** — the extension's trusted core; brokers native messaging and authorises port actions. A compromise here is assumed (TM2) to give an attacker host interaction within the bounded action set.
5. **Content scripts / popup / MAIN-world scripts** — the browser-side surfaces exposed (partly) to page influence (TM1).

**Attack surfaces and where the line is drawn:** page-realm code (TM1) controls the DOM, can forge CustomEvent/postMessage bridges, and can read anything deliberately filled into a page-owned field — but cannot open extension runtime ports, cannot reach the native port, and cannot steer a ceremony's origin (origin/rpId are re-derived in the isolated world and re-validated in the worker and the host). A compromised extension context (TM2) can, at most, trigger whitelisted decrypts and passkey assertions subject to the host's whitelist, rpId-binding, and rate limiter — matching the SECURITY.md worst-case. A hostile local filesystem (TM4) can craft store contents and race Parcel's files, but must still beat the host's realpath/containment and exact-match whitelist membership, and any same-user actor who can tamper with `~/.config/parcel` already has a more direct path (F16T/F24T are accepted).

## 3. Methodology

- **Model identity:** `deepseek-v4-flash`. Operational suffix (`-flash`) omitted per §0 → filename form `deepseek-v4`. I could not introspect a per-session model label beyond the runtime banner; this matches the convention used by prior reports.
- **Date:** 2026-08-08.
- **Release version:** 1.0.5 (`.version`).
- **Refs:** `git rev-parse --short HEAD` = `6b0f1a7`; `git describe --tags --always` = `v1.0.5`; `git log -1` shows HEAD is the v1.0.5 release commit (2026-08-08); working tree clean. Release review path used.
- **Grounding documents read in full:** `CONSTITUTION.md`, `SECURITY.md`, `README.md` (architecture + configuration sections), `security-review/findings.md` (the canonical prior-findings record). **I did not open any file under `security-review/reviews/`** — `findings.md` is my only source on prior reviews. No violation to record.
- **Source examined (direct read):** `parcel-host` (bootstrap, 257 lines, full); `src/parcel-host` (main host, 902 lines, full); `src/js/agent.js` (full); `src/js/integration.js` (full); `src/js/popup.js` (full); `src/js/helpers.js`; `src/js/plaintext.js`; `src/js/schema.js`; `src/js/selectors.js`; `src/js/targets.js`; `src/js/webauthn.js`; `src/js/main-world/shadow.js`; `src/js/main-world/webauthn.js`; `src/js/integration.es6.js`; `src/html/popup.html`; `src/manifest.json`; `Makefile`; `src/Makefile`; `scripts/pre-commit-gitleaks`; `.gitleaks.toml`; `package.json`; and the test suite (`test/*.test.js`, `test/chrome-api-mock.js`).
- **Tests run:** `make test` — **407 passed, 0 failed** (includes `test-syntax`: prettier + eslint). No failures.
- **Differential scope:** `git diff v1.0.4..HEAD` reviewed to isolate new v1.0.5 security-relevant changes.
- **Subagent allocation:** Per §5, I attempted three parallel subagents (native-host+constitution; extension JS+WebAuthn+popup; manifest/build/tests+regressions). All three returned **empty turn-0 output** (no usable findings) and are listed as `idle`; they appear to have failed to produce output rather than reporting clean. Consequently **I performed the entire audit directly** — reading every file above myself. This strengthens rather than weakens the verification trail: every finding below is backed by my own `file:line` trace, not a delegated (unverified) report.
- **Empirical verification:** construction of a token-bucket arithmetic re-derivation (confirmed 24-token burst, 1 token/150 s sustained); state-file injection analysis (`validate_state_content` regex only admits `DECRYPT_BUCKET_TOKENS=digits` / `DECRYPT_BUCKET_LAST=digits`, so `eval` is safe); constitution mechanical checks (grep for `curl`/`wget`/`nc`/`> ` writes — only log file, state file, template `parcelrc`, temp keyring). No external sandbox tooling was required beyond the existing test suite.
- **Limitations:** no adversarial runtime harness was built for this review beyond the test suite; passkey and native-host behaviours were verified statically plus via the existing GPG-mocked native-host tests. Several candidate items could not be raised to a confirmed reachable scenario and are recorded only in Residual/Hardening or Second-Look, as the protocol requires.

## 4. Findings

### Consolidated findings table (exchanged in Phase 2, finalised after cross-verification)

| ID | severity | confidence | area | threat model | title | file:line |
|----|----------|------------|------|--------------|-------|-----------|
| F40M | MEDIUM | Medium | extension port-auth | TM2 | Port-authorisation gate (F20M boundary) is self-issuable: any extension context can open a `popup`-named port and authenticate via the public `broadcast` token (or a self-registered `auth` token), enabling silent, unattended `decrypt`/`match` of all whitelisted entries with no `port.sender` verification | src/js/agent.js:496-501, 548-567 |
| F46L | LOW | Medium | native host / rate-limiter | TM4 | State-file `load_state` fail-open lets a same-user hostile process reset the rate-limiter bucket; partially defeats F35M persistence | src/parcel-host:84-114, 384-436 |
| F47L | LOW | Low | native host / robustness | TM3 | `action_changes_since` does not abort after rejecting an invalid `.since`; malformed input continues into `date -d`/`find -newermt` | src/parcel-host:227-232 |
| F41L | LOW | High | native host / bootstrap | TM5/TM3 | Multi-signer signature blob: `grep VALIDSIG`/`cut` extraction is only fail-closed by a regex accident; no explicit single-`VALIDSIG` assertion | parcel-host:155-170 |
| F42L | LOW | Medium | native host / passkey | TM4/TM0 | `passkeyDir` not validated against `..`/absolute paths; textual `.gpg-id` containment can be bypassed (config-controlled) | src/parcel-host:731-736, 788-807 |
| F43L | LOW | Medium | extension (content script) | TM1 | Firefox lacks `ancestorOrigins`, so frame-id broadcast falls back to `postMessage(..., "*")` with no receive-side origin check (F28T resolution is Chromium-only) | src/js/integration.js:163-173, 151-155 |
| F44L | LOW | Medium | extension (content script) | TM1 | Page-forged `parcel-webauthn-conflict` CustomEvent surfaces a false conflict modal and can suppress a genuine per-origin notice; popup-annoyance only | src/js/integration.js:1059-1110, 1322 |
| F45L | LOW | Low | packaging / build | TM5 | `chrome`/`firefox` `rsync -av` lacks `--delete`; stale files can ship in ad-hoc builds | Makefile:42, 48 |
| F48I | LOW | Medium | extension popup | TM4 | Store-controlled `entry.path` into `querySelector` without `CSS.escape` (render-breaking, no injection sink) | src/js/popup.js:1066 |
| F51I | INFO | High | extension (content script) | TM1 | `fill-value` and the `frameOrigin`-undefined edge can skip the destination-origin guard; accepted halves of F36L | src/js/integration.js:1439-1444; src/js/popup.js:9, 1175 |
| F49I | INFO | High | extension (content script + agent) | TM1 | Unbounded `targetBindings`/`#authorisedTokens` growth via synthetic `click()`s (memory pressure, no disclosure) | src/js/integration.js:686-716; src/js/agent.js:496-501 |
| F50I | INFO | High | tests | TM2/TM1 | Regression-test gaps: state-file symlink/fail-open, audit caps, hostile action strings, popup-side fill `origin` assert, container history isolation | test/native-host.test.js; test/popup.test.js |

No CRITICAL / HIGH reachable vulnerabilities were identified.


---

### F46L — Rate-limiter state-file `load_state` fail-open can be reset by a same-user hostile process (LOW)

**Description.** `load_state` refuses to load (returns 0 with the bucket variables left empty) whenever the state file is missing, has wrong permissions, or contains any non-whitelisted content. When the bucket variables are empty, `check_decrypt_rate_limit` re-initialises them to a full bucket. A process running as the same user (TM4) can therefore trivially reset the rate limiter to a full burst by corrupting or deleting `~/.config/parcel/state`.

**Threat model(s).** TM4 (hostile local filesystem).

**Evidence.** `load_state` (src/parcel-host:84-114) returns 0 (refusing to load) in the bad-permission and invalid-content cases, leaving `DECRYPT_BUCKET_TOKENS`/`DECRYPT_BUCKET_LAST` empty; `check_decrypt_rate_limit` (src/parcel-host:401-408) then seeds a full bucket (`if [ -z "$DECRYPT_BUCKET_TOKENS" ] && [ -z "$DECRYPT_BUCKET_LAST" ]; then ... DECRYPT_BUCKET_TOKENS="$BUCKET_MILLIS"`). The comment at src/parcel-host:82-83 states this is "a deliberate fail-open for robustness".

**Exploit scenario.** An attacker with write access to `~/.config/parcel/state` (but *without* the ability to decrypt the GPG store) writes garbage into the file (or deletes it, or chmods it to 0644). The next decrypt's `load_state` fails open, the bucket resets to 24 tokens, and a concurrently-compromised extension (or the same actor driving the host) can immediately decrypt up to `decryptBucket` entries without waiting out the refill. The rate limiter's cross-restart persistence (F35M) is thereby neutralised by the very actor class it is a mitigation against.

**Assessment of reachability/severity.** This is strongest under a *multi-actor* scenario (a hostile helper process + a compromised extension), which is contrived. A single same-user hostile process that can write the state file either (a) already has direct read access to the encrypted store files (though not the plaintext without the GPG key) and, more importantly, (b) can tamper with `parcelrc`/the config dir with equal ease (accepted F16T/F24T). As a standalone control, the fail-open weakens F35M, but the attack requires an actor who in practice already holds comparable or greater influence. I rate this **LOW** with Medium confidence and note it is a deliberate, documented design decision — it sits at the boundary of an accepted tradeoff.

**Recommended fix.** On invalid state-file content or permissions, fail *closed* for the *current* decrypt (deny until the file is fixed) rather than silently resetting to a full bucket; or persist the last-known-good bucket in memory and continue counting from it when the on-disk value is corrupt. This preserves TOTP-style resilience without granting a free reset.

---

### F40M — Extension-side port-authorisation gate is self-issuable by any extension context (MEDIUM)

**Description.** The popup authorisation gate that F20M established — `decrypt`/`match` restricted to "authorised popup ports" — is gated by (a) a token in `#authorisedTokens`, which **any** caller can add by opening an `auth`-named port and posting an arbitrary string, or (b) the well-known literal `"broadcast"`. Consequently any extension context that can call `chrome.runtime.connect` (i.e. any content script, and a fortiori any other compromised extension script) can open a `popup`-named port, authenticate, and invoke `decrypt` on any whitelisted entry.

**Threat model(s).** TM2 (compromised extension context — specifically a compromised content script, without a compromised service worker).

**Evidence.** `auth` port handler (agent.js:496-501): `port.onMessage.addListener((token) => this.#authorisedTokens.add(token));` — no validation of what is added. Auth gate (agent.js:558-567): accepts `message.token === "broadcast"` unconditionally, or any token in `#authorisedTokens`. `PORT_ACTIONS.popup` allows `decrypt`/`match` (agent.js:548-567). The worker does not verify that a `popup`-named port originates from an actual extension page — the only `port.sender` uses are for the `trigger`, `integration`, and `popup-bridge` paths (agent.js:508, 628, 745-765), none of which gate the popup auth. A content-script-initiated `popup` port (whose `sender.tab` is set) is treated identically to a real toolbar-popup port.

**Exploit scenario.** A compromised `integration.js` calls `chrome.runtime.connect({name:"auth"})`, posts `"x"`, then `chrome.runtime.connect({name:"popup"})`, posts `{action:"auth", token:"x", tab:{id, url}}`, then `{action:"decrypt", path: <whitelisted entry>, intent:"fill", origin:<tab origin>}` — the worker returns the plaintext, with **no user gesture** and an **attacker-chosen audit `origin`**. The same is achievable with `token:"broadcast"` alone.

**Assessment.** Mechanism confirmed by independent reproduction. This is a bypass of the F20M "restrict decrypt to authorised popup ports" control: the port-name allow-list is present, but the port *name* is spoofable and the *token* is self-issuable, and the worker performs no sender verification. A realistically-compromised content script (the F20M threat model) thereby gains silent, unattended `decrypt`/`match` of every whitelisted entry. I **initially rated this LOW** in Phase 1, reasoning that the outcome (a compromised extension reading whitelisted entries) is the documented SECURITY.md worst-case and that the maintainers explicitly document the token as a correlation ID rather than a TM2 control. On cross-verification I **upgrade to MEDIUM**: the gap is the *enabler* (not a redundant defence) for a capability the F20M gate was specifically built to deny, and it operates without a user gesture. It does not defeat the host-side whitelist or rate limiter, and it sits at the boundary of the documented accepted worst-case, so it does not reach HIGH.
**Severity uncertainty flagged:** if the maintainers classify "authorised popup port" as expressly including a `broadcast`/self-issued token by design (i.e. the F20M gate was never intended to hold against a compromised content script), this should be recorded as an accepted-by-design disposition rather than a vulnerability.

**Recommended fix.** Require `decrypt`/`match` popup ports to originate from an actual extension page (e.g. reject `decrypt`/`match` when `port.sender.tab` is set, or require `sender.url` to be the `chrome-extension://.../html/popup.html` page), so the per-popup authorisation is cryptographically or structurally bound to the real popup rather than to a spoofable port name/token.

---

### F47L — `action_changes_since` does not abort on invalid timestamp (LOW, robustness)

**Description.** When `.since` fails the `^[0-9]{10}$` check, the function calls `parcel_error` (which transmits the error but does not exit) and then **continues** into `date -d "@$SINCE"` and `find ... -newermt "$SINCE"` with the unvalidated, attacker-supplied string. Under a crafted native-messaging peer (TM3), the malformed value flows into `date`/`find` argument position.

**Threat model(s).** TM3 (malicious native-messaging peer / tampered host inputs).

**Evidence.** src/parcel-host:227-232:
```
local SINCE="$(jq -r '.since' <<< "$1")"
if [[ -z "$SINCE" || "$SINCE" == "null" || ! "$SINCE" =~ ^[0-9]{10}$ ]]; then
    parcel_error "Invalid timestamp: $SINCE"
fi
SINCE="$(date -d "@$SINCE" ...)"
```
No `return` after the error. Because the regex already constrains the *accepted* path to exactly 10 digits, the only way to reach the continuation is with input that failed the check; `date -d "@$SINCE"` on GNU coreutils prints an error and the `||` fallback (`date -j`, BSD-only, absent on Linux) yields an empty `SINCE`, after which `find -newermt ""` errors. No command injection (the value is an argument, and a non-matching value is not evaluated by the shell).

**Exploit scenario.** A host-peer sends a malformed `.since`; the host logs the error but proceeds to run `find` with a bogus `-newermt`, which fails closed (no changes reported per the `| read -r _` guard) — a best-effort robustness defect with no credential exposure.

**Assessment.** **LOW**, Low confidence of security impact; essentially a robustness/consistency nit (the function neither aborts nor returns a clean result). Include for completeness; arguably should be folded into Residual.

**Recommended fix.** `return 0` (or `return 1` with a clean error) immediately after `parcel_error` on an invalid timestamp, mirroring the other host actions.

---

### F51I — `fill-value` and the `frameOrigin`-undefined edge can skip the destination-origin guard (INFO)

**Description.** The destination-origin guard on a `fill` only triggers when the message carries an `origin` key (`hasOwnProperty` check). The popup sends `origin: frameOrigin`, which is set only once the content script answers `ready` with its `origin`. Two edges can leave `origin` absent: (a) a `frameOrigin` that is `undefined` at fill time (its `undefined` value is dropped by `postMessage`'s structured-clone), and (b) the `fill-value` action, which never carries `origin`.

**Threat model(s).** TM1 (hostile web page).

**Evidence.** integration.js:1439-1444 (guard conditional on `hasOwnProperty(msg,"origin")`); popup.js:9 (`let frameOrigin;`), 1175 (`origin: frameOrigin`), and the `fill-value` sends at popup.js:236/361/578 (no `origin`).

**Exploit scenario / reachability.** I could not construct a confirmed reachable exploit:
- For the `frameOrigin`-undefined edge, the popup must be usable enough for the user to reach a fill while the `ready`→`origin` round-trip has not completed. In every real flow the `origin` message resolves before a fill can be initiated, and even if it did not, the fill target is the element the user explicitly clicked — the guard is defence-in-depth, not the primary control.
- For `fill-value`, the value is user-supplied text from the detail view of an already-decrypted entry, delivered to the specific element the user clicked; there is no decrypted-credential-from-a-different-origin path. The maintainers explicitly rejected this half of F36L ("`fill-value` ... there is no exploit path for it"), and I concur.

**Assessment.** **INFO** — records the mechanics for completeness and to satisfy the F36L regression trace; no reachable scenario. The primary `fill` path (including the broadcast fire-and-forget fallback) correctly carries and checks origin.

**Recommended fix (optional hardening).** Send `origin` on the `fill-value` action too, or initialise `frameOrigin` defensively and fail closed when it is missing on a `fill`.

---

### F41L — Multi-signer host-script signature: signer extraction constrained only by a regex accident (LOW)

**Description.** In the bootstrap's `action_install`, the trusted signer's primary fingerprint is extracted with `SIGNER="$(grep VALIDSIG <<< "$OUT" | cut -d' ' -f12)"` and then checked against `VALID_SIGNERS` via `[[ ! " $VALID_SIGNERS " =~ [[:space:]]$SIGNER[[:space:]] ]]`. If the extension presents a *multi-signer* detached signature, `grep VALIDSIG` yields multiple lines and `$SIGNER` becomes multi-line; the regex then requires those fingerprints *contiguously* with an embedded newline, which can never match the space-joined `VALID_SIGNERS` — so the check **fails closed today**, but only by accident of the newline. There is no explicit assertion that exactly one `VALIDSIG` was produced.

**Threat model(s).** TM5/TM3 (signature-verification chain; tampered host inputs).

**Evidence.** parcel-host:155-170: `SIGNER="$(grep VALIDSIG <<< "$OUT" | cut -d' ' -f12)"` followed by the `[[ ... =~ ... ]]` check. No `wc -l`/single-line assertion on the `VALIDSIG` count.

**Exploit scenario.** Not currently exploitable (the fail-closed behaviour blocks a multi-signer blob). The risk is *future-proofing*: a refactor or a regex that happens to match across the newline (e.g. if `$SIGNER` were collapsed to spaces, or if a `VALID_SIGNERS` value ever contained a newline) could let an untrusted signer's fingerprint pass alongside a trusted one — i.e. execution of code signed by a non-`VALID_SIGNERS` key. Verified safe today.

**Assessment.** **LOW**, High confidence in the mechanism (verified fail-closed now); it is a defence-in-depth/hardening recommendation to make the single-signer expectation explicit rather than implicit.

**Recommended fix.** Assert exactly one `VALIDSIG` line (e.g. `grep -c VALIDSIG` must equal 1) before extracting the fingerprint, and explicitly reject multi-signer blobs.

---

### F42L — `passkeyDir` traversal can bypass the textual `.gpg-id` containment check (LOW)

**Description.** In `passkey_op_create`, `PASSKEY_DIR` (from `.parcel.json`) is validated against control characters and glob metacharacters (src/parcel-host:731-736) but **not** against `..` components or absolute paths. The `.gpg-id` discovery walks from `$STORE_ROOT/$SUGGESTED` and the final containment test is textual — `[[ "$GPG_ID" != "$STORE_ROOT"/* ]]` (src/parcel-host:804-806). A `passkeyDir` containing `..` (e.g. `a/../../sibling`) makes `$GPG_ID` textually start with `$STORE_ROOT/` while *resolving* outside the store, so the host can read an out-of-store `.gpg-id` and encrypt a newly generated passkey to those recipients. The schema deliberately permits traversal in `passkeyDir` (schema.test.js:370 asserts `..` is accepted).

**Threat model(s).** TM4 (hostile local filesystem) / TM0 (validation intent vs. textual-check divergence).

**Evidence.** src/parcel-host:731-736 (incomplete `passkeyDir` validation), 788-807 (`SUGGESTED_FULL`/`.gpg-id` walk and textual containment). `passkeyDir` is user/`.parcel.json`-controlled, not page-controlled.

**Exploit scenario.** Reachable only with a crafted `.parcel.json` — i.e. the config is already trusted code, so a malicious config is game-over regardless. Within that, a hostile config could point `passkeyDir` outside the store so the host reads a chosen `.gpg-id` and (if the user saves the returned armored blob) encrypts a generated passkey to attacker-chosen recipients. This is a boundary-consistency gap rather than a standalone boundary break.

**Assessment.** **LOW**, Medium confidence. Because `passkeyDir` is trusted user config and the `.gpg-id` walk is bounded to the store *textually*, the marginal impact over what a malicious config already grants is small. Report for hardening/consistency.

**Recommended fix.** Normalise `passkeyDir` (reject `..`/absolute paths, or resolve with `readlink -f` and enforce realpath containment against `realPassdir`) before the walk, so the textual and resolved containment agree.

---

### F43L — Firefox frame-id broadcast falls back to `postMessage(..., "*")` with no receive-side origin check (LOW)

**Description.** The frame-identity broadcast that mitigates forged frame-IDs (F28T) restricts the target via `Location.ancestorOrigins`, which is **Chromium-only**. In Firefox, `location.ancestorOrigins` is undefined, so `topOrigin` falls back to `"*"` (integration.js:170-172) and the message is posted with no target restriction. The receive handler (`window.addEventListener("message", ...)`, integration.js:151-155) matches the sender only by `ev.source` (the iframe that owns the `parcel-frame-id` value) and does **not** check `ev.origin`, so an embedding page in Firefox can forge/set an iframe's `_parcelFrameId`.

**Threat model(s).** TM1 (hostile web page).

**Evidence.** integration.js:163-173 (broadcast with `"*"` fallback), 151-155 (receive handler with no origin check).

**Exploit scenario.** An embedding page forges `{action:"parcel-frame-id", frameId}` to (re)label an iframe, which is then used for popup positioning (integration.js:132-136 looks up the iframe by `_parcelFrameId`). Impact is limited to popup-positioning confusion / frame-id disclosure — no plaintext, no signature, no origin steering. This is the F28T attacker-side effect the `ancestorOrigins` narrowing mitigated, but only in Chromium.

**Assessment.** **LOW**, Medium confidence. Overlaps the accepted F28T tradeoff; the only delta is that the documented mitigation is incomplete on Firefox. Popup-annoyance/phishing-surface only.

**Recommended fix.** Where `ancestorOrigins` is unavailable, omit the frame-id broadcast entirely (fall back to no pre-location) rather than posting with `"*"`, or have the receiver validate `ev.origin` against the known parent/embedder origin.

---

### F44L — Page-forged `parcel-webauthn-conflict` CustomEvent can fake a conflict modal and suppress a genuine notice (LOW)

**Description.** The MAIN-world interceptor dispatches `parcel-webauthn-conflict`, and the isolated world trusts it (integration.js:1322 → `handlePasskeyConflict`). A page can forge the event with a schema-valid payload (`{"reason":"wrapped"}`). The handler (only in the top frame, when passkeys are enabled and the user holds candidates) opens a conflict modal and, on dismissal, persists `passkeyConflictDismissed[origin]` for that origin.

**Threat model(s).** TM1 (hostile web page).

**Evidence.** integration.js:1322 (listener), 1059-1110 (`handlePasskeyConflict`: schema-validates the *event-controlled* `reason`, shows a modal, reads/writes `passkeyConflictDismissed`).

**Exploit scenario.** A page fires a forged conflict event → a false "another extension controls passkeys" modal appears; if the user dismisses it, the per-origin dismissal suppresses a *genuine* later conflict warning for that origin. Net effect is popup-annoyance plus the suppression of a genuine warning — squarely within the documented "bridge forgery is popup-annoyance at worst" posture (SECURITY.md), with no signature, decryption, or origin steering. (The dismissal storage is in `chrome.storage.local`, so the page cannot set it directly; suppression requires the user to dismiss the fake modal.)

**Assessment.** **LOW**, Medium confidence. Consistent with the accepted bridge-as-untrusted tradeoff; recorded because it can *suppress a genuine warning*, which is a slightly stronger harm than annoyance.

**Recommended fix.** Do not source conflict *truth* from a page-forgeable event: re-derive whether another extension actually controls `navigator.credentials` in the isolated realm (an origin/realm check that page script cannot spoof), or scope dismissal to only suppress repeat *forged/same* notices rather than all future genuine ones for the origin.

---

### F45L — `make chrome`/`make firefox` `rsync` lacks `--delete`; stale files can ship on ad-hoc builds (LOW)

**Description.** The packaging targets copy `src/dist/` into `chrome/`/`firefox/` with `rsync -av` (Makefile:42, 48) which does **not** prune files removed from `src/dist/`. Building these targets without first running `clean` can leave a stale (previously shipped) file in the bundle that no longer exists in source, producing a distribution that diverges from `src/` without any source change being visible.

**Threat model(s).** TM5 (supply chain / build-integrity; source↔distribution parity).

**Evidence.** Makefile:42, 48 (`rsync -av src/dist/ chrome/` and `... firefox/`); the `release` target does run `clean extension` first (Makefile:66), so official releases are unaffected.

**Exploit scenario.** A developer or CI runs `make chrome` on an existing `chrome/` tree after an entry is removed from `src/`; the removed file lingers in `chrome/`. The stale artifact is an *outdated* copy of earlier legitimate Parcel code, not attacker-injected, and is eliminated by `clean`. No credential/security impact; a parity/robustness concern.

**Assessment.** **LOW**, Low confidence of security impact; informational in practice. Recommend `--delete` (or a pre-clean) to guarantee `chrome/`/`firefox/` mirror `src/dist/`.

**Recommended fix.** Add `--delete` to both `rsync` invocations, or make `chrome`/`firefox` depend on `clean`-style pruning.

---

### F48I — Store-controlled `entry.path` interpolated into `querySelector` without `CSS.escape` (LOW, render-breaking)

**Description.** In the popup result list, `ul.querySelector(`li[data-path="${entry.path}"]`)` (popup.js:1066) interpolates the store-controlled `entry.path` directly into a CSS selector without `CSS.escape`. A crafted `.gpg` filename containing a `"`, `\`, `]`, or other selector-relevant character makes `querySelector` throw a `SyntaxError`, which can break rendering of the entry list for that origin.

**Threat model(s).** TM4 (hostile local filesystem — crafted password-store filenames).

**Evidence.** popup.js:1066. The value is used only as a selector for element lookup/reuse; it is not an HTML/JS injection sink (`querySelector` cannot execute code).

**Exploit scenario.** An attacker able to place an entry with a pathological filename in the store (or a user with such a filename) causes the popup to fail to render the affected origin's entry list (a localised UI DoS). No plaintext disclosure and no code execution.

**Assessment.** **LOW**, Medium confidence. Interpolating path data into a CSS selector is a latent fragility; impact is a render break. Kimi rates this INFO; I rate LOW (reachable UI break) but note it is at the INFO/LOW boundary.

**Recommended fix.** Use `CSS.escape(entry.path)` (or `li[data-path]` matching via a stored index / `dataset` comparison) instead of embedding the raw path in a selector string.

---

### F49I — Unbounded `targetBindings`/`#authorisedTokens` growth via synthetic clicks (INFO)

**Description.** A page can `click()` any of its own elements, which opens the Parcel popup/binding path; `targetBindings` entries survive until the element is bound/cleaned (integration.js:686-716 deliberately retains bindings on disconnect), and the agent's `#authorisedTokens` set grows on every `auth`-port post (agent.js:496-501). A hostile page issuing many synthetic clicks can accumulate unbounded entries, causing memory pressure (an extension-side DoS).

**Threat model(s).** TM1 (hostile web page).

**Evidence.** integration.js:686-716 (binding retention on disconnect), agent.js:496-501 (`#authorisedTokens.add` with no cap); note tokens are one-time-deleted when non-`broadcast`.

**Exploit scenario.** A page loops `element.click()` across many synthetic elements, each creating a persistent binding/token entry. Impact is memory growth of the extension context only; no disclosure. Bounded in practice by the per-frame lifetime and by the fact that a page can already impose other costs on the extension.

**Assessment.** **INFO**, High confidence; no security/credential impact, a resource-exhaustion hardening note.

**Recommended fix.** Cap or expire `targetBindings`/`#authorisedTokens` (e.g. LRU or per-origin quotas, and a maximum token count).

---

### F50I — Regression-test coverage gaps (INFO)

**Description.** The test suite (407 tests, all passing) has strong coverage of rate-limit persistence, state-file injection rejection, whitelist/symlink policy, port auth single-use/broadcast, and origin mismatch. A few security-relevant edges remain unexercised: state-file *symlink-follow* and *fail-open reset* paths (native-host tests), explicit audit-field length-cap assertions, hostile action strings through the dispatch regex, an assertion that the **primary popup** `fill` path actually carries `origin` (the tests exercise the broadcast fallback but the popup-side `origin: frameOrigin` send is not directly asserted), and container history isolation.

**Threat model(s).** TM2/TM1 (coverage of the above controls).

**Evidence.** test/native-host.test.js (state-file tests at 1494-1590 cover content and permissions but not symlink/fail-open); test/popup.test.js (origin/fill assertions).

**Assessment.** **INFO**, High confidence. Tests matching information; no vulnerability itself.

**Recommended fix.** Add assertions for the state-file symlink/fail-open paths, audit caps, hostile action dispatch, the primary popup fill-`origin` send, and container-scoped history readback.

---

## 5. Regression Checks

Verification that every prior fixed/addressed finding is still present, not partially reverted, and not bypassed in the current tree (commit `6b0f1a7`):

| ID | Task # | Status | Evidence |
|----|--------|--------|----------|
| F1M | #46 | CONFIRMED | Bootstrap uses `GNUPGHOME=/dev/null gpg ... --no-default-keyring --keyring "$KEYRING"` with `mktemp` + `rm -f` (parcel-host:87-113). |
| F2M | #48 | CONFIRMED | `audit_decrypt` strips `[[:cntrl:]]` from all fields (src/parcel-host:311-317). |
| F9L | #49 | CONFIRMED | `SHA256="$(command -v ...)"` is set after `. "$PARCELRC"` (parcel-host:62). |
| F10L/F14L | #56 | CONFIRMED | Length caps present: `INTENT:0:128`, `ORIGIN:0:1024`, `FILE_PATH:0:1024`, `MESSAGE:0:4096` (src/parcel-host:316). |
| F11L | #55 | CONFIRMED | Manifest CSP includes `script-src 'self'; object-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'self'`. |
| F17L | #57 | CONFIRMED | `collect_roots` enforces link policy before traversal; `validate_decrypt_path_policy` re-checks at decrypt (src/parcel-host:157-197, 442-463). |
| F18M | #68 | CONFIRMED | CSP directives present (manifest.json). |
| F19M | #67 | CONFIRMED | `chrome.runtime.onStartup`/`onInstalled` → `#ensureNativeConnected` (agent.js:57-67); reconnect uses same helper. |
| F20M | #69 | CONFIRMED | `PORT_ACTIONS` allow-list restricts `decrypt`/`match` to `popup`; `integration`→`config` only (agent.js:548-551). See F40M for a residual nuance. |
| F22L | #71 | CONFIRMED | `HOST_HASH` computed from `jq -rj '.script' | sha256sum` (exact bytes, no added newline) (parcel-host:122-127). |
| F29L | #71 | CONFIRMED | `"$SHA256"` quoted in command position. |
| F30L | 0c9be39 | CONFIRMED | GPG `$OUT` logged to stderr only; extension receives generic `"Signature verification failed"` (parcel-host:99-120). |
| F31L | ffeae49 | CONFIRMED | `[[ ! "$ACTION" =~ ^[a-zA-Z0-9_]+$ ]]` regex gate before dispatch (parcel-host:213-219). |
| F35M | #116 | CONFIRMED | `validate_state_content`/`load_state`/`save_state` persist bucket to `STATEFILE` with 0600 (src/parcel-host:67-125). |
| F36L | #118 | CONFIRMED | Popup sends `origin: frameOrigin`; integration `fill` checks `msg.origin !== window.location.origin` (popup.js:1175; integration.js:1439). See F51I for the accepted halves. |
| F37L | #123 | CONFIRMED | gitleaks pinned to `8.30.1` with per-os/arch SHA-256 checksums, verified before extraction (scripts/pre-commit-gitleaks). |
| F38I | 27dd6f2 | CONFIRMED | Comment now reads "content-script (`integration`) ports may only request `config`" (agent.js:546-547). |

No regression found.

## 6. Deliberate Tradeoffs

Re-examined documented tradeoffs; none diverge from the documentation:
- **Plaintext bash host / HOST_HASH off by default** — unchanged; HOST_HASH is opt-in and recommended (SECURITY.md).
- **Absent `.parcel.json` reveals all entries** (#4T) — unchanged; popup warning persists.
- **`parcelrc` as trusted code-execution boundary** (#5T) + `LOGFILE`/`STATEFILE` unvalidated (#24T) — unchanged; 0600 enforced.
- **Entry rules not using dereferenced paths / symlink options** — unchanged; users warned.
- **WAR / fingerprintability** (#7T/#26T) — unchanged; list empirically justified. (Note: current WAR omits `popup.js`, which the earlier finding described, but still exposes the JS modules; the tradeoff rationale holds.)
- **History metadata unsalted** (#8T/#27T) — unchanged.
- **shadow.js in MAIN world** (#13T) and WebAuthn in page realm — unchanged; bridge treated as untrusted.
- **Rate-limiter default burst** (#23T) — unchanged; rate limiter bounds sustained (not burst) exfiltration.
- **VALID_SIGNERS includes backup keys** (#21T) — unchanged.
- **Popup element page-stylable/removable** (#39T) — unchanged; inherent.
- **`config` leaks passdir** (#33T) — accepted as-is; unchanged.
- **Audit-log unbounded line / log mode** (#15T/#25T) — `chmod 0600` now applied on log creation; line length bounded in practice.
- **State-file fail-open** (this release's design note) — documented; see F46L.

## 7. Residual Observations

Observations with no confirmed reachable exploit path (not raised to findings, per §4):

- **`load_state` single-variable emptiness edge.** If only one of `DECRYPT_BUCKET_TOKENS`/`DECRYPT_BUCKET_LAST` is persisted, the `if [ -z ... ] && [ -z ... ]` seed block does not fire and the arithmetic uses the loaded value against an empty sibling; worst case this over-credits refill (bucket reset). Non-exploitable beyond a reset, and overlaps F46L.
- **State-file symlink-follow on load/write.** `save_state` (`>`, `chmod`) and `load_state` (`touch`, `find -perm`, `cat`) operate through whatever object sits at `$STATEFILE`; a symlink placed there (TM4) is followed by the writes and causes `find -perm 0600` to return nothing, so `load_state` fails open to a full-bucket reset (overlaps F46L). A hostile actor able to plant the symlink in the user-owned config dir already has comparable influence (accepted F16T/F24T). Residual / overlaps F46L and kimi-k3 F46L.
- **`action_list` newline/metacharacter `.gpg` filenames (TM4).** A crafted filename containing a newline or wildcard could misalign the line-based `find`/`readlink`/`@sh` assembly. The #122 desync count check (`grep -c ''` parity) catches divergence and fails closed; and `action_decrypt` membership is an exact string match on `ALLOWED_FILES`, so no whitelist bypass. Impact limited to DoS/odd listing. Residual.
- **Symlink/TOCTOU between `validate_decrypt_path_policy` and `gpg --decrypt`.** A same-user actor racing the store could swap a path between revalidation and open; the actor already has store write access. Residual.
- **Deeply-nested external symlink DoS (TM4).** With `allowExternalLinks: true` a crafted store could direct `find` over a huge tree. Policy is applied before traversal; traversing allowed links is inherent to the option. Residual (matches SECURITY.md warning).
- **`parcel_transmit` length-prefix.** Correctly byte-counted under `LC_ALL=C`; no multibyte desync. Verified clean.
- **Zombie/duplicate host processes sharing the state file.** Two live host processes could race reads/writes of `STATEFILE`; bounded and non-exploitable (content is validated, writes are atomic-ish `>` clobber). Residual.
- **CSP of `popup.html`.** A hardened editor could additionally pin `style-src`/`img-src` for the popup; the current `'self'`-scoped CSP is adequate. Hardening note.

## 8. Things Done Well

- **Native-host enforcement boundary is real.** Whitelist membership, symlink policy, rpId binding, passkey-exclusion and rate limiting are all re-verified host-side at decrypt time, independent of a (possibly stale) extension cache.
- **State-file validation before `eval`.** The strict `VAR=digits` whitelist (#125/#119) makes the persisted-state `eval` safe against command-substitution/piped/subshel syntax, with dedicated regression tests.
- **TOCTOU/desync parity check** in `action_list` (#122) and the re-check of link policy at decrypt time.
- **Zero HTML-based XSS sinks in extension JS.** No `innerHTML`, `insertAdjacentHTML`, `document.write`, or `eval` reachable from store-controlled data; detail/fill values flow through `.value`/`textContent`.
- **Passkey isolation.** Private keys never leave the host; origin and rpId are re-derived in the isolated world, re-validated in the worker (`#validateRpId`), and re-bound in the host immediately before signing; `allowCredentials` enforced host-side; popup-spam guard and Permissions-Policy check in the isolated realm are present.
- **Origin validation now on the primary fill path** (F36L/#118), with adversarial coverage in the test suite (broadcast fallback "carries the intended origin").
- **Signature-verification hygiene** (temp keyring, status output not leaked to the extension, hash basis matches documentation).
- **Test suite quality.** 407 tests pass; security-critical paths are explicitly covered (rate-limit persistence across restarts, state-file injection rejection, whitelist/symlink policy matrix, port auth single-use/broadcast, origin mismatch).

## 9. Cross-Model Verification

Phase 2 was performed: the other model's exchange table `security-review-table-kimi-k3-20260808-6b0f1a7.md` was imported and read (the table only — not kimi-k3's full report, preserving independence of reasoning). I independently re-derived the *why* for each entry from the code before deciding. Results:

| kimi-k3 ID | My verdict | Notes |
|---|---|---|
| F40M (M) | **CONFIRMED — adopted as MEDIUM (F40M, upgraded from my Phase-1 LOW)** | I initially rated this LOW on the documented-tradeoff framing. On re-derivation, the control-bypass nature (worker performs no `port.sender` verification; `popup` port name spoofable; `broadcast`/self-issued token authenticates; silent unattended `decrypt` of all whitelisted entries) is a bypass of the F20M authorisation gate rather than redundant defence, so MEDIUM is the more honest severity. I flag the boundary with the documented accepted "compromised extension reads whitelisted entries" worst-case and the maintainers' explicit statement that the token is not a TM2 control. |
| F41L (L) | CONFIRMED — adopted as F41L (LOW) | Verified fail-closed today (multi-line `$SIGNER` newline cannot match `VALID_SIGNERS`); no explicit single-`VALIDSIG` assertion. |
| F42L (L) | CONFIRMED — adopted as F42L (LOW) | Verified `passkeyDir` has no `..`/absolute validation and the `.gpg-id` containment is textual; config-controlled preconditions flagged. |
| F43L (L) | CONFIRMED — adopted as F43L (LOW) | Verified Firefox `ancestorOrigins` fallback to `"*"` and no receive-side `ev.origin` check. |
| F44L (L) | CONFIRMED — adopted as F44L (LOW) | Verified forgeable `parcel-webauthn-conflict` → false modal + possible suppression of a genuine notice; aligns with accepted bridge-untrusted posture. |
| F45L (L) | CONFIRMED — adopted as F45L (LOW) | Verified `rsync -av` lacks `--delete` (Makefile:42,48); `release` runs `clean` first. |
| F49I (I) | CONFIRMED — adopted as F49I (INFO) | Verified unbounded `targetBindings`/`#authorisedTokens` growth via synthetic clicks; memory-only. |
| F48I (I) | CONFIRMED — adopted as F48I (LOW) | Verified `entry.path` into `querySelector` without `CSS.escape` (popup.js:1066); render-breaking, no injection sink. I rate LOW (reachable UI break) vs kimi's INFO. |
| F46L (I) | CONFIRMED — overlaps my F46L | State-file symlink-follow + load-time fail-open; already covered in F46L (I additionally note the symlink-follow nuance in Residual). |
| F50I (I) | CONFIRMED — adopted as F50I (INFO) | Test-coverage gaps verified. |

**Additions from my own Phase-1 set that kimi-k3 did not surface:** F46L (state-file fail-open rate-limit reset — overlaps kimi's F46L), F47L (`action_changes_since` non-abort), F51I (origin-guard edges / accepted F36L halves).

**Disagreements / non-reproductions:** The only lettered disagreement is F40M — kimi-k3 rated it MEDIUM; my Phase-1 draft rated it LOW; after re-derivation I **adopt MEDIUM** (a verdict change driven by re-analysis of the control-bypass, not merely to reach consensus). F48I severity differs at the INFO/LOW boundary (I rate the popup render-break LOW). No non-reproductions. No severity was changed purely to achieve consensus; each was re-derived from the code.

**Exchange-file cleanup (per §6):** both exchange files (`security-review-table-kimi-k3-20260808-6b0f1a7.md` and my own `security-review-table-deepseek-v4-20260808-6b0f1a7.md`) are transient artifacts and are deleted along with this finalisation.

## 10. Second-Look Review

Adversarial re-read of this draft (finalised after Phase 2):

- **Did every finding survive the reachability requirement?** Yes. F46L (contrived multi-actor, flagged; overlaps accepted F16T/F24T and kimi F46L); F40M (MEDIUM after re-derivation — mechanism confirmed; boundary with documented accepted worst-case flagged); F47L (robustness, no injection); F41L/F42L/F45L (defence-in-depth / low reachability, flagged); F48I (reachable UI break, flagged); F51I/F43L/F44L/F49I/F50I (INFO or within accepted tradeoffs, reachability limited). Suspicious-but-unverifiable items remain in Residual/Hardening rather than as findings.
- **Superficial checklist areas?** All §3 areas were directly re-examined after Phase 2 for the new findings: bootstrap signature chain (F41L), passkey `create`/`.gpg-id` walk (F42L), content-script bridge + frame-id (F43L), WebAuthn conflict bridge (F44L), packaging parity (F45L), popup rendering (F48I), tests (F50I). None skipped.
- **Unverified assumptions?** F40M assumes a content script can open a `popup`-named runtime port and that the worker does not distinguish `port.sender` — verified (agent.js:548-567 uses no sender gating for popup ports; `port.sender.tab` is only consulted on `trigger`/`integration`/`popup-bridge` paths). F46L assumes a same-user attacker can write `~/.config/parcel/state` — reasonable (the config dir is user-owned). F42L assumes `passkeyDir` traversal is reachable only via trusted `.parcel.json` — true, and flagged.
- **Misattributed tradeoffs as findings?** Re-checked the tradeoffs table (see §6). F40M, F43L, F44L and F51I are flagged as deliberately overlapping documented tradeoffs (F20M and bridge-untrusted postures, F28T, F36L). F46L overlaps F16T/F24T. No confirmed tradeoff was miscategorised as a hard finding without that flag.
- **Every `jq` call site / unquoted `$VAR` / dispatch path verified?** Yes — all `jq` invocations use `<<< "$MESSAGE"` (quoted) or fixed strings; `$SHA256`/`$GPG`/`$JQ` are quoted or wrapped in functions; the action dispatch has a regex gate; `parcel_transmit` uses `%b`/`%s` correctly.
- **Origin validation on every fill/decrypt path?** Yes — popup `fill` and the agent broadcast fallback carry `origin`; integration `fill` checks it; `fill-value` is user-value-only (accepted F36L). Mid-decrypt navigation is blocked by the `origin` comparison at fill time.
- **Severity consistency?** The single MEDIUM (F40M) is defended to the standard required: reachable under the F20M TM2 premise, bypasses that documented control (the gate being the *enabler*), and discloses whitelisted credential plaintext without a user gesture — while explicitly bounded below HIGH by the documented accepted worst-case and the host-side whitelist/rate limiter that still apply. I used only the permitted letters (M/L/I); tradeoff dispositions are cross-referenced to prior `T` findings rather than re-issued.
- **Confidence calibration:** F46L Medium; F40M Medium (mechanism High, severity Medium); F47L Low; F51I High (mechanics, no impact); F41L High; F42L Medium; F43L Medium; F44L Medium; F45L Low; F49I High; F48I Medium; F50I High. Evidence that would change each: F40M — maintainer clarification that the F20M gate was never intended to hold against a compromised content script (would drop to accepted-by-design); F46L/F42L — a demonstrated single-actor path without trusted-config influence; F41L — a demonstration that a multi-signer blob can pass the signer check; F43L/F44L — a demonstrated non-annoyance impact (e.g. mis-steered fill or signature/decryption), which I could not construct.

## 11. About This Review

- **Model:** `deepseek-v4` (runtime banner: `deepseek-v4-flash`; operational suffix omitted).
- **Date:** 2026-08-08.
- **Commit/tag:** `6b0f1a7` (short) / `v1.0.5` (tag). Working tree clean; HEAD is the release commit.
- **Prompt:** the committed `security-review/prompt.md` is the canonical record of the review protocol.

# Parcel v1.0.8 Security Review — kimi-k3

**Status: FINAL.** Both phases of the review protocol were completed, including cross-model verification against mimo-v2.6-pro's exchange table.

## Executive Summary

Parcel v1.0.8 presents a strong security posture. The host-side enforcement boundary — the property the whole design rests on — held under every attack path traced by either reviewing model: the whitelist, the passkey content-marker backstop, rpId/`allowCredentials` binding, the atomic rate-limiter state lock, the signer blacklist, and the host-version ratchet all behave as documented. No CRITICAL or HIGH vulnerabilities were identified.

Seven findings are recorded after cross-model verification (six LOW, one INFORMATIONAL); none discloses credentials, key material, or bypasses the host boundary:

| Severity | Count |
|----------|-------|
| C | 0 |
| H | 0 |
| M | 0 |
| L | 6 |
| I | 1 |

The single most important takeaway: every live defect found is a denial of service or a documentation/build defect, not a disclosure — the worst of them is `collect_roots` being driven into combinatorial root-queue growth by two ancestor-pointing symlinks in the store when the non-default `allowLinks` option is enabled (F69L). Everything users' credentials depend on (whitelist enforcement, signature verification, passkey key isolation) verified intact, including every previously fixed finding checked for regression.

## Trust Model & Attack Surfaces

Components examined: the bootstrap host (`parcel-host`, 1014 lines, read in full by this reviewer), the main host script (`src/parcel-host`, 1240 lines, read in full), the extension background (`agent.js`, `agent-native.js`), the content scripts (`integration.js`, `webauthn-integration.js`, `main-world/shadow.js`, `main-world/webauthn.js`), the popup (`popup.js`, `popup-elements.js`, `popup-webauthn.js`, `popup.html`), shared modules (`helpers.js`, `plaintext.js`, `schema.js`, `selectors.js`, `targets.js`, `scopes.js`, `webauthn.js`), the manifest, the build system, `scripts/`, `example/`, and the test suite.

My own structural read of the trust-boundary hierarchy:

1. **The bootstrap host is the root of trust on the host side.** It alone decides what code the host runs: GPG detached-signature verification against a temporary keyring, anchored `VALIDSIG` extraction, `VALID_SIGNERS` (user/system parcelrc, else the four release keys), blacklist checks against both primary and signing-key fingerprints, optional `HOST_HASH` byte-pinning, and the `HOST_VERSION` ratchet. Everything downstream (`eval "$PARCEL_HOST"`) is only as strong as this chain, so the v1.0.7/v1.0.8 hardening here (environment whitelist, strict-mode binary ownership, `/etc/parcelrc` trust anchor, writable-bootstrap refusal) is the right place to spend hardening effort.
2. **The main host script is the enforcement boundary for the store.** The extension is fully untrusted: every entry path is re-checked against the host-computed `ALLOWED_FILES` at decrypt/sign time, symlink policy is re-validated at decrypt time (list→decrypt TOCTOU mitigation), passkey-classified entries can never be returned as plaintext (rule-based *and* content-marker backstop), and passkey signing re-checks rpId and `allowCredentials` after decryption, immediately before signing.
3. **The background worker brokers, the content script isolates, the page is hostile.** Ports are allow-listed by name (`PORT_ACTIONS`); origin and rpId are re-derived in the isolated world on every fill/ceremony; MAIN-world scripts are limited to the two pieces that genuinely require the page realm (attachShadow patching, WebAuthn interception); the DOM bridge is treated as forgeable, with worst case bounded at popup annoyance.
4. **Consent is a page-facing guarantee, enforced extension-side** (integration.js/webauthn-integration.js + popup), while key material safety is host-enforced. This split is consistent with the maintainer's F40M/F59M posture: extension-internal correlation tokens are not a defence against a compromised extension.

## Methodology

- **Model:** kimi-k3 (Copilot CLI 1.0.91), reviewing as `kimi-k3` per existing `security-review/reviews/` naming.
- **Date:** 2026-10-04. **Tree:** commit `f34f710`, exactly at tag `v1.0.8`, clean working tree — a release review of shipped code.
- **Documents read in full before analysing code:** `CONSTITUTION.md`, `SECURITY.md`, `README.md`, `security-review/findings.md`.
- **Prior-review isolation:** no file under `security-review/reviews/` was opened or read by me or by any subagent. Directory *names* were listed solely to derive the filename format, as §0 of the review protocol instructs. No violation occurred.
- **Source files examined:** both host scripts in full by me personally; all extension JS/HTML, the manifest, Makefiles, `scripts/`, `example/`, and the test suite by scoped subagents, with key security paths (port allow-list/auth gate, http-auth token lifetime, fill origin guard, popup fill origin carriage, manifest CSP/WAR, WebAuthn consent flow) additionally verified by me directly.
- **Tests run:** full `make test` by me — **615/615 pass, 35 suites, 0 failures** (includes prettier/eslint/shellcheck gates). Subagents additionally ran `test/native-host.test.js` (167/167), `test/agent.test.js`, `test/popup.test.js`, `test/integration.test.js`, `test/webauthn-integration.test.js` and the remaining module/popup suites individually — all green.
- **Empirical verification:** (a) PoC of F69L: `collect_roots` extracted verbatim and run against a fake store — one ancestor symlink terminates (~40 roots via kernel ELOOP); two ancestor symlinks still running at 8 s and 20 s timeouts (combinatorial growth). (b) HOST_HASH basis PoC: `jq -rj '.script'` of an install-shaped message hashes byte-identically to `sha256sum src/parcel-host`. (c) Length-header edge PoC: framing saturates/blocks for all 32/64-bit extremes. (d) `make extension SIGN_KEY=<throwaway ed25519 key>` build with a real GPG signature, and `chrome/`/`firefox/` bundle parity verified against `src/` (byte-identical modulo documented manifest rewrites, the `.es6.js` shim, and the generated `.asc`); tree restored clean afterwards.
- **Subagent allocation (all kimi-k3, three simultaneous):** (1) native host + host-side constitution compliance; (2) extension JS + WebAuthn + popup; (3) manifest/build/tests + regression checks. All findings below were independently re-verified by me against the code before inclusion.
- **Phase 2 (cross-model):** the mimo-v2.6-pro exchange table was read (table only); each of its nine entries was re-derived from the code, with live empirical checks for F70L (jq/Node engine divergence) and F72L (scratch-tree build). Both exchange files were deleted after finalisation per protocol.
- **Limitations:** GPG cryptography itself is out of scope (mocked in tests by design); macOS-only paths (osascript, BSD stat flags) were reviewed statically, not executed; the Firefox bundle was verified by replicating the Makefile's exact steps (rsync unavailable in this container).

## Findings

Consolidated findings table (this is the phase-2 exchange table):

| ID | Severity | Confidence | Area | Threat model | Title | file:line |
|----|----------|-----------|------|--------------|-------|-----------|
| F69L | L | High | native host (main script) | TM4 | `collect_roots` textual-only dedup: two ancestor-pointing symlinks cause combinatorial root-queue growth, permanently wedging the host | src/parcel-host:374-390 |
| F73L | L | Medium | docs vs bootstrap | TM0 | SECURITY.md:87 overstates fail-closed behaviour: malformed `BLACKLIST_SIGNERS`/`MINIMUM_HOST_VERSION`/path values are ignored with a log note, not refused | parcel-host:482-503, SECURITY.md:87 |
| F70L | L | High | native host (main script) | TM4 | A rule pattern that is valid in JS but invalid in jq's Oniguruma silently wedges `action_list` — no response is ever sent | src/parcel-host:646-696; parcel-host:746-750 |
| F72L | L | High | build | TM5, TM0 | `make extension`/`chrome`/`firefox` silently skip the Prettier step and execute `write(1)` instead | src/Makefile:42-47; Makefile:17 |
| F74L | L | Medium | docs vs extension | TM0 | Passkey/HTTP-auth consent guarantees are phrased as absolutes that do not hold under the accepted TM2 posture | SECURITY.md:146, 166 |
| F71L | L | High | WebAuthn content script | TM1 | Popup-spam guard bypassed by ceremony supersede/abort paths, which settle without counting as dismissals | src/js/webauthn-integration.js:321-327, 372-385, 545-551 |
| F77I | I | High | popup comment | TM0 | Comment overstates the constrain-height token's forgery protection — the page can read the token from the popup iframe's `src` | src/js/popup.js:552-554; src/js/integration.js:762-763 |

### F69L — `collect_roots` symlink-cycle amplification wedges the host (LOW)

**Description.** With the non-default `allowLinks: true`, `collect_roots` (src/parcel-host:344-392) maintains a queue of scan roots and appends every qualifying symlink found beneath each queued root. The deduplication at src/parcel-host:374-381 compares **textual paths only** (`"$ROOT" == "$LINK"`), never resolved targets. A symlink whose target is an ancestor directory inside the store re-queues itself via ever-longer textual spellings (`d/up`, `d/up/up`, …). With one such link the kernel's 40-hop ELOOP limit bounds the queue to ~40 roots (~40 full store traversals — terminates). With **two** such links in the same directory the path tree branches (all 2^n strings of n hops with n < 40), yielding ~2^40 queued roots, each spawning a `find` — effectively permanent.

**Threat model(s).** TM4 (hostile local filesystem / crafted store contents, e.g. a store synced from an untrusted source), conditioned on the user-enabled `allowLinks` option.

**Evidence.** src/parcel-host:344-392 — loop at :362, per-root `find -H` at :389, textual-only dedup at :374-381, queue append at :382. PoC (verbatim-extracted function against a fake store): single ancestor symlink terminated normally; two ancestor symlinks still running after 20 s.

**Exploit scenario.** An attacker with store write access places `d/up1 -> .` and `d/up2 -> .`. The next `list` (or config-change-triggered `update_config` → `action_list`) wedges the host; the extension's ping watchdog respawns it and the next list re-wedges — sustained denial of service of Parcel. No plaintext, key material, whitelist, or audit-log impact.

**Recommended fix.** Deduplicate queued roots by `readlink -f` resolved target (keeping the first textual spelling, preserving the documented multi-spelling accessibility), and/or cap `ROOTS` growth with an explicit error (e.g. refuse after a few hundred queued roots). This is a residual gap in the F17L/#57 fix (which addressed policy *timing*, not cycles), not a re-report.

**Severity note.** Rated LOW: narrow preconditions (non-default option + store-write attacker) and DoS-only impact with watchdog recovery, consistent with the F17L precedent. A maintainer weighting "host wedge by store content" more heavily could justify MEDIUM; the uncertainty is flagged rather than silently rounded down.

### F73L — SECURITY.md overstates parcelrc fail-closed behaviour (LOW)

**Description.** SECURITY.md:87 states, of the `/etc/parcelrc` hardening: "Any violation refuses startup, as does malformed content in either file". In the implementation, only `VALID_SIGNERS`, `HOST_HASH`, and shape-malformed `GPG`/`JQ`/`OPENSSL` overrides are fatal (parcel-host:476-480, 488-489, 505-513). A malformed `BLACKLIST_SIGNERS` (parcel-host:482-486), malformed `MINIMUM_HOST_VERSION` (:491-495), or non-absolute `LOGFILE`/`STATEFILE`/`PASSWORD_STORE_DIR` (:497-503) is instead **ignored with a log note** in both files — and unrecognised lines are likewise noted and ignored (`load_parcelrc`, parcel-host:552-556). The test suite deliberately asserts this fail-open behaviour (test/native-host.test.js:829, :935), so the implementation is intentional and the documentation is wrong.

**Threat model(s).** TM0 (documentation tension on a security control).

**Evidence.** SECURITY.md:87; parcel-host:482-503 (ignore paths) vs :476-480/:488-489/:505-513 (fatal paths); test/native-host.test.js:829, :935.

**Exploit scenario.** An administrator adds a revocation to `/etc/parcelrc` with a malformed fingerprint, relying on the documented refusal to surface the mistake. The revocation is silently dropped (log note only); a host script signed by the intended-to-be-revoked key still installs. Bounded: a valid signature from a `VALID_SIGNERS` key is still required, and the revocation mechanism is documented as best-effort/defence-in-depth.

**Recommended fix.** Amend SECURITY.md:87 to state that `VALID_SIGNERS`/`HOST_HASH`/binary-shape violations refuse startup while `BLACKLIST_SIGNERS`, `MINIMUM_HOST_VERSION`, and path-value violations are ignored with a log note (mirroring the #193 wording-correction precedent), or make malformed values in the *system* file fatal.

**Severity note.** Rated LOW, consistent with the F62L precedent (documented-absolute vs implemented-transient). A reading of SECURITY.md:87 as scoped purely to the ownership gate would downgrade this to INFORMATIONAL; the sentence explicitly extends the refusal claim to "malformed content in either file", so LOW is retained.

### F70L — JS-valid/Oniguruma-invalid rule pattern silently wedges `action_list` (LOW)

(Added in phase 2; independently reproduced — see Cross-Model Verification.)

**Description.** The host evaluates `.parcel.json` rule patterns with jq's Oniguruma regex engine (`test($pattern)`, src/parcel-host:660-676), while the extension validates and applies the same patterns as JS `RegExp` with the `u` flag (src/js/agent.js:345). The two engines' grammars diverge: for example `\p{Script_Extensions=Greek}` compiles in JS u-mode but fails in Oniguruma ("invalid character property name" — verified live against jq 1.7 and Node 26). When `action_list`'s jq pipeline hits such a pattern it exits non-zero with no stdout; the failure is masked because the capture is `local OUT="$(...)"` (src/parcel-host:646-695), and `parcel_send` then sends nothing because its `if [ ${#1} -gt 0 ]` guard drops the empty payload (parcel-host:746-750). The net effect is a silent violation of the host's one-response-per-request invariant: the extension's list request is never answered.

**Threat model(s).** TM4 (crafted `.parcel.json`; SECURITY.md's configuration-isolation section explicitly contemplates stores obtained from elsewhere).

**Evidence.** src/parcel-host:646-696 (masked pipeline failure), :660-676 (`test($pattern)` evaluation), parcel-host:746-750 (empty-payload drop). Empirical: `jq -n '"a" | test("\\p{Script_Extensions=Greek}")'` → exit 5, no output; Node accepts the same pattern. The host stays alive; only the response is lost.

**Exploit scenario.** A store obtained from an untrusted source carries `.parcel.json` with a pattern that is JS-valid but Oniguruma-invalid. Every `list` (and every config-change-triggered `update_config` → `action_list`) produces no reply; the popup waits indefinitely and Parcel silently stops working. Security-wise the failure is closed (ALLOWED_FILES ends up empty, so all decrypts are denied); the impact is availability only.

**Recommended fix.** Capture the jq pipeline's exit status explicitly (avoid `local X=$(...)`, which masks it) and call `parcel_error` on failure, preserving the one-response-per-request invariant. Optionally pre-validate each rule pattern with a probe `jq -n '"" | test($pattern)'` at `load_config` and report the offending rule.

**Severity note.** LOW: availability-only, fails closed, requires a hostile/malformed store config. Related to F47L's robustness class but worse in kind (no response at all rather than an error response), hence a finding rather than a residual.

### F72L — `make extension` executes `write(1)` instead of Prettier (LOW)

(Added in phase 2; independently reproduced — see Cross-Model Verification.)

**Description.** The top-level `extension` target invokes the sub-make as `$(MAKE) VERSION=$(VERSION) -C ./src` (Makefile:17) and does not pass `PRETTIER`. In `src/Makefile` the variable is never given a default, so the `prettier` recipe (src/Makefile:46-47) expands to a leading ` --write '**/*.{js,json,less,css,html,xhtml}'`. GNU make consumes the expanded leading `--` as its ignore-errors prefix and executes `write '**/*.{js,json,less,css,html,xhtml}'` — the Unix `write(1)` command — which fails with "not logged in" and is ignored ("Error 1 (ignored)"). Verified live: `make extension` in a scratch copy prints exactly this and proceeds. The Prettier normalisation step is therefore silently skipped on every `make extension` / `make all` / `make chrome` / `make firefox` build; only `make prettier` and `make test` (which pass `PRETTIER` explicitly) actually format.

**Threat model(s).** TM5 (build integrity / source↔distribution parity), TM0 (the build does not do what the Makefile and custom instructions say it does).

**Evidence.** Makefile:17 (no `PRETTIER` passed), Makefile:25-26 (top-level definition, not exported), src/Makefile:42-47 (no default; recipe). Empirical: `make -n -C src` shows `write '**/*.{js,json,less,css,html,xhtml}'`; `make extension` executes `write(1)`, ignores its failure, and completes (exit 0).

**Exploit scenario.** No attacker-reachable path: `write(1)` receives only fixed arguments and the skipped formatting is caught downstream by `make test`'s `prettier --check` gate (Makefile test-syntax target). The realistic harm is drift: a maintainer building without running `make test` ships unformatted source, and the build log conceals it. `write(1)` existing on the build host is also an assumption — on hosts without it the shell reports "command not found", still ignored.

**Recommended fix.** Give `PRETTIER` a default in `src/Makefile` (e.g. `PRETTIER ?= $(CURDIR)/../node_modules/.bin/prettier`) or pass `PRETTIER=$(PRETTIER)` in the top-level `extension` target, so the recipe never expands to a leading `--`.

**Severity note.** LOW: build-hygiene defect with a downstream detector (`make test`), no exploitable path, fail-benign.

### F74L — Consent guarantees phrased as absolutes (LOW)

(Added in phase 2; independently assessed — see Cross-Model Verification.)

**Description.** SECURITY.md:146 states "No signature is produced without you explicitly selecting a credential in the consent popup", and :166 states "No credentials are supplied without explicit user selection in the popup" for HTTP auth. Under the maintainer-accepted TM2 posture (F40M, F59M), these absolutes do not hold: a fully compromised extension context can drive `decrypt` (with a self-issued correlation token) and `passkey` `assert`/`create` on whitelisted entries with no consent interaction at all. The sentences' second halves are correctly scoped ("A page cannot silently authenticate you"), but the leading absolutes are not. This is documentation tension only: the missing gate itself is the rejected F59M, and the substantive guarantees (host whitelist, rate limiter, rpId binding) are unaffected.

**Threat model(s).** TM0.

**Evidence.** SECURITY.md:146, :166; the accepted posture at F40M/F59M in findings.md; the gateless `passkey` port allow-list (src/js/agent.js:619) and the correlation-token design (src/js/agent.js:531-537).

**Exploit scenario.** A user reading SECURITY.md to gauge compromise impact concludes that credential use always requires their consent, underestimating the accepted TM2 blast radius (silent use of whitelisted entries within the rate limit).

**Recommended fix.** Scope the leading sentences the way the trailing clauses already are — e.g. "A page cannot obtain a signature without you explicitly selecting a credential in the consent popup" — mirroring the #193 wording-correction precedent.

**Severity note.** LOW: documentation/implementation divergence against an explicitly accepted design posture. Proximity to the rejected F59M is why this is framed strictly as wording.

### F71L — Popup-spam guard bypassed via supersede/abort (LOW)

(Added in phase 2; independently reproduced — see Cross-Model Verification. Severity disputed: the other model rates M.)

**Description.** The popup-spam guard (src/js/webauthn-integration.js:274-285) refuses passkey ceremonies for one second after two consecutive *dismissed* ceremonies. Dismissals are counted only in `finish()` (:545-551). Two page-reachable paths settle ceremonies without touching the streak: a newer request superseding an in-flight one deletes the old binding directly (:321-327), and an abort relayed from the MAIN-world interceptor (`AbortSignal`/timeout) deletes the binding in `handlePasskeyAbort` (:372-385). A page can therefore loop `navigator.credentials.get()` + immediate `abort()` forever, re-raising and closing the consent popup without the guard ever engaging.

**Threat model(s).** TM1 (hostile web page).

**Evidence.** src/js/webauthn-integration.js:274-285 (guard), :321-327 (supersede deletes bindings, no streak), :372-385 (abort deletes binding, no streak), :545-551 (streak only in `finish()`).

**Exploit scenario.** A malicious page runs `for (;;) { const c = new AbortController(); navigator.credentials.get({ publicKey: {...}, signal: c.signal }); c.abort(); }` (with real ceremony parameters), producing an endless open/close flicker of Parcel's consent modal. Every ceremony still requires consent; no signature, decryption, or origin-steering is possible — the impact is extension-UI spam, i.e. exactly the documented worst case for bridge forgery ("can summon an unwarranted popup", SECURITY.md passkey section).

**Recommended fix.** Count aborts and supersedes as dismissals for streak purposes (route `handlePasskeyAbort` and the supersede loop through the same streak-incrementing path as `finish`), so every non-consented terminal state feeds the guard.

**Severity note.** LOW, not M: the bypassed control is anti-annoyance, and its bypass yields the annoyance-class outcome the project already documents and accepts (F44L precedent; the bridge-forgery worst case). The dissent is recorded in Cross-Model Verification.

### F77I — Comment overstates constrain-height token forgery protection (INFORMATIONAL)

(Added in phase 2; independently reproduced — see Cross-Model Verification.)

**Description.** The comment above the popup's `constrain-height` message handler (src/js/popup.js:552-554) says "the token check stops a page or another frame from forging the instruction". The token travels in the popup iframe's `src` query string (src/js/integration.js:762-763), and that iframe element lives in page DOM (the accepted F39T posture), so the hosting page can read the token and post a conforming message; `ev.source === window.parent` passes because the page *is* the parent. The check does stop cross-origin sibling frames (which cannot read the parent page's DOM), so the comment is half-right; the impact of a forged message is popup sizing only, within the accepted F28T class.

**Threat model(s).** TM0 (stale/overstated comment).

**Evidence.** src/js/popup.js:552-558; src/js/integration.js:762-763.

**Exploit scenario.** None beyond the accepted page-controls-own-DOM class (popup resize confusion).

**Recommended fix.** Correct the comment to say the token check stops *other frames* from forging the instruction; the hosting page can already resize via its own DOM.

## Regression Checks

All prior findings recorded as fixed/addressed/resolved in `findings.md` were verified in the current tree (fix present, not partially reverted, not undermined by later changes). All intact:

- **F1M (#46)** — temporary GPG keyring for verification, removed after use (parcel-host:851-872).
- **F2M (#48)** — control characters stripped from all audit fields (src/parcel-host:705-709, 875-877).
- **F5T gate (#50)** — parcelrc 0600 enforced; symlinked parcelrc rejected (parcel-host:315-318).
- **F9L (#49)** — `SHA256` resolved after parcelrc loading (parcel-host:683-692, :729).
- **F10L/F14L (#56)** — audit field caps 128/1024/1024/4096 (src/parcel-host:710, :879).
- **F11L (#55)** — explicit CSP declared (src/manifest.json:31).
- **F17L (#57)** — link policy applied before traversal in `collect_roots` (src/parcel-host:344-392); residual cycle gap reported as F69L.
- **F18M (#68)** — CSP includes `connect-src 'none'; frame-src 'none'; base-uri 'self'` (src/manifest.json:31).
- **F19M (#67)** — `onStartup`/`onInstalled` → idempotent `ensureConnected` (src/js/agent.js:87-91; src/js/agent-native.js).
- **F20M (#69)** — `PORT_ACTIONS` allow-list and enforcement (src/js/agent.js:605-616, :656-659).
- **F22L (#71)** — HOST_HASH basis byte-identical to `sha256sum` of the raw file (parcel-host:912; PoC-verified).
- **F29L (#71)** — `"$SHA256"` quoted in command position (parcel-host:912).
- **F30L** — GPG status output no longer sent to the extension; log-only (parcel-host:866-869, 899-903).
- **F31L** — action-name regex gate before dispatch (parcel-host:953-956).
- **F34M (#106)** — destination-origin guard on fill (src/js/integration.js:1261-1264); broadcast origin stamped by the worker (src/js/agent.js:780-781).
- **F35M (#116)** — persisted token bucket with 0600 gate (src/parcel-host:104-154).
- **F36L (#118)** — popup fill carries `origin: frameOrigin` (src/js/popup.js:1086-1090; verified by me).
- **F37L (#123)** — gitleaks pinned with per-arch SHA-256 (scripts/pre-commit-gitleaks:51-52, :74).
- **F42L (#130)** — `passkeyDir` rejects `..`/leading-`/`/metacharacters (src/parcel-host:1067-1070); `.gpg-id` containment re-checked (:1119-1122).
- **F45L (#131)** — `rsync --delete` in chrome/firefox targets (Makefile:41, :47).
- **F47L** — `action_changes_since` returns after rejecting an invalid `.since` (src/parcel-host:540-543).
- **F48I (#132)** — `CSS.escape(entry.path)` in popup render (src/js/popup.js:912).
- **F50I (#132)** — integration-port action rejection tests (test/agent.test.js:640-650).
- **F52C (#144)** — anchored `grep '^\[GNUPG:\] VALIDSIG '` (parcel-host:897; verified by me).
- **F53M (#175)** — atomic state lock: rename/O_EXCL create, orphan recovery, EXIT trap (src/parcel-host:173-233).
- **F54L (#170)** — TOTP digits 6-10, period 1-3600 (src/js/helpers.js:51-55).
- **F55L (#171)** — real `crossOrigin` + conditional `topOrigin` (src/js/webauthn.js:233-241; src/js/webauthn-integration.js:584-590).
- **F56L (#172)** — malicious-UID VALIDSIG regression test (test/native-host.test.js:619-654).
- **F57L (#174)** — schema unknown-key gate via `hasOwnProperty` (src/js/schema.js:115).
- **F58L (#174)** — MetaSchema nested recursion with cyclic guard (src/js/schema.js:49, 128-134).
- **F60L (#195)** — newline-containing entry paths refused (src/parcel-host:603-610).
- **F61L (#198)** — writable system-looking bootstrap aborts (parcel-host:90-140, invoked :250).
- **F62L (#201)** — http-auth intent restriction sticky for the port's lifetime (src/js/agent.js:641, :730-732; verified by me).
- **F63L (#203)** — `SIGN_KEY` override works (src/Makefile:5; built successfully with a throwaway key).
- **F64L (#202)** — Dockerfile documents deliberate unpinned dev/test convenience (Dockerfile:5-9); acceptance rationale still holds.
- **F65L (#204)** — popup fill-origin assertion test (test/popup.test.js:693-695).
- **F66I (#206)** — regression tests for CSS.escape render, hasOwnProperty gate, per-container history isolation (test/popup.test.js:320-336, 836+; test/schema.test.js:252-259; test/agent.test.js:662-679).
- **F67I (#205)** — tradeoff table now documents the host-side clipboard auto-clear (SECURITY.md tradeoffs table).

No regressions found.

## Deliberate Tradeoffs

Every documented tradeoff in SECURITY.md and every maintainer-accepted finding in `findings.md` was re-derived and tested against the current code; none has diverged:

- Plaintext bash host / HOST_HASH off by default / absent `.parcel.json` reveals all entries — unchanged, still accurately documented.
- Content script on `<all_urls>`, extension detectability, WAR breadth (F7T/F26T) — the current WAR list was traced entry-by-entry; all eight entries are load-bearing; nothing new has crept in.
- Non-dereferenced rule paths (symlink options documented as risky) — unchanged; F69L is a DoS gap under that opt-in, not a contradiction of it.
- Clipboard tradeoff wording (F67I) — now matches the v1.0.7+ host-side implementation.
- First-come-first-served WebAuthn interception, page-realm interception, `allowCredentials` disclosure, popup-spam guard posture — implementation matches documentation exactly (isolated-side Permissions-Policy check, inert-until-enabled shim, non-configurable install with full back-off).
- SPA scope-at-load tradeoff — implemented as documented (README:405, agent.js cascade best-effort).
- F40M/F59M correlation-token posture — code comments and SECURITY.md wording now scope the guarantee accordingly; consistent.
- F12T (user ReDoS), F13T (shadow.js page-realm patch), F28T/F43L/F44L (forgeable bridge events bounded to popup/UI annoyance), F46L (same-UID state tampering out of scope), F15T/F16T, F21T, F23T-F25T, F32T, F33T, F39T, F49I, F51I, F3T-F6T, F8T — re-examined; acceptance rationales still hold.

## Residual Observations

Risks inherent to the design, and hardening notes with no reachable path identified:

- **R1 (host):** `dd bs=4 count=1` without `iflag=fullblock` can short-read the native-messaging length header on a pipe, desyncing framing — fail-closed, and the writer is the browser's native-messaging layer, not attacker-reachable (parcel-host:940).
- **R2 (host):** the `od -An -tx4` length decode is host-endian; correct on little-endian, broken on big-endian — portability, fail-closed (parcel-host:940).
- **R3 (host):** even with F69L fixed, a single ancestor symlink yields a bounded ~40x find amplification via kernel ELOOP.
- **R4 (host):** `.parcel.json` is `cat`ted through symlinks; a store-write attacker gains nothing beyond writing the file directly (default is already allow-all) (src/parcel-host:302).
- **R5 (host):** `decryptRate` regex `^[0-9.]+$` admits multi-dot strings that `awk` truncates; config is a trusted store file (src/parcel-host:726).
- **R6 (host):** POSIX ACLs are not evaluated in the ownership gates (`/etc/parcelrc`, strict-mode binaries); mode-bit checks could miss an ACL grant — admin-misconfiguration territory.
- **R7 (extension):** on tab-port resync after cross-origin navigation, `frameOrigin` refreshes to the *current* origin before the fill post, narrowing the F34M guard to "current origin"; the F6T accepted warning-only posture still fires the cross-origin `alert()`, and the no-resync race hard-refuses (src/js/popup.js:733-742).
- **R8 (extension):** `message.origin` is forwarded verbatim to the host audit log (the unreconciled half of F20M); the only exploiter is a compromised popup, which already holds decrypt capability under the F40M posture; reconciliation is architecturally blocked by popup sender semantics (src/js/agent.js:738).
- **R9 (extension):** forged `parcel-shadow-click` can inject an attribute-selector string into `querySelector`; capability equals the page's inherent `el.click()` (F28T rationale) (src/js/integration.js:987-988).
- **R10 (extension):** `entry.rule` assumed non-null at src/js/popup.js:929,945; reachable only via Oniguruma-vs-JS regex divergence with a trusted config — robustness, not security.
- **R11 (tests):** the Chrome API mock fabricates default tabs for unknown IDs, replays events to late listeners, delivers port messages synchronously, and polyfills `CSS.escape` naively — all availability-fidelity gaps, each traced to fail-closed real behaviour; the mock GPG does not cryptographically bind signature to payload (out of test scope by design).
- **R12 (build):** CI pins actions by major tag, not SHA; CI never produces shipped artifacts.
- **R13 (host):** `clipboardTimeout` > 3600 is clamped rather than rejected, while SECURITY.md says "permitted range 1-3600" — cosmetic.
- **R14 (extension, from cross-model verification):** the toolbar-popup fill can only lack an `origin` key if `frameOrigin` is still undefined at click time; the origin handshake precedes any match results, so the race resolves before any real fill — the rejected F51I edge. Where `tab.url` is unavailable (e.g. `chrome://` pages) no content script runs, so no fill target exists. Cross-origin warning-only filling remains the accepted F6T posture. No reachable path beyond those two records (src/js/popup.js:16, 738, 1086-1090; src/js/integration.js:1261).
- **R15 (build, from cross-model verification):** make's timestamp rules can ship a stale `src/dist` (including `parcel-host.asc` after a `SIGN_KEY` change) on ad-hoc builds; the `release` target depends on `clean`, so official artifacts are always rebuilt from scratch, and the `.asc` staleness case is README-documented ("run `make clean` first"). Hardening only (src/Makefile:57, 79-85; Makefile:40-47, 72-84).
- **R16 (extension, from cross-model verification):** the passkey-conflict view's docs link opens a GitHub page via user-initiated `window.open` with `noopener,noreferrer` (src/js/popup-webauthn.js:317-318). This is the user's browser navigating on an explicit click, not Parcel interacting with network resources; consistent with the constitution's intent (the rule targets autonomous interaction — telemetry, updates, remote code).

## Things Done Well

- **The F52C fix culture:** the anchored `VALIDSIG` grep is paired with an adversarial regression test that crafts a malicious-UID line passing the old grep and failing the new one (test/native-host.test.js:619-654) — fixes and their regression detectors land together.
- **The passkey content-marker backstop:** beyond rule-based classification, any entry whose decrypted first line carries the `#!parcel-passkey ` prefix can never be returned as plaintext (src/parcel-host:867-873) — a second, independent layer exactly where a single point of failure would be catastrophic.
- **The atomic rate-limiter lock:** rename/O_EXCL single-winner semantics, 5 s orphan recovery, jittered backoff, fail-closed exhaustion, whitelist-validated content before `eval` (src/parcel-host:89-233). Kill-reconnect and parallel-process bypasses are both closed.
- **Environment hygiene in the bootstrap:** loader-redirection variables unset before re-exec, whitelist-based environment cleanup, builtins-only PATH filtering, and strict-mode root-ownership chains for binaries and `/etc/parcelrc` — defence-in-depth done carefully, with honest in-code notes about the residual edges.
- **Consent unforgeability by construction:** signatures are only ever produced via the popup port on a token-bound binding; forged bridge events can at worst summon an unwarranted popup.
- **Zero HTML injection sinks:** every store-controlled string in the popup flows through `textContent`/`createTextNode`; config `color` is schema-pinned to hex before touching style.
- **Fail-loud design:** broken-looking installs abort with actionable messages rather than silently degrading to a weaker mode.

## Cross-Model Verification

Phase 2 was performed against `security-review-table-mimo-v2.6-pro-20261004-f34f710.md` (nine entries). Only the exchange table was read; the other model's full report was never accessed. Every entry was independently re-derived from the code. Neither of my phase-1 findings appeared in the other table, and vice versa — zero overlap.

**Confirmed and added (with this review's own analysis):**

- **mimo-v2.6-pro-3 → F72L** (`make extension` runs `write(1)`): confirmed empirically in a scratch copy (`make -n` shows the expanded recipe; a real run prints `write: **/*... is not logged in`, "Error 1 (ignored)", and completes). My mechanism analysis: the sub-make never receives `PRETTIER`, and GNU make consumes the expanded leading `--` as the ignore-errors prefix. Severity L agreed.
- **mimo-v2.6-pro-4 → F70L** (Oniguruma-invalid rule pattern silently wedges `action_list`): confirmed. I independently demonstrated the engine divergence (`\p{Script_Extensions=Greek}`: accepted by Node's JS u-mode, rejected by jq's Oniguruma) and traced the silent no-response to the `local OUT="$(...)"` status masking plus `parcel_send`'s empty-payload guard. Severity L agreed; fails closed (empty whitelist), availability-only.
- **mimo-v2.6-pro-7 → F74L** (consent absolutes): confirmed as a wording-level TM0 tension at SECURITY.md:146/:166. Severity L agreed. Framed strictly as documentation against the accepted F40M/F59M posture to avoid re-reporting the rejected substance.
- **mimo-v2.6-pro-9 → F77I** (constrain-height comment): confirmed — the token is readable from the popup iframe's `src` in page DOM (integration.js:762-763), so the check stops other frames, not the page. Severity I agreed.

**Severity disagreements:**

- **mimo-v2.6-pro-2 → F71L (popup-spam guard bypass via supersede/abort)** — mimo rates M; this review rates it **LOW** and adds it as a finding on that basis:

  *Supersede and abort both settle ceremonies without touching `passkeyDismissStreak` (supersede at src/js/webauthn-integration.js:321-327, abort at :372-385; the streak only moves in `finish()` at :545-551). A page can therefore cycle `navigator.credentials.get()` + `AbortSignal.abort()` indefinitely, re-raising the consent popup without the two-dismissal guard ever engaging. The bypass is real and reachable with two lines of page JS. LOW rather than M because the guard is an anti-annoyance control: its bypass yields exactly the documented and accepted worst case for bridge forgery ("can summon an unwarranted popup", SECURITY.md), and the F44L precedent rates page-driven popup/manipulation effects LOW. No signature, decryption, or origin-steering consequence exists — consent still gates every ceremony. Recommended fix: count aborts and supersedes as dismissals for streak purposes (treat any non-consented terminal state identically in `finish`/`handlePasskeyAbort`/the supersede loop).*

**Non-reproductions / downgrades to residual:**

- **mimo-v2.6-pro-1 (fill without `origin` skips the F34M guard)** — not reproduced as a finding. The message omits `origin` only when `frameOrigin` is undefined at fill time, i.e. before the content script's `origin` handshake completes; entries cannot be clicked before the (slower) match round trip, which itself post-dates the handshake, and where `tab.url` is unavailable no content script exists to fill into. This is the maintainer-rejected F51I edge ("no practical exploit exists") compounded with the accepted F6T warning-only posture; the dedup rule bars re-reporting absent a rationale change, and none was demonstrated. Recorded as R14.
- **mimo-v2.6-pro-3 (rule-less entry aborts popup render)** — not reproduced as a finding. Reachability requires a pattern that matches an entry name under jq's Oniguruma but not under JS u-mode while passing JS-side schema validation; no concrete divergent pair was demonstrated by either model, and the only confirmed engine divergence (F70L) runs the *opposite* direction (JS accepts, Oniguruma rejects — which fails closed host-side). The throw is additionally caught by `scheduleRender` (src/js/popup.js:1064-1067). Recorded as R10.
- **mimo-v2.6-pro-6 (timestamp staleness ships stale `src/dist`)** — not reproduced as a finding. The `release` target depends on `clean` (Makefile:72), so shipped artifacts are always rebuilt; ad-hoc staleness requires mtime manipulation on the build machine, an actor who already owns the build; the `.asc`/SIGN_KEY case is README-documented. Recorded as R15.
- **mimo-v2.6-pro-8 (`window.open` docs link vs no-network)** — confirmed as an accurate observation, classification disagreement: this review treats a user-initiated, `noopener,noreferrer` docs navigation as the user's browser acting on an explicit click, not Parcel autonomously interacting with network resources, which is what the constitution prohibits. Recorded as R16.

## Second-Look Review

Honest answers to the second-look checklist:

- **Reachability:** all seven findings survived. F69L, F70L, and F72L were demonstrated with live PoCs (symlink-cycle root growth; jq/Node regex divergence plus the masked-failure trace; scratch-tree build executing `write(1)`); F71L was confirmed by reading the three settlement paths against the single streak-mutation site. F73L and F74L are documentation/implementation divergences confirmed line-by-line in both artefacts (and, for F73L, in the tests that pin the behaviour). F77I is comment-only. No "looks suspicious" item was promoted — everything else is in Residual Observations with an explicit no-reachable-path statement, including the four cross-model entries I could not confirm as findings (R10, R14-R16).
- **Superficial areas:** the checklist was gone through item by item by the owning subagent and spot-verified by me. The thinnest personal coverage is (a) the osascript/JXA clipboard path (static review only — macOS unavailable) and (b) the popup's rendering code (verified via sink greps and the test suite rather than line-by-line reading of all 1251 lines).
- **Unverified assumptions:** F69L assumes the extension watchdog respawn loop re-triggers `list` (observed behaviour in the F60L wedge discussion in findings.md); F73L assumes the SECURITY.md:87 sentence is intended to cover value-malformation, not just the ownership gate — hence the Medium confidence; F74L assumes readers interpret the leading absolutes at face value rather than as page-scoped — hence Medium confidence on impact (High on the wording).
- **Tradeoff misattribution:** the full tradeoffs table and all accepted findings were cross-checked; F69L sits under the documented symlink-option risk but is a *new mechanism* (cycle amplification, not policy timing), so it is reported; the accepted `allowCredentials` disclosure, first-come-first-served interception, and SPA scope-at-load items were deliberately not re-reported.
- **jq call sites / unquoted variables / dispatch paths:** all `jq` extraction sites in both host scripts were enumerated by the host subagent; the only deliberate unquoted expansion (`blacklisted`, parcel-host:832) iterates regex-validated hex; dispatch is regex-gated then `type -t` gated.
- **Origin validation on every fill/decrypt path:** verified by me on the primary popup path (popup.js:1090 carries origin), the inline fill path (integration.js:1261-1264), and the broadcast path (agent.js:780-781 stamps decrypt-time origin); http-auth decrypts are intent-restricted for the port's lifetime.
- **Severity consistency:** no C/H/M used; the six L's defend as: demonstrated store-content→host-DoS under a non-default option (F69L, M arguable — flagged); a documented fail-closed promise the code deliberately fails open (F73L, I arguable — flagged); a fail-closed availability wedge from hostile store config (F70L); a fail-benign build defect with a downstream detector (F72L); wording that overstates an accepted TM2 posture (F74L); and an anti-annoyance guard bypass whose impact is the documented, accepted annoyance class (F71L, M arguable — flagged). Only the six permitted letters used. The one cross-model severity dispute (popup-spam guard, M vs L) is argued explicitly in Cross-Model Verification rather than silently resolved.
- **Prior-review isolation:** confirmed — no access to `security-review/reviews/` content by me or any subagent, and no access to the other model's full report in phase 2 (table only).
- **Confidence calibration:** F69L High (live PoC; a demo that the wedge resolves promptly under watchdog respawn would not change the severity, only the impact narrative). F73L Medium (a maintainer statement that :87 scopes only the ownership gate would drop it to I). F70L High (live engine divergence + traced silent-no-response path; evidence that would change it: a response-invariant guard I missed). F72L High (empirically executed). F74L Medium on impact, High on wording. F71L High on the bypass (three settlement paths read against the single streak site; evidence that would change it: an abort-side streak update I missed), Medium on the L-vs-M call (a demonstrated user-harm beyond popup spam would raise it). F77I High (token visibly carried in the iframe `src` at integration.js:762-763).

## About This Review

- **Model:** kimi-k3 (model ID: kimi-k3), via GitHub Copilot CLI 1.0.91
- **Date:** 2026-10-04
- **Commit:** `f34f710` (tag `v1.0.8`; release review — HEAD exactly at the tag, clean tree)
- The committed `security-review/prompt.md` is the canonical record of what was prompted.

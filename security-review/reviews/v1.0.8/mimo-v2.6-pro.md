# Security review - Parcel v1.0.8 - mimo-v2.6-pro

Final report. Phase 1 (independent review) and phase 2 (cross-model verification against kimi-k3's findings table) both complete.

## Executive Summary

This review examined Parcel v1.0.8 at commit `f34f710` (exactly at tag `v1.0.8`, clean tree - a release review) across all six threat models and every coverage-checklist area. The overall posture is strong: the native host's enforcement boundary - whitelist, rate limiter, signer revocation, HOST_HASH pinning, version ratchet, rpId binding, allowCredentials enforcement, and the passkey content-marker backstop - held under every attack attempted, including roughly 35 live adversarial checks against the real host scripts with a controllable mock GPG. The extension contains zero HTML/JS injection sinks, the manifest CSP is complete, and the built Chrome/Firefox bundles were verified byte-identical to `src/` apart from documented manifest transforms. The full test suite passes 615/615 (35 suites).

Eleven findings are recorded: two MEDIUM, seven LOW, two INFORMATIONAL. No CRITICAL or HIGH. Nine were found in phase 1; two LOW findings reported by the other reviewing model (kimi-k3) were independently reproduced in phase 2 and added as findings 10-11 with my own analysis. The single most important takeaway: **the F34M destination-origin guard - the primary anti-cross-origin-fill protection - is silently skipped on Chrome whenever the popup's origin handshake has not completed**, because the fill message then carries `origin: undefined`, which Chrome's JSON message serialisation drops, so the content script's `hasOwnProperty(msg, "origin")` gate never fires. This re-opens the exact mid-decrypt cross-origin fill scenario that F34M closed, under narrow timing preconditions, and it also skips the F6T cross-origin warning. The fix is small (fail closed when `origin` is absent, and seed `frameOrigin` from `tab.url`).

The second MEDIUM is a confirmed bypass of the documented WebAuthn popup-spam guard: a page that supersedes (or aborts) each in-flight ceremony instead of dismissing it never increments the dismissal streak, so consent popups can be raised without bound. Impact is popup annoyance only - consent, rpId binding, and the host boundary are unaffected - so the severity is disputed in both directions (see finding).

## Trust Model & Attack Surfaces

The trust-boundary hierarchy, as examined in this review rather than paraphrased:

1. **The native host is the enforcement root.** `parcel-host` (bootstrap) accepts exactly one privileged operation from the browser - `install` of a script plus detached signature - and gates it behind a four-layer chain: GPG verification in an ephemeral keyring, anchored `VALIDSIG` signer extraction with hex-validated primary/signing fingerprints, blacklist union (parcelrc + state cache, primary and subkey forms), then optional `HOST_HASH` pinning and the `MINIMUM_HOST_VERSION` ratchet. Only after all gates pass does the bootstrap `eval` the script. Every step fails closed; the action surface is regex-gated (`^[a-zA-Z0-9_]+$`); the framing layer caps messages at 16 MiB. I verified each gate in the code and via the host PoC driver.
2. **`src/parcel-host` bounds what a fully compromised extension can do.** Decryption requires an exact path match against `ALLOWED_FILES` (built only from the filtered `find` traversal), passes the symlink policy re-checked at decrypt time (list-to-decrypt TOCTOU), is denied for passkey-classified entries and - as a content-marker backstop - for any entry whose decrypted first line is `#!parcel-passkey *`, and costs a rate-limiter token even when denied. Passkey signing additionally requires the entry's `rpId` to equal the request rpId (host-validated to `^[a-z0-9][a-z0-9.-]{0,252}$`), `allowCredentials` membership when supplied, and a well-formed entry. Private key material never appears in any response or log. The rate-limiter bucket persists through an atomic rename/noclobber lock, so kill-and-reconnect does not reset it.
3. **The extension mediates page-facing policy but is not trusted for host policy.** The content script re-derives origins and rpIds in the isolated world, the popup shows the true origin and requires explicit selection, and the agent enforces a per-port-name action allow-list. These are anti-phishing and anti-accident controls; per the accepted F40M/F59M posture they are not TM2 defences - the host is. The gaps found in this review (findings 1 and 2) are in this layer.
4. **MAIN-world code is minimal and inert by design.** `main-world/shadow.js` records shadow roots and re-dispatches clicks; `main-world/webauthn.js` wraps `navigator.credentials` only after the isolated world confirms passkeys are enabled and in scope. Neither holds secrets; both are forgeable surfaces the design deliberately accepts (F28T/F13T), with the mitigating invariant that every bridge message is re-derived and re-validated isolated-side and every ceremony requires the consent popup.
5. **Configuration is split by trust.** `parcelrc` is a trusted, 0600-gated, canonically-parsed `KEY="value"` file (with a root-owned `/etc/parcelrc` anchor that can only add revocations and raise the version floor); `.parcel.json` is store-synced and therefore potentially hostile (SECURITY.md says so explicitly), and is treated as data: schema-validated in the extension and consumed via `jq` on the host. Findings 3 and 4 are defects in that hostile-config handling.
6. **Build/packaging is a pure copy-and-sign pipeline.** Verified byte parity between `src/` and both bundles; the only transforms are the documented manifest rewrites and the generated `.asc`. Findings 5 and 6 are defects in this pipeline's robustness, not in shipped artefacts.

## Methodology

- **Model identity:** mimo-v2.6-pro (filename-safe form `mimo-v2.6-pro`).
- **Date:** 2026-10-04. **Release:** 1.0.8 (`.version`). **Commit:** `f34f710`, `git describe` = `v1.0.8`; working tree clean, HEAD exactly at the release tag, so this is a release review and the report lives under `reviews/v1.0.8/`.
- **Documents read in full (grounding):** `CONSTITUTION.md`, `SECURITY.md`, `README.md`, `security-review/findings.md`.
- **Prior full reviews:** no file under `security-review/reviews/` was opened, read, or otherwise accessed. For the §0 filename convention the *directory listing* (filenames only) of `security-review/reviews/` and `security-review/reviews/other/` was inspected; no file contents were touched. `findings.md` was the sole source on prior reviews.
- **Source examined (main session, in full or in substantial part):** `parcel-host` (bootstrap: environment sanitisation, strict-mode and writable-install guards, parcelrc parser and `/etc/parcelrc` gate, blacklist/version-floor persistence, `action_install` verification chain, main loop), `src/parcel-host` (state lock and rate limiter, config load, `action_list` whitelist construction, `action_decrypt`, `action_passkey`/`passkey_op_get`/`passkey_op_create`, audit logging), `src/js/agent.js` (port auth, action allow-list, http-auth tokens, `#validateRpId`), `src/js/integration.js` (fill paths and origin guard), `src/js/popup.js` (handshake, fill send, render path, history keying), `src/js/popup-webauthn.js` (save-command builder), `src/js/webauthn-integration.js` (spam guard, supersede/abort, consent flow), `src/js/main-world/shadow.js`, `src/js/plaintext.js`, `src/js/scopes.js`, `src/js/helpers.js` (TOTP bounds), `src/manifest.json`, `Makefile`, `src/Makefile`, `test/native-host.test.js` (adversarial cases), `test/schema.test.js`, `test/popup.test.js` (origin-carriage assertion).
- **Subagents:** three, all on mimo-v2.6-pro per protocol, each owning a distinct area: (1) native host + host-side constitution compliance; (2) extension JS + WebAuthn + popup; (3) manifest/build/tests + regression checks. Every finding and regression line entering this report was re-verified in the main session against the code (and, where noted, by independent PoC); one subagent finding (rpId shell injection) was demoted to hardening after main-session reachability analysis, and one subagent severity (popup-spam guard) was re-calibrated with the uncertainty flagged.
- **Tests run:** `make test` in a /tmp copy of the tree (tree kept pristine; `git status` clean before and after): **615 pass / 0 fail, 35 suites** (prettier --check, eslint, shellcheck, and all 18 node suites). Subagent runs corroborate: 615/615, `make test-setup` 44/44, `make todo` clean. One subagent observed a load-flaky `native-host` lock-exhaustion test (passes in isolation); host behaviour verified correct - a test-robustness note, not a product defect.
- **Empirical work (all outside the reviewed tree):** host PoC driver over real native-messaging framing with controllable mock GPG - ~20 scenarios/35 checks covering the VALIDSIG injection (F52C), HOST_HASH basis (F22L), newline filenames (F60L), action-dispatch injection (F31L), message framing/oversize, rate-limiter persistence and concurrency (F35M/F53M), symlink policy timing (F17L), TOCTOU symlink swap, passkey rpId/allowCredentials/content-marker controls, audit-field sanitisation and caps (F2M/F10L/F14L), jq injection attempts, blacklist and version-ratchet semantics, keyring lifecycle (F1M), `changes_since` validation (F47L), GPG-status leak (F30L); plus real ES256 signing with independent signature verification. Extension PoCs (Node + jsdom + Chrome-API mock): popup-spam guard bypass (25/25 popups raised via supersede vs 2-then-refuse control), rule-less entry render abort (0/2 entries rendered), origin-key-dropped-on-the-wire and originless-fill-applied (with mismatched-origin correctly refused when `origin` present). Build PoCs: `make extension` formatting no-op + `write(1)` execution confirmed; stale-mtime `src/dist` shipping confirmed; full chrome+firefox build with a throwaway key verified byte-identical bundles and exact manifest deltas; unanchoring the VALIDSIG grep makes exactly the F56L adversarial test fail; a `minLengh` typo in a nested schema makes the meta-validation test fail (transitive coverage confirmed). Main-session probes: WHATWG hostname charset (`` ` ``/`$`/`;`/`&`/`"` accepted in hostnames), `jq` regex-failure behaviour, GNU make prefix stripping.
- **Scratch locations (retained as evidence outside the tree):** `/tmp/parcel-review-main/collect-roots-poc/` (main-session PoCs incl. the finding-10 reproduction), `/home/copilot/parcel-review-build/` (build subagent), session workspace `files/parcel-review-host/` (host subagent; its runtime prohibited `/tmp` writes).
- **Limitations:** no live browser was available, so Chrome's JSON message serialisation dropping `origin: undefined` is reasoned from documented semantics, not observed (finding 1's confidence would rise to High on observation); no real release signatures or store artefacts were checked; the `/etc/parcelrc` ownership gate was code-reviewed but not live-tested (needs root fixtures); macOS clipboard paths untested (Linux only); GPG was mocked for protocol tests (real GnuPG used for passkey crypto); timing/side-channel analysis out of scope; `src/publicsuffix` excluded per project guidance.

## Findings

| ID | Severity | Confidence | Area | Threat model | Title | file:line |
|----|----------|------------|------|--------------|-------|-----------|
| F68M | M | Medium-High | Content script / popup | TM1 | Chrome: fill message without `origin` key skips the F34M destination-origin guard and the F6T warning | src/js/popup.js:16,738,1090; src/js/integration.js:1261 |
| F71L | M | High | WebAuthn | TM1 | Popup-spam guard bypassed by ceremony supersede/abort paths | src/js/webauthn-integration.js:22-23,274-285,321-327,372-385,541-550 |
| F75L | L | Medium | Popup | TM4 | Rule-less entry aborts the whole popup render batch | src/js/popup.js:929,945; src/js/agent.js:333-348 |
| F70L | L | High | Native host | TM4 | Malformed `.parcel.json` rule pattern silently wedges `action_list` (no response) | src/parcel-host:646-696; parcel-host:746-750 |
| F72L | L | High | Build | TM5, TM0 | Build silently skips its Prettier step and executes `write(1)` instead | Makefile:19; src/Makefile:42-47 |
| F76L | L | High | Build | TM5 | Timestamp rules let a stale `src/dist` (incl. `parcel-host.asc`) ship | src/Makefile:57,79,82-85; Makefile:40-47 |
| F74L | L | Medium | Documentation | TM0 | Consent guarantees phrased as absolutes the host does not enforce under TM2 | SECURITY.md:146,166; src/parcel-host:883-1046 |
| F69L | L | High | Native host | TM4 | `collect_roots` textual-only dedup: self-referential store symlinks cause unbounded root-queue growth that wedges the host | src/parcel-host:344-394 |
| F73L | L | Medium | Documentation / bootstrap | TM0 | SECURITY.md:87 overstates fail-closed handling: malformed `BLACKLIST_SIGNERS`/`MINIMUM_HOST_VERSION`/path values are ignored with a log note, not refused | parcel-host:482-505; SECURITY.md:87 |
| F78I | I | High | Popup / documentation | TM0 | `window.open` help link vs "no network access, for any reason" | src/js/popup-webauthn.js:317-318 |
| F77I | I | High | Popup | TM0 | Comment overstates the constrain-height token's forgery protection | src/js/popup.js:553-555 |

### F68M - Chrome: fill message without `origin` key skips the F34M destination-origin guard and the F6T warning (M)

**Description:** The F34M fix makes the content script refuse a fill whose intended origin differs from the frame's current origin, and the F6T tradeoff's mitigation warns on cross-origin fills. Both controls live behind `Object.prototype.hasOwnProperty.call(msg, "origin")` in `integration.js`, and the popup populates `origin` from `frameOrigin`, a variable assigned only when the origin handshake message arrives *and* `tab.url` is truthy. When the handshake has not completed, the fill message carries `origin: undefined`; Chrome serialises port messages as JSON, which drops the key entirely, so the guard's `hasOwnProperty` gate is false and the fill proceeds with no cross-origin check and no warning. (Firefox's structured clone preserves the key with an `undefined` value, where the guard fires and refuses - the defect is Chrome-specific.)

**Threat model(s):** TM1 (mid-decrypt navigation redirecting a credential cross-origin - the exact F34M scenario).

**Evidence:** `src/js/popup.js:16` (`frameOrigin` declared, no initialiser), `src/js/popup.js:738` (assigned only inside the `msg?.action === "origin"` handler, itself gated on `if (tab.url)`), `src/js/popup.js:1085-1091` (fill sends `origin: frameOrigin`), `src/js/integration.js:1261` (guard fires only when the `origin` key is present), `src/js/popup.js:1244-1249` (handshake failure is explicitly non-fatal: "Your fill may still work when you trigger it"), `src/js/popup.js:447-477` (`waitForTabReady`: 3 attempts x 600 ms, then gives up). The F6T warning sits in the same `origin` handler (`src/js/popup.js:737-747`) and is skipped by the same edge. Regression test `test/popup.test.js:693-695` covers only the handshake-complete path.

**Exploit scenario:** The user opens the toolbar popup on a page whose module content script has not yet completed the ready/origin handshake (module content scripts run after document parse, so slow-loading pages realistically exceed the 1.8 s budget; the popup even tells the user fills "may still work"). The user selects an entry; decryption is slow (interactive GPG unlock). Mid-decrypt the tab navigates to attacker origin B (page-initiated redirect, meta-refresh, or open redirect). The fill is delivered to the content script now resident in the tab; because the message carries no `origin` key, the guard at `integration.js:1261` is skipped and the credential intended for origin A is typed into B's form, where page script reads it. With `origin` present the same sequence is refused (verified by PoC).

**Recommended fix:** fail closed in `integration.js`: treat a fill carrying no `origin` as unfillable (or compare against `tab.url`'s origin as a fallback), and seed `frameOrigin` from `new URL(tab.url).origin` at popup startup so the key is always present. Add a no-handshake fill test.

**Confidence:** Medium-High. The code path and the key-dropping semantics are verified; the Chrome JSON-serialisation behaviour is reasoned from documented semantics rather than observed in a live browser. Evidence that would change it: a browser-observed demonstration that Chrome preserves `origin: undefined` keys (would drop the finding), or that fills are unreachable before the handshake (contradicted by the popup's own warning text).

**Severity note (flagged uncertainty):** the severity table lists "origin validation on fill" under HIGH for reachable bypasses; a strict reading could rate this HIGH. I rate MEDIUM because exploitability requires a conjunction of narrow preconditions (incomplete handshake, mid-decrypt navigation to a hostile origin, user proceeding despite the "page has not responded" warning), which is the MEDIUM tier's "narrow preconditions" clause. If the maintainers consider the handshake gap easily forced (e.g. by a page that delays parse), this should be revisited upward.

### F71L - Popup-spam guard bypassed by ceremony supersede/abort paths (M)

**Description:** SECURITY.md's seventh passkey protection promises that after two consecutive dismissed ceremonies, further WebAuthn requests "are refused popup-free for one second", so a site cannot re-raise the consent modal in a loop. The dismissal streak is only updated in `finish()` (the popup-dismissal path). Two other terminal paths - a newer request superseding in-flight ceremonies, and `handlePasskeyAbort` - drop bindings without touching the streak, so a page that always supersedes (or aborts) before the user dismisses never trips the guard and can raise consent popups without bound.

**Threat model(s):** TM1 (hostile page-realm JS).

**Evidence:** guard state `src/js/webauthn-integration.js:22-23`; guard check `:274-285`; supersede loop `:321-327` (deletes bindings, answers `fallback`, no streak update); abort handler `:372-385` (same); `finish()` `:541-550` (the only streak update). SECURITY.md:152 states the promise. Verified by PoC: a supersede loop raised 25 consent popups with 0 refusals (same for abort), versus the control path (2 popups then refusals) for dismissals.

**Exploit scenario:** A hostile page loops `navigator.credentials.get()`/`create()`, each call superseding the previous in-flight ceremony before the user can dismiss it. The user is presented with an endless stream of Parcel consent popups over the page - harassment and a social-engineering surface ("just click through"). No signature, decryption, or origin steering is possible: consent still requires explicit selection in the popup, and the minted-credential guard (`:311-319`) prevents discarding an unsaved registration.

**Recommended fix:** count supersede/abort terminals in the same streak as dismissals (or route them through `finish()`), and consider hoisting the guard state to the background worker so it is per-origin rather than per-frame module state. Add regression tests - the guard currently has none.

**Confidence:** High on the mechanics (PoC-verified); the severity is the uncertain part. **Severity note (flagged uncertainty):** the LOW reading is defensible (impact is popup annoyance only, matching the accepted F44L and rejected F49I precedent, and the doc's literal scenario is "after each dismissal"); the HIGH reading is defensible under the letter of "reachable bypass of a documented protection". I rate MEDIUM as the balanced call: a confirmed bypass of a documented control with no overlapping backup (the MEDIUM "defence-in-depth gap in a control with no overlapping backup" clause), with impact bounded to annoyance. A maintainer who weighs impact over letter would reasonably record this as LOW.

### F75L - Rule-less entry aborts the whole popup render batch (L)

**Description:** The host matches entries against rules using `jq`'s Oniguruma regex engine; the extension assigns `entry.rule` by re-matching with JavaScript `RegExp`. When an entry matches a rule on the host but no rule in the JS pass (dialect divergence, or a config/list TOCTOU between the two passes), `entry.rule` is `undefined`, and the render path dereferences `entry.rule.tag` and `entry.rule.strip` without optional chaining, throwing a `TypeError` that aborts rendering of the entire batch.

**Threat model(s):** TM4 (crafted `.parcel.json`, e.g. via a hostile store sync peer - the scenario SECURITY.md's configuration-isolation section warns about).

**Evidence:** `src/js/popup.js:929` (`entry.rule.tag`) and `:945` (`entry.rule.strip`) unguarded, contrasted with `:924-925`/`:1013` which use `entry.rule?.class`; `src/js/agent.js:333-348` (rule assignment; `undefined` when no JS rule matches). PoC: a rule-less entry aborts the render loop - 0 of 2 entries displayed.

**Exploit scenario:** A hostile or merely dialect-clever rule pattern (e.g. an Oniguruma-only construct such as a possessive quantifier) matches on the host but throws or fails to match in the extension's `new RegExp` pass; every entry in the popup list disappears for that origin until the config is repaired. UI denial of service only - no credential exposure (nothing is decrypted by rendering).

**Recommended fix:** use `entry.rule?.tag` / `entry.rule?.strip` (or default `rule` to `{}` in the agent), and wrap per-entry rendering in try/catch so one bad entry cannot sink the batch.

**Confidence:** Medium. Would rise on proof that `#setEntries` always yields a rule (none found); would fall to informational if the host and extension provably share a regex dialect.

### F70L - Malformed `.parcel.json` rule pattern silently wedges `action_list` (no response) (L)

**Description:** In `action_list`, the jq pipeline that evaluates include/ignore patterns runs `test($pattern)` per rule. An invalid regex (`"pattern": "["`) or a non-string pattern makes `jq` fail; the pipeline sits inside `local OUT="$(...)"`, whose exit status is `local`'s own, so `set -e` does not fire and `OUT` is empty. `ALLOWED_FILES` is then cleared (deny-all, fail-closed) and `parcel_send "$OUT"` silently drops the empty payload, so the request receives no response at all - contradicting the one-response-per-request invariant documented in the same function. Every subsequent `list` wedges identically until the config is repaired by hand.

**Threat model(s):** TM4 (crafted `.parcel.json` in a synced store).

**Evidence:** `src/parcel-host:646-689` (jq pipeline inside `local OUT=`), `:690` (`ALLOWED_FILES` cleared from empty output), `:696` (`parcel_send "$OUT"`), `parcel-host:746-750` (`parcel_send` drops empty payloads), invariant comment `src/parcel-host:571-572`. Independently confirmed: `jq` aborts with "Regex failure: premature end of char-class" on `"pattern": "["`, and `parcel_send` sends nothing for an empty string. Subagent PoC verified live: `list` never answers (15 s timeout), the host stays alive (`ping` OK), all later `list` calls wedge the same way.

**Exploit scenario:** A hostile sync peer ships a `.parcel.json` with one malformed rule pattern; the victim's entry listing hangs (extension shows a generic timeout) until they diagnose and repair the config. All decrypts are denied meanwhile (fail-closed), so no credential exposure; the defect is availability plus the documented protocol invariant.

**Recommended fix:** capture the jq pipeline's exit status explicitly and emit `parcel_error "Failed to evaluate config rules"` on failure; optionally validate rule patterns at `load_config` time.

**Confidence:** High. Would change only if a `jq` build exists where `test("[")` does not fail (removes reachability) or the extension surfaces a clear config error on a missing list response (lowers impact).

### F72L - Build silently skips its Prettier step and executes `write(1)` instead (L)

**Description:** The top-level `extension` target invokes `make -C ./src` without forwarding `PRETTIER`, while `src/Makefile`'s default target depends on `prettier`, whose recipe is `$(PRETTIER) --write $(PRETTIER_FILES)`. With `PRETTIER` empty the recipe line becomes `--write '...'`; GNU make strips the repeated `-` prefix characters as ignore-errors markers and runs `write(1)` with the glob as its operand. Every `make extension`/`chrome`/`firefox`/`all`/`release` build therefore skips the documented formatting step and executes an unrelated PATH binary, with the failure ignored.

**Threat model(s):** TM5 (build integrity), TM0 (documented behaviour contradicted - AGENTS.md states the build "formats source with Prettier").

**Evidence:** `Makefile:19` (no `PRETTIER` forwarding, contrast `Makefile:28` and `:126` which do), `src/Makefile:42-47` (recipe). Verified: a minimal Makefile reproduces the prefix-stripping (`write foo` executed, error ignored), and a misformatted probe file survived `make extension` unformatted. On this system `/usr/bin/write` exists and errors harmlessly ("is not logged in"); on a system without `write(1)` the failure is likewise ignored.

**Exploit scenario:** No shipped-artefact divergence (CI's `prettier --check` in `test-syntax` still gates formatting, and bundles were verified byte-identical). The security-relevant residue is twofold: the build's documented formatting gate is a silent no-op (so "the build formats what it ships" cannot be relied on), and each build executes whatever `write` resolves to earlier in `PATH` - a small, unexpected build-time binary invocation surface.

**Recommended fix:** forward the variable: `$(MAKE) VERSION=$(VERSION) PRETTIER=$(PRETTIER) -C ./src`. Would downgrade to informational if formatting were shown to run in any supported invocation.

**Confidence:** High (mechanism reproduced independently in the main session).

### F76L - Timestamp rules let a stale `src/dist` (incl. `parcel-host.asc`) ship (L)

**Description:** `dist/parcel-host` and `dist/parcel-host.asc` are built by timestamp rules against `parcel-host`. If the source file is restored with an older mtime than the existing `dist` artefacts (`cp -p`, `tar -x` preserving archives, clock skew, or a `SIGN_KEY` switch without `make clean`), make considers them up to date and the previous build's host script and signature are synced into `chrome/`/`firefox/` unchanged.

**Threat model(s):** TM5 (source-to-distribution parity; F45L-class residual).

**Evidence:** `src/Makefile:57` (`dist/parcel-host.asc: parcel-host`), `:79` (`dist: ...`), `:82-85` (`dist/parcel-host: parcel-host`), `Makefile:40-47` (rsync of whatever `src/dist` holds). Verified by PoC: restoring `src/parcel-host` with an older mtime produced zero rebuild lines and `make chrome` would have shipped the byte-different stale pair.

**Exploit scenario:** A packager restoring sources with archived mtimes (or switching `SIGN_KEY` without `make clean`, as README warns) ships an older host script with its matching older signature. The pair stays internally consistent and signature-valid, so no unverified code executes; `MINIMUM_HOST_VERSION`/`HOST_HASH` bound replay of genuinely old versions. Impact is parity/review-trail integrity, not code execution.

**Recommended fix:** add a `verify-dist` step that `cmp`s `dist/parcel-host` against `parcel-host` (and re-verifies the `.asc`) in the `chrome`/`firefox` targets, or rebuild `dist` from scratch in `extension`.

**Confidence:** High (mechanism PoC-verified).

### F74L - Consent guarantees phrased as absolutes the host does not enforce under TM2 (L)

**Description:** SECURITY.md's lead sentences for both ceremony types state unconditionally that "No signature is produced without you explicitly selecting a credential in the consent popup" (passkeys) and "No credentials are supplied without explicit user selection in the popup" (HTTP auth). The scoping sentence that follows ("A page cannot silently authenticate you...") correctly limits the guarantee to page script, and the compromised-extension section correctly lists signing among what a compromised extension *can* do - but the lead sentences remain absolutes that fail under the document's own TM2: the host enforces whitelist, rpId, allowCredentials, content markers and the rate limiter, but has no consent gate (verified: real ES256 signatures obtainable with no UI). This is the residual documentation tension noted when F59M was rejected; the #193 wording correction scoped the second sentence but not the first.

**Threat model(s):** TM0 (with TM2 as the counterexample).

**Evidence:** `SECURITY.md:146`, `SECURITY.md:166`; `src/parcel-host:883-1046` (`action_passkey`/`passkey_op_get` contain no consent input); F59M rejection rationale in `findings.md` ("Consent is a page-facing guarantee").

**Exploit scenario:** None beyond the accepted F59M posture - a compromised extension context can obtain signatures within whitelist/rpId/allowCredentials/rate-limit bounds. The defect is that the documentation, read literally, promises more.

**Recommended fix:** scope both lead sentences, e.g. "For page-initiated ceremonies, no signature is produced without you explicitly selecting a credential... (a compromised extension context can invoke signing within the host's whitelist, rpId, allowCredentials and rate-limit constraints)".

**Confidence:** Medium. Would drop to informational if the maintainers judge the adjacent scoping sentences sufficient context.

### F69L - `collect_roots` textual-only dedup: self-referential store symlinks cause unbounded root-queue growth that wedges the host (L)

*Reported by kimi-k3 in phase 2; independently reproduced and analysed here.*

**Description:** `collect_roots` expands scan roots when `allowLinks` is enabled, deduplicating only by textual string comparison of link paths. `find -H` follows each root symlink on its command line, so every already-collected link is rediscovered *through* each previously collected link under a longer textual prefix (`a/l1` -> `a/l1/l1` -> `a/l1/l1/l1`...), and each rediscovery passes the textual dedup. A single self-referential symlink (`a/l1 -> .`) therefore grows the root queue without bound (linearly); two such links (`a/l1 -> .`, `a/l2 -> .`) grow it combinatorially (each root rediscovers both). The `while [ $ROOT_IDX -lt ${#ROOTS[@]} ]` loop never terminates.

**Threat model(s):** TM4 (crafted password-store contents - symlinks - combined with crafted `.parcel.json`).

**Evidence:** `src/parcel-host:344-394` (function), specifically `:374-390` (rediscovery loop and textual dedup `[ "$ROOT" == "$LINK" ]`). Reproduced live in the main session with the verbatim-extracted function against a fixture store: benign store returns 1 root instantly; with `a/l1 -> .` the queue grows `a/l1`, `a/l1/l1`, `a/l1/l1/l1`, ... without bound; with `a/l1 -> .` and `a/l2 -> .` the queue doubles per level (observed `a/l2/l2/l2`, `a/l2/l1/l1`, `a/l1/l2/l2`, ... at depth 3 within seconds) and the call did not terminate within 60 s. Note the target-containment check (`:377`) does not help: the links' target (`store/a`) is legitimately inside the store.

**Exploit scenario:** A hostile store sync peer ships `.parcel.json` with `allowLinks: true` (or the user has legitimately enabled it, as the documented symlink tradeoff permits) plus one or two self-referential directory symlinks. The next `action_list` (or `action_changes_since`, which calls the same function at `src/parcel-host:540`) spins forever, burning CPU and growing memory; the native-messaging connection wedges, and the extension's watchdog respawns a fresh host that wedges the same way on the next listing. Parcel is denial-of-serviced until the store is cleaned. Confidentiality is unaffected - the wedge happens before any listing completes and all decrypts fail closed (empty `ALLOWED_FILES`).

**Recommended fix:** bound the expansion - track visited roots by `readlink -f` (canonical target) rather than by link text, cap the root count/depth, or detect that a candidate root resolves to an already-visited directory and skip it. Add a regression test with a self-referential link.

**Confidence:** High (reproduced in the main session). Severity L is calibrated to the F17L precedent (symlink-based DoS of the listing path, availability-only, precondition is the documented trust-in-links option); an M reading under "narrow preconditions" is defensible but the impact class is identical to F17L's.

### F73L - SECURITY.md:87 overstates fail-closed handling of malformed parcelrc content (L)

*Reported by kimi-k3 in phase 2; independently reproduced and analysed here.*

**Description:** SECURITY.md's system-parcelrc section promises that "malformed content in either file" causes a refusal to start - "mistakes and tampering fail loudly rather than being silently ignored". The implementation is inconsistent: malformed `VALID_SIGNERS`, `HOST_HASH`, and binary-override shapes are fatal, but malformed `BLACKLIST_SIGNERS`, `MINIMUM_HOST_VERSION`, and non-absolute path values are only noted to the logfile and silently ignored, and startup continues.

**Threat model(s):** TM0 (documentation/implementation divergence), with a TM2-adjacent consequence.

**Evidence:** `SECURITY.md:87` (the "fail loudly" promise) versus `parcel-host:482-485` (`BLACKLIST_SIGNERS` malformed -> `parcelrc_note`, ignored), `:492-495` (`MINIMUM_HOST_VERSION` malformed -> note, ignored), `:497-503` (path values non-absolute -> note, ignored), against `:478-481`, `:488-491`, `:505-517` (fatal for `VALID_SIGNERS`, `HOST_HASH`, binary-override shapes). The note is buffered to the logfile only (`parcelrc_note`, `parcel-host:344-352`), not surfaced to the extension.

**Exploit scenario:** No attacker-controlled input path - an attacker who can write `/etc/parcelrc` is root, and user-parcelrc malware gains nothing it does not already have (it could simply delete the line; F5T posture). The concrete consequence is an admin-error scenario: an administrator records a durable revocation in `/etc/parcelrc` with a typo (wrong length or a non-hex character), the value is silently dropped, and the revoked - potentially compromised - signing key remains trusted, directly undercutting SECURITY.md's own recommendation that "durable revocations should be set as `BLACKLIST_SIGNERS` in `parcelrc`". The same applies to a malformed `MINIMUM_HOST_VERSION` floor (ratchet silently weakened) and non-absolute `LOGFILE`/`STATEFILE`/`PASSWORD_STORE_DIR` (documented override silently ineffective).

**Recommended fix:** make malformed values in either parcelrc file fatal, as documented (the code already does this for `VALID_SIGNERS`/`HOST_HASH`/binary shapes), or narrow the documentation to say which keys fail loudly and which fall back to defaults.

**Confidence:** Medium (behaviour verified; severity depends on how the maintainers weigh the admin-error consequence). Flagged uncertainty: the silently-dropped revocation in the trust anchor could justify MEDIUM under "implementation contradicting a documented security promise"; I keep LOW to match the F62L/F63L precedent for wording-versus-implementation mismatches, since no attacker-reachable path exists.

### F78I - `window.open` help link vs "no network access, for any reason" (I)

**Description:** The passkey-conflict notice's "documentation" button calls `window.open("https://github.com/parcel-pm/parcel#...", "_blank", "noopener,noreferrer")`. The constitution and README state the extension "must not interact with any network resources, for any reason", and SECURITY.md repeats "does not communicate over the network, for any reason". A user-initiated navigation to a hardcoded URL is not data exfiltration (no data flows, `noopener,noreferrer` is set, the CSP's `connect-src 'none'` still blocks programmatic requests), but it is literally an interaction with a network resource.

**Threat model(s):** TM0.

**Evidence:** `src/js/popup-webauthn.js:317-318`; `CONSTITUTION.md` §1.3.5; `SECURITY.md` "Security Model" rule 1.

**Exploit scenario:** None - the navigation is user-initiated and carries no data. The finding is the wording tension only.

**Recommended fix:** either narrow the documentation ("the extension never sends or fetches data over the network; user-initiated navigation to project documentation is not network access") or replace the button with a copyable URL.

**Confidence:** High.

### F77I - Comment overstates the constrain-height token's forgery protection (I)

**Description:** The comment above the `constrain-height` message handler claims "the token check stops a page or another frame from forging the instruction", but the token is delivered to the inline popup iframe via its `src`, which the embedding page can read (the popup host element is page-realm DOM by accepted design, F39T). The check does distinguish the genuine integration script from *other frames*, but not from the page itself.

**Threat model(s):** TM0 (comment vs actual guarantee).

**Evidence:** `src/js/popup.js:553-555` (claim), `src/js/popup.js:9` (token in iframe `src`), `src/js/integration.js:762-764` (iframe appended to page DOM).

**Exploit scenario:** None of consequence - a page that forges the instruction can only resize the popup's height clamp, which the page can influence by other means anyway (F39T posture).

**Recommended fix:** reword the comment (e.g. "distinguishes the integration script's channel from other frames'").

**Confidence:** High.

## Regression Checks

Every prior finding marked fixed/addressed/resolved was re-verified against the current tree (main-session spot verification for the bolded items; subagent verification with main-session cross-checks for the remainder). Verdicts: all intact unless noted.

- **F1M** - temp keyring: `mktemp` keyring, `GNUPGHOME=/dev/null --no-default-keyring`, `rm -f` on success and failure paths - intact (`parcel-host:851-872`).
- **F2M** - audit fields stripped of `[[:cntrl:]]` before assembly - intact (`src/parcel-host:705-710`).
- **F9L** - sha256 resolved after parcelrc load; `PATH` is not a parcelrc key - intact (`parcel-host:729` region).
- **F10L / F14L** - audit field caps `${INTENT:0:128} ${ORIGIN:0:1024} ${FILE_PATH:0:1024} ${MESSAGE:0:4096}` - intact (`src/parcel-host:710`).
- **F11L** - explicit extension-pages CSP declared - intact (`src/manifest.json:30-32`).
- **F17L** - link policy applied before traversal; `allowLinks: false` performs no link following; 60-level external tree neither traversed nor listed - intact (`src/parcel-host:355-397`); a residual gap in the same control (unbounded root growth *within* the `allowLinks: true` policy) is F69L.
- **F18M** - CSP includes `connect-src 'none'; frame-src 'none'; base-uri 'self'` - intact (`src/manifest.json:31`).
- **F19M** - `onStartup`/`onInstalled` -> `ensureConnected()` plus reconnecting transport - intact (`src/js/agent.js:83-90`, `src/js/agent-native.js`).
- **F20M** - per-port-name action allow-list; `decrypt`/`match` restricted to authorised popup ports; `integration` limited to `config`/`frame-id` - intact (`src/js/agent.js:605-621`).
- **F22L** - HOST_HASH computed over raw script bytes (`jq -rj '.script'`), matching `sha256sum` of the on-disk file - intact (`parcel-host:912`).
- **F29L** - `$SHA256` quoted in command position; remaining unquoted expansions are hex-validated lists - intact (`parcel-host:912,832`).
- **F30L** - GPG status output goes only to the logfile, never to the extension - intact (`parcel-host:865-867,899-902`).
- **F31L** - action names gated by `^[a-zA-Z0-9_]+$`; injection-shaped actions rejected - intact (`parcel-host:953`).
- **F34M** - destination-origin guard present on the fill path - intact as implemented, but skippable when the `origin` key is absent: new finding F68M (`src/js/integration.js:1261`).
- **F35M** - bucket persists across kill-reconnect and mid-session re-eval - intact (`src/parcel-host:112-155`).
- **F36L** - popup fill message carries the frame origin - intact on the normal path (`src/js/popup.js:1090`, `test/popup.test.js:693-695`); the incomplete-handshake edge is F68M.
- **F37L** - gitleaks pinned to a version with per-platform SHA-256 verification, fail-closed - intact (`scripts/pre-commit-gitleaks:52-75`).
- **F38I** - stale port-action comment corrected - intact.
- **F42L** - `passkeyDir` rejects `..`, absolute paths, globs, control characters; `.gpg-id` walk textually contained - intact (`src/parcel-host:1067-1071`).
- **F45L** - `rsync --delete` on both bundle syncs - intact (`Makefile:41,47`); adjacent staleness surface is F76L.
- **F47L** - invalid `.since` aborts after `parcel_error` - intact (`src/parcel-host:531-534`).
- **F48I** - `CSS.escape(entry.path)` in selector lookups - intact (`src/js/popup.js:912`).
- **F50I** - hostile-action and state-file tests present; log-cap assertions intentionally omitted per response - intact (`test/agent.test.js:640,652`, `test/native-host.test.js`).
- **F52C** - signer extraction anchored at `^\[GNUPG:\] VALIDSIG `; fingerprints hex-validated before matching - intact (`parcel-host:897`); adversarial regression test present and effective (unanchoring the grep makes exactly that test fail).
- **F53M** - atomic single-winner lock (`mv` / `O_EXCL`) around load-compute-save; concurrent hosts share one bucket - intact (`src/parcel-host:168-225`).
- **F54L** - TOTP `digits` clamped to 6-10, `step` to 1-3600, algorithm allow-listed - intact (`src/js/helpers.js:45-61`).
- **F55L** - `clientDataJSON` emits real `crossOrigin` and `topOrigin` when embedded cross-origin - intact (`src/js/webauthn.js` builder; builder tests pass).
- **F56L** - adversarial malicious-UID VALIDSIG regression test present - intact (`test/native-host.test.js:619-634`).
- **F57L** - unknown-key gate uses `Object.prototype.hasOwnProperty` - intact (`src/js/schema.js`).
- **F58L** - MetaSchema nested recursion with cyclic re-entry guard - intact (`src/js/schema.js:47,120,172-173`); all defined schemas meta-validated in tests.
- **F60L** - newline-containing entry paths rejected explicitly before the line stream - intact (`src/parcel-host:605-610`).
- **F61L** - `refuse_writable_system_bootstrap` walks the link chain and aborts caller-reachable system installs - intact (`parcel-host:80-140`).
- **F62L** - http-auth token restricted to `intent: "http-auth"` for the port's whole lifetime (sticky) - intact (`src/js/agent.js:636-641,728-731`).
- **F63L** - default build fails closed with self-build guidance; `SIGN_KEY` override works end to end - intact (`src/Makefile:5,57-77`).
- **F64L** - Dockerfile documented as an unpinned dev/test convenience, never shipped - intact (`Dockerfile:1-10`).
- **F65L** - popup fill test asserts the fill message carries the frame origin - intact (`test/popup.test.js:693-695`).
- **F66I** - CSS.escape / prototype-safety / per-container isolation regression tests present - intact (`test/popup.test.js:320,836`, `test/schema.test.js:249`).
- **F67I** - clipboard tradeoff row updated for the host-side auto-clear - intact (SECURITY.md tradeoff table).

## Deliberate Tradeoffs

Re-examined against the current code; all remain acceptable unless noted.

- **Plaintext bash host** - holds; the audit burden is real but the scripts remain readable and were fully reviewable.
- **HOST_HASH off by default** - holds; the popup's `host-unpinned` warning is present and correct.
- **Absent `.parcel.json` reveals all entries** - holds; default rules injected host-side, `defaultRules` warning shown in the popup.
- **Content script on all URLs** - holds; needed for field detection; scope gating (`scopes.js`) adds a blacklist floor on top.
- **Entry rules not dereferenced** - holds; symlink policy is enforced before traversal and re-checked at decrypt.
- **Clipboard auto-clear opportunistic** - holds; F67I wording now matches the implementation.
- **Extension detectable by websites** - holds (WAR fingerprinting surface unchanged in kind).
- **WebAuthn interception in the page realm** - holds; bridge forgery remains bounded to popup annoyance *for forged messages*, but the guard that bounds annoyance frequency is bypassable (F71L) - a gap in the mitigation layer around this tradeoff, not a reversal of it.
- **First-come-first-served interception** - holds; non-configurable accessors and clean back-off match the documentation.
- **`webRequest` for HTTP auth** - holds; main-frame only, token-bound challenge URL, sticky intent restriction verified.
- **Card entries bypass origin-matching** - holds; `scope: "context"` gating verified.
- **URL scopes at document load (SPA gap)** - holds as documented; the scheme-level blacklist floor cannot be escaped.
- **Accepted/rejected findings re-derived:** F3T, F4T, F5T, F6T, F7T, F8T, F12T, F13T, F15T, F16T, F21T, F23T, F24T, F25T, F26T, F27T, F28T, F32T, F33T, F39T, F43L, F44L, F64L rationales all still hold in the current code. F40M, F41L, F46L, F49I rejections hold (F46L's fail-open load and symlink write-through remain, unchanged, within the rejected same-UID scope). **Two accepted/rejected rationales are stale or incomplete:** F51I's "the frameOrigin-undefined edge resolves before any real fill" is disproved (F68M), and F59M's "SECURITY.md wording is corrected in #193" is incomplete (F74L).

## Residual Observations

Risks inherent to the design, and hardening notes with no reachable path identified:

1. **Passkey save-command `rpId` is not shell-escaped (hardening; no reachable path).** `buildPasskeySaveCommand` interpolates `rpId` raw into the `git commit -m "..."` string (`src/js/popup-webauthn.js:24`) while paths go through `q()`. WHATWG hostnames can contain shell metacharacters (verified: `` ` ``/`$`/`;`/`&`/`"` parse fine), so the sink is unsafe *in isolation*. However, the save command is only built on `passkey-created`, which requires the host's `create` to succeed, and `action_passkey` rejects any rpId not matching `^[a-z0-9][a-z0-9.-]{0,252}$` (`src/parcel-host:893-896`) before dispatch - so no metacharacter rpId can ever reach the sink. Under TM2 the popup is already attacker-controlled, making the sink irrelevant. (This demotes a subagent finding; the subagent's PoC drove the builder directly, bypassing the host gate.) Recommend `q()`-escaping the message anyway as defence in depth.
2. **State-file symlink write-through and fail-open load** - unchanged from the F46L rejection; a same-UID hostile process can reset the bucket. Out of scope per that rejection. (`src/parcel-host:112-127,153`.) The `repair_state` comment slightly overstates the "never write through a symlink" invariant (the check is on the locked file at repair time only).
3. **`"00"` (string) `decryptRate` disables the limiter without tripping the popup's `rate-limit-disabled` warning** - config-trusted posture (F24T-class); noted for completeness.
4. **Unbounded `.parcel.json` read** (`cat` of the whole file into `CONFIG`) - a huge config costs memory/time; config is user/store-trusted; no exposure.
5. **NUL byte in the `install` payload's `.script`** would desynchronise the hash basis from the eval string - fail-closed (hash mismatch refuses), noted only as a robustness observation.
6. **Temporary keyring removed on normal and error paths but not on SIGKILL** - contains only public key material; negligible.
7. **`intent` is an audit label, not an authorisation input, on the host** - consistent with the accepted F40M/F59M posture; the extension-side sticky restriction (F62L) is the control.
8. **Entry-cache `changes_since` has second-granularity TOCTOU** - the host re-validates at decrypt, so no exposure path.
9. **Test robustness:** the native-host "state lock exhaustion" test is load-flaky (its simulated lock ages past the host's 5 s orphan-recovery window under parallel load); behaviour verified correct. Consider making the test's lock age relative to the recovery window.
10. **CI actions are tag-pinned, not SHA-pinned** (`actions/setup-node` etc.) - supply-chain hardening opportunity; dev-time only.
11. **jq `gsub(".js"; ".es6.js")` in the Firefox manifest transform** treats `.` as a regex wildcard - currently harmless (the pattern matches the intended literal too) but fragile if file names ever change.
12. **`PASSWORD_STORE_DIR` from the environment is not absoluteness-checked** at bootstrap (it is validated as a path later by usage); documented as settable in the session environment.
13. **ScopeSchema has no direct meta-validation assertion** (covered transitively via ConfigSchema) and the F54L TOTP bounds lack direct tests - test gaps only.
14. **`window`-mode popups skip the origin handshake by design** (http-auth windows); their fills are intent-restricted to `http-auth`, so the F68M edge does not apply there.

## Things Done Well

- The host enforcement boundary is genuinely defence-in-depth: whitelist exact-match, passkey classification, content-marker backstop, symlink re-check at decrypt, attempt-costing rate limiter, and rpId/allowCredentials binding all overlap; every attack attempted against it failed closed.
- The anchored `VALIDSIG` extraction with hex-validated fingerprints, plus an adversarial regression test that fails exactly when the anchoring is removed - the F52C class is closed *and* pinned.
- The atomic state lock (single-winner `mv`/`O_EXCL`, stale-orphan recovery, fail-closed exhaustion) makes the rate limiter survive kill-reconnect and concurrency, as verified under parallel hosts.
- Fail-closed posture throughout the bootstrap: malformed `VALID_SIGNERS`/`HOST_HASH` refuse startup; the version ratchet treats missing markers as version 0; the writable-system-install guard aborts with fix guidance.
- Zero HTML/JS injection sinks in the entire extension - every render path uses `textContent`/`createTextNode`/`createElement`, colours are schema-constrained to hex, and store-controlled strings pass `CSS.escape` where they reach selectors.
- Complete extension-page CSP (`connect-src 'none'; frame-src 'none'; base-uri 'self'`) and a WAR list where every entry was traced to a concrete consumer.
- Source-to-distribution parity is real: both bundles byte-identical to `src/` apart from documented manifest transforms, with the signing step failing closed and self-builds supported via `SIGN_KEY`.
- The test suite has genuine adversarial content (malicious-UID VALIDSIG, hostile action strings, state-file symlink cases, meta-schema typo detection) rather than tautological coverage; 615/615 pass.

## Cross-Model Verification

Phase 2 completed against kimi-k3's exchange table (`security-review-table-kimi-k3-20261004-f34f710.md`, read in full; its full report was never accessed, preserving independence of reasoning). The table carried two findings; both were independently reproduced from the code and added to this report as findings 10-11 with my own analysis. No non-reproductions.

- **kimi-k3-1 -> F69L (confirmed; severity agreement: L).** I rebuilt the scenario from `src/parcel-host:344-394` and reproduced it live with the verbatim-extracted function: one self-referential symlink (`a/l1 -> .`) yields unbounded linear root growth, two (`a/l1`, `a/l2 -> .`) yield combinatorial growth, and the call fails to terminate (killed at 60 s). My analysis adds: the rediscovery mechanism is `find -H` following each root symlink so already-collected links reappear under longer textual prefixes, defeating the string-equality dedup; the target-containment check does not help because the target is legitimately in-store; `action_changes_since` shares the wedge; the extension's watchdog respawns into the same wedge, making the DoS sticky; confidentiality is unaffected (fail-closed). kimi-k3 rated L/High; I concur, calibrated to the F17L precedent, and note the M-reading alternative inline.
- **kimi-k3-2 -> F73L (confirmed; severity agreement: L).** Verified against `parcel-host:474-525`: malformed `BLACKLIST_SIGNERS`/`MINIMUM_HOST_VERSION`/path values are `parcelrc_note`-and-ignored while `VALID_SIGNERS`/`HOST_HASH`/binary shapes are fatal, contradicting SECURITY.md:87's "malformed content in either file ... fail[s] loudly rather than being silently ignored". My analysis adds the concrete consequence the doc tension creates: a typo'd `/etc/parcelrc` revocation is silently dropped, weakening the documented durable-revocation mechanism, and the note reaches only the logfile, never the extension. kimi-k3 rated L/Medium; I concur on L with the flagged M-reading noted inline.
- **Disjointness note:** kimi-k3's table contains no entries corresponding to this review's findings 1-9, and this review's phase-1 table contained no entries corresponding to kimi-k3's two findings. The two models' phase-1 outputs are fully disjoint (9 vs 2 findings, 2 shared in phase 2 after reproduction). kimi-k3's summary independently reports `make test` 615/615 and all prior fixed findings regression-verified intact (35 checks), consistent with this review's results. The merge editor should treat findings 1-9 as single-source (mimo-v2.6-pro) and findings 10-11 as dual-source (kimi-k3 first reported, mimo-v2.6-pro independently reproduced).

## Second-Look Review

Adversarial re-read of the draft, per the checklist:

- **Did every finding survive the reachability requirement?** Yes, with one demotion: the subagent-reported rpId shell-injection was moved to Residual Observations after I traced the host-side rpId charset gate that blocks it (documented above as a disagreement). Findings 1-4 and 10 each have a traced input path; findings 5-6 have PoC-reproduced absent controls; findings 7-9 and 11 are documentation/comment divergences, which are first-class here (TM0).
- **Superficially treated areas:** the `/etc/parcelrc` ownership gate and the setup script's install/uninstall write surface were code-reviewed but not live-tested (needs root fixtures); macOS clipboard paths; browser-runtime WAR necessity (no browser available). Everything else in the checklist received line-level treatment with PoCs.
- **Findings resting on unverified assumptions:** finding 1 rests on Chrome dropping `origin: undefined` in port messages (documented JSON serialisation semantics, not browser-observed) - stated in the finding; finding 3 rests on host/JS regex-dialect divergence producing rule-less entries (mechanism verified; a concrete Oniguruma-vs-JS pattern pair was demonstrated by PoC).
- **Documented tradeoffs misattributed as findings?** None. Finding 2 sits *inside* a documented tradeoff's mitigation layer (popup-spam guard) and is reported as a gap in that mitigation, not as a reversal of the tradeoff; finding 8 is reported strictly as wording tension, not as a policy violation.
- **Every `jq` call site, unquoted command-position variable, and dispatch path checked?** Yes - all host `jq` sites use `--arg`/`--rawfile`/here-strings; the only unquoted expansions in command position are the hex-validated fingerprint loops and boolean literals; the dispatch surface is the regex-gated `action_*` set (8 functions, no accidental exposure); the three `eval` boundaries (bootstrap install, state load, state repair) all consume validated input.
- **Origin validation proven on every fill/decrypt path?** Not entirely - that is finding 1: the guard is proven on the `origin`-carried paths (popup fill, broadcast, detail decrypt) but is skipped on the originless edge. Mid-decrypt navigation is otherwise covered by the port lifecycle plus the guard when `origin` is present.
- **Severities consistent?** Findings 1 and 2 carry explicitly flagged severity uncertainty (both could be argued one tier up or down; reasoning given inline). No CRITICAL/HIGH claimed, so nothing to defend at those tiers. Only the six permitted letters used (M, L, I in this report; C/H/T unused but permitted).
- **Anything accessed under `security-review/reviews/`?** No file contents; only directory listings of names for the §0 filename convention, disclosed in Methodology.
- **Confidence calibration:** finding 1 Medium-High (browser-observed serialisation would make it High); finding 2 High (mechanics) with severity uncertainty; finding 3 Medium; findings 4-6 High (PoC-reproduced); finding 7 Medium (maintainer judgement on wording); findings 8-9 High (trivially verified). Phase-2 findings: finding 10 High (reproduced live in the main session, both growth shapes observed); finding 11 Medium (behaviour verified; severity judgement call flagged inline). Both phase-2 findings passed the same reachability test as phase-1 findings: finding 10 has a concrete attacker-controlled input path (crafted store symlinks under the documented `allowLinks` option) and finding 11 is a documented-promise divergence with a concrete admin-error consequence, with no attacker-reachable path claimed.

## About This Review

- **Model:** mimo-v2.6-pro
- **Date:** 2026-10-04
- **Commit:** `f34f710` (`git describe --tags --always` = `v1.0.8`); clean tree, HEAD at the release tag - release review.
- **Phases:** phase 1 (independent review, three mimo-v2.6-pro subagents) and phase 2 (cross-verification against kimi-k3's exchange table) both completed. Both transient exchange files were deleted from this container after finalisation.
- **Protocol:** `security-review/prompt.md` (the canonical prompt record; not embedded here).

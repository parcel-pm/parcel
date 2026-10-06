# Parcel v1.0.8 Security Review - Merged Report (glm-5.3)

**Status: FINAL.** Unified merge of the two post-phase-2 component reviews (kimi-k3, mimo-v2.6-pro), both finalised 2026-10-04 against commit `f34f710` (exactly at tag `v1.0.8`, clean tree - a release review of shipped code). Canonical finding IDs F68-F78 continue the global sequence from `security-review/findings.md`.

## Executive Summary

Parcel v1.0.8 presents a strong security posture. The host-side enforcement boundary - the property the whole design rests on - held under every attack path traced by either reviewing model: the whitelist, the passkey content-marker backstop, rpId/`allowCredentials` binding, the atomic rate-limiter state lock, the signer blacklist, and the host-version ratchet all behaved as documented under both models' live adversarial testing (mimo-v2.6-pro: roughly 35 checks against the real host scripts with a controllable mock GPG, including real ES256 signing; kimi-k3: symlink-cycle, HOST_HASH-basis, length-header, and signed-build PoCs). No CRITICAL or HIGH vulnerabilities were identified. Both models independently ran the full test suite (615/615 pass, 35 suites, including the prettier/eslint/shellcheck gates) and verified the built `chrome`/`firefox` bundles byte-identical to `src/` apart from the documented manifest transforms. The extension has zero HTML/JS injection sinks, a complete extension-page CSP, and a `web_accessible_resources` list whose every entry was traced to a concrete consumer. The fix culture is a genuine strength: security fixes land together with adversarial regression tests that fail exactly when the fix is reverted (verified live for the F52C anchoring by unanchoring the grep).

The merged record carries eleven findings: one MEDIUM, eight LOW, two INFORMATIONAL. None discloses credentials, key material, or bypasses the host boundary; every live defect is a denial of service, a documentation/build defect, or an extension-UI guard gap.

| Severity | Count |
|----------|-------|
| C | 0 |
| H | 0 |
| M | 1 |
| L | 8 |
| I | 2 |

By provenance:

| Provenance | Count | Findings |
|------------|-------|----------|
| Both models | 7 | F69L, F70L, F71L, F72L, F73L, F74L, F77I |
| mimo only - disputed by kimi | 2 | F68M, F78I |
| mimo only - not reproduced by kimi | 2 | F75L, F76L |
| kimi only | 0 | - |

The two models' phase-1 outputs were fully disjoint (kimi-k3 found two findings, mimo-v2.6-pro found nine); every dual-source finding below was discovered by one model in phase 1 and independently reproduced with the other model's own analysis in phase 2. One severity dispute exists (F71L: mimo-v2.6-pro MEDIUM vs kimi-k3 LOW; canonical LOW recorded, both positions preserved verbatim in Disagreements), and four findings are disputed at the finding or classification level (F68M, F75L, F76L, F78I - all mimo-v2.6-pro reports, all with kimi-k3's non-reproduction positions recorded verbatim in Disagreements).

The single most important takeaway is split along the review's one finding-level dispute of substance: mimo-v2.6-pro's F68M holds that the F34M destination-origin guard - the primary anti-cross-origin-fill protection - is silently skipped on Chrome whenever the popup's origin handshake has not completed (the fill message then carries `origin: undefined`, which Chrome's JSON message serialisation drops, so the content script's `hasOwnProperty` gate never fires), re-opening the exact mid-decrypt cross-origin fill scenario that F34M closed, under narrow timing preconditions; kimi-k3 did not reproduce this as a finding, holding it to be the maintainer-rejected F51I edge. The worst undisputed defect is F69L: `collect_roots` driven into combinatorial root-queue growth by two ancestor-pointing symlinks in the store under the non-default `allowLinks` option, permanently wedging the host. Everything users' credentials depend on (whitelist enforcement, signature verification, passkey key isolation) verified intact, including every previously fixed finding checked for regression by both models.

## Findings

| ID | Severity | Provenance | Confidence | Area | Threat model | Title | file:line |
|----|----------|-----------|------------|------|--------------|-------|-----------|
| F68M | M | mimo only - disputed by kimi | Medium-High (mimo) | Content script / popup | TM1 | Chrome: fill message without `origin` key skips the F34M destination-origin guard and the F6T warning | src/js/popup.js:16,738,1090; src/js/integration.js:1261 |
| F69L | L | both models | High (both) | native host (main script) | TM4 | `collect_roots` textual-only dedup: ancestor-pointing store symlinks cause unbounded root-queue growth, wedging the host | src/parcel-host:344-394 |
| F70L | L | both models | High (both) | native host (main script) | TM4 | A rule pattern valid in JS but invalid in jq's Oniguruma (or malformed in both) silently wedges `action_list` - no response is ever sent | src/parcel-host:646-696; parcel-host:746-750 |
| F71L | L | both models - severity disputed | High (both) | WebAuthn content script | TM1 | Popup-spam guard bypassed by ceremony supersede/abort paths, which settle without counting as dismissals | src/js/webauthn-integration.js:22-23,274-285,321-327,372-385,541-551 |
| F72L | L | both models | High (both) | build | TM5, TM0 | `make extension`/`chrome`/`firefox` silently skip the Prettier step and execute `write(1)` instead | Makefile:18-19; src/Makefile:42-47 |
| F73L | L | both models | Medium (both) | docs vs bootstrap | TM0 | SECURITY.md:87 overstates fail-closed behaviour: malformed `BLACKLIST_SIGNERS`/`MINIMUM_HOST_VERSION`/path values are ignored with a log note, not refused | parcel-host:482-505; SECURITY.md:87 |
| F74L | L | both models | Medium (both) | docs vs extension | TM0 | Passkey/HTTP-auth consent guarantees are phrased as absolutes that do not hold under the accepted TM2 posture | SECURITY.md:146,166 |
| F75L | L | mimo only - not reproduced by kimi | Medium (mimo) | popup | TM4 | Rule-less entry aborts the whole popup render batch | src/js/popup.js:929,945; src/js/agent.js:333-348 |
| F76L | L | mimo only - not reproduced by kimi | High (mimo) | build | TM5 | Timestamp rules let a stale `src/dist` (incl. `parcel-host.asc`) ship | src/Makefile:57,79,82-85; Makefile:40-47 |
| F77I | I | both models | High (both) | popup comment | TM0 | Comment overstates the constrain-height token's forgery protection - the page can read the token from the popup iframe's `src` | src/js/popup.js:552-558; src/js/integration.js:762-764 |
| F78I | I | mimo only - classification disputed by kimi | High (mimo) | popup / documentation | TM0 | `window.open` help link vs "no network access, for any reason" | src/js/popup-webauthn.js:317-318 |

### F68M - Chrome: fill message without `origin` key skips the F34M destination-origin guard and the F6T warning (MEDIUM)

**Provenance:** mimo only - disputed by kimi (non-reproduction).
**Maps to:** mimo-v2.6-pro-1; kimi-k3 records the non-reproduction as residual R14 (see Disagreements).

**Description.** The F34M fix makes the content script refuse a fill whose intended origin differs from the frame's current origin, and the F6T tradeoff's mitigation warns on cross-origin fills. Both controls live behind `Object.prototype.hasOwnProperty.call(msg, "origin")` in `integration.js`, and the popup populates `origin` from `frameOrigin`, a variable assigned only when the origin handshake message arrives *and* `tab.url` is truthy. When the handshake has not completed, the fill message carries `origin: undefined`; Chrome serialises port messages as JSON, which drops the key entirely, so the guard's `hasOwnProperty` gate is false and the fill proceeds with no cross-origin check and no warning. (Firefox's structured clone preserves the key with an `undefined` value, where the guard fires and refuses - the defect is Chrome-specific.) mimo-v2.6-pro notes that `window`-mode popups (http-auth windows) skip the origin handshake by design, but their fills are intent-restricted to `http-auth`, so this edge does not apply there.

**Threat model(s).** TM1 (mid-decrypt navigation redirecting a credential cross-origin - the exact F34M scenario).

**Evidence.** `src/js/popup.js:16` (`frameOrigin` declared, no initialiser), `:738` (assigned only inside the `msg?.action === "origin"` handler, itself gated on `if (tab.url)`), `:1085-1091` (fill sends `origin: frameOrigin`), `src/js/integration.js:1261` (guard fires only when the `origin` key is present), `src/js/popup.js:1244-1249` (handshake failure is explicitly non-fatal: "Your fill may still work when you trigger it"), `:447-477` (`waitForTabReady`: 3 attempts x 600 ms, then gives up). The F6T warning sits in the same `origin` handler (`src/js/popup.js:737-747`) and is skipped by the same edge. Regression test `test/popup.test.js:693-695` covers only the handshake-complete path. mimo-v2.6-pro's PoC verified the origin-key-dropped-on-the-wire and originless-fill-applied behaviour (with mismatched-origin correctly refused when `origin` is present); the Chrome JSON-serialisation behaviour is reasoned from documented semantics, not observed in a live browser (confidence Medium-High).

**Exploit scenario.** The user opens the toolbar popup on a page whose module content script has not yet completed the ready/origin handshake (module content scripts run after document parse, so slow-loading pages realistically exceed the 1.8 s budget; the popup even tells the user fills "may still work"). The user selects an entry; decryption is slow (interactive GPG unlock). Mid-decrypt the tab navigates to attacker origin B (page-initiated redirect, meta-refresh, or open redirect). The fill is delivered to the content script now resident in the tab; because the message carries no `origin` key, the guard at `integration.js:1261` is skipped and the credential intended for origin A is typed into B's form, where page script reads it. With `origin` present the same sequence is refused (verified by PoC).

**Recommended fix.** Fail closed in `integration.js`: treat a fill carrying no `origin` as unfillable (or compare against `tab.url`'s origin as a fallback), and seed `frameOrigin` from `new URL(tab.url).origin` at popup startup so the key is always present. Add a no-handshake fill test.

**Severity note.** MEDIUM (mimo-v2.6-pro, Medium-High confidence): the severity table lists "origin validation on fill" under HIGH for reachable bypasses; a strict reading could rate this HIGH, but exploitability requires a conjunction of narrow preconditions (incomplete handshake, mid-decrypt navigation to a hostile origin, user proceeding despite the "page has not responded" warning), which is the MEDIUM tier's "narrow preconditions" clause. kimi-k3 disputes the finding itself (see Disagreements).

### F69L - `collect_roots` textual-only dedup: ancestor-pointing store symlinks cause unbounded root-queue growth, wedging the host (LOW)

**Provenance:** both models - kimi-k3 phase 1, independently reproduced by mimo-v2.6-pro in phase 2. Severity agreement: L.
**Maps to:** kimi-k3-1; mimo-v2.6-pro-10.

**Description.** With the non-default `allowLinks: true`, `collect_roots` (src/parcel-host:344-394) maintains a queue of scan roots and appends every qualifying symlink found beneath each queued root. The deduplication compares **textual paths only** (`[ "$ROOT" == "$LINK" ]`, src/parcel-host:374-390), never resolved targets. `find -H` follows each root symlink on its command line, so every already-collected link is rediscovered *through* each previously collected root under a longer textual prefix (`a/l1` -> `a/l1/l1` -> `a/l1/l1/l1`...), and each rediscovery passes the textual dedup. A symlink whose target is an ancestor directory inside the store therefore re-queues itself via ever-longer textual spellings; with **two** such links in the same directory the path tree branches (all 2^n strings of n hops), yielding combinatorial root-queue growth, each queued root spawning its own `find` - effectively permanent. The target-containment check does not help: the links' target is legitimately inside the store.

**Threat model(s).** TM4 (hostile local filesystem / crafted store contents, e.g. a store synced from an untrusted source), conditioned on the user-enabled `allowLinks` option.

**Evidence.** src/parcel-host:344-394 (function), :362 (loop), :374-390 (textual dedup), :382 (queue append), :389 (per-root `find -H`), :377 (target-containment check). Both models reproduced the wedge live with the verbatim-extracted function against fixture stores. Their observations of the **single**-link case conflict and are presented with attribution: kimi-k3's PoC observed one ancestor symlink terminating normally (~40 roots, bounded by the kernel's 40-hop ELOOP limit), with two ancestor symlinks still running at 8 s and 20 s timeouts; mimo-v2.6-pro's PoC reports a single self-referential symlink (`a/l1 -> .`) growing the root queue without bound (linearly), with `a/l1 -> .` plus `a/l2 -> .` doubling per level and no termination within 60 s. Both agree two links yield combinatorial growth and a permanent wedge. mimo-v2.6-pro adds that `action_changes_since` shares the wedge (it calls the same function, src/parcel-host:540).

**Exploit scenario.** An attacker with store write access places `d/up1 -> .` and `d/up2 -> .`. The next `list` (or config-change-triggered `update_config` -> `action_list`, or `action_changes_since`) wedges the host, burning CPU and growing memory; the extension's ping watchdog respawns a fresh host that re-wedges on the next listing - sustained denial of service of Parcel until the store is cleaned. No plaintext, key material, whitelist, or audit-log impact; all decrypts fail closed (empty `ALLOWED_FILES`).

**Recommended fix.** Deduplicate queued roots by `readlink -f` resolved target (keeping the first textual spelling, preserving the documented multi-spelling accessibility), and/or cap `ROOTS` growth with an explicit error (e.g. refuse after a few hundred queued roots), or detect that a candidate root resolves to an already-visited directory and skip it. Add a regression test with a self-referential link. This is a residual gap in the F17L/#57 fix (which addressed policy *timing*, not cycles), not a re-report.

**Severity note.** Both models rate LOW, calibrated to the F17L precedent (symlink-based DoS of the listing path, availability-only, precondition is the documented trust-in-links option). Both flag the M reading as defensible: kimi-k3 notes a maintainer weighting "host wedge by store content" more heavily could justify MEDIUM; mimo-v2.6-pro notes an M reading under "narrow preconditions" is defensible but the impact class is identical to F17L's.

### F70L - A rule pattern that is valid in JS but invalid in jq's Oniguruma silently wedges `action_list` - no response is ever sent (LOW)

**Provenance:** both models - mimo-v2.6-pro phase 1, independently confirmed by kimi-k3 in phase 2. Severity agreement: L.
**Maps to:** mimo-v2.6-pro-4; kimi-k3-3.

**Description.** The host evaluates `.parcel.json` rule patterns with jq's Oniguruma regex engine (`test($pattern)`, src/parcel-host:660-676), while the extension validates and applies the same patterns as JS `RegExp` with the `u` flag (src/js/agent.js:345). The two engines' grammars diverge: for example `\p{Script_Extensions=Greek}` compiles in JS u-mode but fails in Oniguruma ("invalid character property name" - verified live by kimi-k3 against jq 1.7 and Node 26); a pattern malformed in both engines (e.g. `"pattern": "["`, which jq aborts with "Regex failure: premature end of char-class") wedges identically. When `action_list`'s jq pipeline hits such a pattern it exits non-zero with no stdout; the failure is masked because the capture is `local OUT="$(...)"` (src/parcel-host:646-695) - `local`'s own exit status replaces the pipeline's, so `set -e` does not fire - and `parcel_send` then sends nothing because its `if [ ${#1} -gt 0 ]` guard drops the empty payload (parcel-host:746-750). `ALLOWED_FILES` is then cleared (deny-all, fail-closed). The net effect is a silent violation of the host's one-response-per-request invariant (documented at src/parcel-host:571-572): the extension's list request is never answered, and every subsequent `list` wedges identically until the config is repaired by hand.

**Threat model(s).** TM4 (crafted `.parcel.json`, e.g. via a hostile store sync peer - the scenario SECURITY.md's configuration-isolation section explicitly contemplates).

**Evidence.** src/parcel-host:646-696 (masked pipeline failure), :660-676 (`test($pattern)` evaluation), :690 (`ALLOWED_FILES` cleared from empty output), :696 (`parcel_send`), parcel-host:746-750 (empty-payload drop), invariant comment src/parcel-host:571-572. Empirical: kimi-k3 demonstrated the engine divergence (`jq -n '"a" | test("\\p{Script_Extensions=Greek}")'` -> exit 5, no output; Node accepts the same pattern) and traced the silent no-response to the status masking plus empty-payload guard; mimo-v2.6-pro's subagent PoC verified live that `list` never answers (15 s timeout), the host stays alive (`ping` OK), and all later `list` calls wedge the same way.

**Exploit scenario.** A store obtained from an untrusted source carries `.parcel.json` with a pattern that is JS-valid but Oniguruma-invalid (or malformed in both). Every `list` (and every config-change-triggered `update_config` -> `action_list`) produces no reply; the popup waits indefinitely and Parcel silently stops working. Security-wise the failure is closed (ALLOWED_FILES ends up empty, so all decrypts are denied); the impact is availability plus the documented protocol invariant.

**Recommended fix.** Capture the jq pipeline's exit status explicitly (avoid `local X=$(...)`, which masks it) and call `parcel_error` on failure, preserving the one-response-per-request invariant. Optionally pre-validate each rule pattern with a probe `jq -n '"" | test($pattern)'` at `load_config` and report the offending rule.

**Severity note.** Both models rate LOW: availability-only, fails closed, requires a hostile/malformed store config. kimi-k3 notes it is related to F47L's robustness class but worse in kind (no response at all rather than an error response), hence a finding rather than a residual.

### F71L - Popup-spam guard bypassed by ceremony supersede/abort paths, which settle without counting as dismissals (LOW; severity disputed)

**Provenance:** both models - mimo-v2.6-pro phase 1, added by kimi-k3 in phase 2. Severity disputed: mimo-v2.6-pro rates MEDIUM, kimi-k3 rates LOW; canonical LOW (see Disagreements).
**Maps to:** mimo-v2.6-pro-2; kimi-k3-6.

**Description.** SECURITY.md's seventh passkey protection promises that after two consecutive dismissed ceremonies, further WebAuthn requests "are refused popup-free for one second", so a site cannot re-raise the consent modal in a loop. The dismissal streak (`passkeyDismissStreak`) is only updated in `finish()` (the popup-dismissal path). Two other terminal paths - a newer request superseding in-flight ceremonies, and `handlePasskeyAbort` - drop bindings without touching the streak, so a page that always supersedes (or aborts) each in-flight ceremony before the user can dismiss it never trips the guard and can raise consent popups without bound.

**Threat model(s).** TM1 (hostile page-realm JS).

**Evidence.** Guard state src/js/webauthn-integration.js:22-23; guard check :274-285; supersede loop :321-327 (deletes bindings, answers `fallback`, no streak update); abort handler :372-385 (same); `finish()` :541-551 (the only streak update). SECURITY.md:152 states the promise. mimo-v2.6-pro's PoC: a supersede loop raised 25 consent popups with 0 refusals (same for abort), versus the control path (2 popups then refusals) for dismissals. kimi-k3 confirmed the bypass by reading the three settlement paths against the single streak-mutation site. mimo-v2.6-pro additionally notes the minted-credential guard (:311-319) prevents discarding an unsaved registration, and that the guard currently has no regression tests.

**Exploit scenario.** A hostile page runs `for (;;) { const c = new AbortController(); navigator.credentials.get({ publicKey: {...}, signal: c.signal }); c.abort(); }` (with real ceremony parameters), or loops `navigator.credentials.get()`/`create()` with each call superseding the previous in-flight ceremony. The user is presented with an endless stream of Parcel consent popups over the page - harassment and a social-engineering surface ("just click through"). No signature, decryption, or origin-steering is possible: consent still requires explicit selection in the popup.

**Recommended fix.** Count aborts and supersedes as dismissals for streak purposes (route `handlePasskeyAbort` and the supersede loop through the same streak-incrementing path as `finish`), so every non-consented terminal state feeds the guard. mimo-v2.6-pro adds: consider hoisting the guard state to the background worker so it is per-origin rather than per-frame module state, and add regression tests.

**Severity note.** Canonical LOW. kimi-k3: the bypassed control is anti-annoyance, and its bypass yields the annoyance-class outcome the project already documents and accepts (F44L precedent; the bridge-forgery worst case, "can summon an unwarranted popup"). mimo-v2.6-pro rates MEDIUM: a confirmed bypass of a documented control with no overlapping backup (the MEDIUM "defence-in-depth gap in a control with no overlapping backup" clause), with impact bounded to annoyance; mimo-v2.6-pro also flags that a strict reading under "reachable bypass of a documented protection" could support HIGH, and that a maintainer who weighs impact over letter would reasonably record LOW. Both positions are recorded verbatim in Disagreements.

### F72L - `make extension`/`chrome`/`firefox` silently skip the Prettier step and execute `write(1)` instead (LOW)

**Provenance:** both models - mimo-v2.6-pro phase 1, independently reproduced by kimi-k3 in phase 2. Severity agreement: L.
**Maps to:** mimo-v2.6-pro-5; kimi-k3-4.

**Description.** The top-level `extension` target invokes the sub-make as `$(MAKE) VERSION=$(VERSION) -C ./src` (Makefile:18-19) and does not pass `PRETTIER`. In `src/Makefile` the variable is never given a default, so the `prettier` recipe (src/Makefile:42-47) expands to a leading ` --write '**/*.{js,json,less,css,html,xhtml}'`. GNU make consumes the expanded leading `--`/repeated `-` prefix as its ignore-errors marker and executes `write '**/*.{js,json,less,css,html,xhtml}'` - the Unix `write(1)` command - which fails with "not logged in" and is ignored ("Error 1 (ignored)"). The Prettier normalisation step is therefore silently skipped on every `make extension` / `make all` / `make chrome` / `make firefox` / `make release` build; only `make prettier` and `make test` (which pass `PRETTIER` explicitly) actually format.

**Threat model(s).** TM5 (build integrity / source-to-distribution parity), TM0 (the build does not do what the Makefile and the documented build instructions say it does - "formats source with Prettier").

**Evidence.** Makefile:18-19 (no `PRETTIER` passed; contrast Makefile:27-28 and :70-71 which do), Makefile:25-26 (top-level definition, not exported), src/Makefile:42-47 (no default; recipe). Both models verified live: kimi-k3 in a scratch copy (`make -n -C src` shows the expanded recipe; a real run prints `write: **/*... is not logged in`, "Error 1 (ignored)", and completes exit 0); mimo-v2.6-pro with a minimal Makefile reproducing the prefix-stripping (`write foo` executed, error ignored) plus a misformatted probe file surviving `make extension` unformatted. On hosts without `write(1)` the shell reports "command not found", still ignored.

**Exploit scenario.** No attacker-reachable path: `write(1)` receives only fixed arguments and the skipped formatting is caught downstream by `make test`'s `prettier --check` gate (the test-syntax target); no shipped-artefact divergence (both models verified the bundles byte-identical to `src/`). The realistic harm is drift: a maintainer building without running `make test` ships unformatted source, and the build log conceals it; each build also executes whatever `write` resolves to earlier in `PATH` - a small, unexpected build-time binary invocation surface.

**Recommended fix.** Give `PRETTIER` a default in `src/Makefile` (e.g. `PRETTIER ?= $(CURDIR)/../node_modules/.bin/prettier`) or pass `PRETTIER=$(PRETTIER)` in the top-level `extension` target, so the recipe never expands to a leading `--`.

**Severity note.** Both models rate LOW: build-hygiene defect with a downstream detector, no exploitable path, fail-benign.

### F73L - SECURITY.md:87 overstates parcelrc fail-closed behaviour (LOW)

**Provenance:** both models - kimi-k3 phase 1, independently reproduced by mimo-v2.6-pro in phase 2. Severity agreement: L.
**Maps to:** kimi-k3-2; mimo-v2.6-pro-11.

**Description.** SECURITY.md:87 states, of the `/etc/parcelrc` hardening: "Any violation refuses startup, as does malformed content in either file" ("mistakes and tampering fail loudly rather than being silently ignored"). In the implementation, only `VALID_SIGNERS`, `HOST_HASH`, and shape-malformed `GPG`/`JQ`/`OPENSSL` overrides are fatal (parcel-host:476-481, 488-491, 505-517). A malformed `BLACKLIST_SIGNERS` (parcel-host:482-486), malformed `MINIMUM_HOST_VERSION` (:491-495), or non-absolute `LOGFILE`/`STATEFILE`/`PASSWORD_STORE_DIR` (:497-503) is instead **ignored with a log note** in both files - and unrecognised lines are likewise noted and ignored (`load_parcelrc`, parcel-host:552-556). The test suite deliberately asserts this fail-open behaviour (test/native-host.test.js:829, :935), so the implementation is intentional and the documentation is wrong. mimo-v2.6-pro adds that the note is buffered to the logfile only (`parcelrc_note`, parcel-host:344-352), never surfaced to the extension.

**Threat model(s).** TM0 (documentation tension on a security control), with a TM2-adjacent consequence (mimo-v2.6-pro).

**Evidence.** SECURITY.md:87; parcel-host:474-525 (ignore paths at :482-503 vs fatal paths at :476-481/:488-491/:505-517); test/native-host.test.js:829, :935.

**Exploit scenario.** An administrator records a durable revocation in `/etc/parcelrc` with a typo (wrong length or a non-hex character), relying on the documented refusal to surface the mistake. The revocation is silently dropped (log note only); a host script signed by the intended-to-be-revoked - potentially compromised - signing key remains trusted, directly undercutting SECURITY.md's own recommendation that durable revocations be set as `BLACKLIST_SIGNERS` in `parcelrc`. The same applies to a malformed `MINIMUM_HOST_VERSION` floor (ratchet silently weakened) and non-absolute path overrides (documented override silently ineffective). Bounded: a valid signature from a `VALID_SIGNERS` key is still required, the revocation mechanism is documented as best-effort/defence-in-depth, and no attacker-controlled input path exists (an attacker who can write `/etc/parcelrc` is root).

**Recommended fix.** Amend SECURITY.md:87 to state which keys fail loudly (`VALID_SIGNERS`/`HOST_HASH`/binary-shape violations refuse startup) and which are ignored with a log note (`BLACKLIST_SIGNERS`, `MINIMUM_HOST_VERSION`, path values), mirroring the #193 wording-correction precedent - or make malformed values in either parcelrc file fatal, as documented.

**Severity note.** Both models rate LOW, consistent with the F62L precedent (documented-absolute vs implemented-transient). Both flag the adjacent readings: kimi-k3 (Medium confidence) notes a reading of SECURITY.md:87 as scoped purely to the ownership gate would downgrade this to INFORMATIONAL, but the sentence explicitly extends the refusal claim to "malformed content in either file", so LOW is retained; mimo-v2.6-pro notes the silently-dropped revocation in the trust anchor could justify MEDIUM under "implementation contradicting a documented security promise", but keeps LOW to match the F62L/F63L precedent since no attacker-reachable path exists.

### F74L - Passkey/HTTP-auth consent guarantees are phrased as absolutes that do not hold under the accepted TM2 posture (LOW)

**Provenance:** both models - mimo-v2.6-pro phase 1, independently assessed by kimi-k3 in phase 2. Severity agreement: L.
**Maps to:** mimo-v2.6-pro-7; kimi-k3-5.

**Description.** SECURITY.md:146 states "No signature is produced without you explicitly selecting a credential in the consent popup", and :166 states "No credentials are supplied without explicit user selection in the popup" for HTTP auth. Under the maintainer-accepted TM2 posture (F40M, F59M), these leading absolutes do not hold: a fully compromised extension context can drive `decrypt` (with a self-issued correlation token) and `passkey` `assert`/`create` on whitelisted entries with no consent interaction at all - the host enforces whitelist, rpId, allowCredentials, content markers and the rate limiter, but has no consent gate (mimo-v2.6-pro verified: real ES256 signatures obtainable with no UI). The sentences' second halves are correctly scoped ("A page cannot silently authenticate you"), and the compromised-extension section correctly lists signing among what a compromised extension *can* do - but the leading absolutes are not. This is documentation tension only: the missing gate itself is the rejected F59M, and the substantive guarantees (host whitelist, rate limiter, rpId binding) are unaffected. mimo-v2.6-pro notes this is the residual documentation tension noted when F59M was rejected: the #193 wording correction scoped the second sentence but not the first.

**Threat model(s).** TM0 (with TM2 as the counterexample).

**Evidence.** SECURITY.md:146, :166; src/parcel-host:883-1046 (`action_passkey`/`passkey_op_get` contain no consent input); the accepted posture at F40M/F59M in findings.md; the gateless `passkey` port allow-list (src/js/agent.js:619) and the correlation-token design (src/js/agent.js:531-537).

**Exploit scenario.** A user reading SECURITY.md to gauge compromise impact concludes that credential use always requires their consent, underestimating the accepted TM2 blast radius (silent use of whitelisted entries within the rate limit).

**Recommended fix.** Scope the leading sentences the way the trailing clauses already are - e.g. "For page-initiated ceremonies, no signature is produced without you explicitly selecting a credential in the consent popup (a compromised extension context can invoke signing within the host's whitelist, rpId, allowCredentials and rate-limit constraints)" - mirroring the #193 wording-correction precedent.

**Severity note.** Both models rate LOW: documentation/implementation divergence against an explicitly accepted design posture. Both flag Medium confidence on impact (kimi-k3 is High on the wording); mimo-v2.6-pro notes it would drop to informational if the maintainers judge the adjacent scoping sentences sufficient context.

### F75L - Rule-less entry aborts the whole popup render batch (LOW)

**Provenance:** mimo only - not reproduced by kimi as a finding.
**Maps to:** mimo-v2.6-pro-3; kimi-k3 records the non-reproduction as residual R10 (see Disagreements).

**Description.** The host matches entries against rules using jq's Oniguruma regex engine; the extension assigns `entry.rule` by re-matching with JavaScript `RegExp` (src/js/agent.js:333-348; `undefined` when no JS rule matches). When an entry matches a rule on the host but no rule in the JS pass (dialect divergence, or a config/list TOCTOU between the two passes), `entry.rule` is `undefined`, and `src/js/popup.js:929` (`entry.rule.tag`) and `:945` (`entry.rule.strip`) dereference it unguarded - in contrast to `:924-925`/`:1013`, which use `entry.rule?.class`. The reports conflict on the blast radius and both statements are presented with attribution: mimo-v2.6-pro's PoC reports a rule-less entry aborting the render loop (0 of 2 entries displayed); kimi-k3 notes the throw is additionally caught by `scheduleRender` (src/js/popup.js:1064-1067) and that no concrete divergent pattern pair was demonstrated by either model (the only confirmed engine divergence, F70L, runs the opposite direction and fails closed host-side).

**Threat model(s).** TM4 (crafted `.parcel.json`, e.g. via a hostile store sync peer).

**Evidence.** src/js/popup.js:929, :945; src/js/agent.js:333-348; mimo-v2.6-pro PoC (rule-less entry aborts the render batch, 0 of 2 entries rendered); kimi-k3 counter-reading (scheduleRender catch, no demonstrated divergent pair).

**Exploit scenario.** A hostile or merely dialect-clever rule pattern (e.g. an Oniguruma-only construct such as a possessive quantifier) matches on the host but throws or fails to match in the extension's `new RegExp` pass; every entry in the popup list disappears for that origin until the config is repaired. UI denial of service only - no credential exposure (nothing is decrypted by rendering).

**Recommended fix.** Use `entry.rule?.tag` / `entry.rule?.strip` (or default `rule` to `{}` in the agent), and wrap per-entry rendering in try/catch so one bad entry cannot sink the batch.

**Severity note.** LOW (mimo-v2.6-pro, Medium confidence: would rise on proof that `#setEntries` always yields a rule - none found; would fall to informational if the host and extension provably share a regex dialect). kimi-k3 disputes finding status (see Disagreements).

### F76L - Timestamp rules let a stale `src/dist` (incl. `parcel-host.asc`) ship (LOW)

**Provenance:** mimo only - not reproduced by kimi as a finding.
**Maps to:** mimo-v2.6-pro-6; kimi-k3 records the non-reproduction as residual R15 (see Disagreements).

**Description.** `dist/parcel-host` and `dist/parcel-host.asc` are built by timestamp rules against `parcel-host`. If the source file is restored with an older mtime than the existing `dist` artefacts (`cp -p`, `tar -x` preserving archives, clock skew, or a `SIGN_KEY` switch without `make clean`), make considers them up to date and the previous build's host script and signature are synced into `chrome/`/`firefox/` unchanged.

**Threat model(s).** TM5 (source-to-distribution parity; F45L-class residual).

**Evidence.** src/Makefile:57 (`dist/parcel-host.asc: parcel-host`), :79 (`dist: ...`), :82-85 (`dist/parcel-host: parcel-host`), Makefile:40-47 (rsync of whatever `src/dist` holds). mimo-v2.6-pro's PoC: restoring `src/parcel-host` with an older mtime produced zero rebuild lines and `make chrome` would have shipped the byte-different stale pair. kimi-k3's counter-position: the `release` target depends on `clean` (Makefile:72), so shipped artifacts are always rebuilt; ad-hoc staleness requires mtime manipulation on the build machine, an actor who already owns the build; the `.asc`/SIGN_KEY case is README-documented ("run `make clean` first").

**Exploit scenario.** A packager restoring sources with archived mtimes (or switching `SIGN_KEY` without `make clean`, as README warns) ships an older host script with its matching older signature. The pair stays internally consistent and signature-valid, so no unverified code executes; `MINIMUM_HOST_VERSION`/`HOST_HASH` bound replay of genuinely old versions. Impact is parity/review-trail integrity on ad-hoc builds, not code execution.

**Recommended fix.** Add a `verify-dist` step that `cmp`s `dist/parcel-host` against `parcel-host` (and re-verifies the `.asc`) in the `chrome`/`firefox` targets, or rebuild `dist` from scratch in `extension`.

**Severity note.** LOW (mimo-v2.6-pro, High confidence, mechanism PoC-verified). kimi-k3 disputes finding status (see Disagreements).

### F77I - Comment overstates the constrain-height token's forgery protection (INFORMATIONAL)

**Provenance:** both models - mimo-v2.6-pro phase 1, independently reproduced by kimi-k3 in phase 2. Severity agreement: I.
**Maps to:** mimo-v2.6-pro-9; kimi-k3-7.

**Description.** The comment above the popup's `constrain-height` message handler (src/js/popup.js:552-554) says "the token check stops a page or another frame from forging the instruction". The token travels in the popup iframe's `src` query string (src/js/integration.js:762-764; src/js/popup.js:9), and that iframe element lives in page DOM (the accepted F39T posture), so the hosting page can read the token and post a conforming message; `ev.source === window.parent` passes because the page *is* the parent. The check does stop cross-origin sibling frames (which cannot read the parent page's DOM), so the comment is half-right; the impact of a forged message is popup sizing only, within the accepted F28T class.

**Threat model(s).** TM0 (stale/overstated comment).

**Evidence.** src/js/popup.js:552-558, :9; src/js/integration.js:762-764.

**Exploit scenario.** None beyond the accepted page-controls-own-DOM class (popup resize confusion) - a page that forges the instruction can only resize the popup's height clamp, which the page can influence by other means anyway (F39T posture).

**Recommended fix.** Correct the comment to say the token check stops *other frames* from forging the instruction; the hosting page can already resize via its own DOM (e.g. "distinguishes the integration script's channel from other frames'").

### F78I - `window.open` help link vs "no network access, for any reason" (INFORMATIONAL)

**Provenance:** mimo only - classification disputed by kimi.
**Maps to:** mimo-v2.6-pro-8; kimi-k3 records the classification disagreement as residual R16 (see Disagreements).

**Description.** The passkey-conflict notice's "documentation" button calls `window.open("https://github.com/parcel-pm/parcel#...", "_blank", "noopener,noreferrer")` (src/js/popup-webauthn.js:317-318). The constitution and README state the extension "must not interact with any network resources, for any reason", and SECURITY.md repeats "does not communicate over the network, for any reason". A user-initiated navigation to a hardcoded URL is not data exfiltration (no data flows, `noopener,noreferrer` is set, the CSP's `connect-src 'none'` still blocks programmatic requests), but it is literally an interaction with a network resource. kimi-k3's position: this is the user's browser navigating on an explicit click, not Parcel autonomously interacting with network resources, which is what the constitution prohibits (the rule targets autonomous interaction - telemetry, updates, remote code); classification disagreement only.

**Threat model(s).** TM0.

**Evidence.** src/js/popup-webauthn.js:317-318; CONSTITUTION.md section 1.3.5; SECURITY.md "Security Model" rule 1.

**Exploit scenario.** None - the navigation is user-initiated and carries no data. The finding is the wording tension only.

**Recommended fix.** Either narrow the documentation ("the extension never sends or fetches data over the network; user-initiated navigation to project documentation is not network access") or replace the button with a copyable URL.

**Severity note.** INFORMATIONAL (mimo-v2.6-pro, High confidence). kimi-k3 confirms the observation but disputes the classification (see Disagreements).

## Disagreements

One subsection per disputed finding or severity. Quotations are verbatim from the source reports (finding IDs updated to canonical form; emdashes normalised to hyphens per project style). The editor does not adjudicate; the disagreement record is the output.

### F68M - originless fill skipping the F34M guard (finding-level dispute)

mimo-v2.6-pro reports this as a MEDIUM finding; kimi-k3 did not reproduce it as a finding and records it as residual R14.

**mimo-v2.6-pro's position (MEDIUM, Medium-High confidence):**

> **Severity note (flagged uncertainty):** the severity table lists "origin validation on fill" under HIGH for reachable bypasses; a strict reading could rate this HIGH. I rate MEDIUM because exploitability requires a conjunction of narrow preconditions (incomplete handshake, mid-decrypt navigation to a hostile origin, user proceeding despite the "page has not responded" warning), which is the MEDIUM tier's "narrow preconditions" clause. If the maintainers consider the handshake gap easily forced (e.g. by a page that delays parse), this should be revisited upward.

mimo-v2.6-pro additionally holds that the maintainer's F51I rejection rationale no longer holds (from its Deliberate Tradeoffs section):

> **Two accepted/rejected rationales are stale or incomplete:** F51I's "the frameOrigin-undefined edge resolves before any real fill" is disproved (F68M), and F59M's "SECURITY.md wording is corrected in #193" is incomplete (F74L).

**kimi-k3's position (not reproduced as a finding; residual R14):**

> **mimo-v2.6-pro-1 (fill without `origin` skips the F34M guard)** - not reproduced as a finding. The message omits `origin` only when `frameOrigin` is undefined at fill time, i.e. before the content script's `origin` handshake completes; entries cannot be clicked before the (slower) match round trip, which itself post-dates the handshake, and where `tab.url` is unavailable no content script exists to fill into. This is the maintainer-rejected F51I edge ("no practical exploit exists") compounded with the accepted F6T warning-only posture; the dedup rule bars re-reporting absent a rationale change, and none was demonstrated. Recorded as R14.

### F71L - popup-spam guard bypass (severity dispute: mimo-v2.6-pro MEDIUM vs kimi-k3 LOW; canonical LOW)

**kimi-k3's position (LOW):**

> **Severity note.** LOW, not M: the bypassed control is anti-annoyance, and its bypass yields the annoyance-class outcome the project already documents and accepts (F44L precedent; the bridge-forgery worst case). The dissent is recorded in Cross-Model Verification.

From kimi-k3's Cross-Model Verification:

> **mimo-v2.6-pro-2 → F71L (popup-spam guard bypass via supersede/abort)** - mimo rates M; this review rates it **LOW** and adds it as a finding on that basis:
>
> *Supersede and abort both settle ceremonies without touching `passkeyDismissStreak` (supersede at src/js/webauthn-integration.js:321-327, abort at :372-385; the streak only moves in `finish()` at :545-551). A page can therefore cycle `navigator.credentials.get()` + `AbortSignal.abort()` indefinitely, re-raising the consent popup without the two-dismissal guard ever engaging. The bypass is real and reachable with two lines of page JS. LOW rather than M because the guard is an anti-annoyance control: its bypass yields exactly the documented and accepted worst case for bridge forgery ("can summon an unwarranted popup", SECURITY.md), and the F44L precedent rates page-driven popup/manipulation effects LOW. No signature, decryption, or origin-steering consequence exists - consent still gates every ceremony. Recommended fix: count aborts and supersedes as dismissals for streak purposes (treat any non-consented terminal state identically in `finish`/`handlePasskeyAbort`/the supersede loop).*

**mimo-v2.6-pro's position (MEDIUM):**

> **Severity note (flagged uncertainty):** the LOW reading is defensible (impact is popup annoyance only, matching the accepted F44L and rejected F49I precedent, and the doc's literal scenario is "after each dismissal"); the HIGH reading is defensible under the letter of "reachable bypass of a documented protection". I rate MEDIUM as the balanced call: a confirmed bypass of a documented control with no overlapping backup (the MEDIUM "defence-in-depth gap in a control with no overlapping backup" clause), with impact bounded to annoyance. A maintainer who weighs impact over letter would reasonably record this as LOW.

### F75L - rule-less entry render abort (finding-level dispute)

mimo-v2.6-pro reports this as a LOW finding; kimi-k3 did not reproduce it as a finding and records it as residual R10.

**mimo-v2.6-pro's position (LOW, Medium confidence):**

> **Confidence:** Medium. Would rise on proof that `#setEntries` always yields a rule (none found); would fall to informational if the host and extension provably share a regex dialect.

With the PoC result: "PoC: a rule-less entry aborts the render loop - 0 of 2 entries displayed."

**kimi-k3's position (not reproduced as a finding; residual R10):**

> **mimo-v2.6-pro-3 (rule-less entry aborts popup render)** - not reproduced as a finding. Reachability requires a pattern that matches an entry name under jq's Oniguruma but not under JS u-mode while passing JS-side schema validation; no concrete divergent pair was demonstrated by either model, and the only confirmed engine divergence (F70L) runs the *opposite* direction (JS accepts, Oniguruma rejects - which fails closed host-side). The throw is additionally caught by `scheduleRender` (src/js/popup.js:1064-1067). Recorded as R10.

The two reports conflict on a fact here (mimo-v2.6-pro's PoC shows the render batch aborting with 0 of 2 entries displayed; kimi-k3 holds that the throw is caught by `scheduleRender`); both statements are presented above with attribution rather than reconciled.

### F76L - stale `src/dist` shipping (finding-level dispute)

mimo-v2.6-pro reports this as a LOW finding; kimi-k3 did not reproduce it as a finding and records it as residual R15.

**mimo-v2.6-pro's position (LOW, High confidence):**

> **Exploit scenario:** A packager restoring sources with archived mtimes (or switching `SIGN_KEY` without `make clean`, as README warns) ships an older host script with its matching older signature. The pair stays internally consistent and signature-valid, so no unverified code executes; `MINIMUM_HOST_VERSION`/`HOST_HASH` bound replay of genuinely old versions. Impact is parity/review-trail integrity, not code execution.
>
> **Confidence:** High (mechanism PoC-verified).

**kimi-k3's position (not reproduced as a finding; residual R15):**

> **mimo-v2.6-pro-6 (timestamp staleness ships stale `src/dist`)** - not reproduced as a finding. The `release` target depends on `clean` (Makefile:72), so shipped artifacts are always rebuilt; ad-hoc staleness requires mtime manipulation on the build machine, an actor who already owns the build; the `.asc`/SIGN_KEY case is README-documented. Recorded as R15.

### F78I - `window.open` docs link (classification dispute)

mimo-v2.6-pro reports this as an INFORMATIONAL finding; kimi-k3 confirms the observation but classifies it as a residual, not a finding (R16).

**mimo-v2.6-pro's position (INFORMATIONAL, High confidence):**

> **Description:** The passkey-conflict notice's "documentation" button calls `window.open("https://github.com/parcel-pm/parcel#...", "_blank", "noopener,noreferrer")`. The constitution and README state the extension "must not interact with any network resources, for any reason", and SECURITY.md repeats "does not communicate over the network, for any reason". A user-initiated navigation to a hardcoded URL is not data exfiltration (no data flows, `noopener,noreferrer` is set, the CSP's `connect-src 'none'` still blocks programmatic requests), but it is literally an interaction with a network resource.

**kimi-k3's position (accurate observation, not a finding; residual R16):**

> **mimo-v2.6-pro-8 (`window.open` docs link vs no-network)** - confirmed as an accurate observation, classification disagreement: this review treats a user-initiated, `noopener,noreferrer` docs navigation as the user's browser acting on an explicit click, not Parcel autonomously interacting with network resources, which is what the constitution prohibits. Recorded as R16.

## Regression Checks

All prior findings recorded as fixed/addressed/resolved in `findings.md` were verified in the current tree by both models (fix present, not partially reverted, not undermined by later changes). No regressions found.

| Finding | Verdict | Notes | Source |
|---------|---------|-------|--------|
| F1M (#46) | intact | temporary GPG keyring for verification, removed after use (parcel-host:851-872) | both |
| F2M (#48) | intact | control characters stripped from all audit fields (src/parcel-host:705-710) | both |
| F5T gate (#50) | intact | parcelrc 0600 enforced; symlinked parcelrc rejected (parcel-host:315-318) | kimi |
| F9L (#49) | intact | `SHA256` resolved after parcelrc loading (parcel-host:683-692, :729) | both |
| F10L/F14L (#56) | intact | audit field caps 128/1024/1024/4096 (src/parcel-host:710) | both |
| F11L | intact | explicit CSP declared (src/manifest.json:30-32) | both |
| F17L (#57) | intact | link policy applied before traversal (src/parcel-host:344-397); residual cycle gap is F69L | both |
| F18M (#68) | intact | CSP includes `connect-src 'none'; frame-src 'none'; base-uri 'self'` (src/manifest.json:31) | both |
| F19M (#67) | intact | `onStartup`/`onInstalled` -> idempotent `ensureConnected` (src/js/agent.js:83-91; src/js/agent-native.js) | both |
| F20M (#69) | intact | `PORT_ACTIONS` allow-list and enforcement (src/js/agent.js:605-621) | both |
| F22L (#71) | intact | HOST_HASH basis byte-identical to `sha256sum` of the raw file (parcel-host:912); PoC-verified by both | both |
| F29L (#71) | intact | `"$SHA256"` quoted in command position (parcel-host:912) | both |
| F30L | intact | GPG status output log-only, never sent to the extension (parcel-host:865-903) | both |
| F31L | intact | action-name regex gate before dispatch (parcel-host:953) | both |
| F34M (#106) | intact as implemented | destination-origin guard on fill (src/js/integration.js:1261); mimo notes the originless edge -> F68M (disputed) | both |
| F35M (#116) | intact | persisted token bucket with 0600 gate (src/parcel-host:104-155) | both |
| F36L (#118) | intact on the normal path | popup fill carries `origin: frameOrigin` (src/js/popup.js:1086-1091; test/popup.test.js:693-695); the incomplete-handshake edge is F68M (disputed) | both |
| F37L (#123) | intact | gitleaks pinned with per-arch SHA-256 (scripts/pre-commit-gitleaks:51-75) | both |
| F38I | intact | stale port-action comment corrected | mimo |
| F42L (#130) | intact | `passkeyDir` rejects `..`/leading-`/`/metacharacters (src/parcel-host:1067-1071); `.gpg-id` containment re-checked | both |
| F45L (#131) | intact | `rsync --delete` in chrome/firefox targets (Makefile:41, :47); adjacent staleness surface is F76L (disputed) | both |
| F47L | intact | `action_changes_since` returns after rejecting an invalid `.since` (src/parcel-host:531-543) | both |
| F48I (#132) | intact | `CSS.escape(entry.path)` in popup render (src/js/popup.js:912) | both |
| F50I (#132) | intact | integration-port action rejection tests (test/agent.test.js:640-652) | both |
| F52C (#144) | intact | anchored `grep '^\[GNUPG:\] VALIDSIG '` (parcel-host:897); adversarial regression test present and effective (mimo verified unanchoring the grep makes exactly that test fail) | both |
| F53M (#175) | intact | atomic state lock: rename/O_EXCL create, orphan recovery, EXIT trap (src/parcel-host:168-233) | both |
| F54L (#170) | intact | TOTP digits 6-10, period 1-3600 (src/js/helpers.js:45-61) | both |
| F55L (#171) | intact | real `crossOrigin` + conditional `topOrigin` (src/js/webauthn.js:233-241; src/js/webauthn-integration.js:584-590) | both |
| F56L (#172) | intact | malicious-UID VALIDSIG regression test (test/native-host.test.js:619-654) | both |
| F57L (#174) | intact | schema unknown-key gate via `hasOwnProperty` (src/js/schema.js:115) | both |
| F58L (#174) | intact | MetaSchema nested recursion with cyclic guard (src/js/schema.js:47-134) | both |
| F60L (#195) | intact | newline-containing entry paths refused (src/parcel-host:603-610) | both |
| F61L (#198) | intact | writable system-looking bootstrap aborts (parcel-host:80-140, invoked :250) | both |
| F62L (#201) | intact | http-auth intent restriction sticky for the port's lifetime (src/js/agent.js:636-641, :728-732) | both |
| F63L (#203) | intact | `SIGN_KEY` override works (src/Makefile:5; built successfully with a throwaway key by both models) | both |
| F64L (#202) | intact | Dockerfile documents deliberate unpinned dev/test convenience (Dockerfile:1-10) | both |
| F65L (#204) | intact | popup fill-origin assertion test (test/popup.test.js:693-695) | both |
| F66I (#206) | intact | regression tests for CSS.escape render, hasOwnProperty gate, per-container history isolation | both |
| F67I (#205) | intact | tradeoff table documents the host-side clipboard auto-clear | both |

## Deliberate Tradeoffs

Every documented tradeoff in SECURITY.md and every maintainer-accepted finding in `findings.md` was re-derived and tested against the current code by both models; none has diverged.

| Tradeoff / accepted posture | Verdict | Source |
|----------------------------|---------|--------|
| Plaintext bash host | holds; scripts remain readable and were fully reviewed | both |
| HOST_HASH off by default | holds; the popup's `host-unpinned` warning is present and correct | both |
| Absent `.parcel.json` reveals all entries | holds; default rules injected host-side, `defaultRules` warning shown in the popup | both |
| Content script on `<all_urls>`; extension detectability; WAR breadth (F7T/F26T) | holds; all eight WAR entries traced load-bearing, nothing new crept in; scope-gating blacklist floor on top | both |
| Non-dereferenced rule paths (symlink options documented as risky) | holds; F69L is a DoS gap under that opt-in, not a contradiction of it | both |
| Clipboard tradeoff wording (F67I) | holds; matches the v1.0.7+ host-side implementation | both |
| WebAuthn page-realm interception; first-come-first-served; `allowCredentials` disclosure | holds; implementation matches documentation (isolated-side Permissions-Policy check, inert-until-enabled shim, non-configurable install with full back-off); F71L is a gap in the popup-spam mitigation layer around this tradeoff, not a reversal of it | both |
| SPA scope-at-load | holds as documented (README:405; agent.js cascade best-effort; scheme-level blacklist floor cannot be escaped) | both |
| F40M/F59M correlation-token posture | holds; code comments and SECURITY.md wording scope the guarantee accordingly - F74L records the residual lead-sentence tension | both |
| `webRequest` for HTTP auth | holds; main-frame only, token-bound challenge URL, sticky intent restriction verified | mimo |
| Card entries bypass origin-matching | holds; `scope: "context"` gating verified | mimo |
| Re-derived accepted/rejected findings: F3T-F8T, F12T, F13T, F15T, F16T, F21T, F23T-F28T, F32T, F33T, F39T, F41L, F43L, F44L, F46L, F49I, F64L | rationales still hold in the current code (F46L's fail-open load and symlink write-through remain, unchanged, within the rejected same-UID scope) | both |
| F51I rejection ("the frameOrigin-undefined edge resolves before any real fill") | mimo: rationale disproved by F68M; kimi: rationale holds (R14) - disputed, see Disagreements | disputed |
| F59M rejection ("SECURITY.md wording is corrected in #193") | mimo: incomplete - the lead sentences remain absolute (F74L); kimi: wording now scopes the guarantee accordingly; both report the residual tension as F74L | both |

## Residual Observations

Risks inherent to the design, and hardening notes with no reachable path identified. The four mimo-only findings disputed by kimi (F68M, F75L, F76L, F78I) are recorded under Findings and Disagreements rather than duplicated here; kimi's residual records for them are quoted verbatim in Disagreements.

| # | Observation | Source |
|---|-------------|--------|
| 1 | `dd bs=4 count=1` without `iflag=fullblock` can short-read the native-messaging length header on a pipe, desyncing framing - fail-closed, and the writer is the browser's native-messaging layer, not attacker-reachable (parcel-host:940) | kimi |
| 2 | The `od -An -tx4` length decode is host-endian; correct on little-endian, broken on big-endian - portability, fail-closed (parcel-host:940) | kimi |
| 3 | Even with F69L fixed, a single ancestor symlink yields a bounded ~40x find amplification via kernel ELOOP | kimi |
| 4 | `.parcel.json` is `cat`ted through symlinks; a store-write attacker gains nothing beyond writing the file directly (default is already allow-all) (src/parcel-host:302) | kimi |
| 5 | Unbounded `.parcel.json` read (`cat` of the whole file into `CONFIG`) - a huge config costs memory/time; config is user/store-trusted; no exposure | mimo |
| 6 | `decryptRate` regex `^[0-9.]+$` admits multi-dot strings that `awk` truncates; config is a trusted store file (src/parcel-host:726) | kimi |
| 7 | `"00"` (string) `decryptRate` disables the limiter without tripping the popup's `rate-limit-disabled` warning - config-trusted posture (F24T-class) | mimo |
| 8 | POSIX ACLs are not evaluated in the ownership gates (`/etc/parcelrc`, strict-mode binaries); mode-bit checks could miss an ACL grant - admin-misconfiguration territory | kimi |
| 9 | On tab-port resync after cross-origin navigation, `frameOrigin` refreshes to the *current* origin before the fill post, narrowing the F34M guard to "current origin"; the F6T accepted warning-only posture still fires the cross-origin `alert()`, and the no-resync race hard-refuses (src/js/popup.js:733-742) | kimi |
| 10 | `message.origin` is forwarded verbatim to the host audit log (the unreconciled half of F20M); the only exploiter is a compromised popup, which already holds decrypt capability under the F40M posture; reconciliation is architecturally blocked by popup sender semantics (src/js/agent.js:738) | kimi |
| 11 | Forged `parcel-shadow-click` can inject an attribute-selector string into `querySelector`; capability equals the page's inherent `el.click()` (F28T rationale) (src/js/integration.js:987-988) | kimi |
| 12 | Passkey save-command `rpId` is not shell-escaped in `buildPasskeySaveCommand` (src/js/popup-webauthn.js:24) while paths go through `q()`; WHATWG hostnames can contain shell metacharacters, but the host's rpId charset gate (`^[a-z0-9][a-z0-9.-]{0,252}$`, src/parcel-host:893-896) blocks any metacharacter rpId from reaching the sink, and under TM2 the popup is already attacker-controlled - `q()`-escaping recommended as defence in depth | mimo |
| 13 | State-file symlink write-through and fail-open load - unchanged from the F46L rejection; a same-UID hostile process can reset the bucket; the `repair_state` comment slightly overstates the "never write through a symlink" invariant (the check is on the locked file at repair time only) (src/parcel-host:112-127, :153) | mimo |
| 14 | NUL byte in the `install` payload's `.script` would desynchronise the hash basis from the eval string - fail-closed (hash mismatch refuses) | mimo |
| 15 | Temporary keyring removed on normal and error paths but not on SIGKILL - contains only public key material; negligible | mimo |
| 16 | `intent` is an audit label, not an authorisation input, on the host - consistent with the accepted F40M/F59M posture; the extension-side sticky restriction (F62L) is the control | mimo |
| 17 | Entry-cache `changes_since` has second-granularity TOCTOU - the host re-validates at decrypt, so no exposure path | mimo |
| 18 | Chrome API mock fidelity gaps (fabricates default tabs for unknown IDs, replays events to late listeners, delivers port messages synchronously, polyfills `CSS.escape` naively) - availability-fidelity gaps, each traced to fail-closed real behaviour; the mock GPG does not cryptographically bind signature to payload (out of test scope by design) | kimi |
| 19 | The native-host "state lock exhaustion" test is load-flaky under parallel load (its simulated lock ages past the host's 5 s orphan-recovery window); host behaviour verified correct - test-robustness note | mimo |
| 20 | CI pins actions by major tag, not SHA; CI never produces shipped artifacts - supply-chain hardening opportunity, dev-time only | both |
| 21 | jq `gsub(".js"; ".es6.js")` in the Firefox manifest transform treats `.` as a regex wildcard - currently harmless (the pattern matches the intended literal too) but fragile if file names ever change | mimo |
| 22 | `PASSWORD_STORE_DIR` from the environment is not absoluteness-checked at bootstrap (validated by usage later); documented as settable in the session environment | mimo |
| 23 | `clipboardTimeout` > 3600 is clamped rather than rejected, while SECURITY.md says "permitted range 1-3600" - cosmetic | kimi |
| 24 | ScopeSchema has no direct meta-validation assertion (covered transitively via ConfigSchema) and the F54L TOTP bounds lack direct tests - test gaps only | mimo |

## Methodology

- **Source reports:** kimi-k3 (`security-review/reviews/v1.0.8/kimi-k3.md`) and mimo-v2.6-pro (`security-review/reviews/v1.0.8/mimo-v2.6-pro.md`), both finalised 2026-10-04 against commit `f34f710` (tag `v1.0.8`, clean tree) after completing both phases of the review protocol, including cross-verification against each other's findings tables.
- **Merge date:** 2026-10-04. **Merge editor:** glm-5.3.
- Both source models independently ran the full `make test` suite (615/615 pass, 35 suites, including the prettier/eslint/shellcheck gates) and verified built-bundle parity against `src/`; both read `CONSTITUTION.md`, `SECURITY.md`, `README.md`, and `security-review/findings.md` in full before analysing code, and neither accessed any file under `security-review/reviews/` prior to finalising its own report (directory names were listed solely to derive the filename convention).
- **Editorial integrity:** this merge introduced no findings and changed no severities. All eleven findings and all severities come from the two source reports. Where the component reviews disagreed on severity (F71L), the editor selected one of the two recorded positions (LOW, kimi-k3's) as canonical; the unchosen position (mimo-v2.6-pro's MEDIUM) is recorded verbatim in Disagreements. Finding-level disputes (F68M, F75L, F76L, F78I) are presented as findings carrying their reporting model's severity and provenance tag, with both models' positions recorded verbatim in Disagreements. Canonical IDs F68-F78 continue the global sequence from `findings.md` (previous: F67I); each dual-reported finding carries one ID across all locations.
- Both component reports were updated in place: each report's own finding IDs were rewritten to canonical `F<N><S>` form only; no other aspect of either review was modified. References to the other model's local finding numbers inside the Cross-Model Verification narratives were left as the authors wrote them (they point at the phase-2 exchange tables, which were deleted per protocol).
- Where the two reports genuinely conflict on a fact (F69L single-symlink behaviour; F75L render-abort blast radius), both statements are presented with attribution rather than reconciled.

## About This Merge

- **Merge editor:** glm-5.3 (model ID: glm-5.3), via GitHub Copilot CLI 1.0.91.
- **Date:** 2026-10-04. **Commit:** `f34f710` (tag `v1.0.8`; release review - HEAD exactly at the tag, clean tree).
- **Source reports:** `security-review/reviews/v1.0.8/kimi-k3.md`, `security-review/reviews/v1.0.8/mimo-v2.6-pro.md`.
- The committed `security-review/prompt.md` is the canonical record of both prompts (the reviewing prompt and the merge-editor prompt); neither is embedded in this report.

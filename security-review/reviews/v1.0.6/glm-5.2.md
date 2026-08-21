# Parcel Security Review — v1.0.6 / glm-5.2

**Model:** `glm-5.2` (session powered by `glm-5.2-flex`; operational suffix omitted per §0 — filename form matches `v1.0.2/glm-5.2.md`).
**Date:** 2026-08-19
**Release:** 1.0.6 (`.version`)
**Commit ref:** `03fec5a` (`git describe --tags --always` → `v1.0.6`). Working tree clean except the untracked `security-review/reviews/v1.0.6/` directory holding review reports (not shipped code). The review therefore covers the committed v1.0.6 tree plus the v1.0.5→v1.0.6 diff.

---

## Executive Summary

Overall posture is **strong**. The native host remains a robust enforcement boundary: GPG signature verification, whitelist evaluation, rate-limiter persistence, audit logging, and passkey cryptography all hold under every threat model I could construct. `make test` passes **440/440** (up from 407 in v1.0.5), and the new HTTP-auth, card-class, and cross-origin-passkey test coverage is faithful to the security model.

The single most important takeaway is that **v1.0.6 closes a CRITICAL-class signature-verification bypass (`#144`) that had been reachable through v1.0.5**: the bootstrap's signer check used an unanchored `grep VALIDSIG | cut -d' ' -f12`, so an attacker-controlled GPG UID (appearing in a `GOODSIG` status line) could embed a fake `VALIDSIG <trusted-fingerprint>` substring at the right field offset and cause `eval "$PARCEL_HOST"` to execute attacker-supplied host code — i.e. execution of unverified host code on the user's system. The fix anchors the grep to the genuine `[GNUPG:] VALIDSIG ` status-line prefix. I verified the fix is complete and not bypassable, including against embedded-newline UIDs (GPG status-fd %-escapes these to `%0A`, so no physical `[GNUPG:] VALIDSIG` line can be injected). **The v1.0.6 committed tree is not vulnerable.** The one live residual is the migration: the bootstrap is user-installed and cannot self-update, so users still running a v1.0.5-or-older bootstrap remain vulnerable until they manually upgrade; the v1.0.6 extension surfaces an advisory popup warning when it detects `bootstrapVersion < 2`. This advisory-only migration is the best the extension can do and is consistent with the project's existing advisory hardening posture (e.g. `HOST_HASH`).

Beyond the `#144` fix, this review records **four live findings** (one MEDIUM, three LOW) and re-verifies every prior fixed/addressed finding: none have regressed. One additional finding (`F52C`, the `#144` class) is recorded as fixed-in-release. Two candidates from the cross-model phase were assessed as residual (no reachable exploit) rather than findings.

| ID | Sev | Conf | Area | TM | Title |
|----|-----|------|------|----|-------|
| F52C | C | H (fix verified) | bootstrap host | TM2, TM3 | `VALIDSIG`-signer extraction was forgeable via an unanchored grep (fixed in #144 / v1.0.6; pre-fix was reachable through v1.0.5) |
| F53M | M | H | native host rate limiter | TM2 | Concurrent native-host processes amplify the persisted token-bucket budget (non-atomic load/compute/save across `connectNative()` ports) |
| F54L | L | M | plaintext / shared helpers (TOTP) | TM4 | Unbounded `otpauth://` `digits` parameter causes large-allocation DoS in browser-side TOTP generation |
| F55L | L | H | extension WebAuthn | TM0, TM1 | `clientDataJSON.crossOrigin` hardcoded `false` despite cross-origin-iframe ceremony support (#138) |
| F56L | L | H | bootstrap host tests | TM5 | No adversarial regression test for the `#144` VALIDSIG-injection fix |

Severity letters follow §4. `#144` is the central security event of this release and is recorded here so the maintainer can add it to `findings.md` (it was never previously identified or tracked); the v1.0.6 committed tree is not vulnerable, and the migration residual is noted under Residual Observations.

---

## Trust Model & Attack Surfaces

Parcel is a read-only bridge from the browser to a `pass`-style GPG-encrypted store. Trust is layered so that a fully compromised extension still cannot decrypt non-whitelisted entries, obtain GPG/passkey private key material, defeat rate limiting, or cause the host to exceed its designed constraints — the **native host is the enforcement boundary**. My own structural examination (not a paraphrase of SECURITY.md) confirms the following boundary hierarchy:

1. **Browser extension (page/MAIN-world ↔ isolated content script ↔ popup ↔ service worker).** The page inherently controls its own MAIN-world DOM/CSS/JS; Parcel treats every page↔isolated-world bridge (CustomEvents, `postMessage`, the `attachShadow` patch) as untrusted and re-derives `origin`/`rpId` in the isolated world and background on every request. Popup authorisation is a correlation/token layer over the real boundary (the host), not a crypto boundary.
2. **Native-messaging channel.** A compromised extension (TM2) or a tampered peer (TM3) can craft JSON. The host defends with: (a) the bootstrap signature/hash chain before any shipped host code runs; (b) `action_$ACTION` regex-gated dispatch with an enumerated surface; (c) whitelist re-evaluation at decrypt time independent of the cached list; (d) the token-bucket rate limiter persisted across restarts.
3. **Native host (bootstrap + signed host).** Owns GPG/openssl/file access. All cryptography (decryption, passkey signing, passkey keypair generation) happens here; private key material never crosses back to the browser. The host writes to exactly four permitted locations (template parcelrc, log file, state file, temp verification keyring) and nothing else — verified mechanically.
4. **Local filesystem (TM4).** The store itself, `.parcel.json`, `parcelrc`, and the state file are trusted-by-location; a same-UID/root actor can tamper with them, but this is out of scope per the accepted findings (F5T, F24T, F46L) because such an actor already holds stronger primitives than Parcel can contain.

Components examined: root `parcel-host` (bootstrap), `src/parcel-host` (signed host), `src/js/agent.js`, `src/js/integration.js`, `src/js/main-world/shadow.js`, `src/js/main-world/webauthn.js`, `src/js/webauthn.js`, `src/js/popup.js`, `src/html/popup.html`, `src/js/helpers.js`, `src/js/plaintext.js`, `src/js/schema.js`, `src/js/selectors.js`, `src/js/targets.js`, `src/js/integration.es6.js`, `src/manifest.json`, `Makefile`, `src/Makefile`, the test suite, and the v1.0.5→v1.0.6 diff (notably `#141` HTTP auth, `#143` card class, `#144` VALIDSIG fix, `#138` cross-origin passkey frames, `#136` passwordless fix, `#137` `@` in passkey names).

---

## Methodology

- **Model identity:** `glm-5.2` (session model `glm-5.2-flex`).
- **Grounding (read in full, in order):** `CONSTITUTION.md` → `SECURITY.md` → `README.md` → `security-review/findings.md`. **No file under `security-review/reviews/` was opened, read, or grepped** — `findings.md` was the sole prior-review source. The committed `security-review/prompt.md` was read for threat-model definitions and the checklist (canonical prompt).
- **Source files examined (line-by-line where stated):** root `parcel-host` (full, 1–257); `src/parcel-host` (full, 1–904); `src/js/agent.js` (1–120, 600–800, 940–1075, 1179–1200 + grep); `src/js/integration.js` (700–760, 990–1145, 1440–1630 + grep of origin/broadcast/fill/token paths); `src/js/popup.js` (525–545, 838–860, 1100–1110, 1170–1180 + grep of XSS sinks); `src/js/helpers.js` (30–90, 120–180); `src/js/plaintext.js` (40–60); `src/js/targets.js` (full); `src/js/integration.es6.js` (full); `src/manifest.json` (full); `Makefile` (full); `src/html/popup.html` (1–60). `src/js/schema.js`, `src/js/selectors.js`, `src/js/webauthn.js`, `src/js/main-world/shadow.js`, `src/js/main-world/webauthn.js`, `src/Makefile`, `scripts/pre-commit-gitleaks`, `example/*`, `chrome/manifest.json`, `firefox/manifest.json` were examined by the responsible subagent and spot-checked by me.
- **Empirical verification:**
  - `make test` → **440 pass / 0 fail** (exit 0). Includes the new HTTP-auth interception suite, card-class search tests, cross-origin passkey tests, multi-sig bootstrap tests, HOST_HASH trailing-newline variants, rate-limiter persistence, state-file rejection, and symlink-policy revalidation.
  - `make todo` → **empty** (no outstanding `TODO:` comments in `src/`/`test/`).
  - Safe Node PoC confirming the `#144` signer-extraction arithmetic and the TOTP `digits` allocation semantics (no live renderer-OOM was executed — deliberately, to avoid crashing the shared environment).
  - The native-host subagent ran the bootstrap's exact GPG invocation against real GnuPG 2.4.9 to verify the `#144` fix and the GPG status-fd %-escaping of newline UIDs.
  - Phase-2 PoCs: (i) a bash model of the rate-limiter concurrency amplification (`F53M`) — 50 concurrent "processes" each performing one decrypt against a shared state file, confirming a 50× budget amplification (50 decrypts consumed one persisted token); (ii) a Node PoC confirming the `Schema` prototype-key bypass (`F57L`) and the dead `MetaSchema` nested-recursion (`F58L`).
- **Subagent allocation (3 × `glm-5.2-flex`, per §5/§9):** (1) native host + constitution host-side compliance; (2) extension JS + WebAuthn + popup; (3) manifest/build/tests + shared config modules. I consolidated, deduplicated, and **independently verified** every subagent finding against the code before accepting it. No subagent finding entered this report unverified. The second-look pass was performed solely by me (not delegated).
- **Limitations:** static + test-harness + scripted-PoC verification; I did not execute a live browser renderer or the real signed-host against a live store. The GPG %-escaping conclusion rests on GnuPG 2.4.9 behaviour and the authoritative `gpg/doc/DETAILS` status-fd convention; a hypothetical non-conformant/ancient GPG (pre-2.0) emitting raw control bytes in status-fd is not a realistic deployment for the supported version matrix (`gpg >= 2.2.20` per README).

---

## Findings

Consolidated table (exchanged in phase 2; updated after cross-verification):

| ID | Severity | Confidence | Area | Threat model | Title | file:line |
|----|----------|------------|------|--------------|-------|-----------|
| F52C | C | H (fix verified) | bootstrap host | TM2, TM3 | `VALIDSIG` signer extraction was forgeable via an unanchored grep (fixed in #144 / v1.0.6; pre-fix was reachable through v1.0.5) | `parcel-host:164` (post-fix anchored grep); pre-fix `grep VALIDSIG \| cut -d' ' -f12` |
| F53M | M | H | native host rate limiter | TM2 | Concurrent native-host processes amplify the persisted token-bucket budget (non-atomic load/compute/save across `connectNative()` ports) | `src/parcel-host:84-110` (`load_state`), `:115-119` (`save_state`), `:385-431` (`check_decrypt_rate_limit`), `:402` (unconditional reload) |
| F54L | L | M | plaintext / shared helpers (TOTP) | TM4 | Unbounded `otpauth://` `digits` parameter causes large-allocation DoS in browser-side TOTP generation | `src/js/helpers.js:67`, `:171`; `src/js/plaintext.js:50-56`; `src/js/popup.js:535,539`; `src/js/targets.js` (`totp`/`totp-url`) |
| F55L | L | H | extension WebAuthn | TM0, TM1 | `clientDataJSON.crossOrigin` hardcoded `false` despite cross-origin-iframe ceremony support (#138) | `src/js/webauthn.js:237`; call sites `src/js/integration.js:1334`, `:1358` |
| F56L | L | H | bootstrap host tests | TM5 | No adversarial regression test for the `#144` VALIDSIG-injection fix | `parcel-host:164`; `test/native-host.test.js:59-73` |

### F52C — `VALIDSIG` signer extraction was forgeable via an unanchored grep (CRITICAL, fixed in #144 / v1.0.6)

**Status:** Fixed in `#144` (commit `ba16ea1`). The v1.0.6 committed tree is **not vulnerable**. Recorded here because this critical vulnerability was never previously tracked in `findings.md` and was reachable in the immediately prior release (v1.0.5); the migration residual is noted under Residual Observations.

**Description (pre-fix).** The bootstrap's signer check extracted the primary fingerprint with `grep VALIDSIG <<< "$OUT" | cut -d' ' -f12` — unanchored. GPG status-fd emits `[GNUPG:] GOODSIG <keyid> <uid>` lines whose `<uid>` is attacker-controlled (it is the signing key's user-ID string). An attacker who crafts a GPG key whose UID contains the literal text `VALIDSIG <trusted-fingerprint> 0 0 0 0 0 0 0 0 0 0 <trusted-fingerprint>` arranged so that field 12 (as `cut -d' ' -f12` splits the `GOODSIG` line) lands on a fingerprint present in `VALID_SIGNERS` would cause `SIGNER_VALID=true`, after which the bootstrap proceeds to `eval "$PARCEL_HOST"` — executing the attacker-supplied host script on the user's system outside the browser sandbox. This meets the CRITICAL criterion: execution of unverified/unpinned host code.

**Threat model(s).** TM2 (compromised extension context that ships a malicious `SCRIPT` + crafted `SIGNATURE` via the `install` native-messaging action — the bootstrap only accepts `install` from the extension) and TM3 (a tampered native-messaging peer crafting the same JSON). The attacker does not need a key trusted by the user — they self-import their own key (the bootstrap uses `--auto-key-import --trust-model always --keyring "$KEYRING"` with a temp keyring), so `gpg --verify` exits 0 on the attacker's signature, and the only gate between "exit 0" and `eval` was the unanchored grep.

**Evidence (file:line).** Post-fix anchored extraction: `grep '^\[GNUPG:\] VALIDSIG ' <<< "$OUT" | cut -d' ' -f12` (`parcel-host:164`); the signer-containment test is `[[ -n "$SIGNER" && " $VALID_SIGNERS " =~ [[:space:]]$SIGNER[[:space:]] ]]` (`parcel-host:160`); `eval "$PARCEL_HOST"` (`parcel-host:244`) runs only after signature + signer (+optional `HOST_HASH`) all pass. The pre-fix code is visible in the `#144` diff (`grep VALIDSIG` → `grep '^\[GNUPG:\] VALIDSIG '`).

**Exploit scenario (pre-fix, was reachable through v1.0.5).** (1) Attacker generates a GPG key whose UID embeds a `VALIDSIG` substring with a trusted fingerprint at the field-12 offset. (2) A compromised extension (TM2) or tampered peer (TM3) sends an `install` message with the attacker's `SIGNATURE` (a detached signature over the attacker's `SCRIPT`, made with `--include-key-block` so the key auto-imports) and a malicious `SCRIPT`. (3) `gpg --verify` exits 0 (the signature is valid for the attacker's self-imported key under `--trust-model always`). (4) `grep VALIDSIG` matches the forged substring inside the `GOODSIG` UID; `cut -d' ' -f12` yields a trusted fingerprint; `SIGNER_VALID=true`. (5) `eval "$PARCEL_HOST"` runs the attacker's script with the user's shell privileges. The temp keyring is cleaned up regardless, leaving no obvious trace.

**Verification of the fix.** The anchor `^\[GNUPG:\] VALIDSIG ` only matches genuine GPG status lines (which begin with `[GNUPG:] `); a `GOODSIG` line begins with `[GNUPG:] GOODSIG`, so its UID can never match. Multi-sig blobs (#129) accept only if a genuine `VALIDSIG` from a trusted key appears — harmless. I additionally verified (via the native-host subagent on real GnuPG 2.4.9) that an embedded raw-newline (`0x0A`) UID — the only remaining way to try to inject a physical `[GNUPG:] VALIDSIG` line — is %-escaped by GPG status-fd (`%0A`), so no physical line can be injected; this is corroborated by the authoritative `gpg/doc/DETAILS` status-fd convention. The `BOOTSTRAP_VERSION` was bumped to `2` and the v1.0.6 extension surfaces an advisory popup when it detects an older bootstrap. **The v1.0.6 tree is not exploitable.**

**Recommended action.** None for the code. Maintain a regression test that mocks a `GOODSIG` line whose UID contains a `VALIDSIG` substring and asserts **rejection**, plus a newline-UID case asserting `%0A` (the existing native-host suite mocks `gpg` with clean `VALIDSIG` lines only — a future regression of the anchor would not be caught). The migration residual (advisory-only warning for old bootstraps) is the live concern; see Residual Observations. (This test-fidelity gap is tracked separately as F56L.)

### F53M — Concurrent native-host processes amplify the persisted token-bucket budget (MEDIUM)

*Confirmed during phase-2 cross-verification (F53M); independently reproduced with a PoC.*

**Description.** The F35M fix persists the token-bucket state to `STATEFILE` so that a kill-reconnect cannot reset the bucket. However, `check_decrypt_rate_limit` (`src/parcel-host:385-431`) performs `load_state → compute → save_state` with **no locking and no atomic compare-and-swap**, and the comment at `:396` acknowledges it is "deliberately not atomic — best-effort only." Critically, `load_state` (`src/parcel-host:84`) re-reads the file on **every** call (it `eval`s the file contents, overwriting the in-memory `DECRYPT_BUCKET_TOKENS`/`_LAST` globals), and `save_state` (`:115`) clobbers the file. There is no `flock`.

Scriptable native messaging spawns **one host process per `chrome.runtime.connectNative()` call**. A TM2-compromised service worker holds the `nativeMessaging` permission and can call `chrome.runtime.connectNative("com.github.erayd.parcel")` N times directly (bypassing the agent's single-port management), spawning N bootstrap processes. Each receives the signed host via `install` (agent.js:158) and runs an independent in-memory bucket, all sharing one `STATEFILE`.

**Threat model(s).** TM2 (compromised extension context). The host whitelist still bounds *which* entries are decryptable, but the rate limiter is the documented TM2 damage-limiting control (per F35M and the F40M response: "the host whitelist and rate limiter still bound the blast radius").

**Evidence (file:line).** `load_state` (`src/parcel-host:84-110`) is called unconditionally at `:402` at the start of every `check_decrypt_rate_limit`; `save_state` (`:115-119`) clobbers; no `flock`/atomic primitive anywhere (grep-confirmed). Each process's `DECRYPT_BUCKET_TOKENS` is seeded from the persisted file, so two concurrent processes both read the same value X before either's save lands.

**Exploit scenario (reachable) — empirically reproduced.** I modelled the real `load→compute→save` shape with a shared state file (seeded to a full 24-token bucket) and ran 50 concurrentbash "processes" each performing one decrypt: **all 50 succeeded**, but the persisted bucket dropped from 24000→23000 — i.e. **50 decrypts consumed only 1 persisted token** (a 50× amplification). Scaling to the runtime: with C concurrent host processes, a "round" of C concurrent decrypts yields C decrypts while consuming only 1 persisted token. Draining a 24-token bucket thus takes ~24 rounds × C decrypts = **24×C decrypts** in roughly 24 sequential-GPG-decrypt times (parallelised across C processes). With C=24, that is ~576 decrypts in seconds; with C=100, ~2400 — sufficient to empty a default-allow-all store (F4T) in a single burst-equivalent. The sustained rate is likewise amplified by C for synchronized post-wait batches. This undermines F23T's accepted "typical stores are considerably larger [than 24]" rationale, since the attacker scales C to exceed their store size.

**Severity calibration.** §4 lists "rate limiting" explicitly under HIGH ("reachable bypass of a documented protection ... with realistic exploitability"). I rate **MEDIUM** rather than HIGH because: (a) it is TM2-gated — the exposed data (whitelisted entries) was already accessible to a compromised SW via F40M's broadcast token; this finding removes the *speed limit* on already-accessible plaintext rather than granting new access; (b) the host whitelist, GPG-key protection, and execution boundary all hold; (c) F35M — the parent finding, "trivially reset by a compromised extension" (which allowed *unlimited* resets) — was rated MEDIUM, and this is a strictly-weaker residual (bounded N× multiplication per batch, requiring N concurrent processes and coordination for sustained amplification). A stricter reading escalating to HIGH on the literal §4 wording is defensible; the F35M precedent and the TM2+whitelist bounding justify MEDIUM. *Confidence: High* (mechanism + 50× amplification PoC-confirmed; live multi-process browser PoC not executed, so the precise magnitude under real GPG contention is not measured).

**Recommended fix.** Make the state update atomic: hold an `flock` over the load→compute→save critical section (e.g. `( flock 9; load_state; compute; save_state; ) 9>"$STATEFILE.lock"`), or re-read and re-check inside the lock to prevent the read-modify-write race. Alternatively, enforce a single live host process (e.g. a pidfile/`flock` on a host-lifetime lock at bootstrap startup, refusing to start a second process while one lives) — though that would change the native-messaging lifecycle and may break legitimate reconnects. Add a regression test asserting that two concurrent host processes cannot decrypt more than the configured bucket allows.

### F54L — Unbounded `otpauth://` `digits` parameter → large-allocation DoS in browser-side TOTP generation (LOW)

**Description.** `Helpers.generateTOTP(secret, step = 30, digits = 6)` (`src/js/helpers.js:43`) trusts `digits` verbatim and constructs the token with `(num % Math.pow(10, digits)).toString().padStart(digits, "0")` (`src/js/helpers.js:67`). The `totp-url` transform feeds `digits` directly from a parsed `otpauth://` URI inside the decrypted entry: `Helpers.generateTOTP(secret, url.searchParams.get("period") || 30, url.searchParams.get("digits") || 6)` (`src/js/helpers.js:171`). There is no `parseInt`, clamping, or upper bound.

**Threat model(s).** TM4 (crafted password-store contents). A shared/collaborative `pass` git remote, an imported shared credential, or a maliciously-pasted `otpauth://` URI can carry `digits=100000000` (or any numeric value up to V8's max string length ≈ 2.68×10⁸).

**Evidence (file:line).** The `totp` target is `hoist: true` (`src/js/targets.js`), so it is eagerly evaluated via `await this.#plaintext.getValue(target.name)` at `src/js/popup.js:535` whenever the entry's detail view opens. The path is plaintext.js `getValue` → `transform: ["totp"]`/`onMissing:"fallback"` → `totp-url` transform (`src/js/plaintext.js:50` → `src/js/helpers.js:167` `new URL(fillValue)` → `src/js/helpers.js:171` `generateTOTP(..., digits=<string>)` → `src/js/helpers.js:67` `padStart(digits, "0")`). I confirmed with a Node PoC that `Math.pow(10, "100000000")` is `Infinity`, `num % Infinity` stays finite, and `padStart` coerces the numeric string to a `ToLength` of `100000000` → a ~100 MB string allocation (below V8's `RangeError` boundary of ≈2.68×10⁸, so it is allocated rather than thrown). I also confirmed both store formats (`otpauth://...` and `totp: otpauth://...`) expose `digits` via `searchParams.get("digits")`.

**Exploit scenario (reachable).** An attacker with store-write access plants an entry whose body contains `totp: otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP&digits=100000000`. When the user opens the entry's detail panel (or fills its TOTP field), `padStart` attempts a ~100 MB allocation, hanging or OOM-crashing the popup/renderer. No credential disclosure, no host impact — pure DoS of the extension UI for that entry. (Non-numeric `digits` is harmless → `NaN`/`0`; an astronomically large `digits` > ~2.68×10⁸ yields `RangeError`, caught by the `plaintext.js:51` fallback to a default-`digits` transform — no crash.)

**Recommended fix.** Coerce and bound the otpauth inputs in the `totp-url` transform (`src/js/helpers.js:171`), e.g. `const digits = Math.min(Math.max(parseInt(url.searchParams.get("digits") || "6", 10) || 6, 1), 32);` (and similarly cap `period`). RFC 6238 TOTP values are 6–8 digits, so a ~32 cap is safe. Add an adversarial test for `digits` extremes — the existing `getValue applies totp-url transform` test only exercises `digits=6`.

*Note:* distinct from F12T (user-typed search regex). The `digits` string is store-controlled and auto-applied on view/fill; the fully-reachable path requires store-write access, so this is LOW (DoS only, no credential/host boundary crossed).

### F55L — `clientDataJSON.crossOrigin` hardcoded `false` despite cross-origin-iframe ceremony support (#138) (LOW)

*Confirmed during phase-2 cross-verification (F55L); independently reproduced.*

**Description.** `buildClientDataJSON(type, challengeB64Url, origin)` (`src/js/webauthn.js:231`) hardcodes `"crossOrigin": false` (`:237`). The `#138` feature deliberately *supports* passkey ceremonies originating from cross-origin iframes (origin = the iframe's own origin, which differs from the top-level origin), so `crossOrigin` should be `true` (and, per WebAuthn L3, `topOrigin` should be present) whenever the ceremony's origin differs from the top-level origin.

**Threat model(s).** TM0 (the `#138` feature advertises cross-origin-frame ceremony support but the produced `clientDataJSON` does not reflect the cross-origin context — documentation/spec tension), and TM1 (a hostile page embedding a target site in a cross-origin iframe with `allow="publickey-credentials-get"` produces a `clientDataJSON` that reports `crossOrigin: false` for what is genuinely a cross-origin ceremony).

**Evidence (file:line).** `crossOrigin: false` literal at `src/js/webauthn.js:237`; call sites pass only `binding.origin` (the iframe's own origin) — `integration.js:1334` (get) and `:1358` (create). The `#138` cross-origin-frame path (integration.js:246, the `mayHandlePasskeyHere` Permissions-Policy gate, and the hostname-vs-rpId MAIN-world check) lets a ceremony proceed when the iframe hostname matches/is a subdomain of rpId but is cross-origin to the top — exactly the case where `crossOrigin` should be `true`.

**Exploit scenario (reachable).** `evil.com` embeds `victim.com` in a cross-origin iframe with `Permissions-Policy: publickey-credentials-get`. The iframe requests a passkey; Parcel's MAIN-world interceptor fires (origin=`victim.com`), bridges to the isolated content script, which passes the Permissions-Policy gate and proceeds. The produced `clientDataJSON` has `origin: "https://victim.com"` (correct) and `crossOrigin: false` (incorrect — should be `true` with `topOrigin: "https://evil.com"`). A relying party that uses `crossOrigin`/`topOrigin` to distinguish "user invoked me directly at the top level" from "an embedder invoked me in a cross-origin iframe" is misled into treating the embedded ceremony as same-origin. Impact is contingent on RP behaviour — many RPs check only `origin` (which is correct here) — so the impact is limited.

**Recommended fix.** Thread the top-level origin through the ceremony (integration.js has `location.ancestorOrigins` on Chrome; on Firefox fall back to the rpId-binding + consent model, consistent with F43L). Set `crossOrigin: (origin !== topOrigin)` and include `topOrigin` in `clientDataJSON` when it differs, per WebAuthn L3. Severity LOW because `origin` itself is always correct and RPs that rely only on `origin` are unaffected.

### F56L — No adversarial regression test for the `#144` VALIDSIG-injection fix (LOW)

*Confirmed during phase-2 cross-verification (F56L); matches my own phase-1 residual observation.*

**Description.** The `#144` fix (`parcel-host:164`, anchoring the signer grep to `^\[GNUPG:\] VALIDSIG `) is the security crown jewel of this release — it closes a CRITICAL-class execution-of-unverified-host-code path. The native-host test suite mocks `gpg` with a mock that emits only clean `[GNUPG:] VALIDSIG <fpr> ...` status lines (`test/native-host.test.js:59-73`). There is no test whose mock `gpg` emits a `GOODSIG` line whose attacker-controlled UID contains a `VALIDSIG <trusted-fpr> ...` substring (the pre-fix bug form), nor a UID containing a raw `0x0A` newline (the only remaining injection vector, blocked by GPG `%0A`-escaping). A future regression of the `:164` anchor or of the multi-sig loop would therefore not be caught by the suite.

**Threat model(s).** TM5 (build/test integrity — regression coverage for a critical security gate).

**Evidence (file:line).** Mock-gpg constructor at `test/native-host.test.js:59-73` emits scripted `VALIDSIG` lines only; grepping `test/native-host.test.js` for `GOODSIG`/`%0A`/`VALIDSIG.*VALIDSIG` returns no adversarial case (only the clean multi-sig cases added by #129).

**Exploit scenario.** No live vulnerability in v1.0.6 (the code is correct). This is a test-fidelity gap: the absence of a regression test means a future change could silently re-introduce the unanchored `grep VALIDSIG` and the suite would still pass.

**Severity calibration.** F50I (regression-test gaps over fixed security gates) was INFORMATIONAL. I rate this **LOW** rather than INFORMATIONAL because the guarded control is a CRITICAL-class fix — a silent regression here would re-open host-code-execution — so the test gap is more material than F50I's general hardening gaps. LOW is the calibration; the F50I tension is noted.

**Recommended fix.** Add a mock-gpg variant that emits `[GNUPG:] GOODSIG <keyid> x VALIDSIG <trusted-fpr> 0 0 0 0 0 0 0 0 0 <trusted-fpr>` (UID-embedded forgery) and asserts the bootstrap **rejects** it; add a second variant emitting a raw-newline UID and asserts the bootstrap sees `%0A` (no physical `[GNUPG:] VALIDSIG` line injection).

---

## Regression Checks

Prior fixed/addressed findings, verified present, not reverted, not bypassed in v1.0.6:

- `F1M` (#46 temp keyring) — present, not reverted, not bypassed. `mktemp` keyring; `rm -f "$KEYRING" "$KEYRING"~` on both gpg-fail and gpg-success paths before signer/hash checks.
- `F2M` (#48 control-char strip) — present, not bypassed. `${1//[[:cntrl:]]/}` on every audit field.
- `F9L` (#49 sha256 after parcelrc) — present. `SHA256=command -v sha256sum||command -v sha256` runs after `. "$PARCELRC"`.
- `F10L`/`F14L` (#56 audit field caps) — present. `INTENT:0:128`, `ORIGIN:0:1024`, `FILE_PATH:0:1024`, `MESSAGE:0:4096`.
- `F11L`/`F18M` (#55/#68 extension-page CSP) — present. `script-src 'self'; object-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'self';` in `src/manifest.json`; identical in chrome/firefox builds.
- `F17L` (#57 allowLinks before traversal) — present, not bypassed. `collect_roots` applies policy before traversal; `action_decrypt` re-runs `validate_decrypt_path_policy` at decrypt time (test "revalidates link policy when a regular file is replaced by a symlink" passes).
- `F19M` (#67 deterministic reconnect) — present. `onStartup`/`onInstalled` → idempotent `#ensureNativeConnected()`; reused by the disconnect-reconnect path. `#135` lifecycle changes did not regress it.
- `F20M` (#69 port-name→action allow-list) — present, not bypassed by `#141`/`#143` (http-auth actions added only to the `popup` allow-list). `decrypt`/`match` restricted to authorised popup ports; `integration`→`config`; `passkey`→`passkey`; unknown actions throw.
- `F22L` (#71 HOST_HASH exact bytes) — present. `jq -rj '.script' | "$SHA256"` yields raw script bytes (no here-string newline); matches `sha256sum src/parcel-host`; tests cover with/without/multiple trailing newlines.
- `F29L` (#71 unquoted `$SHA256`) — present. `"$SHA256"` is quoted.
- `F30L` (0c9be39 GPG output leak) — present. `$OUT` logged to fd5 only; extension receives generic "Signature verification failed".
- `F31L` (ffeae49 action regex gate) — present. `[[ ! "$ACTION" =~ ^[a-zA-Z0-9_]+$ ]]`; dispatch surface enumerated = exactly `action_install, configure, ping, changes_since, list, decrypt, passkey`; `passkey_op_get/create` are not `action_*` and are not dispatchable.
- `F34M` (#106 broadcast destination-origin guard) — present, not bypassed by `#141`/`#138`. `msg.origin !== window.location.origin` check at fill time, including the broadcast fallback (covers mid-decrypt navigation). Regression test passes.
- `F35M` (#116 rate-limiter persistence) — present. `load_state`/`save_state` persist `DECRYPT_BUCKET_TOKENS/LAST`; `check_decrypt_rate_limit` loads before computing; a TM2-compromised extension cannot reach `STATEFILE`.
- `F36L` (#118 primary fill carries origin) — present. Popup sends `origin` on `fill`; the `fill-value`/`frameOrigin`-undefined halves remain the rejected F51I (no exploit).
- `F37L` (#123 gitleaks pin) — present. `scripts/pre-commit-gitleaks` pins gitleaks 8.30.1 with per-os/arch SHA-256 checksums and fail-closed; opt-in dev hook, not shipped.
- `F38I` (27dd6f2 stale comment) — present. The comment above `PORT_ACTIONS` matches the map.
- `F41L` (#129 multi-sig) — present, not bypassed. Loop over all `VALIDSIG` lines, accept if any trusted field-12 matches; multi-sig cannot enable bypass (each VALIDSIG field-12 is the genuine primary fingerprint of a key that actually signed the script).
- `F42L` (#130 passkeyDir validation) — present, not weakened by `#137` (`@` allowed in basename regex only; `..`/absolute/control/glob rejected; `..` separately rejected in TAIL).
- `F45L` (#131 rsync --delete) — present. `rsync -av --delete src/dist/` for both chrome and firefox; `release` additionally depends on `clean`.
- `F47L` (return 0 after invalid .since) — present. `action_changes_since` returns after the invalid-timestamp error; `.since` regex-validated `^[0-9]{10}$` before `date -d`.
- `F48I` (#132 CSS.escape) — present. `popup.js:1178` `li[data-path="${CSS.escape(entry.path)}"]` (shifted from the originally-cited line by new code but intact); chrome-api-mock installs `CSS.escape` so the path is exercised.

Accepted/tradeoff findings re-derived as still holding (not re-reported): `F3T`, `F4T`, `F5T`, `F7T`/`F26T` (all WAR entries empirically justified — `targets.js` reached via `schema.js`'s static import from the content-script context; `popup.js`/`plaintext.js` correctly absent), `F8T`/`F27T`, `F12T` (user-typed search regex), `F13T`, `F21T`, `F23T`, `F24T`, `F25T`, `F28T`/`F43L`/`F44L`, `F33T`, `F39T`, `F40M` (the `"broadcast"`/self-issued token remains a documented correlation token, not a TM1 control; the rationale holds), `F46L` (state-file fail-open is TM4-only and the limiter remains effective against its TM2 target), `F49I`, `F51I` (no reachable exploit), `F50I` (test-fidelity gaps noted but not live holes).

No regressions found.

---

## Deliberate Tradeoffs

Re-examined against `SECURITY.md`'s tradeoffs table; all still acceptable or unchanged in v1.0.6:
- Plaintext bash host, `HOST_HASH` off by default, absent-`.parcel.json` reveals all entries, content script on `<all_urls>`, entry rules not using dereferenced paths, no clipboard auto-clear, extension detectability, WebAuthn interception in page realm + first-come-first-served, `webRequest` for HTTP auth — all unchanged and consistent with the code.
- The `webRequest`/`webRequestAuthProvider` permissions added by `#141` are the documented tradeoff for HTTP-auth interception; the feature is default-on but disable-able via `handleHttpAuth: false`, and credentials are only ever supplied via explicit popup selection. No divergence.

---

## Residual Observations

- **#144 migration is advisory-only (live residual of F52C).** The bootstrap is user-installed and cannot self-update, so a user who updates the Parcel extension to v1.0.6 but whose bootstrap `parcel-host` predates `#144` remains vulnerable to the `VALIDSIG` injection until they manually replace the bootstrap. The v1.0.6 extension detects `bootstrapVersion < 2` and shows an advisory popup ("Please upgrade your bootstrap `parcel-host` script to v1.0.6 or newer"). This is the strongest mitigation available without violating the read-only/no-self-modification constitution, and it is consistent with the advisory posture of `HOST_HASH`. No reachable code defect in v1.0.6; recorded so the residual is visible.
- **`#144` robustness rests on GPG's status-fd %-escaping.** Verified empirically on GnuPG 2.4.9 and per `gpg/doc/DETAILS`. A hypothetical non-conformant/ancient GPG (pre-2.0) emitting raw control bytes in status-fd could in principle weaken the anchor, but the supported matrix is `gpg >= 2.2.20`, so this is not a realistic concern. A regression test asserting `%0A` (no physical line) for a newline-UID would harden this.
- **Config-driven regex ReDoS (distinct from F12T).** `rules[].pattern`/`strip` and `targets[].pattern`/`fallbackMatch` are auto-applied against store-/page-controlled strings without complexity/length bounds. The only fully-reachable DoS requires the attacker to control the matched string **and** `.parcel.json` simultaneously — but anyone who can plant crafted plaintext already effectively holds the store, making the DoS redundant. The non-redundant path (hostile `.parcel.json` only, matched against benign entry names) is low-likelihood. Per the reachability rule this is a hardening suggestion, not a finding. Suggested: cap config-regex source length and/or run a safe-regex lint at `format:"regex"` validation time.
- **In-memory plaintext not explicitly zeroed.** The popup detail view and broadcast-fill closure retain decrypted plaintext in JS memory until context teardown/GC. No reachable exploit (the value is delivered to the form field by design; the page already receives the filled value). Standard tradeoff for browser password managers.
- **Origin is message-supplied to the host/audit log (F20M residual).** `message.origin` is forwarded verbatim to the host and audit log by design, because the other end may be a `popup-bridge` port where `port.sender.tab` is not authoritative. Under TM1 the popup derives origin from the real `tab.url`/`serverAuthUrl`, so the audit origin is correct; under TM2 a compromised context can spoof the audit origin, but the entry path/intent/timestamp remain host-truthful and the extension is already compromised. The host cannot independently verify origin over native messaging. Accepted.
- **State-file fail-open (F46L rationale holds).** Any unloadable/0600-violating/symlinked/corrupt state seeds a full bucket. Only a same-UID/root actor (TM4) can reach `STATEFILE`; a TM2-compromised extension cannot. Out of scope.
- **Micro-TOCTOU between `validate_decrypt_path_policy` and `gpg --decrypt`.** A TM4 hostile FS racing the realpath check vs the open could swap in a different file, but the path must already be whitelisted and the swapped file must be a valid GPG-encrypted Parcel entry to leak anything (else gpg fails). Low residual under TM4 (actor already holds FS primitives).
- **`passkey` port has no host-side consent nonce (TM2-subsumed).** A `passkey`-named port can invoke assert/create without the host re-checking that the consent popup ran. Under TM1 this is unreachable (the page cannot connect extension ports; forged bridge events still pass through the isolated Permissions-Policy gate + consent popup before any assert is relayed). Under TM2 a compromised content script could bypass consent and sign, but this is strictly subsumed by the accepted F40M posture (a compromised content script can already decrypt any whitelisted entry's password via `"broadcast"`, which is strictly more powerful than a one-time, challenge-bound signature). It does not defeat a TM2-specific documented mitigation.

- **`Schema` unknown-property rejection bypassable for prototype-inherited keys (phase-2 / F57L, not a finding — inert).** I confirmed with a Node PoC that keys named `__proto__`, `constructor`, `toString`, etc. slip past the `if (!schema.properties[key]) throw` check at `src/js/schema.js:88`, because `schema.properties["__proto__"]` resolves (via prototype traversal) to `Object.prototype` (truthy). The reachable input paths are the page-controlled passkey-bridge schemas (TM1) and store/.parcel.json config (TM4, parsed on the host via `jq`). In every case the extraneous key is **inert**: downstream code reads only known keys (no `Object.assign`/spread/generic iteration over config). No reachable exploit results, so per the §4 reachability rule this is a residual hardening gap, not a finding. Recommended hardening: use a prototype-safe check (`Object.create(null)` for `schema.properties` mirrors, or `Object.prototype.hasOwnProperty.call(schema.properties, key)`).

- **`MetaSchema` nested self-recursion is dead code (phase-2 / F58L, not a finding — no attacker input).** I confirmed with a Node PoC that malformed nested schema definitions pass `MetaSchema` validation: the `MetaSchema.properties.properties.items = MetaSchema` / `MetaSchema.properties.items = MetaSchema` self-references at `src/js/schema.js:138-139` never fire, because the `items` keyword is applied only in the array branch, and schema `properties`/`items` values are objects, not arrays. The `schema.test.js` "Defined schemas" case therefore validates only one level and gives false confidence that all nested schema definitions are structurally meta-validated. Schemas are author-controlled code (not attacker input), so there is no reachable exploit — this is an F50I-analogous test/meta-validation gap, hence a residual, not a finding. Recommended hardening: add a `values` keyword to the schema validator that validates each value of an object property against a sub-schema, and use it so nested `properties` definitions are actually meta-validated.

---

## Things Done Well

- **The `#144` fix is exactly right** — anchoring to the genuine `[GNUPG:] VALIDSIG ` status-line prefix closes the injection cleanly, and bumping `BOOTSTRAP_VERSION` + surfacing an advisory popup for old bootstraps is a sensible migration given the no-self-modification constraint.
- **The HTTP-auth design (#141) is well-layered.** Per-challenge `crypto.randomUUID()` tokens bound to a single pending 401 callback, intent restricted to `http-auth` (form-fill decrypt blocked from this token), challenge URL surfaced from the token-bound background record (never the query string), main-frame only, 407 rejected, rate-limiter consumed. The test suite covers cross-challenge isolation, manual fallback, and token-expiry paths.
- **Host-side passkey enforcement is tight.** `rpId == entry.rpId` binding *and* `allowCredentials` enforcement both happen immediately before `-sign`; the `#!parcel-passkey` content marker is an authoritative backstop that refuses misclassified passkey entries from ever returning as plaintext; private key material never crosses to the browser.
- **Permissions-Policy check correctly lives in the isolated realm** (`integration.js` `mayHandlePasskeyHere`), checking both split and legacy feature names — a page cannot spoof the result. Cross-origin-frame handling (#138) re-derives `origin`/`rpId` isolated-side and in the background on every request.
- **Zero HTML-injection sinks** in `src/js` (no `innerHTML`/`insertAdjacentHTML`/`outerHTML`/`srcsrc`/`document.write`/`eval`/`new Function`); all render paths use `textContent`/`createTextNode`/`setAttribute`. The passkey save-command uses single-quote escaping + a quoted heredoc, with the only unescaped interpolation (`rpId`) host-validated to hostname charset.
- **State-file validation whitelist** (`^(DECRYPT_BUCKET_TOKENS|DECRYPT_BUCKET_LAST)=[0-9]+$`) before `eval`, on the same in-memory string — no validate↔eval TOCTOU; symlinks rejected (`-type f`).
- **WAR list is genuinely minimal** — every entry traces to a web/isolated-world load that requires it; `popup.js`/`plaintext.js` are correctly absent.
- **Constitution host-side compliance is mechanically verifiable** — zero network primitives; filesystem writes are exactly the four permitted exceptions.

---

## Cross-Model Verification

The other reviewing model (`kimi-k3`) supplied its phase-1 exchange file (`security-review-table-kimi-k3-20260819-03fec5a.md`). Per §6, I read **only** that exchange table (never the other model's full report) and independently re-derived every item from the code. The exchange files (mine and the imported copy) are deleted at the end of this finalisation.

**Confirmed additions (added to this report with my own original analysis):**
- **F53M → F53M (MEDIUM, confirmed).** Concurrent native-host processes amplify the persisted rate-limiter budget. I empirically reproduced a 50× amplification (50 concurrent one-decrypt processes consumed a single persisted token). Reachable under TM2 (a compromised SW holds `nativeMessaging` and can spawn N host processes directly). I rate **MEDIUM** (TM2-gated; the exposed whitelisted entries were already accessible via F40M at the limited rate; this removes the speed limit rather than granting new access; the host whitelist/execution boundary hold; F35M, the strictly-stronger parent, set the MEDIUM precedent). *Disagreement note:* a stricter literal reading of §4 ("bypass of rate limiting → HIGH") is defensible, but the F35M precedent and the TM2+whitelist bounding justify MEDIUM. A live multi-process browser PoC was not executed, so real-GPG contention magnitude is unmeasured.
- **F55L → F55L (LOW, confirmed).** `clientDataJSON.crossOrigin` hardcoded `false` at `src/js/webauthn.js:237`; call sites pass only the iframe's own origin. Incorrect for the cross-origin-iframe ceremonies that #138 added support for. Real spec-correctness bug; RP impact contingent on use of `crossOrigin`/`topOrigin`.
- **F56L → F56L (LOW, confirmed).** No adversarial regression test for the `#144` fix (the mock `gpg` emits clean `VALIDSIG` lines only). This also matches my own phase-1 residual observation. I rate LOW (vs the F50I INFORMATIONAL precedent) because the guarded control is CRITICAL-class.

**Overlap / severity disagreement:**
- **F54L ≡ F54L (same defect).** kimi-k3 reported the unvalidated `otpauth://` `period`/`digits` at `src/js/helpers.js:171` as INFORMATIONAL; I reported it as **LOW** (`F54L`). The disagreement: I traced the concrete reachable ~100 MB `padStart` allocation (PoC-confirmed arithmetic: `Math.pow(10,"1e8")→Infinity`, `num % Infinity`→finite, `padStart` coerces to length 1e8 just under V8's `RangeError` boundary), which is a real renderer hang/OOM on view or fill of the entry — not merely "unvalidated." The store-write (TM4) precondition keeps it LOW rather than higher. I retain LOW.

**Non-reproductions / re-classifications (not added as findings):**
- **F57L (prototype-key bypass in `Schema` unknown-property rejection).** I *confirmed* the bypass exists (a Node PoC showed `__proto__`, `constructor`, and `toString` keys slip past the `schema.properties[key]` check at `src/js/schema.js:88`). However, it is **inert today**: Parcel's downstream code only reads known config/request keys (the extraneous keys are never spread, assigned, or iterated) — there is no reachable exploit resulting from their acceptance. Per the §4 reachability rule ("If you cannot construct a reachable scenario, do NOT report it as a finding — place it under 'Residual Observations'"), I place this in Residual Observations rather than as a finding. *Disagreement:* kimi-k3 rated LOW; this review assesses it as inert-hence-residual. It is a legitimate latent hardening gap; evidence that any downstream generic-iteration of config keys exists would raise it to a finding.
- **F58L (MetaSchema nested self-recursion never fires).** I *confirmed* the claim: a Node PoC showed malformed nested schema definitions (e.g. a `pattern` of type number, or a non-object property value) **pass** `MetaSchema` validation — the `MetaSchema.properties.properties.items = MetaSchema` self-reference at `src/js/schema.js:138-139` is dead code, because the `items` keyword is applied only in the `case "array"` branch, and schema `properties` values are objects, not arrays. So nested schema definitions are not actually meta-validated. However, schemas are **author-controlled code** in `schema.js` (not attacker-controlled input), so there is no reachable exploit. This is an F50I-analogous test/meta-validation gap; per the §4 reachability rule I place it in Residual Observations, not as a finding. *Disagreement:* kimi-k3 rated LOW; this review assesses it as no-reachable-path-hence-residual.

No verdict was changed merely to achieve consensus.

---

## Second-Look Review

- **Did every finding survive the reachability requirement?** Yes. F54L (TOTP `digits`) has a traced reachable path: store-controlled `otpauth://` URI → `hoist`-eager `totp` target on view → unbounded `padStart`. Verified with a PoC (allocation arithmetic + URL parsing of both store formats). F52C (#144) was reachable through v1.0.5 and is fixed in v1.0.6; the v1.0.6 committed tree is not exploitable, which is stated explicitly. No "looks suspicious" item slipped through as a finding.
- **Which checklist areas got only superficial treatment?** None were skipped. The native host (bootstrap + signed host, 1161 lines) was read line-by-line by both me and the native-host subagent. The extension JS (agent/integration/popup/webauthn/main-world, ~5000 lines) was read line-by-line by the extension-js subagent and crown-jewel paths (port auth, fill/origin, passkey handling, HTTP auth) were read line-by-line by me. Manifest/build/tests/shared-config were covered by the manifest subagent and spot-checked by me. Every checklist item in §3 has an explicit "clean" disposition or a finding.
- **Which findings rest on unverified assumptions?** F54L rests on the assumption that a ~100 MB `padStart` allocation hangs/OOM-crashes a renderer; I verified the arithmetic and `padStart` ToLength coercion but deliberately did not execute a live renderer-OOM in the shared environment. This caps confidence at Medium. F52C's non-bypassability rests on GnuPG 2.4.9 behaviour + the authoritative status-fd convention; a non-conformant ancient GPG is the only theoretical gap (not in the supported matrix).
- **Did I misattribute a documented tradeoff as a finding?** No. F54L and F52C are not in the tradeoffs table. All tradeoff items were re-derived as still holding (§ Deliberate Tradeoffs).
- **Did I verify every `jq` call site, every unquoted `$VAR` in command position, every dispatch path?** Yes (native-host subagent, mechanical). All `$VAR`/`$(…)` in command position are quoted; `jq` responses use `--arg`/`--rawfile` (no shell-interpolated plaintext); the dispatch surface is enumerated to exactly seven `action_*` functions.
- **Is origin validation proven on every fill/decrypt path, including broadcast autofill and mid-decrypt navigation?** Yes. `msg.origin !== window.location.origin` at `integration.js:1577` (fill time, including the broadcast fallback); the broadcast fallback carries the intended origin; the HTTP-auth challenge origin is supplied by the background, never the page.
- **Are severities consistent and defensible?** Yes. F54L = LOW (DoS only, TM4 store-write precondition, no credential/host boundary crossed) — defensible. F52C = CRITICAL (pre-fix: execution of unverified host code) — defensible and clearly annotated as fixed-in-release. Only the six permitted letters (C/H/M/L/I/T) are used.
- **Did I accidentally clobber or duplicate a prior finding?** No. F54L is distinct from F12T (store-controlled `digits` vs user-typed regex). F52C was never tracked in `findings.md` (it is a fresh v1.0.6 fix).
- **Confidence per finding:** F54L = Medium (code path + arithmetic PoC confirmed; live renderer-OOM not executed). F52C = High (fix verified empirically on real GnuPG 2.4.9 and per the status-fd spec; the committed tree is not vulnerable). F53M = High (mechanism + 50× amplification PoC-confirmed; live multi-process browser PoC not executed, so real-GPG contention magnitude is unmeasured). F55L = High (literal + call sites + cross-origin-frame path all verified). F56L = High (mock-gpg grep-confirmed; no adversarial case).

---

## About This Review

- **Model:** `glm-5.2` (session model `glm-5.2-flex`).
- **Date:** 2026-08-19.
- **Commit ref:** `03fec5a` (tag `v1.0.6`); working tree clean except the untracked `security-review/reviews/v1.0.6/` review-report directory.
- The committed `security-review/prompt.md` is the canonical record of what was prompted; it is not embedded here.

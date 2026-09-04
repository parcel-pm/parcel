# Parcel v1.0.6 Security Review — kimi-k3

Final report. Phase 1 (independent review) and phase 2 (cross-model verification against
the glm-5.2 exchange table) are both complete; outcomes are recorded in
`## Cross-Model Verification`.

## Executive Summary

Parcel v1.0.6 (commit `03fec5a`, tag `v1.0.6`, working tree clean at review start) was
reviewed in full: the signed bootstrap host, the main native-messaging host, the MV3
background worker, both content scripts (isolated and MAIN world), the popup UI, shared
config/schema modules, packaging, and the test suite. Threat models TM0–TM5 were applied
component by component, and every prior fixed finding in `security-review/findings.md`
was re-verified.

No CRITICAL or HIGH vulnerabilities were identified. One MEDIUM and five LOW findings are
reported (the INFORMATIONAL phase-1 item was re-rated to LOW after phase-2 verification —
see `## Cross-Model Verification`):

- **F53M (MEDIUM, TM2)** — the decryption rate limiter persisted per F35M is
  non-atomic across concurrent host processes; a compromised extension opening K parallel
  `connectNative()` ports multiplies the documented burst (24) and sustained rate by K.
  Verified with a live PoC (bucket=4: sequential cap honored at 4/12, parallel 20/20
  succeeded).
- **F55L (LOW)** — `clientDataJSON.crossOrigin` is hardcoded `false` even for the
  cross-origin iframe ceremonies newly supported in #138 (correctness/spec-compliance;
  origin binding itself is unaffected).
- **F57L (LOW)** — config-schema unknown-property rejection is prototype-subvertible
  (`__proto__` etc. pass the truthiness check); inert today, latent hardening gap.
- **F58L (LOW)** — the MetaSchema self-recursion never fires, so nested schema
  definitions are never meta-validated; development-time validation weakening passes
  silently.
- **F56L (LOW)** — the #144 VALIDSIG-injection fix lacks an adversarial regression
  test (mock GPG emits no `GOODSIG` lines); reverting the anchored grep fails no test.
- **F54L (LOW)** — `otpauth://` `period`/`digits` parameters are used unvalidated
  (requires store-write access; up to ~100 MB string-allocation churn in the popup per
  crafted entry).

The most important takeaway: the v1.0.6 change surface (#144 bootstrap signer verification
hardening, #141 HTTP-auth interception, #138 cross-origin passkey frames) is implemented
carefully — note especially that the #144 multi-signature/VALIDSIG fix was empirically
verified against live GnuPG 2.4.9 with a malicious-UID key (forged status lines are
percent-escaped and cannot satisfy the anchored extraction). The single finding of real
consequence is the rate limiter's lack of inter-process atomicity: after F35M was fixed in
v1.0.6 via state-file persistence, concurrency rather than restart has become the remaining
lane, and it is reachable by the same attacker class the limiter documents itself against.

`make test`: **440/440 tests pass** (31 suites), verified independently twice (lead + two
subagent runs).

## Trust Model & Attack Surfaces

Components examined (source of truth = `src/` and repo-root scripts; committed `chrome/`
and `firefox/` bundles verified byte-identical to `src/` modulo the documented manifest
rewrites — see Regression Checks / packaging verification):

1. **`parcel-host` (bootstrap, 257 lines).** Reads `parcelrc` (0600-enforced, trusted
   code), verifies the extension-supplied main-host script and detached signature against a
   temporary throwaway keyring (`GNUPGHOME=/dev/null`, `--no-default-keyring`,
   `--trust-model always`, `--auto-key-import`), enforces the `VALID_SIGNERS` allow-list by
   extracting field 12 of anchored `[GNUPG:] VALIDSIG` status lines, optionally enforces
   the `HOST_HASH` pin against the exact script bytes, then `eval`s the verified body. The
   trust anchor is *not* GPG trust (anything self-imports) but the fingerprint list.
2. **`src/parcel-host` (main host, 904 lines).** Grows action surface
   `configure|ping|changes_since|list|decrypt|passkey` behind a regex-gated dispatch;
   builds `ALLOWED_FILES` from `.parcel.json` rules over a policy-filtered store scan;
   decrypts exact-path-matched, non-passkey entries behind the persisted token bucket;
   signs ES256 assertions with host-side rpId binding + `allowCredentials` enforcement;
   encrypts new passkey entries to `.gpg-id` recipients walked with textual store
   containment. Writes go only to the four constitution-permitted files.
3. **`src/js/agent.js` (background worker).** Sole native-messaging client; enforces the
   port-name→action allow-list; owns per-challenge http-auth tokens and the
   `#pendingAuthCallbacks` table; validates rpId against origin + public suffix; brokers
   popup↔tab bridges.
4. **`src/js/integration.js` (isolated content script).** Detects fill targets, mints
   per-element/per-ceremony UUID tokens, renders in-page popups, enforces the
   fill-time destination-origin equality check, gates WebAuthn consent and
   Permissions-Policy in the isolated realm.
5. **`src/js/main-world/{shadow,webauthn}.js`.** Page-realm shims. Hold no secrets; every
   input they relay is schema-validated isolated-side; the WebAuthn response path carries
   only what the page is entitled to.
6. **`src/js/popup.js` + `src/html/popup.html`.** Renders matches/details, obtains
   plaintext for fill only, enrols history per origin+container. Zero HTML string sinks
   (repo-wide grep).
7. **Shared modules** (`schema.js`, `plaintext.js`, `helpers.js`, `selectors.js`,
   `targets.js`, `webauthn.js`).

Boundary hierarchy as verified in code: page realm (hostile) → isolated content script →
background worker → bootstrap host → main host → GPG/openssl. The enforcement boundary
that actually protects credential plaintext sits in `src/parcel-host`
(`ALLOWED_FILES`/`PASSKEY_FILES` exact-list matching, symlink revalidation at decrypt time,
rate limiting, audit logging). Everything extension-side is UX and routing; the manifest
deliberately grants `<all_urls>` and the absence of `externally_connectable` is what keeps
page-realm code from opening extension ports at all.

## Methodology

- **Model:** `kimi-k3` (kimi-k3-flex operating suffix omitted per protocol). Date
  2026-08-19. Target: Parcel v1.0.6 (`03fec5a`, tag `v1.0.6`; tree clean).
- **Documents read in full before code analysis:** `CONSTITUTION.md`, `SECURITY.md`,
  `README.md`, `security-review/findings.md`. **No file under
  `security-review/reviews/` was opened, read, or listed into analysis**; directory names
  were enumerated once for filename-convention purposes only (§0 of the protocol) — content
  untouched.
- **Files examined in full (lead reviewer and/or subagent with independent verification by
  the lead of every derived claim):** `parcel-host`; `src/parcel-host`; `src/js/agent.js`,
  `integration.js`, `popup.js`, `helpers.js`, `schema.js`, `selectors.js`, `targets.js`,
  `plaintext.js`, `webauthn.js`, `main-world/shadow.js`, `main-world/webauthn.js`,
  `integration.es6.js`; `src/manifest.json`; `src/html/popup.html`; `Makefile`,
  `src/Makefile`-relevant release lines; `scripts/pre-commit-gitleaks`, `scripts/todo.sh`;
  `Dockerfile`; `.github/workflows/*`; `example/*`; `test/*.test.js` including
  `test/chrome-api-mock.js`; full `git diff v1.0.5..v1.0.6`.
- **Subagents (three, each `kimi-k3-flex`, distinct scopes per §5):** (1) native host +
  host-side constitution compliance; (2) extension JS + WebAuthn + popup; (3) manifest /
  build / tests / regression verification. Every subagent finding was independently
  reproduced or refuted by the lead; no finding entered this report without a lead-owned
  verification trail. One subagent LOW finding (claimed host crash via `set -e`) was
  **refuted** by the lead's end-to-end verification and is reported only as a hardening
  note (see Residual Observations, H1).
- **Empirical verification (all under `/tmp`, repo tree untouched):**
  - Live GnuPG 2.4.9 chain: attacker key created with `--allow-freeform-uid` embedding
    `\n[GNUPG:] VALIDSIG <trusted-fingerprint> …` in its UID; evil script signed with
    `--include-key-block`; verified through the exact bootstrap pipeline
    (`--status-fd=1 --quiet --verify … 2>&1`). Result: GPG escapes the UID in every status
    and diagnostic line (`%0A`, `\n`, `\\n`); extraction returns only the attacker's real
    fingerprint → rejected. Tampered script, corrupt blob, wrong-data second signature, and
    `HOST_HASH` mismatch all fail closed; valid sig+hash installs.
  - Rate-limiter PoC: mock-GPG harness driving the real bootstrap+host via native-messaging
    framing; bucket=4, rate=1e-6. Sequential control over 12 fresh processes: exactly 4
    decrypts. 20 parallel processes: 20/20 succeeded.
  - RB-2 refutation harness: passkey `get` with `allowCredentials:[true]` through the real
    dispatch — host survives (rc=0, `set -e` suspended inside the `if ! action_…` dispatch),
    ceremony denied fail-closed ("Credential not allowed by request"). Direct-call
    replication shows rc=5 death only outside the dispatch context.
  - Schema PoCs: `__proto__`/`constructor` keys accepted past the unknown-property gate (no
    pollution observed); MetaSchema accepts nested `{type:"giraffe"}` while rejecting a
    top-level one.
  - Symlink-cycle probe of `collect_roots`: parent-linking symlink yields a bounded
    amplification (kernel ELOOP ≈40 layers), not an unbounded loop (see Residual H2).
  - Bundle parity: `chrome/` and `firefox/` JS/CSS/HTML/parcel-host verified byte-identical
    to `src/` via SHA-256; manifests verified field-wise against the documented `jq`
    rewrites (Firefox transform is exactly background-conversion, `.es6.js` shim swap,
    `contextualIdentities`, gecko settings; CSP and permission sets unaltered).
- **Limitations:** only GnuPG 2.4.9 exercised live (status-escaping provenance is
  gpg-version-dependent — see Residual H3); macOS/BSD fallbacks (`stat -f`, `date -j`,
  BSD `sha256`, `readlink -f` portability) reviewed statically only; no real browser
  harness (Chrome/Firefox behavior of the new HTTP-auth and cross-origin passkey paths was
  verified statically + against mock-driven tests).

## Findings

| ID | Severity | Confidence | Area | Threat model | Title | file:line |
|---|---|---|---|---|---|---|
| F53M | M | High | Native host rate limiter | TM2 | Concurrent host processes multiply the persisted token-bucket budget | src/parcel-host:385-431 |
| F55L | L | High | Extension WebAuthn | TM0/TM1-adjacent | `clientDataJSON.crossOrigin` hardcoded `false` despite cross-origin iframe support (#138) | src/js/webauthn.js:237 |
| F57L | L | High | Extension schema | TM4 | Unknown-property rejection prototype-subvertible (`__proto__` etc.) | src/js/schema.js:88 |
| F58L | L | High | Extension schema/tests | TM0 | MetaSchema nested self-recursion never fires; nested defs not meta-validated | src/js/schema.js:138-139 |
| F56L | L | High | Bootstrap host tests | TM5 | No adversarial regression test for the #144 VALIDSIG-injection fix | parcel-host:164; test/native-host.test.js:59-73 |
| F54L | L | High | Extension TOTP | TM4 | `otpauth://` `period`/`digits` used unvalidated (large-allocation DoS / timer churn) | src/js/helpers.js:171 |

### F53M — Concurrent host processes multiply the persisted rate-limiter budget (MEDIUM, TM2)

**Description.** F35M's fix persists the token bucket to `~/.config/parcel/state`, defeating
sequential kill-and-reconnect resets. The load→compute→consume→save sequence in
`check_decrypt_rate_limit` is still not atomic across *concurrent* host processes: the code
even documents this ("load/compute/save is deliberately not atomic", src/parcel-host:401).
Two host processes that both `load_state` before either `save_state`s each observe the same
full bucket and each spend from it independently.

**Threat model(s).** TM2 — compromised extension context (popup/service worker; contexts
that can call `chrome.runtime.connectNative`). Each call spawns an independent host
process, so K parallel ports yield up to ~K × `decryptBucket` burst and ~K × `decryptRate`
sustained throughput.

**Evidence.** `src/parcel-host:385-431` (bucket math, `load_state` at :402, un-synced
`save_state` at :425/:430); `save_state` clobbers without locking at :114-119;
`load_state` at :84-113. Lead's PoC (mock-GPG native-messaging harness, real scripts,
fresh tmp HOME): bucket=4/rate≈0 → sequential control exactly 4/12 successes; **20 parallel
processes → 20/20 successes**. Subagent independently reproduced (19/20 succeeded at K=20).

**Exploit scenario.** A malicious update slips hostile code into the extension repository
(the "unnoticed malicious extension code" half of TM2), or a popup-context compromise of
another kind occurs. The attacker spawns, say, 50 native ports and drains a default-config
store at ~1,200-entry burst instead of the documented 24. The whitelist still bounds
*which* entries are reachable and the audit log records every decryption, but the specific
documented protection — "an initial burst of 24 decryptions and then roughly one every
150 seconds" — is broken wholesale for this attacker.

**Recommended fix.** Serialize the stateful section of `check_decrypt_rate_limit` under an
exclusive lock on the state fd: `flock -x` where available (util-linux flock, Linux), with
a `mkdir`-lock or `set -o noclobber` fallback for macOS; hold the lock across
`load_state`→compute→`save_state`; fail closed on lock-acquisition failure (deny the
decryption) while keeping the single state file to remain inside the constitution's write
exceptions. Alternatively document in SECURITY.md that the limiter is best-effort under
concurrent connections.

*Severity rationale:* rated MEDIUM for consistency with F35M's frozen rating (a strictly
more potent primitive — unlimited sustained resets — was rated M) and because the whitelist
and audit log remain intact overlapping controls. A HIGH rating ("reachable bypass of a
documented protection with realistic exploitability") would also be defensible; uncertainty
flagged explicitly as required.

### F55L — `clientDataJSON.crossOrigin` hardcoded `false` for cross-origin iframe ceremonies (LOW, TM0/TM1)

**Description.** Commit 055c5c5 (#138) made Parcel able to serve WebAuthn ceremonies inside
cross-origin iframes. `buildClientDataJSON` emits `crossOrigin: false` unconditionally, so
the signed client data mislabels genuinely cross-origin ceremonies. Per WebAuthn, RPs may
use `crossOrigin` (and `topOrigin`) to reason about ceremony context; a strict RP can
reject these assertions/registrations.

**Threat model(s).** TM1-adjacent correctness; TM0 (documentation/impl tension: README now
advertises cross-origin passkey handling while the emitted client data denies it).

**Evidence.** `src/js/webauthn.js:231-239` (`crossOrigin: false` literal at :237); callers
without discrimination `src/js/integration.js:1334` (get) and :1358 (create). Cross-origin
support gates: `src/js/main-world/webauthn.js:339-356` (fast gate),
`src/js/integration.js:1004-1021` (Permissions-Policy), authoritative background
validation at `src/js/agent.js:1166-1199`.

**Exploit scenario.** Not an exploit: interop/correctness defect. A site embedding a
cross-origin login iframe using Parcel receives `crossOrigin:false` client data and may
reject; conversely, an RP relying on `crossOrigin` as a signal loses the distinction. The
origin field itself remains correct, signature binding is host-enforced, and consent
displays the true frame origin — no trust-boundary crossing and no credential misdirection.

**Recommended fix.** Compute the cross-origin bit at ceremony intake in integration.js
(`window.top.location.origin !== window.location.origin` in try/catch, catch ⇒ true), carry
it in `passkeyBindings`, and pass it into `buildClientDataJSON(type, challenge, origin,
crossOrigin)`. `topOrigin` remains optional.

### F57L — Schema unknown-property rejection is prototype-subvertible (LOW, TM4)

**Description.** The strictness gate that rejects unknown config keys tests
`schema.properties[key]` for truthiness. `schema.properties` is a plain object, so config
keys named `__proto__`, `constructor`, `hasOwnProperty`, etc. resolve through
`Object.prototype`, pass the gate, and are retained on the validated config object.

**Threat model(s).** TM4 (crafted `.parcel.json`) / TM2-adjacent (config as injection
surface).

**Evidence.** `src/js/schema.js:88`. Lead PoC
(`Schema.validate(ConfigSchema, JSON.parse('{... ,"__proto__":{"polluted":"yes"}}'))`)
accepts without throwing; a control with `"bogus":1` throws as designed; no prototype
pollution occurs.

**Exploit scenario.** No reachable exploit identified today — nothing in `src/js` consumes
config keys dynamically, so injected keys sit inert. This is precisely the "absent control"
class the finding requirements allow: the population check is documented in code as a
shape-strictness gate, and it silently fails for a bounded family of keys. Any future code
path doing dynamic property reads on config (`config[name]`) would inherit misleading
values.

**Recommended fix.** `if (!Object.prototype.hasOwnProperty.call(schema.properties, key))
throw …`, plus regression tests asserting rejection of `__proto__`/`constructor` at config
and per-rule nesting levels.

### F58L — MetaSchema nested self-recursion never fires (LOW, TM0)

**Description.** `MetaSchema.properties.properties.items = MetaSchema;
MetaSchema.properties.items = MetaSchema;` (schema.js:138-139) is intended to make schema
definitions self-validating at any depth. But `Schema.validate` consumes `schema.items`
only in the `array` branch (schema.js:95-103) and `schema.properties` only in the object
branch — the maps' *values* are never meta-validated. Nested schema errors therefore pass
the meta-validation tests in test/schema.test.js silently.

**Threat model(s).** TM0 (validation-quality gate weaker than designed; security-relevant
constraints like `passkeyDir`'s pattern currently *are* covered by their own behavioural
tests, so protection is degraded but not absent).

**Evidence.** `src/js/schema.js:138-139`, consumption sites schema.js:76-103. Lead PoC:
`Schema.validate(MetaSchema, {type:"object", properties:{foo:{type:"giraffe"}}})` →
accepted; `{type:"object", properties:{foo:{type:"boolean", frobnicate:1}}}` → accepted;
top-level bad type → rejected.

**Exploit scenario.** Developer-time only: a typo weakening a nested constraint (e.g.
`maxLengh`) on a security-relevant config member ships unnoticed. A bogus nested `type`
fails closed at config-load runtime (unknown type throws), contributing to why this stays
LOW.

**Recommended fix.** In the `object`-type branch, when `schema.items` is present, validate
each property value against it (keeping `default: {}`/`value: {}` wildcards legal), or add
explicit hasOwnProperty-based keyword whitelisting inside the object branch.

### F56L — No adversarial regression test for the VALIDSIG-injection fix (#144) (LOW, TM5)

**Description.** ba16ea1 anchored the signer extraction (`grep '^\[GNUPG:\] VALIDSIG '`,
parcel-host:164) precisely because the unanchored form enabled status-stream injection.
The test-side mock GPG replicates `VALIDSIG` lines (test/native-host.test.js:59-73) but
emits no `GOODSIG` line at all (`grep -c GOODSIG` = 0), so no test crafts a malicious
UID/notated line that would pass the *old* grep but fail the anchored one. Reverting the
anchor today fails zero tests.

**Threat model(s).** TM5 — regression detector over a previously-exploitable bootstrap
primitive.

**Evidence.** `parcel-host:162-168`; `test/native-host.test.js` mock at lines 59-73 and
422-490; verified absence of `GOODSIG` emission.

**Exploit scenario.** None directly; this is a coverage finding per the finding-type rules
(test-gap over a fixed security gate, F50I-class). The live-PoC verification above shows
the fix itself works on GnuPG 2.4.9; the risk is silent re-widening in a future refactor.

**Recommended fix.** Extend the mock to emit a `GOODSIG` line whose UID embeds a forged
`[GNUPG:] VALIDSIG <trusted>` sequence, and assert install rejection; also exercise
multi-signature acceptance (already partially covered) and an `EXPKEYSIG`-prefixed stream.

### F54L — `otpauth://` `period`/`digits` used unvalidated (LOW, TM4)

**Description.** The `totp-url` transform pulls `period`/`digits` straight from the URI
query without numeric coercion or bounds. Verified effects: `period=0` yields `interval=0`
(string `"0"` is truthy, defeating the `|| 30` default) so the popup detail view's refresh
loop churns every 50 ms while the entry is open; pathological `digits` (e.g. `digits=1e8`)
makes `padStart` allocate a ~100 MB string per regeneration (at magnitudes ≥ 2²⁹ it throws
`RangeError: Invalid string length` instead). Phase-1 rating was INFORMATIONAL; phase-2
verification of the allocation behaviour led to the LOW rating (minimal-but-real resource
impact, nothing confidentiality/integrity-bearing).

**Threat model(s).** TM4 — requires password-store write access; the browser popup's
resources are the only affected asset.

**Evidence.** `src/js/helpers.js:171` (transform forwarding raw query params),
helpers.js:42-76 (`generateTOTP` numeric assumptions; `padStart(digits)` at :67),
popup.js:485-489 (50 ms refresh interval driven off `refreshAt`). Empirically verified in Node: `digits=1e8`
allocates a 100 000 000-char string; `digits=536870912` throws `RangeError`.

**Exploit scenario.** A crafted or corrupted store entry (e.g. from a faulty import, or a
same-UID hostile process with store-write access) degrades/agent-hangs the Parcel popup
whenever the entry is displayed or filled from. No trust boundary is crossed.

**Recommended fix.** Coerce + clamp at parse time (`period ∈ [1,86400]`, `digits ∈ [1,10]`,
non-numeric → defaults).

## Regression Checks

One line per prior finding marked fixed/addressed/resolved (verified against the current
tree; tests referenced where used):

- **F35M (#116)** — Present and dynamically verified *sequentially* (bucket persists across
  fresh processes). Incomplete *under concurrency* → F53M.
- **F42L (#130)** — Present: `passkey_op_create` rejects `..` prefix/infix and leading `/`
  (src/parcel-host:731-735); schema-side pattern rejects traversal (src/js/schema.js:220);
  dynamically verified by host subagent.
- **F45L (#131)** — Present: `rsync -av --delete` on both `chrome:` and `firefox:` targets
  (Makefile:42, 49).
- **F48I (#132)** — Present: `CSS.escape(entry.path)` at popup.js:1178; verified it is the
  only store-data selector interpolation in `src/js` (grep).
- **F47L** — Present (cosmetic): `return 0` after invalid `.since` (src/parcel-host:231).
- **F34M (#106)** — Present: broadcast fallback carries `origin` (agent.js:771);
  destination-frame equality check at integration.js:1577-1583; test coverage present.
- **F36L (#118)** — Present: primary popup fill posts `origin: frameOrigin` (popup.js:1289-1294).
- **F20M (#69)** — Present: `PORT_ACTIONS` allow-list + unknown-action rejection
  (agent.js:634-638, 679-681); integration ports limited to `config`; F40M's reported
  bypass paths are the maintainer-rejected, still-intended semantics (comment at
  agent.js:571-575 unchanged).
- **F19M (#67)** — Present: `onStartup`/`onInstalled` + idempotent `#ensureNativeConnected`
  (agent.js:81-86, 138-142); reconnect path unified through the same helper.
- **F18M (#68)** — Present: `connect-src 'none'; frame-src 'none'; base-uri 'self';` in
  `extension_pages` CSP (src/manifest.json:29-31).
- **F11L (#55)** — Present: explicit CSP declared (same lines).
- **F14L / F10L (#56)** — Present: four per-field length caps + control-char stripping in
  `audit_decrypt`/`audit_passkey` (src/parcel-host:371-382, 536-546); dynamically exercised.
- **F17L (#57)** — Present: link policy applied before traversal in `collect_roots`
  (src/parcel-host:160-212) plus per-entry jq filter and decrypt-time revalidation;
  dynamically verified incl. external-link refusal.
- **F22L / F29L (#71)** — Present: hash computed over exact script bytes via `jq -rj
  .script`; `"$SHA256"` quoted (parcel-host:173-177); mismatch error echoes the same value
  as `sha256sum` on disk.
- **F31L (ffeae49)** — Present: action-name regex gate `^[a-zA-Z0-9_]+$` (parcel-host:201).
- **F30L (0c9be39)** — Present: GPG status output goes to fd5 log only; extension receives
  constant strings (parcel-host:148-156, 165-171); live-verified in the negative PoCs.
- **F37L (#123)** — Present: `scripts/pre-commit-gitleaks` pins v8.30.1 with per-arch
  SHA-256 verified before extraction.
- **F38I (27dd6f2)** — Present: comment above `PORT_ACTIONS` matches the allow-list
  (agent.js:631-632).
- **F35M-adjacent F50I** — Partially closed (port-gating + origin-carry tests added in
  #132); residual gaps noted under Residual Observations H6.
- **F1M (#46)** — Present: temporary `mktemp` keyring, `--no-default-keyring`, removal on
  success/failure (parcel-host:132-156).
- **F5T (#50)** — Present: 0600 enforcement on `parcelrc` incl. symlink refusal via
  `find -type f -perm 0600` (parcel-host:83-86).
- **F9L (#49)** — Present: `SHA256` resolution occurs after `parcelrc` sourcing
  (parcel-host:99-103).
- **F2M (#48)** — Present: control-char stripping of audit fields (src/parcel-host:376-381).

No regressions found anywhere.

## Deliberate Tradeoffs

Re-examined against the current tree (all confirmed consistent; none re-reported):

- **F4T / F23T default-allow-all + 24-burst sizing** — unchanged; popup still shows the
  persistent whitelist warning. Note the interaction with F53M is one-directional
  (F1M worsens the exfil *speed*, not the accepted visibility scope).
- **F6T cross-origin iframe fill warning-only** — blocking `alert()` still raised
  (popup.js:746-762).
- **F7T / F26T WAR breadth** — list unchanged since v1.0.5 (7 resources); each traces to a
  required module/iframe fetch; the new `html/popup.html?mode=http-auth` flow reuses the
  same resource, no additions.
- **F13T shadow.js MAIN-world patch** — unchanged surface.
- **F21T four default signers incl. backup keys** — unchanged by #144; multi-sig handling
  verified correct.
- **F22L-fixed / F32T non-constant-time hash compare** — unchanged; local side-channel
  remains non-applicable.
- **F24T / F25T logfile trust & permissions** — `chmod 0600` on creation remains at
  bootstrap (parcel-host:100); `parcelrc` trust model unchanged.
- **F28T / F43L / F44L forgeable bridges & Firefox `ancestorOrigins` gap** — implementation
  exactly as accepted (`ancestorOrigins` narrowing with `*` fallback + `ev.source`
  correlation at integration.js:177-182/253-264; conflict modal trust unchanged).
- **F33T config endpoint breadth** — unchanged; `integration` ports still receive the full
  config incl. `passdir`.
- **F40M broadcast/auth-port posture** — code comment still documents the correlation-token
  rationale; no divergence.
- **F46L state-file fail-open** — unchanged; refusal logged, empty bucket seeded.
- **F51I fill-value origin omission** — unchanged; non-exploitable per original analysis.
- **F12T search-regex user-DoS** — unchanged; user-supplied only.
- **F15T audit line assembly uncapped** — per-field caps present; assembly-level cap still
  absent as accepted.
- **F16T writable config dir** — unchanged.
- **F39T page-stylable popup host element** — unchanged; inherent.
- **allowCredentials popup-oracle (SECURITY.md passkey §6)** — still present as documented;
  host enforcement observed intact for all-string malformed lists (see Residual H1).
- **WebAuthn page-realm detection & first-come-first-served** — implementation matches
  SECURITY.md word-for-word (non-configurable accessors when first; full backoff otherwise;
  no polling).

No implementation/documentation divergence found for any accepted item.

## Residual Observations

Hardening notes and inherent risks; none reached the finding bar:

- **H1 (RB-2 reframed).** `ALLOW_CREDENTIALS`/`HAS_ALLOW_CREDENTIALS` jq assignments in
  `passkey_op_get` (src/parcel-host:664-667) are plain substitutions inheriting jq's exit
  status; `test()` over a non-string element exits 5. Verified end-to-end: under the real
  dispatch (`if ! "action_$ACTION"`, which suspends `set -e` inside action bodies) the host
  survives and the ceremony is *denied* fail-closed — the code comment's promise
  ("an all-malformed list still constrains the ceremony") holds. A direct-call context
  would kill the host (subagent's PoC, rc=5). Recommendation stands cheaply: add `|| true`
  guards for robustness against future dispatch restructuring; a regression test for
  `allowCredentials:[1,true,null,{}]` would pin the fail-closed behavior.
- **H2.** `collect_roots` symlink-cycle amplification is *bounded* by kernel ELOOP (~40):
  a store with a parent-linking symlink under `allowLinks:true` yields ~40 duplicated scan
  roots and duplicated listed entries (host-side DoS of itself only; stderr uncaptured, no
  crash). A hostile store owner can already inject arbitrary entries. Not a finding.
- **H3.** The #144 fix relies on GnuPG percent/backslash-escaping of UIDs in status and
  diagnostic lines (empirically confirmed only on 2.4.9; README requires ≥2.2.20, and ≥2.2.8
  carries the relevant hardening). Suggested hardening regardless: validate extracted
  candidates against `^[0-9A-F]{40}$` and replace the `=~` containment with exact
  whitespace-token membership to remove regex semantics from the trust gate.
- **H4.** A hostile page can force repeated main-frame 401s, repeatedly opening Parcel
  http-auth popups/windows until the user chooses "Enter manually" (30 s suppression) —
  annoyance-level, mirroring the browser's native-dialog behavior; popup-spam parity with
  the passkey guard could be considered but isn't necessary.
- **H5.** After `#resolveAuthCallback` deletes an http-auth token, the still-connected
  popup port retains generic popup privileges (an ordinary authorised popup has those by
  design; F40M posture). Disconnecting the port on resolution would be zero-cost tidiness.
- **H6.** F50I residual detector gaps remain: state-file symlink/fail-open paths, audit
  truncation assertions, per-container history isolation, hostile action strings;
  packaging/manifest invariants (CSP directives, WAR membership, `--delete` retention,
  manifest-rewrite equivalence classes) are untested.
- **H7.** `extension_pages` CSP has no `default-src`; `img-src`/`font-src`/`style-src`
  unpinned at the boundary F18M hardened. All current loads are bundled (verified CSS/fonts
  reference only `/ttf`, `/img`, `/css`), so nothing crosses the network today; consider
  `default-src 'self'`.
- **H8.** TOTP epoch uses Int32 shifts (helpers.js:55) — wrong codes from ~2043.
- **H9.** jq/Oniguruma vs JS `u`-flag regex dialect drift between host-side rule matching
  and agent-side `#setEntries`/`#validateRpId` rule compilation; config-author-controlled
  only.
- **H10.** Informational release/dev tooling notes: release tag not signed (`git tag
  v$(VERSION)` — release artifacts themselves are GPG-signed, tags are not), dist
  signatures use gpg's default key rather than a pinned one, Dockerfile uses
  `curl … | bash` nodesource + `FROM ubuntu:latest` (dev-only, bind-mounted, produces no
  shipped artifacts), CI actions tag-pinned (tests only). None affect shipped code.
- **H11.** SECURITY.md:173 references a `security-reviews` directory; the actual directory
  is `security-review`. Documentation nit.

## Things Done Well

- **The #144 signer-extraction fix is text-book layered hardening** — anchored status grep,
  multi-signer loop, log-only diagnostics, no status leakage to the extension — and holds
  up under live attack with a purpose-built malicious key. This was the highest-risk line
  in the release and it is solid.
- **Decryption gating is consistently fail-closed**: exact-string allow-list match,
  passkey-class exclusion with a *content-marker backstop* (`#!parcel-passkey ` prefix
  refused in `action_decrypt` regardless of rule classification), symlink-policy
  revalidation at decrypt time, and the find/readlink desync check turning
  newline-filename ambiguity into an error instead of a bypass.
- **HTTP-auth interception (#141)** binds everything to the webRequest record: challenge
  URL served only from the token-bound background record, per-challenge UUID tokens,
  `intent:"http-auth"` restriction while pending, main-frame-only + proxy pass-through,
  and credentials delivered via Chrome's own auth binding so mid-popup navigation cannot
  redirect them.
- **Passkey ceremonies keep every invariant on the hostile side of the bridge:**
  rpId↔entry binding and `allowCredentials` enforced host-side immediately before signing;
  private key material never crosses in either direction (only armor-encrypted blobs);
  Permissions-Policy is checked in the isolated realm; the first-come-first-served backoff
  is implemented exactly as documented, including non-configurable accessors and the "never
  a fight" posture.
- **No HTML string sinks anywhere** in `src/js` (repo-wide grep): UI rendering is uniformly
  `textContent`/node factories — the entire store-data XSS class is absent by construction.
- **Bundle hygiene is provable**: committed `chrome/`/`firefox/` trees are byte-identical
  to `src/`, and both manifest rewrites reduce to the documented transformations with CSP
  and permissions intact — verified field-by-field.
- **Test discipline around security gates has continued improving** (#132 port-action and
  origin-carry assertions; native-host suite covers multi-sig, hostile stores, and
  link-policy matrices end-to-end through the real scripts).

## Cross-Model Verification

Phase 2 completed against `security-review-table-glm-5.2-20260819-03fec5a.md` (glm-5.2,
exchange **table only**; the other report was never opened, per protocol). glm-5.2 reported
two items; both were reproduced/assessed independently by this reviewer before reading
anything beyond the table row.

**F52C — VALIDSIG signer-extraction forgery, fixed in #144 (rated C for the pre-fix
lineage).**

- *Independent reproduction.* A purpose-built attacker key was created (GnuPG 2.4.9,
  `--allow-freeform-uid`) with a UID engineered so that an *in-line* substring
  `VALIDSIG x <trusted-fp>` appears in the `GOODSIG`/`IMPORTED` status lines with the
  trusted fingerprint aligned to space-field 12 (no newline smuggling required; GnuPG 2.4.9
  percent-escapes embedded newlines anyway — that vector is dead on modern GnuPG). The
  resulting signature stream was run through three extraction forms:
  - **Form A — v1.0.5 as shipped** (`SIGNER=$(grep VALIDSIG … | cut -f12)` + containment
    test): **forgery REJECTED**. A valid signature always emits both the forged-hit lines
    and one genuine `VALIDSIG` line, so `$()` yields a multi-line string the containment
    regex can never match. This is exactly the emergent defence documented in F41L
    (maintainer response: rejected, "not a valid finding"; multi-sig capability added in
    #129).
  - **Form B — the unanchored multi-sig loop** (iterate lines, accept on any match — the
    shape introduced for #129 before #144's anchoring): **forgery ACCEPTED**. This form was
    real but *un-shipped*: `git show v1.0.5:parcel-host` is Form A, and the
    v1.0.5..v1.0.6 diff goes A→C directly in ba16ea1 (#144), so the exploitable window
    existed only in development commits of the v1.0.6 cycle.
  - **Form C — v1.0.6 shipped** (anchored `grep '^\[GNUPG:\] VALIDSIG '` + loop):
    **forgery REJECTED**; only the attacker's genuine primary fingerprint is extracted.
- *Verdicts.* Agree emphatically with glm-5.2's key cross-verification point: **the v1.0.6
  committed tree is not vulnerable**, the fix is correct and should be borne in mind
  historically. **Disagreement** on "pre-fix was reachable through v1.0.5" and on applying
  CRITICAL to the released lineage: on the shipped v1.0.5 code the same forgery fails
  because of the F41L emergent property (independently re-derived from the code and
  demonstrated live above). The vulnerability that #144 closed was the *latent* one: the
  anchoring was necessary precisely because the multiline accident was about to be removed
  by the multi-sig loop and was never guaranteed across refactors or GnuPG versions. My
  **F56L** (no adversarial regression test for the anchored grep) is the correct
  live residual, and independently confirms glm-5.2's implicit concern.
- *Not added as a finding:* per §4 scope rules this review reports on the tree under
  review; F52C describes a state not reachable from v1.0.6.

**F54L — unbounded `otpauth:// digits` large-allocation DoS (rated L, TM4).**

- *Independent reproduction.* Confirmed and expanded: `digits=1e8` allocates a 100 MB
  string per TOTP regeneration via `padStart` (helpers.js:67); ≥2²⁹ throws `RangeError`;
  `period=0` (verified) defeats the `|| 30` default via truthy `"0"`. This is the same
  root cause as my phase-1 F54L item.
- *Verdict.* **Full agreement on the finding; partial disagreement on severity.** glm-5.2
  rated LOW while my phase 1 (carried from a subagent's `padStart`-throws characterization)
  rated INFORMATIONAL. Having now run the allocation behaviour myself, the LOW rating is
  better calibrated (a ~100 MB allocation + 50 ms regeneration churn while an entry is
  displayed is minimal-but-real impact, not cosmetic). Adopted: the finding is re-rated
  **F54L**; the evidence text was corrected to the verified behaviour.

**glm-5.2's coverage agreement.** glm-5.2 reports "no HIGH or MEDIUM live findings" while
this review found one MEDIUM (F53M, rate-limiter cross-process race). That finding
stands unaltered on this reviewer's own PoC evidence (sequential 4/12 vs parallel 20/20 at
bucket=4); the protocol requires verdicts never change merely for consensus, and glm-5.2's
table contained no item addressing the rate limiter.

Exchange files deleted post-finalisation (both this container's table and the imported
copy).

## Second-Look Review

Adversarial re-read of this draft:

- **Reachability check on every finding:** F1M — live PoC (lead-owned harness, real host
  scripts, 20/20 vs 4/12 control). F2L — static certainty (literal at webauthn.js:237 plus
  newly-documented cross-origin support; no reachability question since it mislabels only
  legitimate ceremonies). F3L — dynamically reproduced; labelled correctly as latent (no
  current consumer). F4L — dynamically reproduced; developer-time gate only. F5L —
  verified absence; coverage-type finding per the rules. F6L — mechanism demonstrated
  live (allocation + truthiness) and TM4-gated. Nothing entered Findings without a traced
  scenario.
- **Refuted sub-agent claim:** the "host crash via `set -e`" report (would-have-been RB-2)
  was refuted by end-to-end verification (survives + fails closed under the real dispatch);
  it appears only as Residual H1. This is exactly the consolidation discipline §5 requires.
- **Coverage checklist sweep (§3):** every native-host item was covered (bootstrap chain,
  whitelist, symlinks, dispatch, rate limiter [finding], audit log, passkey crypto,
  constitution grep, multi-sig); agent.js lifecycle/auth/allow-list/cache/http-auth covered;
  integration origin validation covered for popup/broadcast/fill-value/http-auth paths;
  MAIN-world surface minimality confirmed; popup XSS/lifetime/history covered; schema and
  config injection surfaces covered (two findings); manifest/packaging parity covered
  byte-for-byte; tests covered incl. mock-fidelity assessment. WebAuthn bridge forgery:
  verified annoyance-only (requestId correlation + consent gating).
- **Unverified assumptions restated:** GnuPG versions other than 2.4.9 (H3); macOS/BSD
  utility fallbacks (static only); real-browser behavior of `document.permissionsPolicy`
  permutations (static + mocked tests).
- **Tradeoff cross-check:** every SECURITY.md tradeoff table row and every
  accepted/rejected `findings.md` item was re-checked against code before exclusion (list in
  *Deliberate Tradeoffs*); F40M in particular was *not* re-reported — the code comment and
  behavior still match the documented correlation-token rationale.
- **jq/unquoted-variable dispatch sweep:** all `jq` call sites use `--arg`/heredoc
  inputs; the two plain-assignment jq extractions identified (passkey allowCredentials)
  were dynamically evaluated → Residual H1. `action_$ACTION` gating re-verified
  (regex gate present, no undocumented exposed functions).
- **Origin validation on every fill/decrypt path:** popup primary (popup.js:1289-1294 →
  integration.js:1577), broadcast fallback (agent.js:771 → same guard), fill-value (F51I
  accepted), http-auth (credentials bound by Chrome to the challenge, plaintext never
  reaches page/popup). Verified.
- **Severity calibration:** would defend F1M as MEDIUM to a human: preconditions (TM2),
  two intact overlapping controls (whitelist, audit), frozen-severity consistency with
  F35M; the argument for HIGH is recorded. F6 was re-rated I→L during phase 2 *after
  independent verification of the allocation behaviour* (glm's rating was evidence, not
  cause); recorded explicitly per the no-consensus-chasing rule. All letters belong to the
  permitted C/H/M/L/I/T vocabulary; T used nowhere (nothing new to classify as such).
- **Prior-review isolation:** confirmed — only `findings.md` was consulted; `reviews/`
  content was never read (names listed once for output-path derivation only).
- **Confidence per finding:** F1M High (two independent PoCs; evidence that would change
  it: proof that Chrome reuses one native process per extension, contradicting documented
  behavior+observed parallel hosts). F2L High (would change: a caller-side override I
  missed — grepped all call sites). F3L High (would change: a dynamic config-key consumer
  being introduced — would upgrade severity). F4L High. F5L High. F6L High (mechanism
  demonstrated live in Node).

## About This Review

- **Model:** kimi-k3 (GitHub Copilot CLI, kimi-k3-flex runtime suffix)
- **Date:** 2026-08-19
- **Target:** Parcel v1.0.6, commit `03fec5a` (release tag `v1.0.6`; clean committed tree,
  so this is a release review of tag-contents)
- **Prompt:** the committed `security-review/prompt.md` is the canonical record.
- **Artifacts:** report (this file); findings-table exchange files
  (`security-review-table-kimi-k3-20260819-03fec5a.md` and the imported
  glm-5.2 copy) were deleted at the end of phase 2 per protocol §6; PoC harnesses under
  `/tmp` (container-local).

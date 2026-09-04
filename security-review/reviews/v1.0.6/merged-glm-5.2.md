# Parcel v1.0.6 Security Review — Merged Report (kimi-k3 + glm-5.2)

Merge editor: `glm-5.2`. Merge date: 2026-08-19. Target: Parcel v1.0.6 (commit `03fec5a`,
tag `v1.0.6`; release review — HEAD is at the `v1.0.6` tag, 0 commits ahead). This report
consolidates the two independent post-phase-2 component reviews
(`security-review/reviews/v1.0.6/kimi-k3.md` and `security-review/reviews/v1.0.6/glm-5.2.md`),
each of which completed both phases of the standard Parcel review protocol including
cross-verification.

## Executive Summary

Parcel v1.0.6's posture is **strong**. The native host remains a robust enforcement boundary:
GPG signature verification, whitelist evaluation, rate-limiter persistence, audit logging,
and passkey cryptography all hold under every threat model both reviews could construct. Both
models report `make test` passing **440/440** (31 suites, up from 407 in v1.0.5) and verified
the committed `chrome/`/`firefox/` bundles byte-identical to `src/` (modulo the documented
manifest rewrites). The central security event of the release is **#144**, which anchors the
bootstrap's signer-extraction `grep` to the genuine `[GNUPG:] VALIDSIG ` status-line prefix;
both models agree the v1.0.6 committed tree is not vulnerable to the former forgery, and the
fix was verified live against GnuPG 2.4.9 with a purpose-built malicious-UID key.

The merged record carries **seven findings**: one CRITICAL (fixed-in-release), one MEDIUM,
and five LOW. By provenance: **one found independently by both models**, **three found by one
model and confirmed in cross-verification**, and **three disputed** (one finding-vs-not-a-
finding raised by glm and disputed by kimi; two raised by kimi and disputed by glm, which
classifies them as residual). No CRITICAL or HIGH vulnerabilities are exploitable in the
v1.0.6 committed tree.

Finding counts by severity and provenance:

| Severity | Both models | One + cross-verified | Disputed | Total |
|---|---|---|---|---|
| CRITICAL (C) | 0 | 0 | 1 (F52C) | 1 |
| MEDIUM (M) | 0 | 1 (F53M) | 0 | 1 |
| LOW (L) | 1 (F54L) | 2 (F55L, F56L) | 2 (F57L, F58L) | 5 |
| **Total** | **1** | **3** | **3** | **7** |

**Key strengths** (both reviews): the #144 fix is textbook layered hardening — anchored status
grep, multi-signer loop, log-only diagnostics, no status leakage to the extension — and holds
under live attack; decryption gating is consistently fail-closed (exact-string allow-list,
`#!parcel-passkey` content-marker backstop, symlink-policy revalidation at decrypt time, the
find/readlink desync check turning newline-filename ambiguity into an error); HTTP-auth
interception (#141) binds everything to the webRequest record; passkey ceremonies keep every
invariant on the hostile side of the bridge (rpId↔entry binding and `allowCredentials` enforced
host-side immediately before signing; private key material never crosses); no HTML-string
sinks anywhere in `src/js` (repo-wide grep — UI rendering is uniformly
`textContent`/`createTextNode`/`setAttribute`); bundle hygiene is provable byte-for-byte.

**Key weaknesses**: the persisted rate limiter (F35M's fix) is not atomic across concurrent
host processes (F53M), so a TM2-compromised extension can multiply the documented burst and
sustained rate by its number of parallel `connectNative()` ports — the same attacker class the
limiter documents itself against. The `otpauth://` `digits`/`period` parameters are consumed
unvalidated (F54L), a store-controlled DoS of the popup. The WebAuthn
`clientDataJSON.crossOrigin` is hardcoded `false` despite the new cross-origin-iframe support
(F55L). The #144 fix lacks an adversarial regression test (F56L). Two latent schema-validation
defects (F57L, F58L) are disputed between the models.

## Findings

Findings are severity-ordered (C → M → L). Each carries: canonical `F<N><S>` ID (continuing the
global sequence from `findings.md`, which ended at F51); provenance tag; a mapping line to the
source finding IDs in each model's report; threat model(s); a consolidated analysis with
`file:line` citations from both reports; and a recommended fix.

### F52C — `VALIDSIG` signer extraction was forgeable via an unanchored grep (CRITICAL; fixed in #144 / v1.0.6)

**Provenance:** glm only — disputed by kimi (kimi verified the mechanism but did not report it
as a finding; reachability-through-v1.0.5 is disputed).

**Source IDs:** kimi-k3.md — phase-2 verification/dispute, not reported as a finding; glm-5.2.md
— `F52C` (orig. `glm-5.2-2`).

**Status:** Fixed in #144 (commit `ba16ea1`). The v1.0.6 committed tree is **not vulnerable**
(both models agree). Recorded here because glm reports this critical vulnerability as never
having been tracked in `findings.md` and as reachable in the immediately prior release; that
reachability is disputed — see `## Disagreements`.

**Threat model(s):** TM2 (compromised extension context shipping a malicious `SCRIPT`+`SIGNATURE`
via `install`, the only action the bootstrap accepts from the extension) and TM3 (tampered
native-messaging peer crafting the same JSON). The attacker self-imports their own key (the
bootstrap uses `--auto-key-import --trust-model always --keyring <temp>`), so `gpg --verify`
exits 0 on the attacker's signature; the only gate between "exit 0" and `eval` was the
unanchored `grep`.

**Analysis (pre-fix).** The bootstrap's signer check extracted the primary fingerprint with
`grep VALIDSIG <<< "$OUT" | cut -d' ' -f12` — unanchored (post-fix anchor at `parcel-host:164`;
pre-fix form visible in the #144 diff). GPG status-fd emits `[GNUPG:] GOODSIG <keyid> <uid>`
lines whose `<uid>` is attacker-controlled (the signing key's user-ID string). An attacker who
crafts a GPG key whose UID contains a `VALIDSIG <trusted-fingerprint> ...` substring arranged
so that field 12 (as `cut -d' ' -f12` splits the `GOODSIG` line) lands on a fingerprint present
in `VALID_SIGNERS` would cause `SIGNER_VALID=true`, after which the bootstrap proceeds to
`eval "$PARCEL_HOST"` (`parcel-host:244`) — executing attacker-supplied host code on the user's
system outside the browser sandbox. This meets the CRITICAL criterion: execution of
unverified/unpinned host code. Signer containment is
`[[ -n "$SIGNER" && " $VALID_SIGNERS " =~ [[:space:]]$SIGNER[[:space:]] ]]` (`parcel-host:160`).

**Fix verification (both models).** The anchor `^\[GNUPG:] VALIDSIG ` (`parcel-host:164`) only
matches genuine GPG status lines (which begin with `[GNUPG:] `); a `GOODSIG` line begins
`[GNUPG:] GOODSIG`, so its UID can never match. Multi-sig blobs (#129) accept only if a genuine
`VALIDSIG` from a trusted key appears — harmless. glm additionally verified (native-host
subagent, real GnuPG 2.4.9) that an embedded raw-newline (`0x0A`) UID — the only remaining
injection vector — is %-escaped by GPG status-fd (`%0A`), corroborated by the authoritative
`gpg/doc/DETAILS` convention. kimi independently created a malicious-UID key and exercised
three extraction forms: Form A (v1.0.5 as shipped) rejected the forgery; Form B (un-anchored
multi-sig loop, un-shipped dev commits of the v1.0.6 cycle) accepted it; Form C (v1.0.6
shipped anchored) rejected it. `BOOTSTRAP_VERSION` was bumped to 2 and the v1.0.6 extension
surfaces an advisory popup when it detects an older bootstrap.

**Recommended action.** None for the v1.0.6 code. Maintain an adversarial regression test
(tracked as F56L) and note the advisory-only migration residual.

### F53M — Concurrent host processes multiply the persisted rate-limiter budget (MEDIUM)

**Provenance:** kimi only — confirmed by glm (glm did not report it in phase 1; confirmed and
reproduced in phase 2).

**Source IDs:** kimi-k3.md — `F53M` (orig. `kimi-k3-F1M`); glm-5.2.md — `F53M`
(orig. `glm-5.2-3`).

**Severity:** Both models MEDIUM (no disagreement).

**Threat model(s):** TM2 — compromised extension context (popup/service worker; contexts that
can call `chrome.runtime.connectNative`). Scriptable native messaging spawns one host process
per `connectNative()` call, so K parallel ports yield ~K × `decryptBucket` burst and ~K ×
`decryptRate` sustained throughput.

**Analysis.** F35M's fix persists the token bucket to `STATEFILE`, defeating sequential
kill-and-reconnect resets. However `check_decrypt_rate_limit` (`src/parcel-host:385-431`)
performs `load_state → compute → save_state` with **no locking and no atomic
compare-and-swap**, and the code documents this as "deliberately not atomic — best-effort only"
(glm cites the comment at `:396`; kimi cites the inline doc at `:401`). `load_state`
(`src/parcel-host:84-110`) re-reads the file on **every** call (it `eval`s the contents,
overwriting the in-memory `DECRYPT_BUCKET_TOKENS`/`_LAST` globals), and `save_state`
(`:115-119`) clobbers without a `flock`. Two host processes that both `load_state` before
either `save_state`s each observe the same full bucket and spend from it independently.

**Evidence (file:line).** kimi: `src/parcel-host:385-431` (bucket math, `load_state` at `:402`,
un-synced `save_state` at `:425`/`:430`), `:84-113` (`load_state`), `:114-119` (`save_state`).
glm: `src/parcel-host:84-110` (`load_state`), `:115-119` (`save_state`), `:385-431`
(`check_decrypt_rate_limit`), `:402` (unconditional reload).

**PoCs (both).** kimi (mock-GPG native-messaging harness, real scripts, fresh tmp HOME,
bucket=4/rate≈0): sequential control exactly 4/12 successes; **20 parallel processes → 20/20
successes** (a subagent independently reproduced 19/20 at K=20). glm (shared-state-file bash
model): 50 concurrent one-decrypt "processes" → 50 decrypts consumed a single persisted token
(a 50× amplification). Both: the whitelist still bounds *which* entries are reachable and the
audit log records every decryption; a live multi-process browser PoC was not executed, so the
precise magnitude under real GPG contention is unmeasured.

**Severity rationale (both converge).** MEDIUM, consistent with F35M's frozen MEDIUM rating —
this is a strictly-weaker residual (bounded N× multiplication per batch requiring N concurrent
processes and coordination, versus F35M's unlimited resets). The exposed data (whitelisted
entries) was already accessible to a compromised SW at the limited rate; this removes the
speed limit rather than granting new access. A stricter reading escalating to HIGH on §4's
literal "bypass of rate limiting → HIGH" wording is defensible (noted by both models); the F35M
precedent and the TM2+whitelist bounding justify MEDIUM.

**Recommended fix (both converge).** Serialize the stateful section of `check_decrypt_rate_limit`
under an exclusive lock on the state fd (`flock -x` on Linux, with a `mkdir`-lock or
`set -o noclobber` fallback for macOS), holding the lock across `load_state`→compute→
`save_state` and failing closed (deny the decryption) on lock-acquisition failure, keeping the
single state file to remain inside the constitution's write exceptions. Add a regression test
asserting that two concurrent host processes cannot decrypt more than the configured bucket
allows.

### F54L — Unvalidated `otpauth://` `digits`/`period` → large-allocation DoS / timer churn in browser-side TOTP (LOW)

**Provenance:** both models — the only finding reported independently by both in phase 1. kimi
originally rated it INFORMATIONAL; after cross-verification (independently running the allocation
behaviour), kimi adopted LOW. Both final positions agree LOW (a resolved severity disagreement,
noted here; not a live dispute).

**Source IDs:** kimi-k3.md — `F54L` (orig. `kimi-k3-F6L`/`kimi-k3-F6I`); glm-5.2.md — `F54L`
(orig. `glm-5.2-1`).

**Threat model(s):** TM4 (crafted/corrupted password-store contents — a shared/collaborative
`pass` remote, an imported shared credential, or a maliciously-pasted `otpauth://` URI). The
browser popup's resources are the only affected asset.

**Analysis.** `Helpers.generateTOTP(secret, step = 30, digits = 6)` (`src/js/helpers.js:43`)
trusts `digits` verbatim and constructs the token with
`(num % Math.pow(10, digits)).toString().padStart(digits, "0")` (`src/js/helpers.js:67`). The
`totp-url` transform feeds `period`/`digits` directly from a parsed `otpauth://` URI inside the
decrypted entry:
`Helpers.generateTOTP(secret, url.searchParams.get("period") || 30, url.searchParams.get("digits") || 6)`
(`src/js/helpers.js:171`). There is no `parseInt`, clamping, or upper bound. The `totp` target
is `hoist: true` (`src/js/targets.js`), so it is eagerly evaluated via
`await this.#plaintext.getValue(target.name)` at `src/js/popup.js:535` whenever the entry's
detail view opens (`popup.js:485-489` drives a 50 ms refresh interval off `refreshAt`).

**Evidence (file:line).** glm: `src/js/helpers.js:43`/`:67`/`:171`; `src/js/plaintext.js:50-56`;
`src/js/popup.js:535,539`; `src/js/targets.js` (totp hoist). kimi: `src/js/helpers.js:42-76`/`:171`;
`src/js/popup.js:485-489`.

**PoCs (both, Node).** `digits=1e8` → `Math.pow(10,"1e8")` is `Infinity`, `num % Infinity`
stays finite, and `padStart` coerces to a `ToLength` of 1e8 → a ~100 MB string allocation just
under V8's `RangeError` boundary (≈2.68×10⁸), so it is allocated rather than thrown, hanging or
OOM-crashing the popup/renderer on view or fill of the entry. `digits=536870912` throws
`RangeError` (caught by the `plaintext.js:51` fallback to a default-digits transform — no
crash). `period=0` (string `"0"` is truthy) defeats the `|| 30` default, so the detail view's
refresh loop churns every 50 ms while the entry is open. Both store formats (`otpauth://...`
and `totp: otpauth://...`) expose `digits`/`period` via `searchParams`. Non-numeric `digits` is
harmless → `NaN`/`0`.

**Exploit scenario (reachable).** An attacker with store-write access plants an entry whose
body contains `totp: otpauth://totp/Example?secret=...&digits=100000000`. When the user opens
the entry's detail panel (or fills its TOTP field), `padStart` attempts a ~100 MB allocation,
hanging or OOM-crashing the popup. No credential disclosure, no host impact — pure DoS of the
extension UI for that entry.

**Severity calibration.** LOW (DoS only, TM4 store-write precondition, no credential/host
boundary crossed). kimi's phase-1 INFORMATIONAL rating was upgraded to LOW after
cross-verification confirmed the allocation is a real renderer hang/OOM rather than merely an
unvalidated parameter; glm had rated it LOW from phase 1. Distinct from F12T (user-typed search
regex). Confidence: glm Medium (arithmetic + `padStart` PoC confirmed; a live renderer-OOM was
deliberately not executed in the shared environment); kimi High.

**Recommended fix (both converge).** Coerce and bound the otpauth inputs in the `totp-url`
transform (`src/js/helpers.js:171`), e.g. `digits = Math.min(Math.max(parseInt(d || "6", 10) || 6, 1), 32)`
and `period ∈ [1,86400]` (RFC 6238 TOTP values are 6–8 digits, so a ~32 cap is safe). Add an
adversarial test for `digits` extremes (the existing `getValue applies totp-url transform` test
only exercises `digits=6`).

### F55L — `clientDataJSON.crossOrigin` hardcoded `false` for cross-origin-iframe ceremonies (LOW)

**Provenance:** kimi only — confirmed by glm (phase 2).

**Source IDs:** kimi-k3.md — `F55L` (orig. `kimi-k3-F2L`); glm-5.2.md — `F55L`
(orig. `glm-5.2-4`).

**Severity:** Both LOW (no disagreement).

**Threat model(s):** TM0 (the #138 feature advertises cross-origin-frame ceremony support but
the produced `clientDataJSON` does not reflect the cross-origin context — documentation/spec
tension) and TM1-adjacent (a hostile page embedding a target site in a cross-origin iframe with
`allow="publickey-credentials-get"` produces a `clientDataJSON` that reports `crossOrigin: false`
for what is genuinely a cross-origin ceremony).

**Analysis.** Commit `055c5c5` (#138) made Parcel able to serve WebAuthn ceremonies inside
cross-origin iframes. `buildClientDataJSON(type, challengeB64Url, origin)`
(`src/js/webauthn.js:231`) hardcodes `"crossOrigin": false` (`:237`), so the signed client data
mislabels genuinely cross-origin ceremonies. Per WebAuthn, RPs may use `crossOrigin` (and
`topOrigin`) to reason about ceremony context; a strict RP can reject these
assertions/registrations. Call sites pass only the iframe's own origin without discrimination —
`src/js/integration.js:1334` (get) and `:1358` (create). The cross-origin-frame path
(`integration.js:246`, the `mayHandlePasskeyHere` Permissions-Policy gate at
`src/js/integration.js:1004-1021`, and the hostname-vs-rpId MAIN-world check at
`src/js/main-world/webauthn.js:339-356`; authoritative background validation at
`src/js/agent.js:1166-1199`) lets a ceremony proceed when the iframe hostname matches/is a
subdomain of rpId but is cross-origin to the top — exactly the case where `crossOrigin` should
be `true`.

**Evidence (file:line).** kimi: `src/js/webauthn.js:231-239` (`crossOrigin: false` at `:237`);
`src/js/integration.js:1334`/`:1358`; `src/js/main-world/webauthn.js:339-356`;
`src/js/integration.js:1004-1021`; `src/js/agent.js:1166-1199`. glm: `src/js/webauthn.js:231`/`:237`;
`src/js/integration.js:1334`/`:1358`; `src/js/integration.js:246`.

**Exploit scenario.** Not an exploit: interop/correctness defect. `evil.com` embeds
`victim.com` in a cross-origin iframe with `Permissions-Policy: publickey-credentials-get`; the
produced `clientDataJSON` has `origin: "https://victim.com"` (correct) and `crossOrigin: false`
(incorrect — should be `true` with `topOrigin: "https://evil.com"`). A relying party that uses
`crossOrigin`/`topOrigin` to distinguish "user invoked me directly at the top level" from "an
embedder invoked me in a cross-origin iframe" is misled into treating the embedded ceremony as
same-origin. Impact is contingent on RP behaviour — many RPs check only `origin` (which is
correct here) — so the impact is limited; the origin field itself remains correct, signature
binding is host-enforced, and consent displays the true frame origin (no trust-boundary crossing,
no credential misdirection).

**Recommended fix (both converge).** Compute the cross-origin bit at ceremony intake in
integration.js (`window.top.location.origin !== window.location.origin` in try/catch,
catch ⇒ true), carry it in `passkeyBindings`, and pass it into
`buildClientDataJSON(type, challenge, origin, crossOrigin)`. Set `crossOrigin: (origin !== topOrigin)`
and include `topOrigin` in `clientDataJSON` when it differs, per WebAuthn L3 (`ancestorOrigins`
on Chrome; Firefox falls back to the rpId-binding + consent model, consistent with F43L).

### F56L — No adversarial regression test for the #144 VALIDSIG-injection fix (LOW)

**Provenance:** kimi only — confirmed by glm (phase 2; glm also notes it matched its own
phase-1 residual observation).

**Source IDs:** kimi-k3.md — `F56L` (orig. `kimi-k3-F5L`); glm-5.2.md — `F56L`
(orig. `glm-5.2-5`).

**Severity:** Both LOW (no disagreement).

**Threat model(s):** TM5 — regression detector over a previously-exploitable bootstrap
primitive (the #144 anchor is the security crown jewel of this release).

**Analysis.** `ba16ea1` (#144) anchored the signer extraction
(`grep '^\[GNUPG:] VALIDSIG '`, `parcel-host:164`/`:162-168`) precisely because the unanchored
form enabled status-stream injection. The test-side mock GPG replicates `VALIDSIG` lines
(`test/native-host.test.js:59-73`, and `:422-490`) but emits **no `GOODSIG` line at all**
(`grep -c GOODSIG` = 0), so no test crafts a malicious UID/notated line that would pass the
*old* grep but fail the anchored one. Grepping `test/native-host.test.js` for
`GOODSIG`/`%0A`/`VALIDSIG.*VALIDSIG` returns no adversarial case (only the clean multi-sig
cases added by #129). Reverting the anchor today fails zero tests.

**Evidence (file:line).** kimi: `parcel-host:162-168`; `test/native-host.test.js` mock `:59-73`
and `:422-490`. glm: `parcel-host:164`; `test/native-host.test.js:59-73`.

**Severity calibration.** F50I (regression-test gaps over fixed security gates) was
INFORMATIONAL; both models rate this **LOW** because the guarded control is CRITICAL-class —
a silent regression here would re-open host-code-execution — so the test gap is more material
than F50I's general hardening gaps.

**Recommended fix (both converge).** Add a mock-gpg variant emitting
`[GNUPG:] GOODSIG <keyid> x VALIDSIG <trusted-fpr> 0 0 0 0 0 0 0 0 0 <trusted-fpr>` (UID-embedded
forgery) and assert the bootstrap rejects it; add a second variant emitting a raw-newline UID
and assert it sees `%0A` (no physical `[GNUPG:] VALIDSIG` line injection). Also exercise
multi-signature acceptance and an `EXPKEYSIG`-prefixed stream.

### F57L — Schema unknown-property rejection is prototype-subvertible (LOW)

**Provenance:** kimi only — disputed by glm (glm confirmed the bypass exists but classified it
residual: inert, no reachable exploit per the §4 reachability rule).

**Source IDs:** kimi-k3.md — `F57L` (orig. `kimi-k3-F3L`); glm-5.2.md — phase-2 verification,
classified residual, not a finding.

**Severity:** kimi LOW; glm — not a finding (residual). Canonical: **LOW**; glm's position is
recorded in `## Disagreements`.

**Threat model(s):** TM4 (crafted `.parcel.json`) / TM2-adjacent (config as injection surface).

**Analysis.** The strictness gate that rejects unknown config keys tests `schema.properties[key]`
for truthiness. `schema.properties` is a plain object, so config keys named `__proto__`,
`constructor`, `hasOwnProperty`, `toString`, etc. resolve through `Object.prototype`, pass the
gate, and are retained on the validated config object.

**Evidence (file:line).** `src/js/schema.js:88`. kimi PoC:
`Schema.validate(ConfigSchema, JSON.parse('{... ,"__proto__":{...}}'))` accepts without throwing;
a control with `"bogus":1` throws as designed; no prototype pollution occurs. glm PoC:
`__proto__`, `constructor`, `toString` slip past because `schema.properties["__proto__"]`
resolves (via prototype traversal) to `Object.prototype` (truthy); no metallic field is set.

**Exploit scenario (divergence).** kimi: "No reachable exploit identified today — nothing in
`src/js` consumes config keys dynamically, so injected keys sit inert. This is precisely the
'absent control' class the finding requirements allow: the population check is documented in
code as a shape-strictness gate, and it silently fails for a bounded family of keys. Any future
code path doing dynamic property reads on config (`config[name]`) would inherit misleading
values." glm: per the §4 reachability rule ("If you cannot construct a reachable scenario, do
NOT report it as a finding — place it under 'Residual Observations'"), because the extraneous
keys are never spread, assigned, or iterated downstream, there is no reachable exploit — hence
residual, not a finding. (Both positions verbatim in `## Disagreements`.)

**Recommended fix (both converge).** `if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) throw …`,
plus regression tests asserting rejection of `__proto__`/`constructor` at config and per-rule
nesting levels. (glm alternative: use `Object.create(null)` for `schema.properties` mirrors.)

### F58L — MetaSchema nested self-recursion never fires (LOW)

**Provenance:** kimi only — disputed by glm (glm confirmed the claim but classified it residual:
no attacker input).

**Source IDs:** kimi-k3.md — `F58L` (orig. `kimi-k3-F4L`); glm-5.2.md — phase-2 verification,
classified residual, not a finding.

**Severity:** kimi LOW; glm — not a finding (residual). Canonical: **LOW**; glm's position is
recorded in `## Disagreements`.

**Threat model(s):** TM0 (validation-quality gate weaker than designed; security-relevant
constraints like `passkeyDir`'s pattern are currently covered by their own behavioural tests, so
protection is degraded but not absent).

**Analysis.** `MetaSchema.properties.properties.items = MetaSchema; MetaSchema.properties.items = MetaSchema;`
(`src/js/schema.js:138-139`) is intended to make schema definitions self-validating at any depth.
But `Schema.validate` consumes `schema.items` only in the `array` branch (`schema.js:95-103`)
and `schema.properties` only in the object branch — the maps' *values* are never meta-validated.
Nested schema errors therefore pass the meta-validation tests in `test/schema.test.js` silently.

**Evidence (file:line).** `src/js/schema.js:138-139`; consumption sites `schema.js:76-103`. kimi
PoC: `Schema.validate(MetaSchema, {type:"object", properties:{foo:{type:"giraffe"}}})` accepted;
`{type:"object", properties:{foo:{type:"boolean", frobnicate:1}}}` accepted; top-level bad type
rejected. glm PoC: malformed nested schema definitions (e.g. a `pattern` of type number, or a
non-object property value) pass `MetaSchema` validation.

**Exploit scenario (divergence).** kimi: "Developer-time only: a typo weakening a nested
constraint (e.g. `maxLengh`) on a security-relevant config member ships unnoticed. A bogus
nested `type` fails closed at config-load runtime (unknown type throws), contributing to why
this stays LOW." glm: schemas are author-controlled code in `schema.js` (not
attacker-controlled input), so there is no reachable exploit — this is an F50I-analogous
test/meta-validation gap, hence residual, not a finding. (Both positions verbatim in
`## Disagreements`.)

**Recommended fix (both converge).** In the `object`-type branch, when `schema.items` (or a new
`values` keyword) is present, validate each property value against it (keeping `default: {}`/
`value: {}` wildcards legal); or add explicit `hasOwnProperty`-based keyword whitelisting inside
the object branch.

## Disagreements

One subsection per disputed finding/severity. Each model's position and rationale is presented
verbatim (or near-verbatim) from its component report. The editor does not adjudicate; the
disagreement record is the output.

### Dispute 1 — F52C: was the #144 forgery a finding, and was it reachable in shipped v1.0.5?

**glm-5.2 — reported F52C as CRITICAL (fixed-in-release).** Verbatim: "this critical
vulnerability was never previously tracked in `findings.md` and was reachable in the
immediately prior release (v1.0.5)"; finding title: "`VALIDSIG` signer extraction was forgeable
via an unanchored grep (fixed in #144 / v1.0.6; pre-fix was reachable through v1.0.5)". glm
verified the fix is complete and non-bypassable (including embedded-newline UIDs %-escaped by
GPG status-fd) and records it so the maintainer can track it in `findings.md`; the live residual
is the advisory-only migration.

**kimi-k3 — not added as a finding; disputes v1.0.5 reachability and applying CRITICAL to the
released lineage.** Verbatim: "Agree emphatically with glm-5.2's key cross-verification point:
the v1.0.6 committed tree is not vulnerable, the fix is correct and should be borne in mind
historically. **Disagreement** on 'pre-fix was reachable through v1.0.5' and on applying
CRITICAL to the released lineage: on the shipped v1.0.5 code the same forgery fails because of
the F41L emergent property (independently re-derived from the code and demonstrated live
above). The vulnerability that #144 closed was the *latent* one: the anchoring was necessary
precisely because the multiline accident was about to be removed by the multi-sig loop and was
never guaranteed across refactors or GnuPG versions." kimi further notes the three forms it
exercised: Form A (v1.0.5 as shipped, `grep VALIDSIG | cut -f12` + containment) — forgery
REJECTED (multi-line `$()` never matches the containment regex); Form B (un-anchored multi-sig
loop, un-shipped dev commits of the v1.0.6 cycle) — forgery ACCEPTED; Form C (v1.0.6 shipped
anchored) — REJECTED. "Not added as a finding: per §4 scope rules this review reports on the tree
under review; F52C describes a state not reachable from v1.0.6." kimi assesses its F56L (no
adversarial regression test) as "the correct live residual, and independently confirms
glm-5.2's implicit concern."

**Editor's canonical choice:** CRITICAL (F52C), per the reporting model's severity, reflecting
the pre-fix class (execution of unverified host code). This does not adjudicate the dispute;
kimi's "not a finding / not reachable in shipped v1.0.5" position stands as recorded. Both models
agree the v1.0.6 committed tree is not vulnerable and that #144 is the correct fix.

### Dispute 2 — F57L: schema unknown-property prototype bypass — LOW finding vs residual?

**kimi-k3 — reported F57L as LOW.** Verbatim: "No reachable exploit identified today — nothing
in `src/js` consumes config keys dynamically, so injected keys sit inert. This is precisely the
'absent control' class the finding requirements allow: the population check is documented in
code as a shape-strictness gate, and it silently fails for a bounded family of keys. Any future
code path doing dynamic property reads on config (`config[name]`) would inherit misleading
values."

**glm-5.2 — classified residual, not a finding.** Verbatim: "I *confirmed* the bypass exists (a
Node PoC showed `__proto__`, `constructor`, and `toString` keys slip past the
`schema.properties[key]` check at `src/js/schema.js:88`). However, it is **inert today**:
Parcel's downstream code only reads known config/request keys (the extraneous keys are never
spread, assigned, or iterated) — there is no reachable exploit resulting from their acceptance.
Per the §4 reachability rule ('If you cannot construct a reachable scenario, do NOT report it as
a finding — place it under "Residual Observations"'), I place this in Residual Observations
rather than as a finding. *Disagreement:* kimi-k3 rated LOW; this review assesses it as
inert-hence-residual. It is a legitimate latent hardening gap; evidence that any downstream
generic-iteration of config keys exists would raise it to a finding."

**Editor's canonical choice:** LOW (F57L), per the reporting model's severity. glm's "residual,
not a finding" position stands as recorded.

### Dispute 3 — F58L: MetaSchema dead self-recursion — LOW finding vs residual?

**kimi-k3 — reported F58L as LOW.** Verbatim: "Developer-time only: a typo weakening a nested
constraint (e.g. `maxLengh`) on a security-relevant config member ships unnoticed. A bogus
nested `type` fails closed at config-load runtime (unknown type throws), contributing to why
this stays LOW."

**glm-5.2 — classified residual, not a finding.** Verbatim: "I *confirmed* the claim: a Node
PoC showed malformed nested schema definitions (e.g. a `pattern` of type number, or a non-object
property value) **pass** `MetaSchema` validation — the `MetaSchema.properties.properties.items = MetaSchema`
self-reference at `src/js/schema.js:138-139` is dead code, because the `items` keyword is
applied only in the `case "array"` branch, and schema `properties` values are objects, not
arrays. ... However, schemas are **author-controlled code** in `schema.js` (not
attacker-controlled input), so there is no reachable exploit. This is an F50I-analogous
test/meta-validation gap; per the §4 reachability rule I place it in Residual Observations, not
as a finding. *Disagreement:* kimi-k3 rated LOW; this review assesses it as
no-reachable-path-hence-residual."

**Editor's canonical choice:** LOW (F58L), per the reporting model's severity. glm's "residual,
not a finding" position stands as recorded.

## Regression Checks

Prior fixed/addressed/resolved findings, verified present, not reverted, not bypassed in v1.0.6.
Both models: `make test` 440/440 (31 suites); no regressions found anywhere.

| Prior | Status | Verified by | Notes |
|---|---|---|---|
| F1M (#46) | Present | both | mktemp temp keyring; `--no-default-keyring`; cleanup on gpg-fail and gpg-success paths |
| F2M (#48) | Present | both | control-char strip (`${1//[[:cntrl:]]/}`) on every audit field |
| F5T (#50) | Present | kimi | 0600 on `parcelrc` incl. symlink refusal via `find -type f -perm 0600` |
| F9L (#49) | Present | both | `SHA256` resolution after `parcelrc` sourcing |
| F10L / F14L (#56) | Present | both | per-field caps: INTENT:128, ORIGIN:1024, FILE_PATH:1024, MESSAGE:4096 |
| F11L / F18M (#55/#68) | Present | both | extension_pages CSP w/ `connect-src 'none'; frame-src 'none'; base-uri 'self'` |
| F17L (#57) | Present | both | `collect_roots` policy before traversal; decrypt-time revalidation |
| F19M (#67) | Present | both | onStartup/onInstalled → idempotent `#ensureNativeConnected()` |
| F20M (#69) | Present | both | port-name→action allow-list; `integration`→`config`; unknown actions rejected |
| F22L / F29L (#71) | Present | both | HOST_HASH over exact bytes (`jq -rj .script`); `"$SHA256"` quoted |
| F30L (0c9be39) | Present | both | GPG status output to fd5 only; extension receives constant strings |
| F31L (ffeae49) | Present | both | action regex gate `^[a-zA-Z0-9_]+$`; enumerated seven `action_*` |
| F34M (#106) | Present | both | broadcast destination-origin guard at fill time incl. broadcast fallback |
| F35M (#116) | Present (incomplete under concurrency) | both | persistence holds sequentially; concurrency gap → F53M |
| F36L (#118) | Present | both | primary popup fill posts `origin: frameOrigin` |
| F37L (#123) | Present | both | gitleaks pinned v8.30.1, per-arch SHA-256 verified before extraction |
| F38I (27dd6f2) | Present | both | stale PORT_ACTIONS comment now matches the allow-list |
| F41L (#129) | Present | glm | multi-sig loop over genuine VALIDSIG lines; trust by genuine primary fingerprint |
| F42L (#130) | Present | both | passkeyDir rejects `..` prefix/infix, leading `/`, control/glob |
| F45L (#131) | Present | both | `rsync -av --delete` on chrome and firefox targets |
| F47L | Present | both | `return 0` after invalid `.since`; `.since` regex-validated `^[0-9]{10}$` |
| F48I (#132) | Present | both | `CSS.escape(entry.path)` at popup.js:1178 |
| F50I (#132 partial) | Partially closed | kimi | residual detector gaps remain (see Residual Observations) |

## Deliberate Tradeoffs

Re-examined against `SECURITY.md`'s tradeoffs table; all still acceptable/unchanged in v1.0.6 and
consistent with the code.

| Accepted tradeoff | Status | Verified by |
|---|---|---|
| F4T / F23T default-allow-all + 24-burst sizing | unchanged (F53M worsens exfil *speed*, not scope) | both |
| F6T cross-origin iframe fill warning-only (`alert()`) | unchanged | kimi |
| F7T / F26T WAR breadth (7 resources, minimal) | unchanged; new http-auth flow reuses same resource | both |
| F12T user-typed search regex DoS | unchanged (user-supplied only) | kimi |
| F13T shadow.js MAIN-world `attachShadow` patch | unchanged | kimi |
| F15T audit-line assembly uncapped | unchanged (per-field caps present) | kimi |
| F16T writable config dir | unchanged | kimi |
| F21T four default signers incl. backup keys | unchanged; #144 multi-sig handling verified correct | kimi |
| F22L-fixed / F32T non-constant-time hash compare | unchanged (local side-channel N/A) | kimi |
| F24T / F25T logfile trust & 0600 on creation | unchanged | kimi |
| F28T / F43L / F44L forgeable bridges / Firefox `ancestorOrigins` gap | unchanged (exactly as accepted) | kimi |
| F33T config endpoint breadth (incl. passdir) | unchanged | kimi |
| F39T page-stylable popup host element | unchanged (inherent) | kimi |
| F40M `"broadcast"`/self-issued `auth` token as correlation-layer | unchanged (not a TM1 control; rationale holds) | both |
| F46L state-file fail-open (TM4-only; limiter effective vs TM2) | unchanged | both |
| F51I `fill-value` origin omission | unchanged (non-exploitable) | kimi |
| allowCredentials popup-oracle (SECURITY.md passkey §6) | as documented; host enforcement intact for malformed lists | kimi |
| WebAuthn page-realm detection + first-come-first-served | as documented (non-configurable accessors when first; full backoff) | both |
| HOST_HASH off by default / no clipboard auto-clear / extension detectability | as documented (advisory hardening posture) | glm |
| webRequest for HTTP-auth (#141; `webRequest`/`webRequestAuthProvider`); default-on, disable via `handleHttpAuth: false`; credentials only via explicit popup selection | new, documented tradeoff | glm |

## Residual Observations

Hardening notes and inherent risks that did not reach the finding bar (or are disputed — see
F57L/F58L and `## Disagreements`).

| Residual | Provenance | Notes |
|---|---|---|
| F52C migration is advisory-only (old bootstrap vulnerable until manual upgrade; `BOOTSTRAP_VERSION` advisory popup) | glm | live residual of F52C; best mitigation w/o violating no-self-modification |
| F52C robustness rests on GPG status-fd %-escaping (verified 2.4.9; supported matrix ≥2.2.20) | both (kimi, glm) | consider validating extracted candidates against `^[0-9A-F]{40}$` + exact whitespace-token membership |
| `allowCredentials` jq assignment robustness (RB-2 reframed: add `\|\| true` guards + regression test) | kimi | host survives + fails closed under real dispatch (`set -e` suspended); direct-call rc=5 only outside dispatch |
| `collect_roots` symlink-cycle amplification bounded by kernel ELOOP (~40) | kimi | host-side DoS of itself only; stderr uncaptured, no crash |
| HTTP-auth 401 popup repeat-spam annoyance (30 s suppression) | kimi | parity with browser native dialog |
| popup port retains generic popup privileges after `#resolveAuthCallback` resolves | kimi | zero-cost tidiness; an authorised popup has those by design |
| F50I residual test-fidelity gaps (state-file symlink/fail-open, audit truncation, container isolation, hostile actions, packaging/manifest invariants) | both (kimi; glm covers parts) | defence-regression detectors, not live holes |
| extension_pages CSP has no `default-src` (`img-src`/`font-src`/`style-src` unpinned at the F18M boundary) | kimi | all current loads bundled; consider `default-src 'self'` |
| TOTP epoch uses Int32 shifts → wrong codes ~2043 | kimi | `src/js/helpers.js:55` |
| jq/Oniguruma vs JS `u`-flag regex dialect drift (host-side vs agent-side rule compilation) | kimi | config-author-controlled only |
| release/dev tooling: unsigned release tags, default-key dist signatures, Dockerfile `curl…\|bash` + `FROM ubuntu:latest`, CI tag-pinned (tests only) | kimi | dev-only, produces no shipped artifacts |
| SECURITY.md:173 references `security-reviews`; actual directory is `security-review` | kimi | documentation nit |
| Config-driven regex ReDoS (`rules[].pattern/strip`, `targets[].pattern/fallbackMatch`) | glm | redundant if attacker controls plaintext+.parcel.json; low-likelihood otherwise |
| In-memory plaintext not explicitly zeroed | glm | standard browser-PM tradeoff; value delivered to field by design |
| Origin message-supplied to host/audit log (F20M residual) | glm | correct under TM1; spoofable under TM2 (already compromised) |
| Micro-TOCTOU `validate_decrypt_path_policy` vs `gpg --decrypt` | glm | TM4; path must be whitelisted + swap must be valid GPG entry |
| `passkey` port has no host-side consent nonce | glm | TM2-subsumed by F40M posture (broadcast token strictly more powerful) |
| Schema prototype-key bypass (inert) / MetaSchema dead-recursion | both | disputed — tracked as findings F57L & F58L; see Findings + Disagreements |

## Methodology

- **Source reports:** `security-review/reviews/v1.0.6/kimi-k3.md` (model `kimi-k3`) and
  `security-review/reviews/v1.0.6/glm-5.2.md` (model `glm-5.2`), both dated 2026-08-19, against
  Parcel v1.0.6 (commit `03fec5a`, tag `v1.0.6`). Each completed both phases of the standard
  Parcel review protocol (independent review + cross-model verification). Both consulted only
  `findings.md` as prior-review context; neither opened the other's full report (only the phase-2
  findings-table exchange file, deleted post-finalisation per protocol §6).
- **Merge editor / date:** `glm-5.2`, 2026-08-19.
- **Scope:** release review (HEAD is at the `v1.0.6` tag — 0 commits ahead; working tree clean
  except the untracked `security-review/reviews/v1.0.6/` report directory).

This merge introduced **no new findings** and **changed no severities**. It assigned canonical
`F<N><S>` IDs continuing the global sequence from `findings.md` (which ended at F51 → F52–F58),
deduplicating so that a finding reported by both models carries one unique ID across all
locations. Where the two component reviews disagreed on severity (or finding-vs-residual), the
editor chose one severity letter for the canonical ID — never a compound form — and recorded the
unchosen position verbatim in `## Disagreements`; the editor did not adjudicate. Where the two
reports genuinely conflicted on a fact (notably the v1.0.5 reachability of the #144 forgery),
both statements are presented with attribution rather than one chosen.

## About This Merge

- **Merge editor model:** `glm-5.2`.
- **Source report filenames:** `security-review/reviews/v1.0.6/kimi-k3.md` and
  `security-review/reviews/v1.0.6/glm-5.2.md`.
- The committed `security-review/prompt.md` is the canonical record of both prompts; it is not
  embedded in this report.

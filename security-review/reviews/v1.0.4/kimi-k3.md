# Parcel Security Review — kimi-k3, against v1.0.4

Automated security review using Copilot / Kimi K3, conducted on 1 August 2026 against Parcel v1.0.4
(commit 9df096d, tip of `master` at review time).

> **Prompt:** This project is a password-management extension, intended to work with the 'pass' tool
> for the purposes of browser integration. Please provide a comprehensive security review of it,
> taking into account deliberate design decisions and tradeoffs. Notwithstanding other instructions
> in this project, do not use subagents. Please do a second-look review of your output file once you
> have created it. Be critical; is there anything you may have missed, or misinterpreted? Save the
> final review to security-review-kimi_k3-20250801-v1.0.4.md. Treat this as a living document; you
> may edit it throughout your review to ensure items are tracked correctly, and later findings are
> incorporated effectively. Once you have completed your review, perform an additional targeted
> review for each finding, and update the review document to take the outcome of that targeted
> review into account.

## 1. Scope and method

Reviewed the complete, canonical source tree (`src/`, repo-root `parcel-host` bootstrap, packaging
`Makefile`s, manifests, examples, tests). Generated bundles (`src/dist/`, `chrome/`, `firefox/`) were
hash-compared against source where relevant; they are build outputs and were otherwise not treated as
sources of truth.

Method:

1. Full read of the threat-relevant code: `parcel-host` (bootstrap), `src/parcel-host` (signed host),
   `src/js/agent.js` (MV3 service worker), `src/js/integration.js` (content script, incl. passkey
   ceremony orchestration), `src/js/popup.js` (toolbar/context/consent popup), `src/js/helpers.js`,
   `src/js/plaintext.js`, `src/js/schema.js`, `src/js/selectors.js`, `src/js/targets.js`,
   `src/js/webauthn.js`, `src/js/main-world/{shadow,webauthn}.js`, `src/manifest.json`,
   `src/html/popup.html`, `example/*`, `Makefile`s, `Dockerfile`.
2. Verified full test suite passes: `make test` → 394/394 pass.
3. Dynamically verified the headline finding with a native-messaging harness driving the real
   bootstrap host and signed-host script in an isolated HOME with a mocked GPG (same technique as
   `test/native-host.test.js`).

Threat model per `SECURITY.md`: (a) malicious/malicious-adjacent websites interacting with
content/MAIN-world scripts; (b) a fully compromised extension context (bounded by the host-side
whitelist, rate limiting, passkey content backstop, and signature checks); (c) local attackers; the
maintainers' own release pipeline is out of scope beyond signature verification.

Prior reviewed findings (`security-review/findings.md`) were used as background to avoid re-reporting
accepted risks; their full reports were not consulted (per project policy).

## 2. Overall assessment

The codebase is in good security shape. The layered design — host-side whitelist enforcement, GPG
signature verification of the host script, optional `HOST_HASH` pinning, per-action port allow-listing
in the service worker, host-side re-validation of symlink policy at decrypt time, a content-marker
backstop that makes passkey entries impossible to decrypt through the fill path, and
user-consent-gated passkey
ceremonies with host-side rpId binding — is coherent and, importantly, implemented at the correct
(trusted) side of each boundary. No CRITICAL or HIGH findings were identified. One MEDIUM and one LOW
new finding are reported, plus informational notes.

Deliberate, documented tradeoffs (default-allow-all without `.parcel.json`, bash host, hashing without
salt for history keys, warning-only iframe fills, extension detectability) were re-examined and are
accepted as consistent with the project's constitution; they are not re-litigated below except where
this review's findings interact with them.

## 3. Findings

### F35M — Decryption rate limiter is per-process and per-install; trivially reset by a compromised extension context (MEDIUM)

**Status: new**

**Description.** `src/parcel-host` implements the token bucket entirely in-process (the
`DECRYPT_BUCKET_TOKENS` / `DECRYPT_BUCKET_LAST` globals, initialised empty and filled to maximum on
first use). Two reset vectors exist:

1. **Re-install on the existing connection.** After a successful `install` action, `main()` returns 2,
   the bootstrap's outer loop re-`eval`s the host script, and the script's top-level assignments reset
   both bucket variables. `action_install` remains dispatchable for the life of the process (nothing
   removes it, and the signed script does not undefine it). Signature verification re-runs, but the
   attacker already possesses a valid script+signature pair: both are bundled inside the extension it
   has compromised (`dist/parcel-host`, `dist/parcel-host.asc`, fetched via `chrome.runtime.getURL`).
2. **Fresh native connections.** `chrome.runtime.connectNative()` is available to background and
   extension-page contexts (the two context types whose compromise the threat model cares about). Each
   connection spawns a brand-new host process with a brand-new, full bucket. An attacker needs only the
   bundled script + signature to bootstrap it — again, both shipped with the extension.

Both vectors were verified dynamically (see §5/§7): with `decryptBucket: 2` and a negligible refill
rate, the third decrypt on a fresh host returns "Decryption rate limit exceeded"; a repeated
`install` action on the *same* connection returns success and the next two decrypts succeed again;
and a completely fresh host process likewise decrypts twice before limiting.

Caveat noted for the maintainers' benefit: re-install on a live connection is an exercised,
test-covered capability ("installing a new host script can overwrite bootstrap functions",
`test/native-host.test.js`) that enables hot host-script updates, so recommendation 1 below is a
deliberate capability tradeoff, not a pure bugfix.

**Impact.** The documented control — `SECURITY.md` "Decryption rate limiting", intent: *"reducing the
potential damage in the event of a successful exfiltration attack"* — degrades from ~1
decryption/150 s to "spawn-rate × bucket-size". With the default 24-entry bucket, a compromised
extension can drain the entire visible store in seconds (bounded in practice by GPG passphrase-cache
and process-spawn speed), and user-noticeable side effects that would otherwise suggest abuse
(audit-log growth, time) no longer accumulate meaningfully. The host-side whitelist and the
passkey-entry protections are unaffected; the class-of-attack this control was created for is exactly
the class it fails to throttle.

Note this is strictly worse than prior finding "F23T — default burst ≥ typical store size" (accepted,
GLM 5.2 review dated 2026-06-25): even a user who explicitly configures a small bucket or relies on
the sustained rate gains no durable throttling against extension-context attackers. It also means the control is weaker
than it appears even in *benign* operation: every MV3 service-worker cold start / native disconnect
reconnect spawns a fresh host with a full bucket, so long-running throttling is effectively per-
session, not per-day.

**Recommendation.** Make the limiter state durable across installs and processes within a single user
session, or bind it to something the extension cannot reset at will. Options, cheapest first:

1. **Refuse re-install once installed.** After the first successful `install`, have the (bootstrap or
   signed) host answer subsequent `install` attempts for the same process with an error (a `INSTALL_DONE`
   flag in the bootstrap before `eval`, checked by `action_install`). This kills vector 1 at ~4 lines
   and also removes a state-reset surface (entry-list caches, config staging) more generally. It does
   not affect the legitimate flow, which installs exactly once per connection.
2. **Persist bucket state across process spawns.** E.g. serialise `DECRYPT_BUCKET_TOKENS`/`_LAST`
   alongside (or appended to) the log file at each decrypt, and restore at startup. Cost: the host
   gains another write target; integrity of that state file becomes relevant (an extension cannot
   write it — only local attackers can, who are out of scope). Moderate complexity in bash.
3. **Skinny alternative:** the bootstrap process owns the bucket (variables initialised in the
   bootstrap script, functions defined there and inherited by the signed script via `eval` scope).
   Re-install then no longer resets state, and vector 1 is closed without refusing re-install.
   Vector 2 (fresh processes) remains and needs option 2 to close fully.

Option 1 is recommended as a minimum; option 2 for full closure. Either way, `SECURITY.md`'s
description of the rate limiter should state its actual boundary (per native-host process) if
maintainers decide the residual risk is acceptable.

### F36L — Popup-driven `fill` message omits `origin`; the #106 destination-origin guard never applies to the primary fill path (LOW, defense-in-depth gap)

**Status: new**

**Description.** The fix for the previous F34M finding (mid-decrypt navigation exfiltrating a credential
to a different origin; PR #106) added a destination-origin check to the content script's `fill`
handler, gated on the message carrying an `origin` property:

```js
if (Object.prototype.hasOwnProperty.call(msg, "origin") && msg.origin !== window.location.origin) { throw ... }
```

The agent's fire-and-forget fallback path supplies `origin` (verified: `chrome.tabs.connect(tabId,
{ name: "broadcast", frameId: 0 })` posts `{ action: "fill", origin, config, plaintext }`). However the
*primary* fill path — the popup posting to its bound tab port — does not:

```js
// src/js/popup.js, "plaintext" handler (intent === "fill")
const delivered = tabPort.postMessage({ action: "fill", token, plaintext: msg.plaintext, config: await config });
```

No `origin` ⇒ `hasOwnProperty` is false ⇒ no check in `integration.js`. The same applies to
`fill-value` messages (detail-view line fills).

**Why this is LOW, not MEDIUM.** The scenarios that made the broadcast path exploitable are
structurally closed on the popup path: the toolbar popup is destroyed on tab navigation, and the
inline context popup lives inside the navigating page's DOM and is destroyed with it, so a pending
decrypt response is never processed after cross-origin navigation. bfcache restores preserve origin.
The residual value of adding `origin` here is defense in depth against *future* structural changes
(e.g. longer-lived popup surfaces, reconnect races in `reconnectingTabPort` re-targeting a re-navigated
tab/frame where token bindings are retained in the same-origin case) — the guard was clearly intended
to be general, and currently silently doesn't apply to the main path.

**Recommendation.** Include `origin: url.origin` (popup already computes `url` from `tab.url`) on both
`fill` and `fill-value` messages, and extend the content script to apply the check to `fill-value`
too (it has no origin concept today because the value has already been decrypted for display — the
risk profile differs, but the same "mid-flight re-targeting" argument applies). One-line-ish change;
existing tests in `test/integration.test.js` around the mismatch guard give the harness pattern.

### F37L — Dev-tooling supply-chain nit: `scripts/pre-commit-gitleaks` downloads and executes the *latest* unpinned gitleaks binary (INFO/LOW)

Opt-in (developer-installed) pre-commit hook, so not part of the shipped product — but it fetches
"latest release" from the GitHub API and pipes a tarball straight into `tar -xz` with no version
pin, checksum, or signature verification, on the very machines where maintainers hold release-signing
material and GPG keys. This sits uneasily with the project's strong anti-supply-chain posture
(`DEPS_INSTALL_CUTOFF` for npm, `--ignore-scripts`, constitution §1.3.1). Recommend pinning a gitleaks
version + SHA-256 in the script, or documenting that the hook is convenience-only. Impact requires a
compromised GitHub release/tag of gitleaks, and is confined to dev machines that install the hook.

### F38I — Documentation nit: stale port-action comment in `agent.js` (INFO)

The comment above `PORT_ACTIONS` says integration ports may request "`config`/`sha256`", but the map
grants integration ports `config` only. Code is the stricter of the two; aligning the comment removes
ambiguity for future readers of an auth-relevant allow-list. (`sha256` remains available to popup
ports, which is harmless: it is a hash oracle over attacker-known strings, no secrets.)

### F39T — In-page popup host element is fully page-stylable/removable (INFO, inherent; worth one line in SECURITY.md)

The inline popups (fill and passkey consent) are appended to the page's DOM; the shadow roots are
closed, but the page retains complete control over the host element: it can delete it (cancels the
ceremony via port disconnect — acceptable), set it `opacity: 0`, translate it off-screen, or bury it
under a z-index 2147483647 overlay and render a *look-alike* "Parcel" UI on top (the popup DOM and
styles are observable to the page at the shadow-host boundary, and the entire look is reproducible
from public sources). A user carefully verifying the origin displayed inside a consent popup can
therefore still be deceived by a spoofed overlay that covers it. This is an inherent limitation of
in-page credential UX (shared by mainstream password managers), not a Parcel implementation bug: the
fill path never acts without a user click, and passkey signing never happens without a consent click
inside the genuine extension-origin iframe. Recommend documenting the residual UI-spoofing
consideration in the tradeoffs table, noting that users who see an unexpected Parcel-looking surface
should cancel the popup and treat the site as hostile.

### F-5 — Reviewed and assessed as not exploitable / accepted-by-design (for the record)

The following candidate findings were investigated and discarded, with rationale:

- **`agent.js` popup-port authorisation via `broadcast` token.** Any Parcel context can adopt the
  `broadcast` token or add tokens via the `auth` port. These contexts are all Parcel-shipped code
  (extension pages and isolated-world content scripts); no page-realm JS can open runtime ports.
  The token mechanism binds a popup to an element binding; it is not relied upon against attackers
  that can already reach the agent. Consistent with boundary placement; not a finding.
- **Forged `parcel-webauthn-response` / `parcel-webauthn-request` DOM events.** A page can answer its
  own pending ceremony with fabricated data (only confuses the page itself; RP verifies server-side)
  or summon consent popups (rate-limited by the 2-dismissals/1 s guard). Origin/rpId are re-derived in
  the isolated world and re-bound to entry contents host-side. Accepted tradeoff, matches SECURITY.md
  analysis.
- **Config JSON consumed unsanitised by host (`decryptBucket` as non-integer etc.).** The config file
  is user-owned (and "Parcel cannot modify its own configuration" is enforced). Agent-side schema
  validation guards it; malformed bash-visible values at worst crash the host for that user
  (`set -e`), failing closed. Not attacker-reachable.
- **Entry names containing newlines through `action_list`'s line-based pipeline.** Misaligned
  transpose output degrades to parse failure or mangled names; injection of an arbitrary decryptable
  path into `ALLOWED_FILES` would require local filesystem write access, at which point the store is
  already fully attacker-controlled. Robustness wart only.
- **`passkey_op_create` consumes no decrypt budget.** It performs no decryption and returns only
  ciphertext encrypted to the user's own `.gpg-id` recipients; spam costs are bounded by the consent
  popup (one per user click). Not a finding.
- **Assertion `signCount` hard-coded to 0 and flags claiming UV.** Protocol-fidelity choice consistent
  with "software, multi-device" authenticator posture; relying parties that reject zero counters are
  a compatibility concern, not a security one (verification happens RP-side over the real signed
  values).
- **Bootstrap message-length endianness (`od -tx4`).** Over-parsing or byte-swap failure modes fail
  closed via the 16 MiB cap and jq parse errors. Portability note only.
- **Tokenless host messages set `TOKEN` to the string `"null"`.** Cosmetic protocol wart (affects only
  the error-path echo of token), no exposure.
- **`HOST_HASH` non-constant-time comparison / GPG details in logs / WAR breadth / history-key
  hashing / LOGFILE validation / directory-mode of `~/.config/parcel`.** All raised and answered in
  prior reviews (see `security-review/findings.md`); not re-reported.
- **ReDoS via user config/search regexes.** Previously reviewed, accepted (self-inflicted only,
  service-worker-transient).

## 4. Positive observations worth recording

- The passkey pipeline places every irreversible step (assertion signing, credential creation) behind
  host-side enforcement: rpId→entry binding, `allowCredentials` enforcement *before* signing,
  whitelist membership, symlink policy at decrypt time, and a content-marker backstop
  (`#!parcel-passkey ` prefix) that refuses plaintext disclosure even if classification rules misfire.
- The MAIN-world WebAuthn interceptor's lock/back-off behaviour (non-configurable accessors, no
  polling-around a foreign lock, conflict notice only where the user holds Parcel passkeys) is exactly
  the conservative shape appropriate for a page-realm shim.
- `Schema`-driven validation of config and bridge messages, and consistent `textContent` rendering of
  all store-derived and ceremony-derived strings in the popup (no `innerHTML` anywhere in `src/js`),
  hold up under review.
- Audit logging strips control characters and length-caps all fields; failure-path log content is
  host-defined constants.
- The origin guard from #106 is test-covered for both match and mismatch directions.

## 5. Verification summary

- `make test` (full suite incl. native-host integration with mocked GPG): **394/394 pass**.
- Dynamic PoC for F35M: harness spawns the real `parcel-host` bootstrap with an isolated HOME and a
  mock `gpg` (replicating the test-suite's approach); `decryptBucket: 2`, refill≈0. Transcript:
  `decrypt a → OK`, `decrypt b → OK`, `decrypt c → rate limit exceeded`, `install (repeat, same
  connection) → success`, `decrypt a → OK`, `decrypt b → OK`, `decrypt c → rate limit exceeded`,
  then a **fresh host process** (the state a new `connectNative` port yields) decrypts `a` and `b`
  before limiting. Both reset vectors demonstrated. Harness retained at
  `/tmp/parcel-poc/ratelimit-reset-poc.mjs` in the review environment (not part of the repository).
- Release-key fingerprints in `keys/` match `CONSTITUTION.md` §2.2 exactly. CI
  (`.github/workflows/ci-unit-tests.yml`) is `contents: read`, runs tests only, and publishes
  nothing — release packaging stays manual per the constitution.
- Source↔distribution parity spot-checked via SHA-256 (`src/` vs `src/dist/` and `chrome/`): the
  checked-in bundles in this working copy are stale relative to `src/` (they predate recent source
  edits per timestamps); they are build outputs regenerated by `make chrome|firefox`, so this affects
  nothing reviewed here, but release consumers should note parity is established at packaging time,
  not in the git checkout.

---

## 6. Second-look review (self-critique pass)

After drafting §3–§5, the whole draft was re-read against the code, hunting for misinterpretations,
missed areas, and over/under-claimed severity. Corrections made as a result:

1. **F39T factual fix.** The first draft claimed the page could reuse a *web-accessible* Parcel logo
   for spoofing. In v1.0.4 the WAR list contains no images (only `html/popup.html` and JS modules),
   and the claim was corrected to observable/reproducible styling generally. No change to the
   conclusion.
2. **F35M fairness caveat added.** Re-install on a live connection is an intentionally exercised
   capability (hot host-script updates, covered by a native-host test). Recommendation text now
   calls this out so maintainers weigh it explicitly.
3. **Date/reference fixes.** Prior "burst" finding attribution corrected to the 2026-06-25 GLM 5.2
   review; internal dates normalised to the actual system date (2026-08-01).
4. **New INFO finding F37L (gitleaks pre-commit hook)** surfaced — the hook fetches and executes the
   latest unpinned gitleaks release, which is inconsistent with the project's own supply-chain
   posture. Missed in the first pass because it is not part of the shipped product; included after a
   tooling sweep.
5. **Coverage check.** Confirmed every JS/HTML/manifest/shell file in `src/`, both host scripts,
   packaging, CI, `Dockerfile`, `example/` (flatpak wrapper, native-messaging manifests, demo store
   zip listing), `test/` (harness patterns), `.gitleaks.toml`, `eslint.config.js`, `CONTRIBUTING.md`.
   `src/css`, `src/img`, `src/ttf`, `branding/` contain no executable logic. `example/
   password-store.zip` was listed (synthetic demo store, no private key material) and dismissed.
   CI uses major-version-pinned first-party actions with read-only contents permission.

Areas specifically re-interrogated for possible misreads, with outcomes:

- *"Does the popup-driven fill path ever outlive a navigation?"* Re-checked: the browser-action popup
  is destroyed on tab navigation; the inline popup iframe is DOM of the navigating page. bfcache
  restores carry the same origin. F36L remains LOW (hardening), not an active exfiltration path.
- *"Can a page reach the `passkey`/`popup` ports?"* No: `chrome.runtime.connect` is unreachable from
  page realms; only Parcel's own isolated-world content scripts and extension pages hold it.
  `externally_connectable` is not declared. F-5 bullet retained.
- *"Does the passkey candidate list cross into the page realm?"* No: candidates travel only
  agent → content script → extension-origin popup iframe; the response CustomEvents to MAIN world
  carry only requestId/type/credential. Confirmed.
- *"Is F35M overstated because GPG passphrase entry already gates unattended decrypts?"* GPG-agent
  caching means unattended decrypts *are* the normal warm-cache case; throttling exactly that case is
  the control's stated purpose, so the reset vectors matter. Severity MEDIUM retained.
- *"Is the F35M 'strictly worse than F23T' comparison fair?"* Yes: F23T concerned defaults; F35M defeats
  even deliberately-hardened configurations (small bucket). Retained.

## 7. Targeted follow-up reviews (per finding)

Each finding above was subjected to a dedicated second pass with fresh verification work:

### F35M (rate-limiter reset)

- Grepped both host scripts: `DECRYPT_BUCKET_*` appears only in `src/parcel-host`; no persistence
  exists anywhere; nothing `unset`s or replaces `action_install` after eval. Confirms both reset
  vectors structurally, independent of the PoC.
- PoC re-run with the fresh-process vector added: transcript shows `decrypt` succeeding twice on a
  second, brand-new host process while the first connection's bucket remained exhausted ("bucket
  after second drain: Decryption rate limit exceeded"). This faithfully models what a compromised
  background/page context gets from simply calling `chrome.runtime.connectNative(
  "com.github.erayd.parcel")` itself with the bundled `parcel-host` + `parcel-host.asc`.
- Attack-chain sanity check (warm-cache assumption): a compromised extension context exfiltrating at
  spawn-rate (tens of installs per minute, each worth a full `decryptBucket` of plaintexts) exceeds
  the documented "≈24/hour sustained" rate by orders of magnitude. `auditDecrypt: true` would still record every entry,
  but the control's purpose — bounding the *amount* exfiltrated before detection — is not served.
  Recommendation and MEDIUM severity stand. Lowest-effort adequate fix confirmed viable against the
  loop structure: an `INSTALL_DONE` guard in the bootstrap's `action_install` (per-process) closes
  vector 1 without touching the hot-update test's semantics (that test uses one install per process).

### F36L (popup fill missing `origin`)

- Re-traced the exact message shapes in `src/js/popup.js`: the `plaintext`+`fill` handler and all
  `fill-value` posts omit `origin`; the content-script guard is presence-gated
  (`hasOwnProperty("origin")`). Confirmed only the agent fallback supplies it.
- Re-examined lifetime/teardown claims (browser-action popup dies on navigation; inline popup is
  page DOM; bfcache preserves origin) - no active exfiltration path identified; the finding stays a
  defense-in-depth gap at LOW. The fix is mechanical (`origin: new URL(tab.url).origin` on both
  message types + check in the `fill-value` branch).

### F37L (gitleaks hook)

- Re-read the script end-to-end: no version pin, no checksum/signature verification of the tarball;
  `curl | tar -x` into a directory on PATH; runs per-commit as the developer. Confirmed opt-in
  (manual `ln -sf` install). INFO/LOW stands. Note it is *not* wired into CI or release flow.

### F38I (stale comment)

- Verified the mismatch persists: comment says "`config`/`sha256`"; `PORT_ACTIONS.integration` is
  `["config"]`. One-line doc fix.

### F39T (UI spoofing)

- No further verification required beyond the corrected framing; remains informational.

### F-5 (discarded candidates)

- Each discarded item was re-checked against the cited acceptance rationale and code. No changes.

*Status of this document: final for v1.0.4. If F35M/F36L are actioned, the rate-limiter behaviour
change should be accompanied by a native-host test asserting that a second `install` on one
connection does not refill the bucket (harness pattern: `test/native-host.test.js`).*


# Parcel Security Review — v1.0.5 (kimi-k3)

Date: 2026-08-08 · Model: `kimi-k3` (kimi-k3-fast, operational suffix omitted) · Commit: `6b0f1a7` (tag `v1.0.5`, working tree clean — review covers exactly the tagged release).

## Executive Summary

Parcel v1.0.5 is in strong shape. All fifteen applicable prior fixes verified still present and effective; no regressions found. `make test` passes 407/407.

One **MEDIUM**, five **LOW**, and four **INFORMATIONAL** findings:

- The single most important takeaway: **the popup-port authorisation gate introduced to fix F20M is silently bypassable by any extension context** — a popup-named port authenticates with the literal string `"broadcast"` (agent.js:559), never issued or validated as a token. A compromised content script (no user gesture, no UI) can therefore drive silent `decrypt`/`match` of whitelisted entries with an attacker-chosen audit origin. The host whitelist and rate limiter still bound the blast radius, and the capability remains inside the documented "compromised extension" envelope — but the specific TM2 mitigation #69 claims to provide is not actually delivered. (F40M below.)
- Everything else is hardening: multi-signer signature-blob robustness, `passkeyDir` containment validation, Firefox's missing `ancestorOrigins` weakening the frame-id broadcast hardening, forged passkey-conflict modals, unbounded token-set growth, missing `rsync --delete` in packaging, and test-coverage gaps over already-fixed security gates.

Finding counts: C=0, H=0, M=1, L=5, I=4, T=0.

## Trust Model & Attack Surfaces

Components examined in full: `parcel-host` (bootstrap), `src/parcel-host` (signed main host), `src/js/{agent,integration,popup,helpers,plaintext,schema,selectors,targets,webauthn}.js`, `src/js/main-world/{shadow,webauthn}.js`, `src/html/popup.html`, `src/manifest.json`, both `Makefile`s, `scripts/`, and the full `test/` suite.

The trust-boundary hierarchy as it actually sits in the code:

1. **The native host is the only hard boundary.** The bootstrap (`parcel-host`) owns nothing but the verification chain and the message loop; the signed main host owns the whitelist, rate limiter, audit log, and all cryptography. My structural finding is that this boundary is *real*: whitelist evaluation, symlink policy revalidation at decrypt time, rpId/allowCredentials enforcement immediately before signing, and fail-closed verification all live host-side and cannot be reached around from the browser.
2. **The extension is soft tissue by design** — the documented model accepts that a compromised extension can read whitelisted entries. Within that, agent.js erects *advisory* gates (port-name allow-list, popup token auth) whose strength varies: the port-name gate is meaningful (port names are browser-checked… but see F40M), while the popup token check is undermined by a magic-string carve-out (F40M).
3. **The page realm is adversarial.** All MAIN-world↔isolated-world bridges are treated as untrusted in the current code; origin and rpId are re-derived isolated-side; consent is enforced by user interaction; and the host re-validates everything before signing. I confirmed no extension-JS-only path to a signature, a decryption of a non-whitelisted entry, or key material.
4. **Config files move trust, not attack surface**: `parcelrc` is code (0600-enforced); `.parcel.json` is data parsed by `jq` host-side with output sanitisation. The one seam I found is `passkeyDir` (F42L), where a config value feeds a containment check that assumes no `..` segments.

## Methodology

- **Model identity:** `kimi-k3` (running as kimi-k3-fast; suffix omitted per §0).
- **Documents read in full, in order:** `CONSTITUTION.md`, `SECURITY.md`, `README.md`, `security-review/findings.md`.
- **No prior full reviews accessed:** I did not open any file under `security-review/reviews/`. One incidental exposure: a repo-wide grep for `fill-value` returned three matched *lines* (plus context lines) from `reviews/v1.0.4/kimi-k3.md`. That content only restated F36L material already present in `findings.md`; I discarded it and based all reasoning on `findings.md` and the code. Recorded here per the hard-rule honesty requirement.
- **Source examined:** every file listed in §3 of the prompt except vendored `src/publicsuffix` (out of scope per AGENTS.md).
- **Tests run:** `make test` — 407/407 pass (includes native-host tests against an isolated HOME with mocked GPG, Chrome-API mock tests, schema/meta-schema tests).
- **Empirical verification:** bash regex-semantics test confirming the multi-`VALIDSIG` signer string fails closed (rejects a two-line fingerprint string); manual trace of `passkeyDir="../other"` through the `.gpg-id` walk; trace of the `"broadcast"` auth carve-out; trace of Firefox `ancestorOrigins` fallback.
- **Subagent allocation (consecutive, same model):** (1) native host + host-side constitution compliance; (2) extension JS + WebAuthn + popup; (3) manifest/build/tests + regression checks. Every reported finding below was independently re-traced by me against the code before inclusion; line numbers re-verified by direct file reads.
- **Limitations:** no live browser testing; GPG multi-signature blob construction reasoned from documented GnuPG status-fd output plus a shell-semantics test rather than a full end-to-end PoC; big-endian `od` length-prefix parse not testable here.

## Findings

| ID | Severity | Confidence | Area | TM | Title | file:line |
|---|---|---|---|---|---|---|
| F40M | M | High | agent.js | TM2 | Popup-port auth gate bypassable via literal `"broadcast"` token | src/js/agent.js:559 |
| F41L | L | High | parcel-host | TM5 | Multi-signer signature blob: signer extraction relies on fail-closed regex accident | parcel-host:158,165 |
| F42L | L | High | src/parcel-host | TM0/TM3 | `passkeyDir` not validated against `..`/absolute, weakening textual store containment | src/parcel-host:731,796 |
| F43L | L | High | integration.js | TM1 | Firefox lacks `ancestorOrigins`: frame-id broadcast falls back to `*`, and receiver applies no origin check | src/js/integration.js:163-173,139-144 |
| F44L | L | High | integration.js | TM1 | Page-forged `parcel-webauthn-conflict` event can surface a false conflict modal and evict genuine dismissal state | src/js/integration.js:1059-1110,1322 |
| F45L | L | High | Makefile | TM5 | `chrome`/`firefox` rsync lacks `--delete`; stale files ship if built outside the `release→clean` chain | Makefile:42,48 |
| F49I | I | High | agent.js, integration.js | TM1 | Unbounded growth of `#authorisedTokens` / `targetBindings` via synthetic clicks | src/js/agent.js:501,28; src/js/integration.js:686-716 |
| F48I | I | High | popup.js | TM4 | Unescaped `entry.path` interpolated into `querySelector` — store-controlled selector syntax errors break popup rendering | src/js/popup.js:1066 |
| F46L | I | High | src/parcel-host | TM4 | State-file `touch`/`chmod`/`>` follow symlinks; load-time check fails open to bucket reset | src/parcel-host:86-118 |
| F50I | I | High | tests | TM2 | Regression-test gaps over fixed security gates (audit caps, hostile action strings, popup-side origin assertion, container isolation) | test/native-host.test.js, test/popup.test.js |

### F40M — Popup authorisation gate bypassable by any extension context via the literal `"broadcast"` token

**Description.** The F20M fix (#69) introduced a port-name→action allow-list and a popup authorisation gate: `decrypt`/`match` are only available to `popup` ports that first authenticate with a correlation token minted by a genuine user click (`agent.js:501` adds tokens pushed by the content script's `auth` port; `agent.js:559-566` consumes them one-shot). However, the same auth branch accepts the literal string `"broadcast"`:

```js
if (message?.action === "auth" && (this.#authorisedTokens.has(message.token) || message.token === "broadcast")) {
```

`"broadcast"` is never added to `#authorisedTokens` — it is a compile-time constant usable by anyone who can open a port named `popup`. Port names are not browser-verified roles: `chrome.runtime.connect({ name: "popup" })` succeeds from *any* extension execution context, including a content script. The handler does not inspect `port.sender` for popup ports (`tabId` is taken verbatim from `message.tab.id`).

**Threat model(s).** TM2 — compromised content script (independently of popup/service-worker compromise). Also relevant to unnoticed malicious code introduction: this carve-out converts the #69 gate from "user-gesture-correlated" to "presence-of-a-magic-string".

**Evidence.**
- `src/js/agent.js:548-552` — `PORT_ACTIONS.popup` includes `decrypt`,`match`.
- `src/js/agent.js:559` — `message.token === "broadcast"` bypass.
- `src/js/agent.js:562-566` — `authorised = true` without token issuance or sender check.
- `src/js/agent.js:496-503` — additionally, any context can open a port literally named `"auth"` and push self-chosen tokens straight into `#authorisedTokens` (`port.onMessage.addListener((token) => this.#authorisedTokens.add(token))`), with no sender validation — a second, equivalent bypass of the same gate (corroborated independently in Phase 2 cross-review).
- `src/js/agent.js:592-601` — `decrypt` relayed to host with attacker-chosen `origin` (`{ path, intent, origin: message.origin }`), forwarded into the audit log host-side (`src/parcel-host:370-380`).

**Exploit scenario.** Attacker gains code execution in a Parcel content-script context (renderer bug / defence-in-depth scenario of TM2). From there:

```js
const p = chrome.runtime.connect({ name: "popup" });
p.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
p.postMessage({ action: "decrypt", path: "websites/bank.com/alice", intent: "fill", origin: "https://attacker.example" });
```

No user gesture, no popup UI, no token issuance. The host whitelist and token-bucket rate limiter still apply (24-entry burst, then ~1/150 s), and the capability to read whitelisted entries is explicitly inside SECURITY.md's "what a compromised extension can do" envelope — which is why this is not HIGH. What *is* lost: (a) the user-interaction binding that #69 was designed to provide (silent, UI-less exfiltration of the whitelisted set becomes possible from a content-script-only compromise); (b) audit-log forensic value, since `origin` is attacker-chosen and the audit trail is the control documented (in F24T's maintainer response) as the one that "survives a compromised extension".

**Severity note.** I rate this MEDIUM rather than HIGH: the bypass is reachable and confirmed, but the actor precondition is heavy, the gained capability is within the documented TM2 envelope, and two overlapping controls (host whitelist, persisted rate limiter) remain intact. If the maintainer considers the #69 gate a *documented* TM2 mitigation on par with the rate limiter, HIGH would be defensible; I flag the boundary explicitly rather than round silently.

**Recommended fix.** Remove the `message.token === "broadcast"` carve-out from the auth gate: mint a real one-shot token for the toolbar-popup path (e.g., issue on `action.onClicked`, deliver to the popup on open) and for the fire-and-forget fallback (have the originating authorised popup transfer a fresh single-use token into the fallback flow). Until then, at minimum record `port.sender` provenance in the audit-origin path so a forged `origin` is detectable.

### F41L — Multi-signer signature blob depends on fail-closed regex accident

**Description.** If a `parcel-host.asc`-style detached-signature blob ever contains **two** signatures (e.g., a supply-chain attacker appends a second signature+cert to the shipped blob, which `--include-key-block` makes mechanically straightforward), `gpg --verify` exits 0 and emits two `VALIDSIG` lines. `SIGNER="$(grep VALIDSIG <<< "$OUT" | cut -d' ' -f12)"` (parcel-host:158) then yields a newline-joined two-fingerprint string, and the containment match `[[ " $VALID_SIGNERS " =~ [[:space:]]$SIGNER[[:space:]] ]]` (parcel-host:165) rejects it only because a two-line literal can't appear inside the whitespace-padded signer list. I verified this fail-closed outcome empirically (bash regex RHS with embedded newline does not match). The control therefore works today, but its correctness rests on an emergent property (multi-line attacker-influenced data never matching) rather than an explicit single-signer assertion; a GnuPG status-format tweak or future refactor could change this silently.

**Threat model(s).** TM5 (supply chain / build integrity).

**Evidence.** `parcel-host:146-153` (verification), `parcel-host:158` (extraction), `parcel-host:165` (membership test).

**Exploit scenario.** None reachable today (fails closed — hence LOW). The concern is robustness of a TM5-critical control.

**Recommended fix.** Assert exactly one `VALIDSIG` line: `[ "$(grep -c '^\[GNUPG:\] VALIDSIG ' <<< "$OUT")" -eq 1 ] || fail`, and extract the fingerprint from that single line.

### F42L — `passkeyDir` lacks `..`/absolute-path validation, weakening textual store containment

**Description.** `passkey_op_create` rejects control characters and glob metacharacters in `passkeyDir` (`src/parcel-host:731`) and carefully rejects `..` in the *page-influenced tail* (`$RP_ID/<basename>`, `:744-748`), and the code comment at `:785-787` asserts every walk from `$STORE_ROOT/<anything>` passes through `$STORE_ROOT`. But `passkeyDir` itself may contain `..` or a leading `/`. With e.g. `"passkeyDir": "../other"`, `SUGGESTED="../other/<rp>/<file>.gpg"` passes the textual prefix check (`:740`), and the `.gpg-id` walk reads `<store>/../other/.gpg-id` — outside the store — because the containment test at `:796` (`[[ "$GPG_ID" != "$STORE_ROOT"/* ]]`) is purely textual and `$STORE_ROOT/../other/.gpg-id` *starts with* `$STORE_ROOT/`. Impact: recipient selection for the newly generated passkey entry is taken from an out-of-store `.gpg-id`, encrypting the new private key — displayed armored to the user — to attacker-influenced recipients *if* an attacker can also place that `.gpg-id`. The precondition chain (user sets a traversal-laden `passkeyDir` + attacker controls a sibling directory) is narrow, and `passkeyDir` is trusted config — hence LOW — but the inconsistency with the tail-side validation is a real (documentation/implementation-divergence-flavoured) gap; README also says "a `passkeyDir` containing literal `..` segments names entries the store scan can never list" without noting the create-side read outside the store.

**Threat model(s).** TM0 (documentation tension), TM3-adjacent (trusted-config edge), TM4 (hostile local filesystem as amplifier).

**Evidence.** `src/parcel-host:721` (read), `:731-735` (validation), `:740-748` (tail checks), `:782-799` (walk + textual containment).

**Exploit scenario.** `.parcel.json` sets `passkeyDir: "../x"`; attacker (or user accident) leaves `/home/user/x/.gpg-id` listing an attacker recipient; user registers a passkey on a site; the armored entry shown for saving is encrypted to the attacker's key as well as (or instead of) the store's.

**Recommended fix.** Reject `passkeyDir` values containing `..` path segments, a leading `/`, or a trailing `/`, at the same point as the control-char/glob check.

### F43L — Firefox: frame-id broadcast falls back to `postMessage("*")`; receiver has no origin check

**Description.** The F28T fix narrowed the `parcel-frame-id` broadcast to the top-level origin via `location.ancestorOrigins` (`src/js/integration.js:170-173`). `ancestorOrigins` is Chrome-only; on Firefox `ancestors?.length` is undefined and the code falls back to `"*"`, broadcasting the extension-internal `frameId` to whatever page occupies the top frame — including a cross-origin embedder, exactly the case the message exists for. The receiving listener (`:139-144`) also performs **no** origin or source-origin validation: it accepts any `parcel-frame-id` message whose `ev.source` matches some iframe's `contentWindow` and writes attacker-chosen `_parcelFrameId` onto that element. Traced impact: popup-position confusion (coordinates resolve through the forged iframe mapping) and minor cross-origin disclosure of a browser-internal frame id. Fill delivery is bound by per-element tokens, not coordinates, so no credential misdirection follows; popups being page-stylable is already accepted (F39T). Marginal impact keeps this LOW.

**Threat model(s).** TM1 (hostile page / hostile embedding page).

**Evidence.** `src/js/integration.js:163-173` (send side), `:139-144` (receive side), `:130-137` (coordinate resolution via `_parcelFrameId`).

**Exploit scenario.** On Firefox, page A embeds iframe B (different origin or not). B's Parcel frame announces its frameId with `"*"` — A learns it. Separately, A (or any frame) posts a forged `parcel-frame-id` naming an arbitrary number; a later legitimate popup trigger misplaces the inline popup relative to an attacker-chosen iframe.

**Recommended fix.** Prefer not to broadcast at all where `ancestorOrigins` is unavailable: the background worker already knows authoritative `sender.frameId`s; have the top frame query the agent for child-frame mappings instead of trusting DOM-delivered messages. Short of that, add `ev.origin === <expected child origin>` where knowable, and treat `_parcelFrameId` writes as hints never used for anything but cosmetic positioning.

### F44L — Page-forged `parcel-webauthn-conflict` event surfaces a false conflict modal

**Description.** `handlePasskeyConflict` (`src/js/integration.js:1059-1110`) is wired to the forgeable DOM event `parcel-webauthn-conflict` (`:1322`). Any page can `document.dispatchEvent(new CustomEvent("parcel-webauthn-conflict", {detail: …}))`; if the user holds rule-classed passkey entries for the site (checked via a real `candidates` round-trip) and the per-frame flag/`per-origin dismissal` don't already suppress it, a genuine-looking modal appears claiming another extension owns passkeys on this origin. Outcomes: (i) UI spoofing consistent with F39T-class inherent risk; (ii) if the user clicks "Don't show again", the dismissal persists for that origin, suppressing *genuine* conflict notices; (iii) dismissal state is a 1000-entry map with eviction, so a determined site with user interaction across origins could churn it. The event alone carries no signature/decryption consequence — the ceremony path itself re-derives everything isolated-side — so LOW.

**Threat model(s).** TM1.

**Evidence.** `src/js/integration.js:1322` (listener), `:1059-1110` (handler; only checks `passkeyConflictShown`, config gates, dismissal state, and candidate existence).

**Exploit scenario.** A nuisance/ phishing-adjacent page repeatedly warns the user that "Parcel passkeys are unavailable here," optionally training the user to click through real Parcel modals, or hiding real conflict notices behind a forged dismissal.

**Recommended fix.** Treat the early-boot DOM marker (`data-parcel-webauthn-conflict`, already used at `:1325-1327`) as the authoritative signal: have the MAIN-world interceptor set it, have the handler require it to be present (and consume it), and ignore bare runtime events — a page forging the attribute can only do so in its own frame before first read, sharply narrowing the window.

### F45L — Packaging rsync lacks `--delete`

**Description.** `Makefile:42` / `:48` sync `src/dist/` into `chrome/` / `firefox/` with `rsync -av` and no `--delete`, and neither target cleans its destination. Files removed or renamed in `src/` between manual `make chrome`/`make firefox` invocations remain in the shipped tree. The `release` target happens to be safe because it depends on `clean` (`Makefile:64`), but that coupling is implicit; a developer running `make chrome` directly after a source reshuffle — the exact flow the README documents for source installs — can ship phantom JS, weakening the source↔distribution parity guarantee in SECURITY.md §3.

**Threat model(s).** TM5.

**Evidence.** `Makefile:41-49` vs `:63-64`.

**Exploit scenario.** `js/targets.js` is refactored away; a maintainer runs `make chrome` (not `make release`); the stale `targets.js` persists in `chrome/`. No code path references it, so nothing executes — but the shipped artifact diverges from the repo and any future file-name reuse could resurrect stale logic.

**Recommended fix.** `rsync -av --delete src/dist/ chrome/` (and firefox); removes the reliance on `release→clean` ordering.

### F49I — Unbounded `#authorisedTokens` / `targetBindings` growth via synthetic clicks

**Description.** Every click on a fill-target element mints a UUID token, pushed over the `auth` port into `#authorisedTokens` (`agent.js:501`), which is only deleted on successful popup auth (`:562`). A hostile page can synthesize clicks on generated inputs (debounce is per-element), growing the set without bound while the page lives; mirrored by `targetBindings` in the content script. No secret exposure; transient extension memory pressure cleared on restart/unload. INFORMATIONAL (DoS-self-class, akin to F12T's accepted posture).

**Evidence.** `src/js/agent.js:28,501,559-562`; `src/js/integration.js:686-716`.

**Fix.** Cap/expire the set (time-based reaping, or size cap with oldest-evict).

### F48I — Unescaped `entry.path` in `querySelector`

**Description.** `popup.js:1066` — ``ul.querySelector(`li[data-path="${entry.path}"]`)`` interpolates store-controlled `entry.path` without `CSS.escape`. A path containing `"` throws `SyntaxError`, breaking that render pass of the match list. All *rendering* sinks are safe (`textContent`/`createTextNode` throughout; zero `innerHTML`-class usage verified). Attacker needs password-store write access ⇒ INFORMATIONAL under TM4.

**Fix.** `CSS.escape(entry.path)` or track `<li>`s in a `Map` keyed by path.

### F46L — State-file writes follow symlinks; load-time symlink check fails open to bucket reset

**Description.** `load_state` (`src/parcel-host:86-89`) `touch`+`chmod`s the state file when missing; `save_state` (`:117-120`) writes via `>` and `chmod` — all symlink-following. A pre-planted `state → /target` symlink is *detected* at load (the `find -type f -perm 0600` identity check fails for symlinks) but the failure mode is a deliberate fail-open full-bucket reset (`:93-103`, confirmed at `:405-410` — empty state initialises to a full burst). The same fail-open applies to *any* unloadable state: a same-UID hostile process can `chmod 644`, corrupt, or delete the state file to force a fresh 24-token burst on every host start, softening the persisted-rate-limit guarantee from F35M's fix. Writes on the symlink path would clobber the target with two numeric lines. All preconditions require same-UID local filesystem access (TM4), which already implies far stronger primitives; no browser-reachable path (TM1–TM3) can touch the file. Noted for constitution-compliance completeness (writes must be confined to the four sanctioned objects) and as a documented design soft spot rather than an exploitable finding.

**Fix.** Guard with `[ -e "$STATEFILE" ] && [ -L "$STATEFILE" ] && rm -f` only under an ownership check, or switch save to temp-file + `mv -n`; consider fail-closed (refuse decryption) on symlink detection rather than fail-open.

### F50I — Regression-test gaps over fixed security gates

**Description.** Four fixed gates lack adversarial regression coverage: (a) audit-log **field-length caps** (F10L/F14L fix at `src/parcel-host:379-380`) — sanitization is tested (`test/native-host.test.js:1188`) but truncation never asserted; (b) the action-regex gate (F31L fix at `parcel-host:202`) — the only negative test sends pure-alpha `nonexistent`, never hostile syntax (`"decrypt; x"`, newline, `$(…)`); (c) the F36L primary-fill-path origin — popup tests never assert the forwarded `origin` field (`test/popup.test.js:434`), so silently dropping it would pass; (d) per-container history keying is computed but never exercised across two container IDs. All four are defence-regression detectors, not live holes — INFORMATIONAL.

**Fix.** One adversarial test each: >4 KB origin → assert truncation; hostile action strings → assert "Invalid host action" and no side effects; popup test posting `{action:"origin"}` then asserting forwarded fill origin; two-container fill asserting distinct history keys.

## Regression Checks

All entries verified against the current tree (code citations gathered during review):

| Ref | Verdict |
|---|---|
| F1M (temp keyring) | Fixed, present — `parcel-host:132-154` (`mktemp` keyring, `--no-default-keyring --keyring`, `GNUPGHOME=/dev/null`, cleanup both paths). |
| F2M (audit control-char strip) | Fixed, present — `src/parcel-host:375-378`, `:539-541`. |
| F5T hardening (#50, 0600 parcelrc) | Present — `parcel-host:81-84` find-based `-perm 0600` identity check, refuse else; template written `chmod 0600` (`:78`). |
| F9L (sha256 after parcelrc) | Present — `. "$PARCELRC"` `:89`, `SHA256=` resolution `:99`. |
| F10L/F14L (audit caps) | Present — `src/parcel-host:379` (128/1024/1024/4096). Untested caps → F50I. |
| F17L (symlink policy before traversal) | Present — `collect_roots` gates root admission on `allowLinks` before any traversal (`:160-178`); `find -H` never dereferences internal links; decrypt-time revalidation `validate_decrypt_path_policy` closes list↔decrypt TOCTOU. |
| F18M (CSP directives) | Present — `src/manifest.json` CSP includes `connect-src 'none'; frame-src 'none'; base-uri 'self'`; Firefox rewrite doesn't touch CSP. |
| F19M (MV3 lifecycle) | Present — `onStartup`/`onInstalled` → idempotent `#ensureNativeConnected()` (`agent.js:73-104`). |
| F20M (port action allow-list) | Present but partially undermined by the `"broadcast"` carve-out → F40M (new finding). Gate itself: `agent.js:548-584`. |
| F22L (HOST_HASH exact bytes) | Present — `parcel-host:175` hashes `jq -rj '.script'` bytes identical to on-disk file. |
| F25T (logfile 0600) | Present — `parcel-host:93`. |
| F29L (quoted `$SHA256`) | Present — `parcel-host:175` `"$SHA256"`. |
| F30L (no gpg status leak) | Present — `$OUT` to fd5 log only (`parcel-host:146-153`); extension gets generic error. |
| F31L (action regex gate) | Present — `parcel-host:202` `^[a-zA-Z0-9_]+$` before dispatch. Test gap → F50I. |
| F34M (broadcast origin check) | Present — `integration.js:1439-1443` presence-gated strict equality; popup always supplies origin; broadcast fallback supplies origin (`agent.js:613`). |
| F35M (persisted token bucket) | Present — `load_state`/`save_state` via `STATEFILE` (`src/parcel-host:84-120`), kill-reconnect no longer resets; content whitelist-validated before `eval`. |
| F36L (popup fill carries origin) | Present — `popup.js:669,1175`; test gap → F50I. |
| F37L (gitleaks pinned) | Present — `scripts/pre-commit-gitleaks` pins version 8.30.1 + per-platform SHA-256 map, aborts on mismatch. |
| F38I (comment) | Present — comment now matches allow-list (`agent.js:544-547`). |

No fix was found reverted, bypassed, or undermined by later changes (with the deliberate-exception noted in F40M, which is a gap *in* the original fix rather than a regression of it).

## Deliberate Tradeoffs

Re-examined against the current tree: F3T (policy-level no-network), F4T (default-allow-all), F6T (warning-only cross-origin fill — `alert()` path at `popup.js:671-678` still warning-only, as documented), F7T/F26T (WAR scope; the WAR JS modules are genuinely needed for Firefox's `integration.es6.js` dynamic-import shim and popup module loading), F8T/F27T (unsalted history hashes; code matches docs), F12T (search ReDoS), F13T (MAIN-world shadow patch), F15T (uncapped assembled log line), F16T (dir-mode check), F21T (backup keys in default `VALID_SIGNERS` — still hard-coded at `parcel-host:94`), F23T (burst 24), F24T (unvalidated LOGFILE), F28T (forgeable in-page bridges; F43L notes the Firefox gap in its partial fix), F32T (non-constant-time compare), F33T (config disclosure to integration ports — still returns full config), F39T (page-stylable popup).

All acceptance rationales still hold; none contradicted by the implementation except as noted in F43L (which is a *coverage gap* in F28T's narrowing, not a contradiction of the accepted core) and F42L (README's `..` statement is accurate for listing but silent about the create-side read — mild TM0 divergence recorded inside F42L rather than as a separate finding).

## Residual Observations

- **`od`-based length-prefix parse** in the bootstrap message loop (`parcel-host:188-191`) assumes host endianness; big-endian systems would misparse message lengths. Correctness, not security.
- **`fill-value` origin** — F36L's rejected half. I independently re-derived the rejection rationale: `fill-value` values originate from plaintext the popup already legitimately obtained; the only injection point is the popup itself (already trusted with the plaintext). No new exploit path; the maintainer's rejection stands.
- **Inline popup in page DOM** — inherent to the design (F39T); combined with F43L/F44L, UI-confusion is the recurring low-grade theme of this release.
- **`.gpg-id` `#` truncation** (`RECIPIENT="${RECIPIENT%%#*}"`) — comment markers in `.gpg-id` are stripped per pass convention; no trust boundary crossed (recipients are public keys; config is trusted).
- **Plaintext lifetime in popup** — detail views retain plaintext in DOM/JS until dismissed; acceptable for a local popup; a "clear on idle" hardening could be considered.
- **Toolbar-popup `match` with arbitrary `url`** — an authorised popup may search under a fabricated URL, affecting only its own view; no boundary crossed.

## Things Done Well

- **Bootstrap verification chain** is genuinely fail-closed on every branch I traced: temp keyring with `GNUPGHOME=/dev/null` keyboxd workaround, fingerprint extraction, signer membership, exact-byte HOST_HASH, and gpg diagnostics confined to the log — with the generic error to the extension.
- **Rate-limiter hardening** post-F35M is exemplary: state content whitelist-validated *before* `eval`, 0600 pinned on load *and* save, numeric-only, kill-reconnect resistant — verified by dedicated tests including four malicious-state-file scenarios.
- **Passkey host-side enforcement**: rpId equality, `allowCredentials` presence-array check, ES256 pin, `#!parcel-passkey` marker, and per-field validation all applied immediately before signing; private key never leaves process-substitution pipes.
- **Zero XSS sinks**: exhaustive check — no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval`/`new Function` anywhere in `src/js`; all store-controlled rendering goes through `textContent`/`createTextNode`.
- **Origin validation is layered and fail-closed on every fill path** (popup fill, broadcast autofill, mid-decrypt navigation) — the F34M/F36L fixes are real and effective.
- **WebAuthn interception discipline**: non-configurable first-come install with complete back-off, Permissions-Policy checked in the isolated realm, popup-spam guard, hint sanitisation, and bridge treated as untrusted with isolated-side re-derivation.
- **Test suite** is strong: 407 tests with isolated GPG mock, real `sha256sum` hash-basis tests, symlink-policy and TOCTOU coverage, forged-bridge-event tests, meta-schema validation of all defined schemas.
- **Supply-chain posture**: zero runtime deps, `--ignore-scripts --before <cutoff>` dev installs, pinned+hashed opt-in gitleaks hook, prettier as the only source transformer with `--check` gating.

## Cross-Model Verification

Phase 2 completed against `deepseek-v4`'s exchange table (`security-review-table-deepseek-v4-20260808-6b0f1a7.md`, four entries). I re-derived each from the code independently; their full report was never read.

| Their ID | Their rating | My verdict | Outcome |
|---|---|---|---|
| F46L | LOW (TM4) — state-file fail-open lets a same-user process reset the bucket | **Confirmed reachable behaviour; severity disagreement — I keep INFO (F46L).** F46L now broadened to note that *any* unloadable state (chmod, corruption, deletion, symlink), not only a planted symlink, forces a full-bucket reset (verified at `src/parcel-host:93-103` + `:405-410`). **Disagreement rationale:** the rate limiter is a documented TM2 mitigation, but the bypass precondition is a same-UID filesystem actor (TM4); that actor class cannot turn this into plaintext without an extension channel, and a same-UID attacker already holds stronger primitives (delete the state file → same effect). It is a genuine softening of a defence-in-depth property and deserves a fix (fail-closed or per-cycle cap), but no trust boundary is crossed — deepseek-v4 rates it LOW as a hardening opportunity; I rate INFO as a documented-softness note. Happy to converge on LOW if the maintainer treats the bucket-persistence guarantee as a TM4 promise. | Merged into F46L |
| F40M | LOW (TM2) — port-auth gate self-issuable via `"auth"` port or `"broadcast"` literal | **Confirmed and merged into my F40M; severity disagreement — I keep MEDIUM.** Their finding independently corroborates F40M and adds a second bypass route I had under-weighted: self-chosen tokens pushed over a self-opened `"auth"` port (`agent.js:496-503`), in addition to the literal `"broadcast"` carve-out. **Disagreement rationale:** under the prompt's TM2 scope rule, a gap remains a finding when it defeats a control specifically established as a TM2 mitigation — here the #69 port-gate fixing F20M. The bypass converts user-gesture-bound decryption into silent, UI-less decryption within the documented envelope; rate limiter and whitelist remain as overlapping controls. deepseek-v4's LOW presumably weights the documented envelope more heavily; I weight the defeated mitigation and the audit-origin forgery more heavily. Both readings are stated here so the merge editor can adjudicate. | Merged into F40M |
| F47L | LOW, confidence Low (TM3) — `action_changes_since` continues after rejecting an invalid `.since` | **Reproduced as a logic flaw; not reproduced as a security finding.** Verified: `parcel_error "Invalid timestamp"` (`src/parcel-host:230`) lacks a `return`/exit; because the shell was entered via a function called from an `if !` condition, `set -e` is suppressed, so execution continues into `date -d` → empty `SINCE` → `find -newermt ""` errors → the pipeline yields nothing → host replies `{"changes": 0}` *after* the error. No quoting/injection consequence (`-newermt` argument is a literal assignment, quoted). Net effect: a malformed `since` produces error + conservative `changes:0`. This is a robustness nit with no security impact; per the reachability rule it belongs in Residual Observations (added there), not in Findings. I disagree with its LOW severity label in a security context. | Non-reproduction (as security finding); logged residual |
| F51I | INFO (TM1) — `fill-value` + `frameOrigin`-undefined edge can skip the destination-origin guard | **Partially dedup'd, partially reproduced.** The `fill-value` half is the maintainer-rejected half of F36L — re-reporting it is excluded by the dedup rule. The `frameOrigin`-undefined half is real but benign: `popup.js:1175` always includes the `origin` key with value `frameOrigin`; if the `origin` handshake message never arrived, the serialised message drops the `undefined` value, the presence gate at `integration.js:1443` passes — but the fill still requires the per-element token binding on the destination content script, which a mid-decrypt navigated frame does not possess (fresh script, no binding). Rating INFO with the same reasoning; not added to my findings table as a new item. | Non-addition; noted |

No entirely-new confirmed findings entered my report from the exchange file; my two merged findings (F40M, F46L) gained stronger evidence. Both exchange files were deleted after finalisation.

### Residual added from cross-review

- `action_changes_since` missing early-return after invalid-`since` rejection (`src/parcel-host:227-232`): emits the error then answers `{"changes": 0}`. Harmless but misleading double-reply; worth a `return 0` for cleanliness. Non-security.

## Second-Look Review

Adversarial re-read of this draft:

- **Reachability discipline:** every finding above has a traced scenario. F41L's scenario *fails closed today* — it is included (as LOW) as a robustness gap in a TM5-critical control, with the fail-closed evidence stated; if the merge editor prefers, it could move to hardening. F42L requires a narrow config+filesystem precondition — stated. F43L/F44L impact is UI-level only — stated.
- **Checklist coverage, item by item:** bootstrap chain ✔ (F41L + regressions); whitelist evaluation ✔ (clean); path/symlink handling ✔ (clean, F46L for state file); action dispatch ✔ (gate verified, test gap F50I); rate limiter ✔ (F46L fail-open noted); audit log ✔ (caps present, F40M notes origin trust); passkey crypto ✔ (clean; F42L adjacent); host constitution compliance ✔ (grep for network primitives — none; writes confined); agent.js lifecycle/auth/allow-list ✔ (F19M regression ok; F40M); integration.js origin validation ✔ (all fill paths traced, clean); MAIN-world necessity ✔ (shadow.js and webauthn.js both require page-realm presence; nothing extraneous found in MAIN world); popup XSS/lifetime/history ✔ (F48I; history accepted per F8T/F27T); shared modules/config injection ✔ (schema `format:"regex"` gates verified; plaintext.js edge cases produce wrong-output-at-worst on user's own store); manifest/CSP/WAR ✔ (F18M verified; no divergence in Firefox rewrite); tests ✔ (F50I).
- **Unverified assumptions:** the GnuPG two-`VALIDSIG` output shape is from documented status-fd behaviour, not a locally-built double-signed blob; the Firefox `ancestorOrigins` absence is well-documented platform fact, not re-tested in a live browser here. Both flagged Medium-confidence implications, High-confidence code facts.
- **Tradeoff misattribution check:** cross-checked every candidate against the tradeoffs table; F43L deliberately framed as a *fix-coverage gap*, not a re-report of F28T; no accepted tradeoff is re-reported as a finding.
- **jq call sites / unquoted vars / dispatch paths:** all bootstrap and host `jq` extractions use `<<<` here-strings into `jq`, never string-interpolated programs; the two historic unquoted-var sites (F29L) verified fixed; the single dispatch path carries the regex gate.
- **Origin validation on every path:** popup fill (`popup.js:1175` → `integration.js:1443`) ✔; broadcast autofill (`agent.js:613` → `integration.js:1443`) ✔; mid-decrypt navigation (fresh content script lacks token binding; port reconnect yields no mapping — fails closed) ✔; `fill-value` — accepted maintainer rejection re-derived ✔.
- **Severity consistency:** only C/H/M/L/I letters used. The one boundary call is F40M (M vs H) — the reasoning is stated inline; I would defend M on "within documented envelope + two overlapping controls intact", and present the H argument rather than hide it. Confidence: F40M High (code-verified); F41L High (shell-verified) / confidence in exploit-impossibility High; F42L High; F43L High code / Medium platform-assumption; F44L High; F45L High; F49I–F50I High.
- **Prior-review access:** none opened; incidental grep-hit disclosed in Methodology.
- **Evidence that would change any verdict:** a demonstration that `port.sender` distinguishes popup contexts from content-script contexts in a way Chrome/Firefox guarantees would downgrade F40M; a working double-signature acceptance PoC would upgrade F41L to H.

## About This Review

Model: `kimi-k3` (kimi-k3-fast) · Date: 2026-08-08 · Commit ref: `6b0f1a7` · Tag: `v1.0.5` (tree clean; review covers the tagged release exactly). The committed `security-review/prompt.md` records what was prompted.

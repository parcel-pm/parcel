# Security Review — Parcel v1.0.5 (merged)

Merge of two independent phase-2 security reviews conducted against Parcel v1.0.5 (commit `6b0f1a7`, tag `v1.0.5`, working tree clean; release review). Both source models independently verified `make test` → 407/407 pass and independently re-derived each finding from the code before finalising. This document is a derived artifact: the two per-model reports remain the primary sources.

## Executive Summary

Parcel v1.0.5 is in strong shape. All fifteen applicable prior fixes were verified still present and effective by both models; **no regressions were found**. The native-host enforcement boundary holds: the extension cannot read non-whitelisted files, cannot obtain passkey private keys, and the rate limiter now survives process restarts. Zero third-party runtime dependencies, a signature-verified bootstrap, host-side whitelist/symlink/rpId re-validation, zero HTML-based XSS sinks across `src/js`, and a 407-test suite (including isolated-GPG native-host and adversarial state-file scenarios) are the recurring strengths both reviews highlight.

No CRITICAL or HIGH reachable vulnerabilities were identified. The merged review records **1 MEDIUM, 7 LOW, 4 INFORMATIONAL** findings (12 canonical IDs).

**Single most important takeaway.** The popup-port authorisation gate introduced to fix F20M (#69) is silently bypassable by any extension context. A popup-named port authenticates with the literal string `"broadcast"` (`src/js/agent.js:559`) — never issued or validated as a token — and the `auth` port accepts any caller-supplied token into `#authorisedTokens` with no sender validation (`agent.js:496-503`). A compromised content script (no user gesture, no popup UI) can therefore drive silent `decrypt`/`match` of whitelisted entries with an attacker-chosen audit `origin`. The host whitelist and token-bucket rate limiter still bound the blast radius, and the capability remains inside the documented "compromised extension reads whitelisted entries" envelope — hence MEDIUM — but the specific TM2 mitigation #69 claims to provide is not actually delivered. (F40M below.)

**Finding counts by severity:** C=0, H=0, M=1, L=7, I=4, T=0.

**Finding counts by provenance:**

| Provenance | Findings | IDs |
|---|---|---|
| Found independently by both models | 8 (no severity dispute) | F41L, F42L, F43L, F44L, F45L, F49I, F50I, F40M |
| Found by both models, severity disputed | 2 | F46L (kimi=I / deepseek=L), F48I (kimi=I / deepseek=L) |
| Found by deepseek-v4 only — disputed by kimi-k3 (moved to residual) | 1 | F47L |
| Found by deepseek-v4 only — acknowledged by kimi-k3 as benign (not filed separately) | 1 | F51I |
| Found by kimi-k3 only | 0 | — (all kimi-k3 findings were confirmed by deepseek-v4) |

Every kimi-k3 finding (F1M, F2L–F6L, F7I–F10I) was independently confirmed by deepseek-v4 in cross-verification. deepseek-v4's two additional items (DV4-F3, DV4-F4) were either disputed as non-security (DV4-F3 → F47L) or acknowledged-but-not-filed as benign (DV4-F4 → F51I) by kimi-k3.

## Findings

| Canonical | Sev | Provenance | kimi-k3 ID | deepseek-v4 ID | Area | Title |
|---|---|---|---|---|---|---|
| F40M | M | both models | F1M | DV4-F2 | agent.js | Popup-port auth gate bypassable via `"broadcast"`/self-issued token |
| F41L | L | both models | F2L | DV4-F5 | parcel-host | Multi-signer signature blob: signer extraction relies on fail-closed regex accident |
| F42L | L | both models | F3L | DV4-F6 | src/parcel-host | `passkeyDir` not validated against `..`/absolute; textual `.gpg-id` containment bypassed |
| F43L | L | both models | F4L | DV4-F7 | integration.js | Firefox lacks `ancestorOrigins`: frame-id broadcast falls back to `*`, no receive-side origin check |
| F44L | L | both models | F5L | DV4-F8 | integration.js | Page-forged `parcel-webauthn-conflict` surfaces false modal, can suppress genuine notice |
| F45L | L | both models | F6L | DV4-F9 | Makefile | `chrome`/`firefox` rsync lacks `--delete`; stale files ship on ad-hoc builds |
| F46L | L | both models (severity disputed — §Disagreements) | F9I | DV4-F1 | src/parcel-host | State-file fail-open lets a same-user process reset the rate-limiter bucket; writes follow symlinks |
| F47L | L | deepseek only — disputed by kimi (§Disagreements) | — | DV4-F3 | src/parcel-host | `action_changes_since` does not abort after rejecting an invalid `.since` |
| F48I | I | both models (severity disputed — §Disagreements) | F8I | DV4-F11 | popup.js | Unescaped `entry.path` in `querySelector` — store-controlled selector render break |
| F49I | I | both models | F7I | DV4-F10 | agent.js, integration.js | Unbounded `#authorisedTokens`/`targetBindings` growth via synthetic clicks |
| F50I | I | both models | F10I | DV4-F12 | tests | Regression-test gaps over fixed security gates |
| F51I | I | deepseek only — acknowledged by kimi (not filed) | — | DV4-F4 | integration.js, popup.js | `fill-value` and `frameOrigin`-undefined edge skip the destination-origin guard (no reachable scenario) |

### F40M — Popup authorisation gate bypassable by any extension context via the `"broadcast"` token / self-issued `auth` token

**Provenance:** both models. **Source IDs:** kimi-k3 F1M (M); deepseek-v4 DV4-F2 (M, upgraded from Phase-1 LOW after cross-verification re-derivation).

**Description (consolidated).** The F20M fix (#69) introduced a port-name→action allow-list and a popup authorisation gate: `decrypt`/`match` are only available to `popup` ports that first authenticate with a correlation token minted by a genuine user click. However, the same auth branch accepts the literal compile-time string `"broadcast"`, which is never added to `#authorisedTokens` and is usable by anyone who can open a port named `popup`. Port names are not browser-verified roles — `chrome.runtime.connect({ name: "popup" })` succeeds from any extension execution context, including a content script — and the handler does not inspect `port.sender` for popup ports (`tabId` is taken verbatim from `message.tab.id`). deepseek-v4 independently corroborated this and surfaced a second, equivalent bypass route under-weighted by kimi-k3: any context can open a port literally named `auth` and push self-chosen tokens straight into `#authorisedTokens` (`port.onMessage.addListener((token) => this.#authorisedTokens.add(token))`) with no sender validation.

**Threat model(s).** TM2 (compromised content script, without service-worker compromise). Also relevant to unnoticed malicious-code introduction: the carve-out converts the #69 gate from "user-gesture-correlated" to "presence-of-a-magic-string".

**Evidence (`file:line` from both reports).** `src/js/agent.js:559` — `message.token === "broadcast"` carve-out (kimi-k3); `src/js/agent.js:548-552` — `PORT_ACTIONS.popup` includes `decrypt`,`match`; `src/js/agent.js:562-566` — `authorised = true` without token issuance or sender check; `src/js/agent.js:496-503` — `auth` port self-issuance with no sender validation (deepseek-v4, corroborated by kimi-k3 in phase 2); `src/js/agent.js:592-601` — `decrypt` relayed with attacker-chosen `origin` (`{ path, intent, origin: message.origin }`), forwarded into the audit log host-side (`src/parcel-host:370-380`). deepseek-v4 additionally notes the worker's only `port.sender` uses are for the `trigger`, `integration`, and `popup-bridge` paths (`agent.js:508, 628, 745-765`), none of which gate popup auth — so a content-script-initiated `popup` port (whose `sender.tab` is set) is treated identically to a real toolbar-popup port.

**Exploit scenario.** A compromised `integration.js` (renderer bug / defence-in-depth TM2 scenario):
```js
const p = chrome.runtime.connect({ name: "popup" });
p.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
p.postMessage({ action: "decrypt", path: "websites/bank.com/alice", intent: "fill", origin: "https://attacker.example" });
```
No user gesture, no popup UI, no token issuance. The host whitelist and token-bucket rate limiter still apply (24-entry burst, then ~1/150 s), and the capability to read whitelisted entries is explicitly inside SECURITY.md's "what a compromised extension can do" envelope — which is why this is not HIGH. What is lost: (a) the user-interaction binding #69 was designed to provide (silent, UI-less exfiltration of the whitelisted set becomes possible from a content-script-only compromise); (b) audit-log forensic value, since `origin` is attacker-chosen and the audit trail is the control documented (in F24T's response) as the one that "survives a compromised extension".

**Severity note (both positions).** Both models' final reports assign MEDIUM. kimi-k3 weighs the defeated TM2 mitigation and audit-origin forgery; deepseek-v4 initially rated LOW (documented-tradeoff framing — the outcome is the documented worst-case, the token is documented as a correlation ID not a TM2 control) and upgraded to MEDIUM on cross-verification re-derivation, on the grounds that the gate is the *enabler* (not redundant defence) for a capability the F20M control was specifically built to deny. deepseek-v4 flags a boundary uncertainty: if the maintainers classify "authorised popup port" as expressly including a `broadcast`/self-issued token by design (i.e. the F20M gate was never intended to hold against a compromised content script), this should be recorded as an accepted-by-design disposition rather than a vulnerability.

**Recommended fix.** Remove the `message.token === "broadcast"` carve-out; require `decrypt`/`match` popup ports to originate from an actual extension page (e.g. reject when `port.sender.tab` is set, or require `sender.url` to be `chrome-extension://.../html/popup.html`); bind the `auth`-port token push to a verified popup sender. Until then, record `port.sender` provenance in the audit-origin path so a forged `origin` is detectable.

### F41L — Multi-signer signature blob: signer extraction relies on fail-closed regex accident

**Provenance:** both models. **Source IDs:** kimi-k3 F2L (L); deepseek-v4 DV4-F5 (L).

**Description (consolidated).** If a `parcel-host.asc`-style detached-signature blob ever contains two signatures (e.g. a supply-chain attacker appends a second signature+cert via `--include-key-block`), `gpg --verify` exits 0 and emits two `VALIDSIG` lines. `SIGNER="$(grep VALIDSIG <<< "$OUT" | cut -d' ' -f12)"` then yields a newline-joined two-fingerprint string, and the containment match `[[ " $VALID_SIGNERS " =~ [[:space:]]$SIGNER[[:space:]] ]]` rejects it only because a two-line literal can never appear inside the whitespace-padded signer list. The control works today, but its correctness rests on an emergent property (multi-line attacker-influenced data never matching) rather than an explicit single-signer assertion; a GnuPG status-format tweak or future refactor could change this silently.

**Threat model(s).** TM5 (supply chain / build integrity); TM3-adjacent (tampered host inputs).

**Evidence (`file:line`).** kimi-k3: `parcel-host:146-153` (verification), `:158` (extraction), `:165` (membership test) — verified fail-closed empirically via a bash regex-semantics test. deepseek-v4: `parcel-host:155-170` — corroborates `grep VALIDSIG`/`cut` extraction with no `wc -l`/single-line assertion on the `VALIDSIG` count.

**Exploit scenario.** Not reachable today (fails closed — hence LOW). The concern is robustness of a TM5-critical control.

**Recommended fix.** Assert exactly one `VALIDSIG` line (e.g. `[ "$(grep -c '^\[GNUPG:\] VALIDSIG ' <<< "$OUT")" -eq 1 ] || fail`) before extracting the fingerprint, and explicitly reject multi-signer blobs.

### F42L — `passkeyDir` lacks `..`/absolute-path validation, weakening textual store containment

**Provenance:** both models. **Source IDs:** kimi-k3 F3L (L); deepseek-v4 DV4-F6 (L).

**Description (consolidated).** `passkey_op_create` rejects control characters and glob metacharacters in `passkeyDir` but not `..` components or a leading `/`. It carefully rejects `..` in the page-influenced tail (`$RP_ID/<basename>`), and a code comment asserts every walk from `$STORE_ROOT` passes through `$STORE_ROOT`. But with e.g. `"passkeyDir": "../other"`, `SUGGESTED="../other/<rp>/<file>.gpg"` passes the textual prefix check and the `.gpg-id` walk reads `<store>/../other/.gpg-id` — outside the store — because the containment test is purely textual and `$STORE_ROOT/../other/.gpg-id` starts with `$STORE_ROOT/`. Impact: recipient selection for the newly generated passkey entry is taken from an out-of-store `.gpg-id`, encrypting the new private key (displayed armored to the user) to attacker-influenced recipients if an attacker can also place that `.gpg-id`. deepseek-v4 notes the schema deliberately permits traversal in `passkeyDir` (`test/schema.test.js:370` asserts `..` is accepted).

**Threat model(s).** TM0 (documentation/implementation-intent divergence), TM3-adjacent (trusted-config edge), TM4 (hostile local filesystem as amplifier).

**Evidence (`file:line`).** kimi-k3: `src/parcel-host:731` (validation), `:740-748` (tail checks), `:785-799` / `:796` (walk + textual containment). deepseek-v4: `src/parcel-host:731-736` (incomplete validation), `788-807` (`SUGGESTED_FULL`/`.gpg-id` walk and textual containment).

**Exploit scenario.** `.parcel.json` sets `passkeyDir: "../x"`; an attacker (or user accident) leaves `/home/user/x/.gpg-id` listing an attacker recipient; the user registers a passkey; the armored entry shown for saving is encrypted to the attacker's key. Reachable only with a crafted `.parcel.json` — config is already trusted code, so a malicious config is game-over regardless; within that, this is a boundary-consistency gap rather than a standalone boundary break. Narrow precondition chain → LOW.

**Recommended fix.** Reject `passkeyDir` values containing `..` segments, a leading `/`, or a trailing `/` at the same point as the control-char/glob check; or resolve with `readlink -f` and enforce realpath containment against `realPassdir`.

### F43L — Firefox: frame-id broadcast falls back to `postMessage("*")`; receiver has no origin check

**Provenance:** both models. **Source IDs:** kimi-k3 F4L (L); deepseek-v4 DV4-F7 (L).

**Description (consolidated).** The F28T fix narrowed the `parcel-frame-id` broadcast to the top-level origin via `location.ancestorOrigins`, which is Chrome-only. On Firefox `ancestors?.length` is undefined and the code falls back to `"*"`, broadcasting the extension-internal `frameId` to whatever page occupies the top frame — including a cross-origin embedder, exactly the case the message exists for. The receiving listener matches only by `ev.source` (the iframe whose `contentWindow` sent the message) and performs no `ev.origin` or source-origin check, writing attacker-chosen `_parcelFrameId` onto that element. Fill delivery is bound by per-element tokens, not coordinates, so no credential misdirection follows; popups being page-stylable is already accepted (F39T). This is a coverage gap in F28T's narrowing (Chromium-only), not a contradiction of the accepted core.

**Threat model(s).** TM1 (hostile page / hostile embedding page).

**Evidence (`file:line`).** kimi-k3: `src/js/integration.js:163-173` (send side), `:139-144` (receive side), `:130-137` (coordinate resolution via `_parcelFrameId`). deepseek-v4: `integration.js:163-173` (broadcast with `"*"` fallback), `151-155` (receive handler with no origin check).

**Exploit scenario.** On Firefox, embedding page A learns iframe B's frameId from the `"*"` broadcast; separately, any frame can post a forged `parcel-frame-id` to relabel an iframe, misplacing a later inline popup. Popup-position confusion / minor cross-origin disclosure of a browser-internal frame id.

**Recommended fix.** Where `ancestorOrigins` is unavailable, omit the frame-id broadcast entirely rather than posting with `"*"`, or have the receiver validate `ev.origin` against the known parent/embedder origin; treat `_parcelFrameId` writes as hints used only for cosmetic positioning.

### F44L — Page-forged `parcel-webauthn-conflict` event surfaces a false conflict modal

**Provenance:** both models. **Source IDs:** kimi-k3 F5L (L); deepseek-v4 DV4-F8 (L).

**Description (consolidated).** `handlePasskeyConflict` is wired to the forgeable DOM event `parcel-webauthn-conflict`. Any page can `document.dispatchEvent(new CustomEvent("parcel-webauthn-conflict", {detail: …}))`; if the user holds rule-classed passkey entries for the site (checked via a real `candidates` round-trip) and the per-frame flag / per-origin dismissal do not already suppress it, a genuine-looking modal appears claiming another extension owns passkeys on this origin. Outcomes: (i) UI spoofing consistent with F39T-class inherent risk; (ii) if the user clicks "Don't show again", the dismissal (`passkeyConflictDismissed[origin]` in `chrome.storage.local`) persists for that origin, suppressing *genuine* conflict notices; (iii) the dismissal-state map is 1000-entry with eviction, so a determined site with user interaction across origins could churn it. The event alone carries no signature/decryption consequence — the ceremony path re-derives everything isolated-side — so low impact, but the ability to *suppress a genuine warning* is slightly stronger harm than mere annoyance.

**Threat model(s).** TM1.

**Evidence (`file:line`).** kimi-k3: `src/js/integration.js:1322` (listener), `:1059-1110` (handler), `:1325-1327` (early-boot DOM marker). deepseek-v4: `integration.js:1322`, `1059-1110` (schema-validates event-controlled `reason`, shows modal, reads/writes dismissal state). Both note dismissal storage is in `chrome.storage.local`, so the page cannot set it directly; suppression requires the user to dismiss the forged modal.

**Exploit scenario.** A nuisance/phishing-adjacent page repeatedly warns "Parcel passkeys are unavailable here," training the user to click through real modals, or hides genuine conflict notices behind a forged per-origin dismissal.

**Recommended fix.** Treat the early-boot DOM marker (`data-parcel-webauthn-conflict`) as the authoritative signal: have the MAIN-world interceptor set it, have the handler require and consume it, and ignore bare runtime events — a page forging the attribute can only do so in its own frame before first read.

### F45L — Packaging rsync lacks `--delete`; stale files ship on ad-hoc builds

**Provenance:** both models. **Source IDs:** kimi-k3 F6L (L); deepseek-v4 DV4-F9 (L).

**Description (consolidated).** `Makefile:42`/`:48` sync `src/dist/` into `chrome/`/`firefox/` with `rsync -av` and no `--delete`, and neither target cleans its destination. Files removed or renamed in `src/` between manual `make chrome`/`make firefox` invocations remain in the shipped tree. The `release` target is safe because it depends on `clean`, but that coupling is implicit; a developer running `make chrome` directly after a source reshuffle — the exact flow the README documents for source installs — can ship phantom JS, weakening the source↔distribution parity guarantee in SECURITY.md §3.

**Threat model(s).** TM5 (supply chain / build integrity).

**Evidence (`file:line`).** kimi-k3: `Makefile:41-49` vs `:63-64`. deepseek-v4: `Makefile:42, 48`; `release` target runs `clean extension` first (`Makefile:66`).

**Exploit scenario.** `js/targets.js` is refactored away; a maintainer runs `make chrome` (not `make release`); the stale `targets.js` persists in `chrome/`. The stale artifact is an outdated copy of earlier legitimate Parcel code, not attacker-injected, eliminated by `clean`. No credential/security impact; a parity/robustness concern.

**Recommended fix.** `rsync -av --delete src/dist/ chrome/` (and firefox); removes reliance on `release→clean` ordering.

### F46L — State-file fail-open lets a same-user process reset the rate-limiter bucket; writes follow symlinks

**Provenance:** both models (severity disputed — kimi-k3 INFO vs deepseek-v4 LOW; see §Disagreements). **Source IDs:** kimi-k3 F9I (I); deepseek-v4 DV4-F1 (L).

**Description (consolidated).** `load_state` refuses to load (returns 0 leaving the bucket variables empty) whenever the state file is missing, has wrong permissions, or contains any non-whitelisted content. When the bucket variables are empty, `check_decrypt_rate_limit` re-initialises them to a full 24-token bucket. A process running as the same user (TM4) can therefore trivially reset the rate limiter to a full burst by corrupting or deleting `~/.config/parcel/state`. The same fail-open applies to a pre-planted `state → /target` symlink: `touch`+`chmod` and `save_state`'s `>`/`chmod` are symlink-following; the `find -type f -perm 0600` identity check fails for symlinks, and the failure mode is again the deliberate fail-open full-bucket reset. kimi-k3 broadened this in phase 2 to note that *any* unloadable state (chmod, corruption, deletion, symlink) forces a full-bucket reset, not only a planted symlink. Writes on the symlink path would clobber the target with two numeric lines. All preconditions require same-UID local filesystem access (TM4), which already implies far stronger primitives; no browser-reachable path (TM1–TM3) can touch the file. The code comment states this is "a deliberate fail-open for robustness".

**Threat model(s).** TM4 (hostile local filesystem); overlaps the accepted F16T/F24T posture and the state-file fail-open design note.

**Evidence (`file:line`).** kimi-k3: `src/parcel-host:86-89` (touch/chmod), `:93-103` + `:405-410` (fail-open seed to full bucket; verified), `:117-120` (save via `>`/`chmod`). deepseek-v4: `src/parcel-host:84-114` (`load_state` returns 0 in bad-permission/invalid-content cases), `:401-408` (`check_decrypt_rate_limit` seeds `DECRYPT_BUCKET_TOKENS="$BUCKET_MILLIS"`); comment at `:82-83` states "deliberate fail-open for robustness".

**Exploit scenario.** An attacker with write access to `~/.config/parcel/state` (but without decrypting the GPG store) writes garbage / deletes / chmods 0644. The next decrypt's `load_state` fails open, the bucket resets to 24 tokens, and a concurrently-compromised extension (or the same actor driving the host) can immediately decrypt up to `decryptBucket` entries without waiting out the refill. The rate limiter's cross-restart persistence (F35M) is thereby neutralised by the very actor class it is a mitigation against. Strongest under a contrived multi-actor scenario (hostile helper process + compromised extension).

**Severity.** Canonical severity assigned: **LOW** (kimi-k3's INFO position and deepseek-v4's LOW position recorded verbatim in §Disagreements). The fail-open defeats the specific persistence guarantee F35M (#116) was shipped to provide; both models place it at the boundary of an accepted tradeoff and a documentation/design-softness note.

**Recommended fix.** On invalid state-file content or permissions, fail *closed* for the current decrypt (deny until fixed) rather than silently resetting to a full bucket; or persist last-known-good bucket in memory and continue counting from it when the on-disk value is corrupt. Switch `save_state` to temp-file + `mv -n`; consider fail-closed on symlink detection.

### F47L — `action_changes_since` does not abort after rejecting an invalid `.since`

**Provenance:** deepseek-v4 only — disputed by kimi-k3 (moved to residual; classified as non-security). See §Disagreements. **Source IDs:** kimi-k3 — (logged in Residual, not filed as a finding); deepseek-v4 DV4-F3 (L).

**Description (consolidated).** When `.since` fails the `^[0-9]{10}$` check, `action_changes_since` calls `parcel_error` (which transmits the error but does not exit the function) and then *continues* into `date -d "@$SINCE"` and `find ... -newermt "$SINCE"` with the unvalidated, attacker-supplied string. Because the shell was entered via a function called from an `if !` condition, `set -e` is suppressed. Under a crafted native-messaging peer (TM3), the malformed value flows into `date`/`find` argument position; the regex already constrains the accepted path to exactly 10 digits, so the continuation runs only on input that *failed* the check. `date -d "@$SINCE"` errors, the `||` fallback (`date -j`, BSD-only, absent on Linux) yields empty, `find -newermt ""` errors, and the pipeline yields nothing → host replies `{"changes": 0}` *after* the error. No quoting/injection consequence (`-newermt` argument is a literal assignment, quoted; the value is an argument, not shell-evaluated).

**Threat model(s).** TM3 (malicious native-messaging peer / tampered host inputs).

**Evidence (`file:line`).** deepseek-v4: `src/parcel-host:227-232`. kimi-k3: same lines (`src/parcel-host:227-232`), independently re-traced.

**Exploit scenario.** A host-peer sends a malformed `.since`; the host logs the error but proceeds to run `find` with a bogus `-newermt`, which fails closed (no changes reported per the `| read -r _` guard) — a best-effort robustness defect with no credential exposure.

**Severity.** Canonical severity assigned: **LOW** (deepseek-v4's filed severity; kimi-k3 disputes it is a security finding at all — its position that this is a non-security robustness nit belonging in Residual is recorded verbatim in §Disagreements).

**Recommended fix.** `return 0` (or `return 1` with a clean error) immediately after `parcel_error` on an invalid timestamp, mirroring the other host actions.

### F48I — Unescaped `entry.path` in `querySelector` — store-controlled selector render break

**Provenance:** both models (severity disputed — kimi-k3 INFO vs deepseek-v4 LOW; see §Disagreements). **Source IDs:** kimi-k3 F8I (I); deepseek-v4 DV4-F11 (L).

**Description (consolidated).** `popup.js:1066` — ``ul.querySelector(`li[data-path="${entry.path}"]`)`` interpolates store-controlled `entry.path` without `CSS.escape`. A path containing `"`, `\`, `]`, or other selector-relevant characters throws `SyntaxError`, breaking that render pass of the match list. All *rendering* sinks are safe (`textContent`/`createTextNode` throughout; zero `innerHTML`/`insertAdjacentHTML`/`document.write`/`eval` usage verified) — `querySelector` cannot execute code. Both models agree on the mechanics and that it is a latent fragility with no injection sink; the disagreement is whether a reachable (TM4-only) UI render break is INFO or LOW.

**Threat model(s).** TM4 (hostile local filesystem — crafted password-store filenames).

**Evidence (`file:line`).** kimi-k3: `src/js/popup.js:1066`. deepseek-v4: `popup.js:1066`.

**Exploit scenario.** An attacker able to place an entry with a pathological filename in the store (or a user with such a filename) causes the popup to fail to render the affected origin's entry list (a localised UI DoS). No plaintext disclosure and no code execution.

**Severity.** Canonical severity assigned: **INFORMATIONAL** (deepseek-v4's LOW position recorded verbatim in §Disagreements). The actor needs store-write access (TM4), where they already fully control the store contents; no security mitigation is defeated, no disclosure, no injection. This aligns with the project's calibration of self/local DoS items (cf. F12T, F15T) as informational.

**Recommended fix.** `CSS.escape(entry.path)`, or track `<li>`s in a `Map` keyed by path.

### F49I — Unbounded `#authorisedTokens` / `targetBindings` growth via synthetic clicks

**Provenance:** both models. **Source IDs:** kimi-k3 F7I (I); deepseek-v4 DV4-F10 (I).

**Description (consolidated).** Every click on a fill-target element mints a UUID token pushed over the `auth` port into `#authorisedTokens`, which is only deleted on successful popup auth. A hostile page can synthesize `click()`s on generated inputs (debounce is per-element), growing the set without bound while the page lives; mirrored by `targetBindings` in the content script, which deliberately retains bindings on disconnect. No secret exposure; transient extension memory pressure cleared on restart/unload. Tokens are one-time-deleted when non-`broadcast`.

**Threat model(s).** TM1 (hostile web page).

**Evidence (`file:line`).** kimi-k3: `src/js/agent.js:28,501,559-562`; `src/js/integration.js:686-716`. deepseek-v4: `integration.js:686-716` (binding retention on disconnect), `agent.js:496-501` (`#authorisedTokens.add` with no cap).

**Exploit scenario.** A page loops `element.click()` across many synthetic elements, each creating a persistent binding/token entry → memory growth of the extension context only; no disclosure. Bounded by per-frame lifetime and by the fact a page can already impose other costs on the extension.

**Recommended fix.** Cap or expire `targetBindings`/`#authorisedTokens` (LRU or per-origin quotas, and a maximum token count).

### F50I — Regression-test gaps over fixed security gates

**Provenance:** both models. **Source IDs:** kimi-k3 F10I (I); deepseek-v4 DV4-F12 (I).

**Description (consolidated).** Four fixed gates lack adversarial regression coverage: (a) audit-log field-length caps (F10L/F14L fix) — sanitization is tested but truncation never asserted; (b) the action-regex gate (F31L fix) — the only negative test sends pure-alpha `nonexistent`, never hostile syntax (`"decrypt; x"`, newline, `$(…)`); (c) the F36L primary-fill-path origin — popup tests never assert the forwarded `origin` field, so silently dropping it would pass; (d) per-container history keying is computed but never exercised across two container IDs. deepseek-v4 additionally notes the state-file *symlink-follow* and *fail-open reset* paths are unexercised in native-host tests (existing state-file tests cover content and permissions but not symlink/fail-open). All are defence-regression detectors, not live holes.

**Threat model(s).** TM2/TM1 (coverage of the above controls).

**Evidence (`file:line`).** kimi-k3: `test/native-host.test.js` (audit caps `:1188`; action gate; origin `test/popup.test.js:434`). deepseek-v4: `test/native-host.test.js` (state-file tests `1494-1590`), `test/popup.test.js`.

**Recommended fix.** One adversarial test each: >4 KB origin → assert truncation; hostile action strings → assert "Invalid host action" with no side effects; popup test posting `{action:"origin"}` then asserting forwarded fill origin; two-container fill asserting distinct history keys; state-file symlink/fail-open path assertions.

### F51I — `fill-value` and `frameOrigin`-undefined edge skip the destination-origin guard (no reachable scenario)

**Provenance:** deepseek-v4 only — acknowledged by kimi-k3 as benign (not filed as a new item; the `fill-value` half dedups to the maintainer-rejected half of F36L). **Source IDs:** kimi-k3 — (cross-verdict: reproduced mechanics, not added); deepseek-v4 DV4-F4 (INFO).

**Description (consolidated).** The destination-origin guard on a `fill` only triggers when the message carries an `origin` key (`hasOwnProperty` check). The popup sends `origin: frameOrigin`, which is set only once the content script answers `ready` with its `origin`. Two edges can leave `origin` absent: (a) a `frameOrigin` that is `undefined` at fill time (its `undefined` value is dropped by structured-clone); (b) the `fill-value` action, which never carries `origin`. kimi-k3 independently re-derived that neither edge yields a reachable exploit: the `frameOrigin`-undefined edge requires the popup to be usable for a fill before the `ready`→`origin` round-trip completes (in every real flow `origin` resolves first), and even then the fill target is the element the user explicitly clicked; `fill-value`'s value is user-supplied text from the detail view of an already-decrypted entry delivered to the specific element the user clicked, with no decrypted-credential-from-a-different-origin path. deepseek-v4 concurs there is no reachable scenario.

**Threat model(s).** TM1 (hostile web page).

**Evidence (`file:line`).** deepseek-v4: `integration.js:1439-1444` (guard conditional on `hasOwnProperty(msg,"origin")`); `popup.js:9` (`let frameOrigin;`), `:1175` (`origin: frameOrigin`), `:236,361,578` (`fill-value` sends, no `origin`). kimi-k3: `popup.js:1175`; `integration.js:1443` (per-element token binding on the destination content script defeats the mid-decrypt-navigated-frame case, which lacks binding).

**Exploit scenario.** None confirmed. The primary `fill` path (including broadcast fire-and-forget fallback) correctly carries and checks origin; the maintainer explicitly rejected the `fill-value` half of F36L ("there is no exploit path for it"), and both models concur.

**Recommended fix (optional hardening).** Send `origin` on `fill-value` too, or initialise `frameOrigin` defensively and fail closed when missing on a `fill`.

## Disagreements

The merge editor does not adjudicate these. Each model's position and rationale are presented as recorded in its final report; the canonical severity chosen for each ID is stated for tracking only.

### F46L — State-file fail-open rate-limiter reset: kimi-k3 INFO vs deepseek-v4 LOW

**Canonical severity assigned:** LOW (F46L).

**kimi-k3 position (INFO):** "Confirmed reachable behaviour; severity disagreement — I keep INFO (F9I). … **Disagreement rationale:** the rate limiter is a documented TM2 mitigation, but the bypass precondition is a same-UID filesystem actor (TM4); that actor class cannot turn this into plaintext without an extension channel, and a same-UID attacker already holds stronger primitives (delete the state file → same effect). It is a genuine softening of a defence-in-depth property and deserves a fix (fail-closed or per-cycle cap), but no trust boundary is crossed — deepseek-v4 rates it LOW as a hardening opportunity; I rate INFO as a documented-softness note. Happy to converge on LOW if the maintainer treats the bucket-persistence guarantee as a TM4 promise." kimi-k3 also frames the finding as: "All preconditions require same-UID local filesystem access (TM4)… no browser-reachable path (TM1–TM3) can touch the file. Noted… as a documented design soft spot rather than an exploitable finding."

**deepseek-v4 position (LOW):** "This is strongest under a *multi-actor* scenario (a hostile helper process + a compromised extension), which is contrived. A single same-user hostile process that can write the state file either (a) already has direct read access to the encrypted store files… and, more importantly, (b) can tamper with `parcelrc`/the config dir with equal ease (accepted F16T/F24T). As a standalone control, the fail-open weakens F35M, but the attack requires an actor who in practice already holds comparable or greater influence. I rate this **LOW** with Medium confidence and note it is a deliberate, documented design decision — it sits at the boundary of an accepted tradeoff."

### F48I — `entry.path` in `querySelector`: kimi-k3 INFO vs deepseek-v4 LOW

**Canonical severity assigned:** INFORMATIONAL (F48I).

**kimi-k3 position (INFO):** "Attacker needs password-store write access ⇒ INFORMATIONAL under TM4." (F8I); cross-verification: "Verified `entry.path` into `querySelector` without `CSS.escape` (`popup.js:1066`); render-breaking, no injection sink."

**deepseek-v4 position (LOW):** "**LOW**, Medium confidence. Interpolating path data into a CSS selector is a latent fragility; impact is a render break. Kimi rates this INFO; I rate LOW (reachable UI break) but note it is at the INFO/LOW boundary." (DV4-F11) — "No plaintext disclosure and no code execution."

### F47L — `action_changes_since` non-abort: deepseek-v4 LOW-finding vs kimi-k3 non-security / residual

**Canonical severity assigned:** LOW (F47L).

**deepseek-v4 position (LOW):** "**LOW**, Low confidence of security impact; essentially a robustness/consistency nit (the function neither aborts nor returns a clean result). Include for completeness; arguably should be folded into Residual." (DV4-F3)

**kimi-k3 position (not a security finding — moved to residual):** "**Reproduced as a logic flaw; not reproduced as a security finding.** Verified: `parcel_error "Invalid timestamp"` (`src/parcel-host:230`) lacks a `return`/exit … so execution continues into `date -d` → empty `SINCE` → `find -newermt ""` errors → the pipeline yields nothing → host replies `{"changes": 0}` *after* the error. No quoting/injection consequence… Net effect: a malformed `since` produces error + conservative `changes:0`. This is a robustness nit with no security impact; per the reachability rule it belongs in Residual Observations… I disagree with its LOW severity label in a security context." kimi-k3's residual entry: "emits the error then answers `{"changes": 0}`. Harmless but misleading double-reply; worth a `return 0` for cleanliness. Non-security."

### F40M — note on the Phase-1 severity history (no live dispute in final reports)

Both models' final reports assign **MEDIUM**; no live severity dispute is recorded here. For completeness: deepseek-v4 initially rated DV4-F2 LOW in Phase 1 on the documented-tradeoff framing and, after cross-verification re-derivation, adopted MEDIUM — "a verdict change driven by re-analysis of the control-bypass, not merely to reach consensus." kimi-k3's cross-verdict recorded its perception of deepseek-v4's LOW and stated it would "keep MEDIUM." The MEDIUM-HIGH boundary is also flagged (not a model-vs-model dispute): kimi-k3 states it "would defend M on 'within documented envelope + two overlapping controls intact', and present the H argument rather than hide it"; deepseek-v4 flags that if maintainers classify the `broadcast`/self-issued token as expressly by-design, the item "should be recorded as an accepted-by-design disposition rather than a vulnerability."

## Regression Checks

All entries verified present, effective, and not bypassed in the current tree by both models (provenance: both models unless noted). No regression found.

| Prior finding | Task / ref | Status | Evidence |
|---|---|---|---|
| F1M (temp keyring) | #46 | CONFIRMED | `GNUPGHOME=/dev/null`, `--no-default-keyring --keyring`, `mktemp`+`rm -f`; kimi `parcel-host:132-154`, deepseek `parcel-host:87-113` |
| F2M (audit control-char strip) | #48 | CONFIRMED | `audit_decrypt` strips `[[:cntrl:]]`; kimi `src/parcel-host:375-378,:539-541`, deepseek `:311-317` |
| F5T (0600 parcelrc) | #50 | CONFIRMED (kimi) | find-based `-perm 0600` identity check, refuse else; template `chmod 0600` (`:78,81-84`) |
| F9L (sha256 after parcelrc) | #49 | CONFIRMED | `SHA256` resolved after `. "$PARCELRC"`; kimi `:89,:99`, deepseek `parcel-host:62` |
| F10L/F14L (audit caps) | #56 | CONFIRMED | length caps `INTENT:0:128`,`ORIGIN:0:1024`,`FILE_PATH:0:1024`,`MESSAGE:0:4096`; kimi `src/parcel-host:379`, deepseek `:316`. (Truncation untested → F50I) |
| F11L (manifest CSP) | #55 | CONFIRMED (deepseek) | `script-src 'self'; object-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'self'` |
| F17L (symlink policy before traversal) | #57 | CONFIRMED | `collect_roots` enforces link policy pre-traversal; `validate_decrypt_path_policy` re-checks at decrypt; kimi `:160-178`, deepseek `:157-197,442-463` |
| F18M (CSP directives) | #68 | CONFIRMED | CSP directives present (`manifest.json`); Firefox rewrite doesn't touch CSP |
| F19M (MV3 lifecycle) | #67 | CONFIRMED | `onStartup`/`onInstalled` → idempotent `#ensureNativeConnected()`; reconnect uses same helper; kimi `agent.js:73-104`, deepseek `:57-67` |
| F20M (port action allow-list) | #69 | CONFIRMED (gate present; partially undermined → F40M) | `PORT_ACTIONS` restricts `decrypt`/`match` to `popup`; `integration`→`config` only (`agent.js:548-551`/`:544-547`) |
| F22L (HOST_HASH exact bytes) | #71 | CONFIRMED | `jq -rj '.script' | sha256sum` (exact bytes, no added newline); kimi `parcel-host:175`, deepseek `:122-127` |
| F25T (logfile 0600) | — | CONFIRMED (kimi) | `chmod` on log creation (`parcel-host:93`) |
| F29L (quoted `$SHA256`) | #71 | CONFIRMED | `"$SHA256"` quoted in command position; kimi `parcel-host:175`, deepseek `:175` |
| F30L (no gpg status leak) | 0c9be39 | CONFIRMED | `$OUT` to fd5 log only; extension receives generic "Signature verification failed"; kimi `:146-153`, deepseek `:99-120` |
| F31L (action regex gate) | ffeae49 | CONFIRMED | `[[ ! "$ACTION" =~ ^[a-zA-Z0-9_]+$ ]]` before dispatch; kimi `parcel-host:202`, deepseek `:213-219`. (Hostile-syntax test gap → F50I) |
| F34M (broadcast origin check) | #106 | CONFIRMED (kimi) | `integration.js:1439-1443` presence-gated strict equality; popup always supplies origin; broadcast fallback supplies origin (`agent.js:613`) |
| F35M (persisted token bucket) | #116 | CONFIRMED | `validate_state_content`/`load_state`/`save_state` persist bucket to `STATEFILE` 0600; kill-reconnect no longer resets; content whitelist-validated before `eval`. (Fail-open softening → F46L) |
| F36L (popup fill carries origin) | #118 | CONFIRMED | popup sends `origin: frameOrigin`; integration `fill` checks `msg.origin !== window.location.origin`; kimi `popup.js:669,1175`, deepseek `popup.js:1175;integration.js:1439`. (Test gap → F50I; accepted halves → F51I) |
| F37L (gitleaks pinned) | #123 | CONFIRMED | pinned `8.30.1` + per-os/arch SHA-256 map, aborts on mismatch |
| F38I (comment) | 27dd6f2 | CONFIRMED | comment matches allow-list (`integration` → `config` only; `agent.js:544-547`/`:546-547`) |

## Deliberate Tradeoffs

Documented tradeoffs re-examined; acceptance rationales still hold for all (none contradicted by the implementation except where a finding records a coverage gap). Provenance: both models unless noted.

| Tradeoff | Status | Notes (provenance) |
|---|---|---|
| F3T — no-network as policy rule, not technical boundary | unchanged | both |
| F4T — default-allow-all when `.parcel.json` absent | unchanged | both |
| F6T — cross-origin fill warning-only | unchanged; popup path still advisory `alert()` (`popup.js:671-678`) | kimi |
| F7T/F26T — WAR scope / fingerprintability | unchanged; list empirically justified (deepseek notes WAR omits `popup.js`, still exposes JS modules) | both |
| F8T/F27T — unsalted history hashes | unchanged | both |
| F12T — search ReDoS self-DoS | unchanged | kimi |
| F13T — `shadow.js` MAIN-world prototype patch | unchanged; bridge treated as untrusted | kimi |
| F15T — uncapped assembled log line | unchanged; `chmod 0600` now on log creation; length bounded in practice | deepseek |
| F16T — host world/group-writable config dir | unchanged (actor already holds stronger primitives; same-user precondition) | both |
| F21T — backup keys in default `VALID_SIGNERS` | unchanged; still hard-coded at `parcel-host:94` | kimi |
| F23T — rate-limiter default burst 24 | unchanged; bounds sustained not burst exfiltration | kimi |
| F24T — unvalidated `LOGFILE` | unchanged; 0600-enforced parcelrc | both |
| F25T — audit log mode | addressed (0600 on creation) | both |
| F28T — forgeable in-page bridges / `parcel-frame-id` `postMessage` | accepted core holds; Chromium-only narrowing gap on Firefox → F43L | both |
| F32T — non-constant-time `HOST_HASH` compare | unchanged (no remote timing attacker) | kimi |
| F33T — `config` leaks passdir to integration ports | accepted as-is; unchanged | kimi |
| F39T — page-stylable/removable inline popup | unchanged; inherent. Combined with F43L/F44L, UI-confusion is the recurring low-grade theme of this release | kimi |

## Residual Observations

Risks inherent to the design and hardening notes with no confirmed reachable exploit path (not raised to findings, per the source protocols). Merged, deduplicated, provenance-tagged.

| Observation | Provenance | Note |
|---|---|---|
| `od`-based length-prefix parse in the bootstrap message loop assumes host endianness; big-endian systems would misparse message lengths | kimi | correctness, not security |
| `fill-value` origin — F36L's rejected half; the only injection point is the popup itself (already trusted with the plaintext) | kimi | overlaps F51I; maintainer rejection re-derived and stands |
| Inline popup lives in page DOM (F39T) | kimi | inherent |
| `.gpg-id` `#` truncation (`RECIPIENT="${RECIPIENT%%#*}"`) | kimi | no trust boundary (recipients public; config trusted) |
| Plaintext lifetime in popup detail views | kimi | acceptable for local popup; "clear on idle" hardening optional |
| Toolbar-popup `match` with arbitrary `url` | kimi | affects only its own view; no boundary crossed |
| `load_state` single-variable emptiness edge (only one of tokens/last persisted) | deepseek | overlaps F46L; worst-case over-credits refill |
| `action_list` newline/metacharacter `.gpg` filenames (TM4) | deepseek | #122 desync count check catches divergence and fails closed; exact-match whitelist prevents bypass |
| Symlink/TOCTOU between `validate_decrypt_path_policy` and `gpg --decrypt` | deepseek | same-user actor already has store write access |
| Deeply-nested external symlink DoS (TM4) with `allowExternalLinks: true` | deepseek | policy applied before traversal; inherent to the option |
| `parcel_transmit` length-prefix | deepseek | correctly byte-counted under `LC_ALL=C`; verified clean |
| Zombie/duplicate host processes sharing `STATEFILE` | deepseek | bounded; content validated; writes atomic-ish `>` clobber |
| CSP of `popup.html` could additionally pin `style-src`/`img-src` | deepseek | current `'self'`-scoped CSP adequate; hardening note |
| `action_changes_since` missing early-return after invalid-`since` rejection | kimi | kimi classifies this as non-security/residual; deepseek files it as F47L (LOW) — dispute recorded in §Disagreements |

## Methodology

- **Source reports:** two independent phase-2 reviews of Parcel v1.0.5 (commit `6b0f1a7`, tag `v1.0.5`, tree clean) under the two-phase protocol in `security-review/prompt.md`, each including cross-verification of the other model's findings-table exchange file.
  - `kimi-k3` (kimi-k3-fast; operational suffix omitted per §0): `security-review/reviews/v1.0.5/kimi-k3.md`.
  - `deepseek-v4` (deepseek-v4-flash; operational suffix omitted per §0): `security-review/reviews/v1.0.5/deepseek-v4.md`.
- **Merge date:** 2026-08-08.
- **Merge-editor model:** `glm-5.2`.
- **Editorial scope:** this merge is editorial, not investigative. Canonical `F<N><S>` IDs were assigned continuing the global sequence from `findings.md` (which ended at F39T); the next IDs are F40–F51. Where the two component reviews reported the same finding, one unique canonical ID was assigned across all locations. Where the two reviews disagreed on severity, the merge editor selected one of the two reported severity letters for the canonical ID and recorded the unchosen position verbatim in `## Disagreements` without adjudicating.
- **Confirmation:** the merge editor introduced **no** new findings and changed **no** severities — neither model's own stated severity was altered; canonical letters were selected solely from the positions the two models themselves reported, and both positions are preserved verbatim in the Disagreements record and in the unchanged prose of the component reports (which received canonical-ID updates only).

## About This Merge

- **Merge-editor model:** `glm-5.2`.
- **Source report filenames:** `security-review/reviews/v1.0.5/kimi-k3.md`, `security-review/reviews/v1.0.5/deepseek-v4.md`.
- **Prompt record:** the committed `security-review/prompt.md` is the canonical record of both prompts (the review prompt and the merge-editor appendix). The prompts are not embedded in this report.
- **Reviewed release:** Parcel v1.0.5 (commit `6b0f1a7`, tag `v1.0.5`); this is a release review (HEAD == release tag), so the merged report is saved under `security-review/reviews/v1.0.5/`.
- **Sibling artifacts:** both component reports were updated in place with canonical `F<N><S>` IDs (no other aspect of those reviews was modified), and `security-review/findings.md` was appended with the F40–F51 entries and maintainer response placeholders. All four files are intended to be committed together atomically by the maintainer.

# Parcel Security Review — GLM 5.2

**Reviewer:** Copilot CLI (GLM 5.2, model ID `glm-5.2`).
**Date:** 15 July 2026.
**Target:** Parcel `v1.0.2` (branch `master`, commit `4d4bbc9` — "Release v1.0.2").
**Methodology:** Three parallel read-only security-review subagents covering (1) the native-host layer, (2) the browser-extension runtime layer, and (3) the configuration/data & packaging layer. Each subagent was given the project's stated security model and the *summary* of prior reviews (`security-review/findings.md`) but was **not** permitted to read the full text of prior reviews under `security-review/reviews/`, per project rules. The reviewer then compiled, cross-checked, performed a second-look pass, and a per-finding targeted follow-up. Findings below are this reviewer's; maintainer responses to *prior* reviews are summarised from `findings.md` where referenced.

**Prompt:**

> This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Use up to three simultaneous subagents, and do a second-look review of your output file once you have created it. Be critical; is there anything you may have missed, or misinterpreted? Save the final review to /scratch/parcel/security-review-glm_5.2-20250715-v1.0.2.md. Treat this as a living document; you may edit it throughout your review to ensure items are tracked correctly, and later findings are incorporated effectively. Once you have completed your review, perform an additional targeted review for each finding, and update the review document to take the outcome of that targeted review into account.


---

## 1. Executive summary

Parcel is a read-only browser↔`pass` bridge whose central security thesis is: **the native host, not the extension, enforces filesystem access**, so a fully compromised extension still cannot read non-whitelisted credential files. The architecture layers defense-in-depth controls (GPG signature verification, optional `HOST_HASH` pinning, `.parcel.json` entry visibility rules, decryption rate limiting, audit logging, storage isolation) that overlap so a failure in one layer does not automatically cascade.

This review of `v1.0.2` did not identify any **CRITICAL** or **HIGH** remotely-exploitable vulnerabilities that breach the core security thesis (an attacker cannot decrypt or exfiltrate non-whitelisted secrets, and cannot escape the whitelist/filesystem boundary). It surfaces a set of **MEDIUM** and **LOW** hardening opportunities, plus a candid assessment of the *deliberate tradeoffs* the project has made. Several items overlap with prior findings (now addressed) and are called out as such rather than re-reported as new.

Two findings are recorded (detailed in §5):

- **F33T (LOW):** the `config` endpoint ships the full config (incl. the password-store home path) to unauthenticated integration ports. Reachable only under the compromised-extension model; worth fixing as defence-in-depth.
- **F34M (MEDIUM):** the broadcast fill path performs no destination-origin validation, so mid-decrypt navigation or popup-death can route a decrypted credential intended for one origin into a different-origin page, bypassing the only (advisory, popup-path-only) cross-origin control.

The core security thesis holds; the most security-critical native controls (exact-match whitelist, GPG signature/hash verification) are sound and fail-closed.

---

## 2. Scope of review

**In scope (source read by the subagents):**

| Layer | Files |
|-------|-------|
| Native host | `parcel-host` (bootstrap), `src/parcel-host` (main host) |
| Extension runtime | `src/js/agent.js`, `src/js/integration.js`, `src/js/integration.es6.js`, `src/js/popup.js`, `src/js/shadow.js`, `src/js/helpers.js` |
| Config / data / packaging | `src/manifest.json`, `src/js/plaintext.js`, `src/js/schema.js`, `src/js/selectors.js`, `src/js/targets.js`, `Makefile`, `src/Makefile`, `package.json`, `.gitleaks.toml`, `keys/` |
| Context | `README.md`, `SECURITY.md`, `CONSTITUTION.md`, `security-review/findings.md` |

**Out of scope / deliberately excluded:**
- The vendored `src/publicsuffix` upstream PSL subtree (treated as trusted external data, per project convention).
- Generated distribution trees (`src/dist/`, `chrome/`, `firefox/`, top-level `dist/`) — verified only for parity with `src/`.
- Full text of prior reviews under `security-review/reviews/` — not permitted by project rules; only `findings.md` (the summary) was consulted.

---

## 3. Threat model & security posture (as stated by the project)

Parcel's own `SECURITY.md` defines the model clearly. The reviewer affirms the restated version below is consistent with the code and packaging observed:

- **Read-only bridge.** No create/edit/delete except the host's own log and a seed `parcelrc` (if absent). The host exposes no API to mutate its own configuration.
- **Host-side whitelist enforcement.** Visibility rules in `$PASSWORD_STORE_DIR/.parcel.json` are evaluated on the host; the extension cannot bypass them. Missing `.parcel.json` defaults to *all entries visible* (deliberate — see tradeoffs).
- **No network access.** Human-enforced governance rule, *not* a technical boundary, because `<all_urls>` `host_permissions` make manifest-level egress blocking impossible for the content script / service worker. The strict `connect-src 'none'; frame-src 'none'; base-uri 'self'` CSP *does* technically bind extension pages (popup), which is a meaningful partial mitigation.
- **No third-party runtime dependencies.** Extension is vanilla JS/HTML/CSS; native host uses only standard shell utilities (`jq`, `gpg`, `sha256sum`, `awk`, `find`, `grep`).
- **Auditable source parity.** No transpilation, bundling, or minification; packaging is `install`/`rsync` + GPG detach-sign. Shipped source == repository source (verifiable).
- **Signature + (optional) hash pinning of the host script.** The bootstrap verifies the GPG detached signature of `src/parcel-host` against `VALID_SIGNERS`, and optionally a `HOST_HASH` SHA-256 pin, before executing.

### Compromised-extension threat model (what a fully compromised extension *can* still do)
Per `SECURITY.md`, and consistent with the code: a compromised extension can read already-whitelisted entries, interact with visited pages/network/other extensions, and exercise the supported host action set. It **cannot** decrypt non-whitelisted files, touch the GPG key, or write arbitrary disk. This is the yardstick against which the MEDIUM/LOW findings are graded.

---

## 4. Deliberate design decisions & tradeoffs (reviewer commentary)

The project documents its tradeoffs transparently in `SECURITY.md`. The reviewer's critical assessment of each, with the security implication, follows. These are **design-rationale evaluations, not vulnerabilities** unless explicitly flagged.

| # | Decision | Rationale (stated) | Reviewer assessment |
|---|----------|--------------------|---------------------|
| T1 | Plaintext bash host vs. compiled binary | Auditable source prioritised over obfuscation/speed | **Sound & central to the trust model.** A compiled host could hide malicious behaviour; bash is directly inspectable. The cost is that the host runs with the user's full shell privileges and GPG access — the entire security boundary rests on *what the script does*, not on sandboxing. This makes signature verification + hash pinning the load-bearing control, which is why `HOST_HASH` being off by default (T3) is the single most consequential tradeoff. |
| T2 | Extension reads pubkey from `keys/` & verifies shipped host signature at runtime | Allows updating the host script with the extension without reinstalling the bootstrap | Sound, but note the bootstrap itself is the trusted root: if the bootstrap is replaced/modified, signature verification is moot. Installation integrity of `parcel-host` (the bootstrap) is therefore a trust root not bound by these reviews. |
| T3 | `HOST_HASH` off by default; strongly recommended | Avoids friction/support burden of re-pinning every update | **Acceptable but high-impact.** Without the pin, a user who accepts a new extension release that ships an attacker-crafted (but validly-signed, or signing-key-compromised) host script gains no resistance. Given the host executes outside the browser sandbox with GPG access, the reviewer agrees with the project's "strongly recommended" stance; the residual risk is users who never opt in. |
| T4 | Missing `.parcel.json` → all entries visible | An empty store is "not a useful default" | **Defensible but worth a louder warning.** Combined with the default `decryptBucket` burst (T8), a compromised extension can exfiltrate up to 24 entries immediately with zero configuration. The default-deny alternative is a breaking change, so the tradeoff is reasonable *if* the docs surface the exposure prominently. |
| T5 | Content script on `<all_urls>` at `document_start`, all frames, incl. MAIN-world `shadow.js` | Required to detect form fields before user interaction & support arbitrary login pages + shadow DOM | Necessity accepted; this is the largest inherent attack surface (any page can detect/fingerprint the extension; MAIN-world prototype patching is observable). The project accepts the fingerprint surface. The trust boundary between MAIN and isolated worlds via custom events/postMessage deserves the continued scrutiny given below (see findings). |
| T6 | No symlink deref before policy evaluation (opt-in `allowLinks`/`allowExternalLinks`) | Portability/usability | Acceptable for the default (links disabled). The prior symlink-traversal-before-policy issue was addressed (#57); the reviewer confirms the *policy-before-traversal* ordering is the right invariant to preserve. |
| T7 | No clipboard auto-clear | Avoids holding `clipboardRead` to verify-before-clear | **Sensible.** The reviewer agrees the `clipboardRead` permission would be a net-negative tradeoff. |
| T8 | Default burst (24) vs. refill (0.006667/s ≈ 24/hr) | Balance usability against exfiltration | Reasonable for sustained exfiltration; the *burst* provides little protection for small stores (see L-burst finding, consistent with prior F23T where maintainers judged typical stores larger). |
| T9 | `parcelrc` is `source`d bash → trusted code | Enables rich host configuration | **Expected for bash, but it makes `parcelrc` a code-execution trust root** equivalent to the bootstrap. The 0600-mode check is necessary-but-insufficient (directory permissions — prior finding, accepted as low-likelihood). Any recommendation touching `LOGFILE` etc. is bounded by this trust model. |
| T10 | Detectable by websites via `web_accessible_resources` + shadow shim | Acceptable fingerprint necessity | Accepted; findings.md F26T records the maintainers empirically verified each WAR entry is required. The reviewer did not re-litigate this. |

---

## 5. Findings

> Populated from the three security-review subagents, then second-looked (§7) and per-finding targeted-reviewed (§8). Severity: CRITICAL / HIGH / MEDIUM / LOW. Confidence: High / Medium / Low.

### Findings index

| ID | Severity | Confidence | Title |
|----|----------|------------|-------|
| F33T | LOW | High | `config` endpoint returns the full config (incl. `passdir`/`realPassdir` → OS home path) to unauthenticated integration ports |
| F34M | MEDIUM | Medium | Broadcast fill path performs no destination-origin validation; mid-decrypt navigation or popup-death can route a decrypted credential to a different-origin page |

---

### F33T — `config` endpoint leaks the full config (incl. password-store home path) to unauthenticated integration ports

**Severity:** LOW | **Confidence:** High
**Location:** `src/js/agent.js` `config` handler (the `{ action: "config", config: this.#config }` response) and `PORT_ACTIONS` allow-list (`integration: ["config"]`); config fields injected by `src/parcel-host` (`passdir`, `realPassdir`); schema `src/js/schema.js` (`passdir` required, `realPassdir` optional).

**Description:**
The agent's `config` handler returns the **entire** cached `#config` object to any port permitted to call `config`. The auth gate applies only to `port.name === "popup"`; `integration` ports need only pass the action allow-list, which permits `config` with **no token / no origin / no tab check**. The native host injects the user's password-store directory into that config — `passdir` (e.g. `/home/<USER>/.password-store`) and `realPassdir` (the `readlink -f`-resolved path) — plus the full visibility `rules`, `additionalSelectors`, and `targets`/`additionalTargets` heuristic set. `integration.js` itself never consumes `passdir` (only `popup.js` does, for path display), so this data is gratuitously shipped to content-script contexts.

**Reachability (second-look correction):** A *web page cannot directly trigger this.* `chrome.runtime.connect({name:"integration"})` is an extension-context API available only to Parcel's own content scripts, not to page scripts. I verified `integration.js` receives the config into an isolated-world `Promise` and uses it only for selector/target evaluation; it does **not** write the config (nor `passdir`) to the page, the MAIN world, or a `postMessage` (it only `postMessage`s `frameId` to the top frame). Consequently the leak is reachable only when **the extension context itself is compromised** (an attacker controlling Parcel's content script), under which threat the attacker can already read rate-limited *decrypted* whitelisted entries — strictly more damaging than reading the home path. The marginal additional capability of F33T over the accepted damage class is small but non-zero: it yields a persistent cross-origin correlator (the OS username, from the home path) and `realPassdir` (defeating any symlink-based path obfuscation) **without** consuming a decryption-rate-limit token.

**Impact:** Information disclosure only — no credentials decrypted, no whitelist bypass, no GPG access. Under the compromised-extension model the marginal harm is the OS username/`realPassdir` as a rate-limit-free tracking signal.

**Recommendation:** Send integration ports a minimized config slice containing only the fields `integration.js` consumes (selectors/targets, `fillRelated`, `disableContextPopup`, etc.) and strip `passdir`/`realPassdir` (and the full `rules` set) before responding to `integration` ports — e.g. a `configForIntegration()` that omits host-filesystem-derived fields. This is hygiene/defence-in-depth rather than a fix for an exploitable web attack.

---

### F34M — Broadcast fill path performs no destination-origin validation; mid-decrypt navigation can exfiltrate a credential to a different origin

**Severity:** MEDIUM | **Confidence:** Medium
**Location:** `src/js/agent.js` fire-and-forget broadcast fallback (`token === "broadcast"` branch in the `decrypt` handler); `src/js/integration.js` broadcast `onConnect`/`fill` handler (root-frame best-target selection); `src/js/popup.js` advisory origin check.

**Description:**
Parcel has two delivery paths for a decrypted credential, and neither applies a **hard** destination-origin check at fill time:

1. **Popup path.** The popup connects to the content-script target, receives the top frame's `origin`, and compares it against `tab.url`'s origin (`popup.js`). On mismatch it shows an `alert(...)` — but the code does **not `return` or abort**: it only `focus-suspend`/`focus-resume` and then the fill flow continues. The check is therefore **advisory-only** (warns the user; does not block). It also uses `tab.url` captured (at the latest) when the popup opened, so a slow GPG/pinentry decrypt (default `decryptTimeout` 60 s) gives a wide window in which the compared-against URL is stale.
2. **Broadcast fallback (agent).** If the popup↔agent port is disconnected during a `decrypt` with `intent === "fill" && token === "broadcast" && tabId`, the agent does `chrome.tabs.connect(tabId, { name: "broadcast", frameId: 0 })` and posts `{ action: "fill", config, plaintext }` **directly**, ignoring responses. `integration.js`'s broadcast handler then finds the current best visible target in the root frame and fills `msg.plaintext` into it. This path has **no origin check at all** — not even an advisory one — and connects to whatever content script is currently resident in the tab's top frame.

**Attack scenario / Impact:**
A user opens the toolbar action (token `broadcast`) on origin A and starts a decrypt+fill. GPG may take seconds-to-minutes (pinentry). If, during that window, the tab navigates from A to attacker origin B (e.g. a redirecting ad/`<meta refresh>`/client-side navigation on A, or the user-initiated page closing the popup so the popup port dies), the broadcast fallback delivers the **decrypted** credential to B's best-matching field, where B can read it. Because the fallback requires no live popup, there is no advisory warning shown. This is distinct from the project's accepted "autofill-phishing" tradeoff: there, the user fills a page they are voluntarily interacting with as an attacker page; here a credential *intended for legitimate origin A* is redirected to B by mid-decrypt navigation, bypassing the only (advisory, popup-path-only) origin control. The decryption rate limiter does not mitigate this — a single decrypt suffices.

**Why "Medium" and not higher:** Exploitability is timing-dependent and requires (a) the popup port to disconnect before decrypt completes, and (b) a cross-origin navigation into a page B that owns a fillable target. Both are achievable (slow decrypts are common; popup-close/navigation are normal), but assemble into a non-trivial condition, hence Medium confidence.

**Recommendation:**
- Make the broadcast fallback **destination-aware**: before delivering `plaintext`, verify the tab's *current* top-frame origin is the same origin the user originally requested the fill for (compare the decrypt request's `origin` against `chrome.tabs.get(tabId)`'s current URL origin, or have `integration.js`'s broadcast handler refuse to fill when `window.location.origin` differs from an intended-origin carried in the message). Abort (and drop the plaintext) on mismatch.
- Alternatively (or additionally), consider aborting the fill on popup disconnect rather than auto-completing it out-of-band — though this trades off the intended UX of completing a fill the user already authorised.
- Separately, consider making the popup-path origin check **blocking** rather than advisory for cross-origin (different-eTLD+1) cases, since `alert`-and-continue still lets a credential flow to a mismatched origin.

---

## 6. Areas that are well-handled (positive observations)

- **Host-side whitelist enforcement is the load-bearing control and it is sound.** The decrypt path uses an exact string match against the `ALLOWED_FILES` array populated only from `action_list`; path-traversal, absolute, or alternate-representation paths simply fail to match. Symlink policy is evaluated at both list time and decrypt time (via `readlink -f` and `path_uses_links`).
- **GPG decrypt path is injection-safe.** The file path is a shell redirect target (`< "$FILE_PATH"`), never a `gpg` argument, so gpg argument injection (e.g. `--output`, `--options`) is impossible.
- **Signature verification is fail-closed and well-bounded.** Signer extraction uses `VALIDSIG` field 12 (primary fingerprint), checked with a space-delimited regex against `VALID_SIGNERS`; `EXPKEYSIG`/`REVKEYSIG`/`NO_PUBKEY` produce no `VALIDSIG` line and are rejected. Verification uses a temporary keyring that is removed, so there is no keyring pollution. Verified script is held in a shell variable (no verify→exec TOCTOU on disk).
- **Action dispatch is guarded.** `ACTION` is regex-gated (`^[a-zA-Z0-9_]+$`) before the `type -t "action_$ACTION"` function lookup, eliminating shell-metacharacter/command-injection paths.
- **Native-messaging framing bounds memory.** A 16 MiB cap rejects oversized claimed lengths before `head -c` reads the body; output framing uses `LC_ALL=C` for byte-accurate length (correct for multi-byte UTF-8 entry names) with correct little-endian encoding.
- **Audit logging is well-scoped.** Control characters are stripped, per-field length caps exist, the logfile is `chmod 0600`, and GPG status output is redirected to fd 5 only (never to the extension). Plaintext is never logged.
- **Rate limiter is correct and fail-safe.** Token bucket uses integer tokens (×1000), 1000 cost per decrypt, clamps to ≥ 0, and treats clock skew (negative elapsed) as more restrictive.
- **Strict, sufficient extension-page CSP** (`script-src 'self'; object-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'self'`) with no `eval`/`new Function`/`importScripts`/remote `fetch`/`import()` anywhere in `src/js` — every `fetch`/`import()` targets `chrome.runtime.getURL(...)`.
- **No third-party runtime dependencies; packaging preserves source parity.** Zero npm `dependencies`; build is `install`/`rsync`/`zip` + `jq` manifest rewrite + GPG detach-sign, with no transpiler/bundler/minifier. The Firefox `.es6.js` shim is a committed 2-line source file, not a transform.
- **No private signing material in-repo.** `keys/` holds only the four public key blocks matching `CONSTITUTION.md §2.2`; gitleaks scoping is sound.
- **Port-name→action allow-list (F20M) holds.** Under the non-compromised model a content-script port cannot reach `decrypt`/`match` (restricted to authorised popup ports), and `integration` ports are limited to `config`. The `auth` token is single-use (deleted after use).

---

## 7. Second-look review

A critical re-read of the three subagent reports and the codebase, performed after compiling §5/§6.

**Changes made to findings during the second look:**

1. **F33T reachability corrected (down-scoped).** The extension-runtime subagent framed the `config`/`passdir` leak as reachable by "any content script on any origin" implying any website could fetch the OS username. I verified this is **not** the case for un-compromised use: `chrome.runtime.connect` is an extension-context API, and `integration.js` does not expose the config to the page or MAIN world. The leak is reachable only under the compromised-extension model, where reading decrypted whitelisted entries (rate-limited) is already possible. I therefore down-scoped F33T from "every site learns your username" to a compromised-extension hygiene/defence-in-depth item (LOW), while noting the marginal rate-limit-free OS-username signal.

**New finding surfaced by the second look:**

2. **F34M added.** The extension-runtime subagent examined the broadcast/fill path and judged the "fill lands on a navigated page" scenario a "structural no-op" for top-frame fills and accepted it as autofill-phishing. On re-reading I found that reasoning imprecise: the popup's origin check is **advisory-only** (alert without abort), and the **agent broadcast fallback** has no origin check at all and delivers `plaintext` to the tab's current top frame. Mid-decrypt navigation (wide window under 60 s default `decryptTimeout` + GPG pinentry) combined with popup-port death can route a credential intended for origin A into attacker origin B, bypassing the only cross-origin control. I documented this as F34M (MEDIUM, Medium confidence) and verified both code paths directly. This is distinct from accepted autofill-phishing because the user's intended fill origin differs from the exfiltration origin.

**Latent non-security bug noted (not escalated to a finding):**
The config/packaging subagent flagged that `Schema.validate` mutates the shared schema object (`schema.type = "number"` after an `integer` passes), so `decryptBucket`/`decryptTimeout`/etc. lose their integer constraint on subsequent reloads. I confirmed this at `src/js/schema.js`. It is a correctness bug, not a security issue: the affected values originate in the user's trusted local `.parcel.json`, the security-relevant rate-limit capacity is enforced **host-side** from the raw value (not via this schema), and NaN/Infinity cannot arrive from `jq`-emitted JSON. Recorded here for hygiene, not as a vulnerability.

**Coverage check for gaps:** The three subagents collectively covered the native host (signature/hash/whitelist/action/quoting/rate-limit/audit/framing), the extension runtime (ports/MV3/broadcast/postMessage/fill-target/storage/XSS), and config/packaging (manifest/CSP/plaintext/schema/selectors/packaging/signing/gitleaks). Cross-layer data-flow (host-injected `passdir` → extension config → integration endpoint) is exactly the seam the parallel split risked missing; the second-look explicitly traced it and produced F33T (with the corrected reachability). No layer was left unexamined, and the highest-risk native control (the whitelist exact-match) was independently re-verified by the reviewer.

---

## 8. Per-finding targeted follow-up

### F33T targeted follow-up — confirmed real, scope reaffirmed as LOW

Re-investigation: (a) confirmed `passdir`/`realPassdir` are injected by `src/parcel-host` (jq at the config-assembly point) and declared required/optional in `schema.js`; (b) confirmed the `config` handler returns `this.#config` wholesale and `integration` ports require no auth; (c) confirmed `integration.js` receives config into an isolated-world `Promise` and never writes it to page-readable space (only `postMessage`s `frameId`). **Outcome:** F33T is real as a gratuitous-info-disclosure/hygiene issue. Severity reaffirmed LOW (not a web-reachable attack; subsumed under compromised-extension damage class except for the marginal rate-limit-free OS-username correlator). The minimal-config-slice recommendation stands. No coupled issue found beyond the `realPassdir` path-obfuscation-defeat note already in the finding.

### F34M targeted follow-up — confirmed real, severity MEDIUM affirmed with caveats

Re-investigation: (a) confirmed `integration.js`'s broadcast `fill` handler has no origin guard (fills `msg.plaintext` into the best current root-frame target); (b) confirmed the agent broadcast fallback posts `{action:"fill", config, plaintext}` directly to `chrome.tabs.connect(tabId, {name:"broadcast", frameId:0})` with no origin check, gated on `token === "broadcast"` and a disconnected popup port; (c) confirmed the popup origin check is advisory-only (no `return`/abort after the `alert`). **Outcome:** F34M is real. The exploitability timing preconditions (slow decrypt + popup-port disconnect + cross-origin navigation into a fillable-target page) keep it at MEDIUM / Medium confidence rather than HIGH. **Coupled consideration:** the advisory-only nature of the *popup-path* origin check is itself borderline (a credential still flows to a mismatched origin after the user dismisses the alert); I folded this into F34M's recommendation rather than opening a separate finding, since both stem from the same "fills proceed without a hard destination-origin gate" gap. The accepted autofill-phishing tradeoff (fill into a page the user is willingly interacting with) does **not** cover the F34M redirect variant, because the user's intended origin (A) differs from the exfiltration origin (B).

---

## 9. Conclusion

No CRITICAL or HIGH remotely-exploitable vulnerabilities were identified in Parcel `v1.0.2`. The core security thesis — the native host, not the extension, enforces filesystem access, so a compromised extension cannot read non-whitelisted secrets — holds; the most security-critical native control (the exact-match whitelist) and the GPG signature/hash verification are sound and fail-closed.

Two findings are recorded:
- **F33T (LOW):** the `config` endpoint ships the full config (incl. the password-store home path) to unauthenticated integration ports. Reachable only under the compromised-extension model (where reading decrypted entries is already possible); worth fixing as defence-in-depth by minimising the config slice sent to content-script ports.
- **F34M (MEDIUM):** the broadcast fill path (especially the agent fire-and-forget fallback) performs no destination-origin validation. Combined with slow GPG decrypts and a wide default `decryptTimeout`, mid-decrypt navigation + popup-port death can route a decrypted credential intended for one origin into a different-origin page, bypassing the only (advisory, popup-path-only) cross-origin control. Recommend making the broadcast fallback destination-aware and aborting on origin mismatch, and strengthening the popup path's advisory check to a hard block for cross-origin mismatches.

The project's deliberate tradeoffs (plaintext bash host, optional `HOST_HASH`, default-allow-all visibility, all-URLs content injection, no clipboard auto-clear) are documented transparently and are, on balance, defensible for the stated threat model and the "complement, not replace, `pass`" scope. The strongest residual risk remains the combination of `HOST_HASH` being off by default and `parcelrc` being a `source`d (code-execution) trust root — both are documented and the latter is mitigated by the 0600 check — so the most impactful single hardening a security-conscious user can apply is enabling `HOST_HASH` and restricting `.parcel.json` rules.

---

*End of review.*


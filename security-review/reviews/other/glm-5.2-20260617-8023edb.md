# Security Review: Parcel Password Manager Extension

**Reviewer:** Copilot (GLM-5.2) automated security review
**Date:** 2026-06-17
**Commit reviewed:** `8023edb` (`8023edb68ad9fbf7bb66e90e22f4993168d9664a`)
**Scope:** Full source tree — `src/` canonical source, `parcel-host` bootstrap, `src/parcel-host` signed host, `manifest.json`, `SECURITY.md`, `CONSTITUTION.md`, `test/`.

## Prompt

This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Save this review to security-review-copilot-glm_5.2-20260617-8023edb.md.

## Executive Summary

Parcel is a browser extension that bridges the `pass` GPG password store to the browser for read-only credential search, viewing, and autofill. Its architecture is deliberately conservative: no third-party runtime dependencies, no transpilation, a plaintext bash native host, no network access (governance-enforced), and enforcement of filesystem limits on the host side.

The security design is sound and reflects thoughtful tradeoffs documented in `SECURITY.md` and `CONSTITUTION.md`. The most valuable property is **host-side enforcement of the whitelist**: even a fully compromised extension cannot decrypt entries outside `ALLOWED_FILES`, and re-validation of symlink policy at decrypt time closes a TOCTOU window that would otherwise allow symlink retargeting to exfiltrate files outside the store. The prior review cycle has already addressed the obvious hardening items (audit-log control-character stripping, field length caps, `parcelrc` 0600 enforcement, temporary keyring for verification, manifest CSP, `HOST_HASH` ordering fix).

This review identified **no critical or high-severity vulnerabilities**. A small number of low-severity observations and hardening opportunities are listed below. None are exploitable to read non-whitelisted passwords; they relate to defense-in-depth, robustness, and informed-user tradeoffs.

## Scope & Methodology

I examined:

- **Bootstrap host** (`parcel-host`): native-messaging protocol framing, GPG signature verification, `HOST_HASH` pinning, `parcelrc` sourcing, the `eval` of the installed main host script, and the `action_*` dispatch table.
- **Main signed host** (`src/parcel-host`): config loading, `action_list` enumeration & whitelist construction, `action_decrypt` path validation (including symlink policy and TOCTOU re-validation), audit logging, rate limiting, `action_changes_since`.
- **Service worker** (`src/js/agent.js`): native port management, port auth model, the broadcast fallback fill, history storage, entry matching, public-suffix handling.
- **Content script** (`src/js/integration.js`): target detection, popup triggering, broadcast autofill, cross-frame relay, cross-origin fill warning.
- **Popup** (`src/js/popup.js`): token handling, decryption requests, history persistence, detail view rendering.
- **Shared modules** (`src/js/helpers.js`, `plaintext.js`, `schema.js`, `selectors.js`, `shadow.js`): TOTP generation, plaintext parsing, schema validation, shadow-DOM shim.
- **Manifest** (`src/manifest.json`): permissions, CSP, `web_accessible_resources`, content-script world.
- **Tests** (`test/*.test.js`): 209 tests, all passing (`make test`).

I did not review the vendored `src/publicsuffix` subtree (per project convention) except to note that it is fetched at runtime from `public_suffix_list.dat`.

## Architecture & Threat Model Assessment

The security model in `SECURITY.md` is accurate and matches the implementation. Key properties verified:

### 1. Host-side whitelist enforcement is correctly implemented
`action_decrypt` rejects any path not present in the `ALLOWED_FILES` array (populated exclusively by `action_list`), and `/etc/passwd` etc. are correctly refused (test: `action_decrypt rejects out-of-scope path`). A compromised extension cannot influence `ALLOWED_FILES` directly because the array is a process-local bash variable populated from the host's own `find` output.

### 2. TOCTOU for symlinks is closed
`validate_decrypt_path_policy` re-walks the path components at decrypt time and re-checks `readlink -f` against `realPassdir`. The tests `revalidates symlink scope at decrypt time` and `revalidates link policy when a regular file is replaced by a symlink` confirm that retargeting a symlink to an external file between `list` and `decrypt` is rejected. This is a notably strong property — many credential managers would only check at list time.

### 3. GPG verification uses an isolated keyring
`action_install` creates a `mktemp` keyring and passes `--no-default-keyring --keyring`, so verified keys do not pollute the user's keyring (resolves the issue previously tracked under #46). The keyring and its backup file are removed on both success and failure paths.

### 4. `eval` of the installed host script is gated by signature + optional hash
The only path to `eval "$PARCEL_HOST"` runs after `action_install` has verified the detached GPG signature against `VALID_SIGNERS` and, if set, compared `HOST_HASH`. Because the bootstrap host is installed via the browser's native-messaging manifest (which points at a fixed path the extension cannot rewrite without OS-level access), and because the script + signature are extension-bundled resources fetched via `chrome.runtime.getURL`, an attacker who can replace those resources has already compromised the extension or the install. The `HOST_HASH` opt-in provides a meaningful additional pin for users who want to review updates.

### 5. Read-only by design
Neither the bootstrap nor the main host writes to user files other than `parcelrc` (only if absent) and the log file. `gpg --decrypt` uses `--output -` (stdout), so no intermediate plaintext files are written to disk.

## Findings

### F1 — Audit-log line assembly is unbounded in the `MESSAGE` slot when decryption fails with a long error

**Severity:** Low
**Location:** `src/parcel-host`, `audit_decrypt()` (lines 187–198)

**Description:**
`audit_decrypt` caps `INTENT`, `ORIGIN`, `FILE_PATH`, and `MESSAGE` to fixed lengths (`:0:128`, `:0:1024`, `:0:1024`, `:0:4096`). The `MESSAGE` value passed on the *success* path is the fixed string `"Success"`, but on failure paths it is a free-form string such as `"Denied (rate limit)"`, `"Denied (path out of scope)"`, `"File not found"`, `"Decryption failed"`. These are all constants set by the host itself, so they are not attacker-controlled. However, `FILE_PATH` is sourced from the extension message (`jq -r '.path'`), and while it is capped to 1024 bytes, a compromised extension could send a path approaching `jq`'s output length limits that, combined with the origin field, produces oversized log lines.

This was substantially addressed by the field-length caps added in #56 (and re-merged per the findings summary). The residual concern is minor: the *total* line length is not bounded, only the individual fields, and a malicious extension can still emit ~6KB per audit line. Given that audit logging is opt-in and rate-limited decryptions gate log entries, the realistic log-growth risk is low.

**Recommendation:** No change required. The existing per-field caps are adequate defense-in-depth. If desired, an overall line-length cap before the `>&5` write would be a trivial addition.

### F2 — `action_changes_since` conversion from epoch seconds relies on platform `date` parsing

**Severity:** Low (informational)
**Location:** `src/parcel-host`, `action_changes_since()` (lines 83–92)

**Description:**
The timestamp is validated against `^[0-9]{10}$` (requiring a 10-digit Unix epoch, which is valid from 2001-09-09 to 2286-11-20). It is then passed to GNU `date -d` with a macOS `date -j -f "%s"` fallback. Because the value is regex-validated to digits-only and is the caller's own `#entriesUpdated` timestamp (from `agent.js`), there is no injection surface — `date` receives a numeric string, not arbitrary input. This is a robustness note rather than a vulnerability.

**Recommendation:** No change. If future code paths allow a non-numeric `since`, the existing regex guard should be preserved.

### F3 — `parcelrc` is sourced as executable bash, which is a trusted execution boundary

**Severity:** Low (already acknowledged tradeoff)
**Location:** `parcel-host`, line 82 (`. "$PARCELRC"`)

**Description:**
`parcelrc` is sourced, so anyone who can write to `~/.config/parcel/parcelrc` (or replace it via a directory write) can execute arbitrary code as the user whenever the native host starts. This is documented in `SECURITY.md` and findings.md, and was hardened in #50 by enforcing `0600` permissions and refusing to load otherwise.

The residual surface is the *directory* containing `parcelrc`: if `~/.config/parcel` is writable by another user, they could replace a `0600` file via rename/rename-over. The bootstrap enforces the file mode but does not verify the directory mode or ownership. On a typical single-user macOS/Linux system the directory is user-owned and this is not an issue. On shared systems or where a misconfigured package manager created the directory world-writable, the check would be bypassable via replacement.

**Recommendation:** Optional hardening: additionally check that the `~/.config/parcel` directory is not group/world-writable (e.g., `[ "$(stat -c %a "$(dirname "$PARCELRC")")" -le 755 ]`). This is defense-in-depth and not exploitable in the normal install path.

### F4 — Broadcast (`token === "broadcast"`) autofill can be triggered by the toolbar shortcut without an explicit per-field binding

**Severity:** Low (deliberate UX tradeoff)
**Location:** `src/js/agent.js` (lines 342–347 fallback), `src/js/integration.js` (lines 438–465 broadcast target selection)

**Description:**
When the user invokes the toolbar command (`Ctrl/Cmd+Shift+F`), the agent sends a `fill` to the tab with `token === "broadcast"`. The content script in the top frame then scans for any "suitable" autofill target using a priority order (`totp` > `login` > `secret` > `cardholder`) and fills the first match it finds, plus related fields.

This is the intended broadcast-autofill behavior. The security-relevant property is that the popup still gates decryption (the user sees and selects the entry, which sends a `decrypt` action with `intent: "fill"`, and the agent forwards the plaintext to the frame via a `broadcast`-named port). The cross-origin warning (`alert()` in `popup.js` lines 461–471) fires when the filled field's origin differs from the tab's origin. As documented in findings.md, allowing the user to proceed past this warning is a deliberate choice for the power-user audience.

**Recommendation:** No change. This matches the documented model and the target audience.

### F5 — `web_accessible_resources` exposes the popup HTML and several JS modules to all origins

**Severity:** Low (acknowledged fingerprinting surface)
**Location:** `src/manifest.json` (lines 34–47)

**Description:**
The `web_accessible_resources` entry matches `<all_urls>` and includes `html/popup.html`, several JS modules, and the small logo. As noted in the prior review (and the maintainers' response), these are all required for the inline/context popup iframe, and narrowing the list would break functionality. The cost is that any website can probe `chrome.runtime.getURL("html/popup.html")` to detect the extension and fingerprint the user by extension ID. `SECURITY.md` lists this as an acceptable tradeoff.

A subtle additional consideration: exposing `js/helpers.js`, `js/schema.js`, etc. via `web_accessible_resources` means a malicious page can load and inspect these modules directly (e.g., to read selector/target definitions). This leaks no secrets — these files contain no credentials or store data — but it does give a page a slightly more detailed view of the extension's internals than strictly necessary. The popup HTML is the only resource that *must* be web-accessible (for the iframe `src`). The JS modules are loaded by the popup via `import(chrome.runtime.getURL(...))`, which works from within the extension's own popup context regardless of `web_accessible_resources`.

**Recommendation:** Optional: verify whether the JS modules (other than the popup HTML and its direct script) actually need to be in `web_accessible_resources`. If the popup loads them via `chrome.runtime.getURL` from its own extension origin, they may not need to be listed. This would reduce the fingerprinting/information surface. **Note:** This was previously assessed as not possible without breaking the extension; I flag it only as a re-verification opportunity, not a required change.

### F6 — Search regex is compiled from user input without ReDoS protection

**Severity:** Low (previously addressed; status quo accepted)
**Location:** `src/js/agent.js` `search()` (lines 486–496), `src/js/integration.js`/`popup.js` consumer

**Description:**
User-typed search terms are split on whitespace and each term is compiled as a `RegExp(term, "ui")` and tested against entry names. A pathologically-crafted term could cause catastrophic backtracking and transiently hang the service worker. As the maintainers noted in the prior review's response, this is self-inflicted DoS by the user on their own service worker and is considered acceptable.

I agree with that assessment. The only refinement I'd add: because the service worker holds the native-messaging port and any in-flight decryption promises, a sustained hang on a search would block subsequent decrypt calls until the worker is terminated for unresponsiveness (at which point Chrome restarts it). There is no data-loss or credential-exposure path here — only a transient availability impact self-imposed by the user.

**Recommendation:** No change.

## Verified Strengths

1. **Defense-in-depth is real, not nominal.** Whitelist enforcement, symlink re-validation at decrypt time, GPG signing with an isolated keyring, optional `HOST_HASH`, rate limiting, audit logging, and the read-only host model each independently limit the blast radius of a compromise. Failure of any one does not cascade.

2. **No third-party runtime dependencies** is enforced at both the constitution level and in practice: the extension is vanilla JS/HTML/CSS with no `node_modules`-sourced runtime code, no bundler, no transpiler. This removes the dominant supply-chain attack vector for browser extensions.

3. **Source/distribution parity** (`src/` === shipped code) makes independent user verification of the shipped artifact feasible, which is unusual and valuable for a credential-handling extension.

4. **The popup iframe runs in the extension origin** with a closed shadow root, and the content script never injects credential plaintext into the page's DOM as raw text — it sets `el.value` / `el.setAttribute("value", ...)` and dispatches synthetic input events. Plaintext is not written to `innerHTML` anywhere (verified: zero matches for `innerHTML`, `insertAdjacentHTML`, or `document.write` across `src/js`).

5. **Token authentication for popup ports** (`src/js/agent.js` lines 283–317) ensures that a `decrypt` or `match` request from a popup port is only honored if the token was previously registered via the `auth` port (which is only reachable from the content script's `authPort.postMessage(target._parcelToken)` on a genuine field click). A page cannot directly open the popup and drive decryption without a real user click on a detected field.

6. **The `parcel-frame-id` postMessage uses `"*"` as target origin** (`integration.js` line 68), but the payload is only a frame ID (a number) sent to `window.top`, and the receiver uses it solely to map an iframe element to a frame ID for popup positioning. No credential or sensitive data flows through this message, so the broad target is not a leak.

7. **Rate limiting defaults are conservative** (burst of 24, then ~1 per 150s) and correctly disabled only when a config value is explicitly `0`, not when missing (defaults apply when `null`). The token-bucket math uses millisecond timestamps and caps the bucket at capacity, preventing token hoarding.

## Deliberate Tradeoffs (Confirmed Acceptable)

The tradeoffs table in `SECURITY.md` accurately reflects the implementation. I specifically confirm:

- **Absent `.parcel.json` reveals all entries** — true; `load_config` injects `defaultRules: true` and a catch-all `{pattern: "."}` rule. The popup displays a persistent warning until a whitelist is configured. This is usability-vs-security and is well-communicated.
- **Inline autofill across origin boundaries is warning-only** — true; the `alert()` in `popup.js` allows the user to proceed. Appropriate for the declared security-conscious power-user audience.
- **Extension is detectable by websites** — true; see F5. Acceptable given the function.
- **No clipboard auto-clear** — true; avoids the `clipboardRead` permission. Reasonable.

## Test Coverage Assessment

The `make test` suite (209 tests, all passing) exercises the security-critical paths well:
- Bootstrap: signature/signer validation, `HOST_HASH` mismatch, oversized-message rejection, `parcelrc` permission enforcement, installer behaviour.
- Main host: whitelist filtering, symlink inclusion/exclusion (internal vs external), `TOCTOU` retargeting rejection, audit logging (enabled/disabled/control-char sanitising), rate limiting (allow/burst/disable).
- Path handling covers literal regex characters in store names, which validates that `jq`'s `@sh` quoting of paths into `ALLOWED_FILES` is robust.

One area with thinner coverage: the **`action_$ACTION` dispatch in the bootstrap** is not fuzzed for action-name characters that could be interpreted specially by bash function-name lookup (e.g., names containing `::` or hyphens). In practice the only actions are `install` (bootstrap) and the host-script actions, all alphanumeric/underscore, and `type -t "action_$ACTION"` would return empty for any non-matching name (falling through to "Unknown host action"), so this is not exploitable. I note it only for completeness.

## Recommendations Summary

| ID | Severity | Action |
|----|----------|--------|
| F1 | Low | No change; existing per-field caps are adequate. |
| F2 | Low | No change; regex guard is sufficient. |
| F3 | Low | Optional: verify parent directory mode of `parcelrc`. |
| F4 | Low | No change; documented UX tradeoff. |
| F5 | Low | Optional: re-verify whether JS modules need to be in `web_accessible_resources`. |
| F6 | Low | No change; self-inflicted, accepted by maintainers. |

## Conclusion

Parcel demonstrates a mature, defense-in-depth security posture with clearly documented and consistently implemented tradeoffs. The host-side enforcement model is the correct architectural choice for a credential bridge and is implemented carefully, including the difficult TOCTOU cases around symlinks. No vulnerabilities that would allow reading non-whitelisted credentials were identified. The findings above are low-severity hardening observations, most of which align with tradeoffs the maintainers have already explicitly accepted and documented.

---

*Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>*


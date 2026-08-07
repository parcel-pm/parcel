# Security Review: Parcel

- **Reviewer:** Copilot GPT-5.4
- **Date:** 2026-06-17
- **Repository state reviewed:** `7232b47cbf7a416dd8213c0db123b5baf8ab976b`
- **Scope:** `parcel-host`, `src/parcel-host`, extension manifest/runtime, relevant shared helpers, and security-focused tests

## Prompt

This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Save this review to `security-review-copilot-gpt_5.4-20260617-8023edb.md`.

## Executive summary

Parcel has a strong security posture overall. The project keeps the high-risk boundary small and explicit: the extension is plain-source MV3 code with a narrow permission set and explicit CSP, while filesystem and GPG access are delegated to a signed bash native host that applies whitelist, decrypt-time path revalidation, rate limiting, and optional audit logging on the host side (`src/manifest.json:8-45`, `package.json:4-7`, `parcel-host:115-160`, `src/parcel-host:95-183`, `src/parcel-host:201-323`).

I found **one new low-severity issue**: symlinked directories are still dereferenced during `list` and `changes_since` scans even when `allowLinks` is disabled, which weakens the "no arbitrary file access" boundary at the metadata/traversal level and creates a realistic denial-of-service vector via hostile or accidental external symlink trees (`src/parcel-host:90`, `src/parcel-host:99-117`, `src/parcel-host:155-168`, `src/parcel-host:261-279`). I did **not** identify any critical or high-severity issue that would let a compromised extension decrypt non-whitelisted entries or escape the browser/native-host trust model as currently implemented.

## Architecture and trust boundaries reviewed

| Area | Assessment | Evidence |
| --- | --- | --- |
| Extension runtime | Minimal runtime dependencies, explicit MV3 CSP, and no declared network APIs. The main browser risk is intentional `<all_urls>` injection and page interaction, which the docs correctly describe as a necessary tradeoff rather than a containment boundary. | `src/manifest.json:8-45`, `SECURITY.md:7-16`, `CONSTITUTION.md:51-77`, `package.json:4-7` |
| Bootstrap host | Trusts `parcelrc` as executable code, but constrains it with a `0600` mode check, signer allowlist, temporary GPG keyring, and optional `HOST_HASH` pinning before `eval` of the main host. This is a sharp boundary, but a clearly documented one. | `parcel-host:37-91`, `parcel-host:115-160`, `parcel-host:214-228`, `SECURITY.md:39-54`, `README.md:134-160` |
| Main native host | Correctly keeps whitelist enforcement and decryption on the host side. `action_decrypt` checks the cached allowlist, existence, and link policy again at decrypt time rather than trusting stale list state. | `src/parcel-host:95-183`, `src/parcel-host:261-323` |
| Browser-to-page boundary | Inline popup/token flow is reasonably careful: tokens are per-field, random, consumed once, and bridged only to the addressed frame. The toolbar "broadcast" path is intentionally broader and treated as a usability tradeoff. | `src/js/agent.js:112-135`, `src/js/agent.js:283-347`, `src/js/agent.js:382-416`, `src/js/integration.js:378-399`, `src/js/integration.js:424-539`, `SECURITY.md:77-88` |
| Local metadata persistence | History is stored only in `chrome.storage.local`, per-origin and per-container, but is only obscured with unsalted SHA-256 rather than treated as secret. This is deliberate and appropriately documented. | `src/js/popup.js:385-390`, `src/js/popup.js:603-610`, `SECURITY.md:69-76`, `security-review/findings.md:129-136` |

## Findings

### 1. Low: `allowLinks: false` does not stop symlink traversal during host scans

**What happens**

The host's entry-list and cache-invalidation scans follow symlinks **before** applying the configured link policy:

- `action_changes_since` always uses `find -L "$PASSWORD_STORE_DIR"` (`src/parcel-host:83-91`).
- `action_list` also starts with `find -L "$PASSWORD_STORE_DIR"` and resolves realpaths for all discovered candidates before filtering (`src/parcel-host:95-117`).
- Only later does the jq filter exclude symlink-derived entries unless `allowLinks` / `allowExternalLinks` permits them (`src/parcel-host:155-168`).
- `action_decrypt` correctly revalidates link policy at use time, so plaintext disclosure is still blocked (`src/parcel-host:261-323`).

**Why this matters**

This does not expose decrypted credentials or returned out-of-scope paths, but it does mean the native host still traverses filesystem content outside the password store even when the user has explicitly disabled link handling. That is weaker than the documented boundary:

- The constitution says Parcel must not have access to files the user has not explicitly whitelisted (`CONSTITUTION.md:101-107`).
- The security docs say a compromised extension is incapable of reading non-whitelisted files because the host enforces that boundary (`SECURITY.md:17-35`).
- The README says `allowLinks: false` should exclude symlinked entries (`README.md:185-188`).

Because `changes_since` feeds entry-cache invalidation in the background worker, an external symlink to a busy directory can keep the cache perpetually dirty and force repeated full rescans (`src/js/agent.js:245-259`). A symlink to a very large tree can also make ordinary popup usage unexpectedly expensive. In practice this is a **metadata/traversal and availability** problem, not a plaintext-exposure problem, so I rate it **Low**.

**Exploitation conditions**

An attacker needs a way to place a symlink inside the password store. That usually means control over store contents (for example, a malicious sync target, a compromised checkout, or local filesystem access). The issue is still worth fixing because the current behavior contradicts the intended semantics of disabling links.

**Recommended fix**

1. Stop using `find -L` in `action_list` and `action_changes_since` when links are disabled.
2. Enumerate entries without dereferencing first, then resolve only the specific symlink candidates that survive the `allowLinks` gate.
3. Make `changes_since` use the same policy as `action_list`, so disabled links cannot perturb cache invalidation.

## Deliberate tradeoffs reviewed and found acceptable

| Tradeoff | Review assessment | Evidence |
| --- | --- | --- |
| `parcelrc` is sourced as shell code | Acceptable given the project's "auditable plaintext host" goals, provided users treat `parcelrc` as a full code-execution boundary. The `0600` check, signer allowlist, and optional hash pin materially reduce accidental trust expansion. | `parcel-host:37-91`, `parcel-host:115-160`, `SECURITY.md:39-54`, `security-review/findings.md:105-110` |
| No network access is a governance rule, not a manifest sandbox | Correctly documented. With `<all_urls>` content scripts and page interaction, this cannot be made a strong technical boundary without giving up core functionality. | `src/manifest.json:8-45`, `SECURITY.md:7-16`, `security-review/findings.md:89-95` |
| Absent `.parcel.json` exposes all entries | Usability-first but explicitly surfaced to the user: the host injects a default allow-all rule, and the popup warns when default rules are active. | `src/parcel-host:58-64`, `src/js/popup.js:671-678`, `SECURITY.md:55-58`, `security-review/findings.md:97-103` |
| Cross-origin fill is warning-only | Deliberate power-user tradeoff. The popup does warn when the target frame's origin differs from the visible tab origin, which is the right minimum safeguard for this design. | `src/js/popup.js:461-470`, `security-review/findings.md:112-119` |
| Detectability / fingerprinting from web-accessible resources and MAIN-world shadow patch | Real but documented and seemingly unavoidable for the chosen UX. The implementation does not turn this into direct plaintext exposure on its own. | `src/manifest.json:14-45`, `src/js/shadow.js:3-30`, `SECURITY.md:84-87`, `security-review/findings.md:121-127` |
| History hashing is obscurity, not secrecy | Appropriate framing. The project does not pretend this metadata is secret and offers `saveHistory` as an opt-out. | `src/js/popup.js:385-390`, `src/js/popup.js:603-610`, `SECURITY.md:69-76`, `security-review/findings.md:129-136` |

## Positive security controls worth preserving

1. **Signed host bootstrap with optional content pinning.** The bootstrap verifies a detached signature in a temporary keyring, checks the signer fingerprint against `VALID_SIGNERS`, and can additionally require an exact `HOST_HASH` before evaluating the host (`parcel-host:123-160`). Tests cover both the hash mismatch and `parcelrc` permission gate (`test/native-host.test.js:326-405`).
2. **Host-side scope enforcement.** Entry visibility is computed on the native side, cached as exact allowed paths, and revalidated at decrypt time, including symlink-policy checks after list generation (`src/parcel-host:95-183`, `src/parcel-host:261-323`). Tests cover output filtering and decrypt-time revalidation for retargeted links (`test/native-host.test.js:635-780`).
3. **Useful damage-limiting controls.** The token-bucket limiter and optional audit log are implemented in the host, not the extension. Audit fields are stripped of control characters and length-capped per field (`src/parcel-host:187-241`). Tests cover audit logging, sanitization, and rate limiting (`test/native-host.test.js:792-972`).
4. **Careful browser-side data handling.** The popup and content script use `textContent` rather than HTML injection for user-controlled values, use clipboard write-only APIs, block top-level-broadcast popup embedding inside frames, and hash history keys before storing them (`src/js/popup.js:6-18`, `src/js/popup.js:109-117`, `src/js/popup.js:234-242`, `src/js/popup.js:385-390`, `src/js/popup.js:613-624`).
5. **Single-use field authorization for inline popup fill.** Content-script click handling generates a per-field token, sends it over an internal auth port, and the background consumes it on first popup authentication (`src/js/integration.js:378-399`, `src/js/agent.js:283-317`). This is a sensible defense against arbitrary extension-page port reuse.

## Residual risks that remain inherent to the design

- **Any page the user chooses to fill can receive the filled credentials.** That is fundamental to browser-integrated password managers, not a Parcel-specific bug. Parcel reduces some phishing risk with host-based entry scoping, hostname-biased search, field heuristics, and origin-mismatch warnings, but it cannot make arbitrary web content trustworthy (`SECURITY.md:17-25`, `src/js/agent.js:427-505`, `src/js/popup.js:461-470`).
- **The bootstrap trust chain is only as strong as signer trust and optional user pinning.** Without `HOST_HASH`, the bootstrap accepts any host version signed by an allowed key. That is a reasonable operational tradeoff, but users who want rollback resistance should enable the hash pin (`parcel-host:149-155`, `SECURITY.md:49-54`).

## Overall conclusion

Parcel is security-conscious, internally consistent, and unusually explicit about what it is and is not trying to defend against. The native host remains the critical trust boundary, and most of the important controls are correctly implemented on that side.

The only new issue I found is the **low-severity symlink-traversal-before-policy bug** in `action_list` / `changes_since`. Fixing that would bring the implementation back into line with the stated semantics of `allowLinks: false` and strengthen the project's "no arbitrary file access" story without changing the user-facing model.

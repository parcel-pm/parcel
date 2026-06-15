# Security review of Parcel

Date: 2026-06-14
Reviewer: GPT-5.4

## Prompt

This project is a password-management extension, intended to work with the 'pass' tool for the purposes of browser integration. Please provide a comprehensive security review of it, taking into account deliberate design decisions and tradeoffs. Save this review to security-review-copilot-$MODEL-$DATE.md.

## Executive summary

**Overall assessment: strong security architecture with two meaningful implementation issues and several deliberate tradeoffs that should stay highly visible to users.**

Parcel does a number of unusually good things for a browser password-management integration:

- It keeps the browser extension and native host small, readable, and auditable, with no third-party runtime dependencies and no hidden build output (`CONSTITUTION.md:43-112`, `README.md:5-8`, `src/Makefile:51-79`).
- It puts the main security boundary in the native host rather than trusting extension code. Whitelist enforcement, decryption, rate limiting, and audit logging all happen host-side (`src/parcel-host:51-323`).
- It treats shadow DOM, cross-frame UI, and autofill as first-class problems instead of hand-waving around them (`src/js/shadow.js:3-31`, `src/js/integration.js:15-540`, `src/js/popup.js:1-683`).

I did **not** find an obvious path for a compromised web page or a compromised extension to decrypt arbitrary non-whitelisted files. The host-side allowlist, decrypt-time symlink revalidation, and action-limited native protocol are the right core design (`src/parcel-host:95-183`, `src/parcel-host:243-323`, `test/native-host.test.js:649-749`).

The main concerns are:

1. **The bootstrap host verifies signatures with `--auto-key-import`, which can silently import attacker-controlled keys into the user's GPG keyring even when the signer is later rejected** (`parcel-host:115-129`).
2. **Audit log entries are built from unsanitized user-controlled fields, so logs can be forged or polluted by newline injection** (`src/parcel-host:186-198`, `src/parcel-host:283-323`).

Neither issue immediately breaks the native host's path-isolation model, but both weaken important security properties.

## Scope and threat model

This review focused on:

- Project security model and stated constraints (`CONSTITUTION.md`, `README.md`, `SECURITY.md`)
- Extension permissions and packaging (`src/manifest.json`, `Makefile`, `src/Makefile`)
- Native host bootstrap and main host logic (`parcel-host`, `src/parcel-host`)
- Browser-side coordination, popup/UI isolation, content-script behavior, and storage (`src/js/*.js`)
- Existing tests that validate security-sensitive behavior (`test/native-host.test.js`, `test/agent.test.js`, `test/integration.test.js`, `test/popup.test.js`)

Assumed attacker models:

- A malicious website visited by the user
- A compromised Parcel extension build
- A local attacker or local malware with access to the user's account

Out of scope:

- Security of GPG itself
- Security of the underlying browser
- Security of other installed extensions

## Strongest security properties

### 1. Host-side enforcement of password-store scope

This is the project's best decision. The extension never gets raw filesystem access; it can only ask the host for defined actions. `action_list` builds the allowed file set, and `action_decrypt` refuses anything outside that set (`src/parcel-host:95-183`, `src/parcel-host:283-315`). The tests cover out-of-scope access, missing files, symlink retargeting, and file-to-symlink replacement (`test/native-host.test.js:649-749`).

**Impact:** even a fully compromised extension should remain unable to decrypt arbitrary files outside the host-approved scope.

### 2. Defense in depth around native host updates

The extension ships the main host script and detached signature; the bootstrap host verifies the signature, extracts the primary fingerprint, checks it against `VALID_SIGNERS`, and can optionally pin an exact hash with `HOST_HASH` (`parcel-host:107-142`, `README.md:141-160`, `SECURITY.md:39-53`).

**Impact:** a hostile or tampered extension cannot simply swap in a new native host unless it also has a trusted signing key, and hash pinning gives advanced users an additional review gate.

### 3. Good minimization choices for a password extension

The manifest asks for only `nativeMessaging` and `storage`, not broad browser powers such as `scripting`, `tabs`, or clipboard read (`src/manifest.json:8-29`). The extension does not declare network permissions, and the project constitution explicitly forbids network access and third-party runtime dependencies (`CONSTITUTION.md:51-112`).

**Impact:** this materially shrinks both the supply-chain surface and the number of privileged browser APIs available to malicious extension code.

### 4. Sensible UI isolation for inline autofill

The inline popup is rendered inside a closed shadow root and uses an extension-origin iframe (`src/js/integration.js:304-359`). The popup refuses to run with the default `broadcast` token when embedded in a frame, explicitly treating framed embedding as potentially hostile (`src/js/popup.js:6-18`).

**Impact:** pages can detect that Parcel exists, but they cannot directly read the inline popup's DOM or script state.

### 5. Privacy-aware storage choices

Per-origin history is stored in `chrome.storage.local` using SHA-256 hashes of origin/container scope and entry path rather than storing those strings verbatim (`src/js/popup.js:385-390`, `src/js/popup.js:548-610`, `src/js/agent.js:69-77`).

**Impact:** this does not eliminate metadata leakage, but it is better than persisting cleartext site names and credential paths.

## Findings

## Finding 1: GPG auto-import lets rejected install attempts pollute the user's keyring

**Severity:** Medium
**Type:** Implementation issue

The bootstrap verifies the received host script with:

```bash
gpg --status-fd=1 --quiet --verify --trust-model always --auto-key-import ...
```

(`parcel-host:115-129`)

`--auto-key-import` causes GPG to import keys embedded in signature material before the code later checks whether the signer fingerprint is in `VALID_SIGNERS`. That means a compromised extension can repeatedly send signatures containing arbitrary public keys; the bootstrap will reject the signer, but the user's keyring may already have been modified.

### Why this matters

- It creates **persistent side effects from untrusted input** in a path that is supposed to be verification-only.
- It can be used for **keyring pollution / denial of cleanliness**, potentially making future GPG operations noisier or more confusing.
- It weakens the stated trust story: the project intends `VALID_SIGNERS` to be the trust anchor, but auto-import extends trust-related state before that check completes.

### Why this is probably a bug, not a tradeoff

Nothing in `README.md`, `SECURITY.md`, or `CONSTITUTION.md` frames "import new keys from install attempts" as intended behavior. The documented model is "verify against trusted signers", not "learn new signers automatically" (`SECURITY.md:39-53`).

### Recommendation

Remove `--auto-key-import` from the verification command. If key distribution is needed, document a one-time manual import step for trusted release keys instead.

## Finding 2: Audit logs can be forged or polluted through unsanitized fields

**Severity:** Medium
**Type:** Implementation issue

When `auditDecrypt` is enabled, the host logs:

```bash
echo "[$TIMESTAMP] DECRYPT $INTENT $ORIGIN $FILE_PATH: $MESSAGE" >&5
```

(`src/parcel-host:186-198`)

`INTENT` and `ORIGIN` come from the extension request (`src/parcel-host:285-287`), and `FILE_PATH` is also included verbatim. These values are not sanitized before being written.

### Why this matters

If an attacker controls extension code, or can otherwise cause hostile values to reach the host, they can inject line breaks or confusing text into the log. That lets them:

- Forge apparent success or failure entries
- Hide real decryption attempts in noisy output
- Break downstream log parsing

This is especially important because audit logging is presented as a security feature (`SECURITY.md:59-62`).

### Recommendation

Escape or strip control characters before writing log fields, especially `\r` and `\n`. If practical, log JSON lines instead of free-form text.

## Finding 3: "No network access" is a governance rule, not a technical containment boundary

**Severity:** Medium
**Type:** Deliberate tradeoff

The project is explicit that no-network behavior cannot be technically enforced in the manifest because the extension needs `<all_urls>` to operate (`SECURITY.md:7-15`, `SECURITY.md:77-86`, `src/manifest.json:8-29`).

That is accurate, and the code I reviewed does not make remote requests. The only `fetch()` calls I found are for extension-packaged assets (`src/js/agent.js:43-46`, `src/js/agent.js:515-517`). Still, once the extension is compromised, the browser-side code can in principle talk to the network even though the project constitution says it must not.

### Why this matters

This weakens one of the review's most important conclusions:

- The host still protects non-whitelisted files.
- But **a compromised extension can exfiltrate any decrypted or visible data it obtains** because the browser cannot technically prevent outbound requests in this design.

### Assessment

This is not a bug in the code. It is a real and well-documented limitation of the platform and design.

### Recommendation

Keep treating "no network access" as a review and release-discipline requirement, not as a sandbox guarantee. Users who need stronger technical containment should understand that the native host is the real boundary, not the extension runtime.

## Finding 4: Default visibility is intentionally permissive and increases blast radius

**Severity:** Medium
**Type:** Deliberate tradeoff / secure-default weakness

If `.parcel.json` is absent, the host injects default rules allowing the full store:

- Documentation: `README.md:165-168`, `SECURITY.md:55-58`, `SECURITY.md:81-85`
- Implementation: `src/parcel-host:53-65`
- UI warning: `src/js/popup.js:671-678`

### Why this matters

This does not violate the architecture, but it materially increases impact if either:

- the extension is compromised, or
- the user uses Parcel on a malicious page and approves a decryption they should not have

In that state, the host still protects the rest of the filesystem, but the **entire password store** becomes fair game.

### Assessment

This is a conscious usability tradeoff, not a hidden flaw. The warning in the popup helps, but it is reactive and easy to ignore.

### Recommendation

If the project wants a stronger default stance without breaking first-run usability, a good compromise would be:

- keep read access disabled until the user explicitly confirms broad visibility, or
- require a generated starter `.parcel.json` on first use.

If the current design stays, this tradeoff should remain prominently documented.

## Finding 5: `parcelrc` is a trusted code-execution boundary and should be treated as such

**Severity:** Medium for local compromise, Low in remote threat models
**Type:** Deliberate tradeoff

The bootstrap host sources `~/.config/parcel/parcelrc` directly as bash:

```bash
. "$PARCELRC"
```

(`parcel-host:24-70`, `SECURITY.md:91-103`)

This is by design: the file is used to set binary paths, signer trust, log location, and optional host hash. But it also means any process that can write that file gets arbitrary code execution inside the native-host process.

### Why this matters

- It expands the local trust boundary beyond the repository code itself.
- It means `parcelrc` deserves the same care as shell startup files or GPG configuration.

### Assessment

This is acceptable for a power-user, local-tool design, but it should be treated as an explicit trust boundary rather than just "configuration".

### Recommendation

- Document recommended permissions (for example, user-writable only).
- Consider warning if the file is group/world writable.

## Finding 6: Inline autofill across origin boundaries is warning-only

**Severity:** Low to Medium, depending on phishing assumptions
**Type:** Deliberate tradeoff

When the popup connects to a target field, the content script reports the field's real frame origin (`src/js/integration.js:479-487`). If that origin differs from the top-level tab origin, the popup shows a warning dialog (`src/js/popup.js:461-470`), but it does not block filling.

### Why this matters

This is better than silently filling cross-origin frames, but it still relies on the user making the right decision at the moment of risk. A deceptive top-level page embedding a sensitive-looking frame could still receive credentials if the user ignores or misunderstands the warning.

### Assessment

This is a UX/security tradeoff, not an implementation bug. It preserves flexibility for legitimate embedded login flows.

### Recommendation

Consider making this behavior configurable:

- warn only (current behavior)
- require explicit second confirmation
- block cross-origin frame fills entirely

## Finding 7: `web_accessible_resources` is broader than necessary and enables easy fingerprinting

**Severity:** Low
**Type:** Hardening opportunity

The manifest exposes `popup.html`, images, and several JS modules as web-accessible to `<all_urls>` (`src/manifest.json:30-44`).

### Why this matters

Any web page can probe those resources to detect that Parcel is installed. The page cannot use that alone to steal secrets, but it helps targeted phishing and extension fingerprinting.

The risk is partially mitigated by the popup's refusal to run in framed `broadcast` mode (`src/js/popup.js:6-18`), but the exposed surface is still wider than strictly necessary.

### Recommendation

- Reduce `web_accessible_resources` to the minimum required for the inline popup
- Consider `use_dynamic_url` if supported by the target browsers

## Finding 8: History metadata is obscured, not truly secret

**Severity:** Low
**Type:** Privacy tradeoff

History is stored using SHA-256 hashes of origin, container scope, and entry path rather than plaintext (`src/js/popup.js:385-390`, `src/js/popup.js:548-610`). This is good practice, but the hashes are unsalted.

### Why this matters

A local attacker with access to the browser profile, or malicious extension code with storage access, can still dictionary-attack likely domains and entry paths. This is a privacy improvement, not strong secrecy.

### Recommendation

This is probably acceptable as-is. If desired, the project could add a per-profile random salt stored locally, but that would complicate portability and recovery.

## Finding 9: `HOST_HASH` resolution order is fragile on systems that rely on `parcelrc` PATH changes

**Severity:** Low
**Type:** Reliability/security-control robustness

The bootstrap resolves `sha256sum`/`sha256` before sourcing `parcelrc` (`parcel-host:60-66`), but the generated sample config explicitly suggests adding Homebrew paths there (`parcel-host:34-35`, `README.md:151-160`).

### Why this matters

If a user relies on `parcelrc` to put the hash tool on `PATH`, `HOST_HASH` can fail in confusing ways or become unavailable when the user expects it to work.

### Recommendation

Resolve the hash binary after sourcing `parcelrc`, and emit a clear error if `HOST_HASH` is set but no usable hash tool exists.

## Design decisions that I think are good

These are risky-looking choices that are justified by the design:

### Signed `eval` in the bootstrap host

`eval "$PARCEL_HOST"` is scary in isolation (`parcel-host:193-207`), but here it is the explicit mechanism for loading a signed, plaintext, auditable host script. Given the constitution's anti-obfuscation goals, I think this is a coherent choice.

### MAIN-world shadow interception

Patching `Element.prototype.attachShadow` and listening in the page world (`src/js/shadow.js:3-31`) expands the interaction surface, but it is a practical way to make autofill work inside real-world shadow DOM. The alternative would be poorer site compatibility or a much more invasive design.

### Host-side symlink policy

The combination of:

- allow/deny flags for symlinks
- real-path checks during listing
- decrypt-time revalidation

is the right shape for this problem (`src/parcel-host:117-177`, `src/parcel-host:243-315`, `test/native-host.test.js:573-749`).

## Recommended priority order

### High priority

1. Remove `--auto-key-import` from bootstrap verification.
2. Sanitize audit-log fields before writing them.

### Medium priority

3. Make `parcelrc`'s trust implications and recommended permissions explicit.
4. Improve `HOST_HASH` robustness by resolving hash tooling after sourcing `parcelrc`.
5. Decide whether cross-origin frame fills should remain warning-only.

### Low priority

6. Trim `web_accessible_resources`.
7. Consider optional salting for stored history metadata.

## Final assessment

Parcel is **better designed than most browser password-extension integrations** because it puts the critical security boundary in a small, auditable native host and enforces scope there. That is the right architectural decision, and the tests show real effort to validate the security-sensitive parts.

The project's biggest residual risks are not "arbitrary file decryption" or "remote code execution through a web page". They are:

- **trust-management sharp edges** around host bootstrapping and local configuration,
- **blast-radius tradeoffs** when users expose too much of their store,
- and **browser-platform realities** that prevent "no network" from being a hard runtime guarantee.

I would be comfortable describing the current state as **architecturally strong, with two medium-severity issues worth fixing promptly and several well-understood tradeoffs that should remain clearly documented**.

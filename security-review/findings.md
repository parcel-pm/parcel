# Security Review Findings

This document outlines the findings from security reviews conducted on the project, and the maintainers' responses to them.

## [security-review-copilot-kimi_K2.6-20260615-293a1b2.md](reviews/security-review-copilot-kimi_K2.6-20260615-293a1b2.md)

Automated security review using Copilot / Kimi K2.6, conducted on June 15, 2026 against commit 293a1b26d76510e53a89608ceb4979c47260f5f9.

New findings are listed below. Existing findings from the previous review are omitted, as they are already listed in the section for that review.

### Log-bloating via unbounded audit-log fields

**Description:** The audit log strips control characters but does not limit the length of fields such as `FILE_PATH`, `INTENT`, or `ORIGIN`,
which could allow a compromised extension to cause unbounded log growth.

**Response:** Added length limits to these fields in #56.

### No Content Security Policy declared in manifest

**Description:** The extension relies on the browser's default MV3 CSP rather than an explicit declaration.

**Response:** Added CSP to manifest in #55.

### Search regex ReDoS risk in service worker

**Description:** User-provided search terms are compiled as regular expressions without length limits or ReDoS checks, which could
transiently hang the service worker.

**Response:** If the user wishes to DoS themselves via a typed regular expression, that's on them ;-). The status quo is therefore
acceptable.

### `shadow.js` runs in MAIN world and patches global prototype

**Description:** `shadow.js` patches `Element.prototype.attachShadow` in the page's JavaScript realm, which increases detectability and
exposes a small interference surface.

**Response:** This is considered an acceptable tradeoff. The patch supports core functionality, and alternatives have significant
performance penalties.

## [security-review-copilot-gpt_5.4-20260614-v1.0.0.md](reviews/security-review-copilot-gpt_5.4-20260614-v1.0.0.md)

Automated security review using Copilot GPT 5.4, conducted on June 14, 2026 against the v1.0.0 release.

There are no unaddressed findings remaining from this review.

### GPG auto-import lets rejected install attempts pollute the user's keyring

**Description:** `gpg --auto-key-import` pollutes the user's keyring with release keys when verifying the host signature.

**Response:** Resolved in #46 by using a temporary keyring for signature verification.

### Audit logs can be forged or polluted through unsanitized fields

**Description:** Some audit fields are passed from the extension directly to the audit log contents, which could allow an attacker to forge
or pollute audit log entries.

**Response:** Resolved in #48 by stripping control characters from audit log fields.

### "No network access" is a governance rule, not a technical containment boundary

**Description:** The "no network access" rule is a governance rule that relies on user compliance, and is not a technical containment
boundary.

**Response:** This is addressed in [SECURITY.md](../SECURITY.md), and is a deliberate tradeoff. It is not possible to technically enforce
no network access and also allow the extension to interact with the page. This is therefore enforced at a policy level during code review.

### Default visibility is intentionally permissive and increases blast radius

**Description:** If the user has not configured a whitelist, the extension will provide a default that shows all entries in the password
store.

**Response:** This is addressed in [SECURITY.md](../SECURITY.md), and is a deliberate tradeoff for the sake of usability. The popup will
display a persistent warning at the top (immediately above the search bar) until the user configures a whitelist.

### parcelrc is a trusted code-execution boundary and should be treated as such

**Description:** The `.parcelrc` file is sourced as executable code, in a similar manner to a `bashrc` file.

**Response:** This is deliberate, but has been hardened further in #50 by enforcing an 0600 permission on `parcelrc` and refusing to load if
this constraint is not met.

### Inline autofill across origin boundaries is warning-only

**Description:** The extension will warn (via `alert()`) if a user tries to fill into an origin that doesn't match the tab (e.g. iframe
login forms), but still allows users to proceed with filling anyway.

**Response:** This is deliberate. The target audience for this extension is security-conscious power users, and it is assumed that they are
competent enough to make their own choice regarding whether proceeding with the fill is an acceptable action. The protection approach here is
therefore to ensure that they are aware of the situation, and then get out of the way.

### `web_accessible_resources` is broader than necessary and enables easy fingerprinting

**Description:** The extension's `web_accessible_resources` is broader than necessary, which allows any website to detect the presence of
the extension and fingerprint users based on the extension's unique ID.

**Response:** The listed files are all required by the popup. Narrowing this list is not possbile without breaking the extension.
The resulting fingerprint surface is considered an acceptable tradeoff to allow the extension to function.

### History metadata is obscured, not truly secret

**Description:** The extension's history uses an unsalted hash of the origin / scope and the entry path. This allows an attacker with access
to local storage to brute-force which entries have been used on which origins.

**Response:** This is deliberate. The history is convenience metadata, not a secret, and adding salting or encryption would simply be an
obfuscation measuer that would give a false sense of security. Users who are concerned about this can disable history entirely via the
`saveHistory` configuration option.

### `HOST_HASH` resolution order is fragile on systems that rely on `parcelrc` `PATH` changes

**Description:** The bootstrap looks for the sha256 binary before loading `parcelrc`, which means that `parcelrc` cannot set the `PATH` for
this operation.

**Response:** Resolved in 49 by moving the sha256 setup to after `parcelrc` is loaded.

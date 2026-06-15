# Security

This document describes Parcel's security model, the deliberate tradeoffs it makes, the protections it provides, and the configuration options available to harden your installation.

## Security Model

Parcel is designed as a **read-only bridge** between your browser and an existing `pass`-style GPG-encrypted password store. It deliberately minimizes attack surfaces by following several core rules:

1. **No network access** — The extension does not communicate over the network, for any reason. There is no telemetry, no update checks, etc. Note that as Parcel requires an all-URLs permission in order to operate, *there is no way to technically enforce this via the manifest*. This is a security measure enforced by humans during the development process and is intended to remove the potential attack surface that can be exposed by the use of remote resources: it is not a technical measure to contain an attack in progress.
2. **No third-party runtime dependencies** — The browser extension is written in vanilla JavaScript, HTML, and CSS. This avoids exposure to supply chain attacks against such dependencies, which is unfortunately becoming an increasingly common threat vector.
3. **Clear, human-auditable source** — No part of Parcel is transpiled, bundled, or minified, which means the code that ships to users is identical to the code in this repository, and this *can easily be directly verified by the user*. This includes the native host, which is implemented as a plaintext bash script.

    In order to maintain the spirit of the no-external-dependencies rule, the native host will only call standard shell utilities (you should not need to install anything extra), and will try to minimise the number of those it makes use of.
4. **Read-only by design** — Parcel never creates, edits, or deletes any filesystem item other than its own dedicated log file and a template parcelrc (if missing at startup).
5. **Defense in depth** — Parcel attempts to provide safeguards at a number of different levels, and avoids single points of security failure where possible. Whitelist-based access, GPG signature verification, optional hash pinning, rate limiting, and audit logging all overlap so that a failure in one layer does not automatically compromise the whole system.

### What a compromised extension can and cannot do

Because the native host (not the extension) enforces the limits on filesystem access, a fully compromised browser extension is still **incapable** of reading non-whitelisted files. However, there are other malicious things a compromised extension is still capable of. The most damage a compromised Parcel extension can do is:

- Read entries that are already whitelisted in `.parcel.json`.
- Interact with the native host within the constraints of the supported action set.
- Interact with the web pages you visit.
- Interact with network resources.
- Interact with other potentially vulnerable extensions.

It **cannot**:

- Decrypt arbitrary files.
- Decrypt password entries that have not been whitelisted.
- Access or use your GPG key (other than to decrypt whitelisted password entries).
- Access or modify arbitrary files on disk.
- Execute anything outside of the browser sandbox.
- Modify your password store or host configuration.
- Modify your parcel configuration.

## Protections

### GPG signature verification

The bootstrap host (`parcel-host`) receives the main host script (`src/parcel-host`) from the browser extension via the native-messaging protocol. Before executing that script, the bootstrap host:

1. Verifies the GPG detached signature shipped alongside the script.
2. Extracts the primary fingerprint from the GPG status output.
3. Checks that the fingerprint is present in the `VALID_SIGNERS` list configured in `~/.config/parcel/parcelrc`.

If any step fails, the script is discarded and the host refuses to start.

### HOST_HASH pinning

Even after signature verification, you may wish to pin the exact contents of the main host script. Setting `HOST_HASH` in `parcelrc` to the SHA-256 hash of `src/parcel-host` causes the bootstrap host to compute and compare the hash before execution. If the hash does not match, the host reports an error with the new hash and exits, giving you the opportunity to review the updated script before updating the pinned value.

This is an **opt-in** defence-in-depth measure. It is not set by default because it requires manual intervention on every update. However, as the native host has shell access to your system outside of the browser sandbox, it is ***strongly*** recommended that you enable this feature.

### Whitelist-based entry visibility

The native host reads `$PASSWORD_STORE_DIR/.parcel.json` to determine which password-store entries are visible to Parcel. Rules are evaluated on the host side, so the extension cannot bypass them. If `.parcel.json` is absent, the host defaults to making **all** entries visible. Users who want to restrict visibility should create an explicit rule set, and doing so is highly recommended.

### Audit logging

Enabling `auditDecrypt: true` in `.parcel.json` causes the native host to log every decryption request—whether successful or failed—to the log file configured in `parcelrc` (`LOGFILE`). The log lines include the timestamp, entry path, intent (`fill` or `detail`), origin URL, and result. Plaintext credentials are **never** written to the log.

### Decryption rate limiting

The native host uses a token-bucket rate limiter to restrict how frequently password entries can be decrypted, with the aim of reducing the potential damage in the event of a successful exfiltration attack. Each decryption costs one token. The bucket holds up to `decryptBucket` tokens and refills at `decryptRate` tokens per second. With the defaults (`decryptBucket: 24`, `decryptRate: 0.006667`), the host allows an initial burst of 24 decryptions and then sustains roughly one decryption every 150 seconds thereafter.

Setting either `decryptBucket` or `decryptRate` to `0` disables rate limiting entirely.

### Storage isolation

The extension stores per-origin history and settings in `chrome.storage.local`. This storage is isolated per browser profile and, on Firefox, respects Multi-Account Containers. No data is persisted outside the browser's own storage sandbox, and this storage is not synchronised to browser sessions on other systems.

### Configuration isolation

The entirety of Parcel's configuration lives in a `.parcel.json` file at the root of your password store directory. By design, Parcel is incapable of modifying its own configuration file—the host script will read it, but contains no API endpoint to modify it. There are no modifiable settings within the browser extension itself.

## Deliberate Tradeoffs

| Tradeoff | Rationale |
|----------|-----------|
| **Plaintext bash host instead of a compiled binary** | Auditable source is prioritised over obfuscation or speed. A compiled binary could hide malicious behaviour that would be obvious in a shell script. |
| **HOST_HASH is off by default** | Requiring every user to maintain a hash pin would create significant friction and support burden. Users who want the extra assurance can enable it, and are recommended to do so. |
| **Absent `.parcel.json` reveals all entries** | An empty password store is not a useful default. Users who want restriction must opt in by creating the file. |
| **Content script injected into all URLs** | Parcel needs to detect form fields before the user interacts with them. The `host_permissions` and `content_scripts` declarations in `manifest.json` are scoped to `<all_urls>`, which is the only way to support arbitrary login pages. The content script does not execute remote code and does not communicate externally. |
| **Entry rules do not use dereferenced paths** | For portability and usability, file paths are not dereferenced prior to evaluating them against the whitelist / ignore rules. Users should not enable either of the symlink options unless they are certain that all links within the scope of their whitelisting rules are trustworthy. |
| **No clipboard auto-clear** | Automatically clearing the clipboard after copying credentials requires first *reading* the clipboard to ensure that the data to be cleared is still present. In order to avoid holding a `clipboardRead` permission, which would be a notable additional attack surface, Parcel does not implement this feature. |


## Security-Related Configuration

### `parcelrc` options

Located at `~/.config/parcel/parcelrc`. This file is sourced as a bash script on host startup.

| Option | Description |
|--------|-------------|
| `VALID_SIGNERS` | Space-separated list of GPG fingerprints trusted to sign the main host script. |
| `HOST_HASH` | Optional SHA-256 pin of `src/parcel-host`. When set, the bootstrap host refuses to execute updated host scripts until the pin is updated after review. |
| `GPG` | Path to the GPG binary (default: `gpg`). |
| `JQ` | Path to the `jq` binary (default: `jq`). |
| `LOGFILE` | Destination for host logging (default: `~/.local/log/parcel-host.log`). |
| `PASSWORD_STORE_DIR` | Root of the `pass` password store (default: `~/.password-store`). |

### `.parcel.json` options

Located at `$PASSWORD_STORE_DIR/.parcel.json`. Reloaded automatically when modified.

| Option | Description |
|--------|-------------|
| `rules` | Array of visibility rules evaluated on the host. Entries are visible only if they match at least one non-ignored include pattern and do not match any ignore pattern. |
| `auditDecrypt` | Log every decryption attempt (default: `false`). |
| `allowLinks` | Include symlinked entries in the entry list (default: `false`). |
| `allowExternalLinks` | Include symlinks pointing outside the password store (default: `false`; requires `allowLinks`). |
| `cacheTTL` | Seconds the extension caches the entry list before re-querying the host (default: `10`). |
| `decryptTimeout` | Seconds before a decryption request is aborted (default: `60`). |
| `decryptBucket` | Token-bucket capacity for decryption rate limiting. Each decryption costs one token (default: `24`). |
| `decryptRate` | Token refill rate in tokens per second for decryption rate limiting (default: `0.006667`; i.e. 24 per hour). |
| `additionalSelectors` | Custom DOM selectors to augment built-in field detection. |
| `additionalTargets` | Custom target mappings for extracting and filling credential data. |
| `targets` | Complete replacement for built-in target extraction rules. |

## Security Reviews

Parcel is subject to regular automated security reviews in order to surface any potential vulnerabilities. These reviews, along with a summary of findings and the maintainers' responses, are published in the `security-reviews` directory in this repository.

Where a review is conducted against a specific release, that review is included in the release artifacts on GitHub.

If you are a security professional who is interested in contributing to the project by performing a review, please open a new issue to coordinate this.

## Reporting Security Issues

If you discover a security vulnerability in Parcel, please open a GitHub issue for it. If the vulnerability is serious, please report it privately to the core maintainers listed in [`CONSTITUTION.md`](CONSTITUTION.md) so that it can be addressed before public disclosure. Vulnerabilities should be reported with a clear description of the issue, the steps to reproduce it, and the version affected.

Please do ***NOT*** report any vulnerability without first verifying that it is real (i.e. don't blindly report the result of automated tools), and without first searching to check if there is already an existing issue for that vulnerability.

## Related Documents

- [`CONSTITUTION.md`](CONSTITUTION.md) — Governance principles, including the prohibition on third-party dependencies, compiled native hosts, and network access.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution guidelines with security requirements for submitters.
- [`README.md`](README.md) — General project documentation, including installation and configuration examples.

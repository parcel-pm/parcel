# Parcel Security Review - Merged (kimi-k3 + glm-5.3)

**Release review of Parcel v1.0.7** (commit `099857c`, exactly at tag `v1.0.7`, clean working tree), conducted 2026-09-12 by both models independently - each completing the standard two-phase protocol including cross-verification - and merged 2026-09-12.

## Executive Summary

Parcel v1.0.7 is in strong security shape. Neither model identified any CRITICAL or HIGH vulnerability. The merged record carries nine findings: one MEDIUM (severity disputed - see Disagreements), six LOW, and two INFORMATIONAL. Every finding was reported by both models: seven originated with glm-5.3 in Phase 1 and were confirmed by kimi-k3 during cross-verification (one with a severity dispute, one with a partial dedup against F50I), and two originated with kimi-k3 in Phase 1 and were confirmed by glm-5.3. There were no non-reproductions and no finding-level disputes.

The single most important takeaway (both models agree): **the `passkey` runtime port is the one privileged action that never received the authorisation gate that `decrypt`/`match` gained in #69** (F59M). Any extension context can enumerate passkey entries and obtain assertion signatures without the consent popup, contradicting SECURITY.md's absolute claim that "there is no API for signing without the popup". glm-5.3 rates this MEDIUM; kimi-k3 rates the same behaviour LOW; the canonical ID carries M and both positions are recorded verbatim in Disagreements.

The host-side enforcement boundary held up under every attack attempted by either model: the whitelist, the rate limiter (including its new atomic state lock), signer revocation, rpId binding, the passkey content-marker backstop, and the new v1.0.7 parcelrc/environment hardening all survived live adversarial testing, and all previously-fixed findings were verified intact.

Key strengths (both models):

- The native host is a genuine enforcement boundary, not theatre: whitelist, rate limiter, rpId binding, allowCredentials, passkey classification with content-marker backstop, and decrypt-time link revalidation all re-derive everything from untrusted input.
- The v1.0.7 parcelrc whitelist parser is canonical-line-only and injection-proof by construction (PoC-verified by glm-5.3; live-verified by kimi-k3), combined with the environment whitelist and privileged re-exec.
- Zero XSS sinks in the extension codebase; every store-controlled value renders via `textContent`/`createTextNode`.
- Regression discipline: all prior fixes verified intact by both models (glm-5.3: 29 findings; kimi-k3: 32, additionally covering F25T and F41L), with adversarial regression tests for the most dangerous past bug (F52C/F56L).
- Source/distribution parity is real: kimi-k3 verified the built `chrome/` and `firefox/` bundles byte-identical to `src/`; glm-5.3 verified byte-identical apart from two documented, behaviour-preserving manifest rewrites.
- The security-warning system (#177) turns accepted tradeoffs (unpinned host, disabled audit/rate-limit) into in-UI prompts rather than silent defaults.

Key weaknesses:

- The ungated `passkey` port (F59M) - the one privileged action missing the #69 gate class.
- Newline-embedded store filenames inject phantom whitelist entries and can wedge the host (F60L).
- Documentation drift against absolute phrasings (F62L, F67I) and an undocumented build-signing dependency that blocks the documented from-source path (F63L).
- Supply-chain hygiene gaps in dev/test tooling (F64L) and test-coverage gaps for fixed gates (F65L, F66I).

Finding counts by severity (canonical): 0 CRITICAL / 0 HIGH / 1 MEDIUM / 6 LOW / 2 INFORMATIONAL.

Finding counts by provenance: found by both models - 9 (7 originated by glm-5.3 and confirmed by kimi-k3; 2 originated by kimi-k3 and confirmed by glm-5.3); found by one model only - 0; disputed - 1 severity dispute (F59M) and 0 finding-level disputes (on F66I, kimi-k3 confirmed two of the four halves and deferred the other two to F50I's already-noted residuals rather than disputing them).

Test suites: glm-5.3 reports `make test` passing 555/555 (32 suites) and `make test-setup` 40/40; kimi-k3 reports 595/595 across all 16 suites plus the setup suite. Both figures are presented as stated by each model; the merge editor did not reconcile them.

## Findings

Findings are deduplicated and severity-ordered. Each carries its canonical ID (continuing the global sequence in `findings.md`, which ended at F58L), a provenance tag, the mapping to each model's source finding ID, and a consolidated analysis assembled from both reports. Where the two reports cite slightly different line ranges for the same code, both are given.

### F59M - `passkey` runtime port has no authorisation or consent gate (MEDIUM; severity disputed)

**Provenance:** both models - originated by glm-5.3 (Phase 1); behaviour confirmed by kimi-k3 in cross-verification. Severity disputed: glm-5.3 rates MEDIUM (High confidence); kimi-k3 rates LOW (facts certain, Medium confidence on the severity question). Canonical severity M selected by the merge editor; see Disagreements.
**Mapping:** glm-5.3-1 ≡ kimi-k3-7L.
**Threat model:** TM2, TM0 (both models). TM1 is not reachable: pages cannot open extension ports, so the page-facing claim "a page cannot silently authenticate you" remains true.

**Description.** The #69 port hardening gave `decrypt`/`match` a two-part gate: they are reachable only from `popup`-named ports, and those ports must authenticate with a token from `#authorisedTokens`, the literal `broadcast`, or a pending http-auth challenge. The `passkey` action - the only action that exercises a passkey's private key - has no equivalent gate at all. `PORT_ACTIONS` grants `passkey: ["passkey"]` (src/js/agent.js:768-773), and the authorisation block applies only to `popup`-named ports (src/js/agent.js:778-808; kimi-k3 cites 779-806), so any extension context can `chrome.runtime.connect({name: "passkey"})` and directly invoke `phase: "candidates"` (enumerate passkey entry names/paths for any claimed rpId; src/js/agent.js:937-975), `phase: "assert"` (sign an assertion over a caller-supplied `clientDataJSON`; src/js/agent.js:976-1002), and `phase: "create"` (mint a credential). The consent popup is enforced only by the *caller* (integration.js builds the ceremony binding and waits for the popup's `passkey-assert` message); the port handler itself performs no consent verification. `#validateRpId` (src/js/agent.js:1416-1441) checks only the internal consistency of the two message-supplied strings `origin` and `rpId`; the host then enforces whitelist membership, passkey classification, entry-rpId == request-rpId, `allowCredentials`, and the rate limit (src/parcel-host:843-980 per glm-5.3; 851-963 per kimi-k3) - all against values the caller chose. SECURITY.md:134 states "there is no API for signing without the popup", which the implementation contradicts. Private key material never leaves the host (both models).

**Evidence.** src/js/agent.js:768-773 (allow-list entry, no auth), 778-808 (auth gate scoped to popup ports only), 937-1013 (passkey handler: candidates/assert/create with no consent check), 975-996 (assert forwards message-supplied `origin`, `rpId`, `clientDataJSON` to the host), 1416-1441 (`#validateRpId`); src/parcel-host:843-980 (host signs the supplied base64 clientDataJSON after its own checks); SECURITY.md:134. glm-5.3 verified by line-tracing in the main session plus a subagent PoC using the project's Chrome API mock: a bare `passkey` port with no auth, no popup, and no user interaction enumerated passkey entries for a claimed rpId and obtained a signature over an attacker-crafted `clientDataJSON`. kimi-k3 confirmed the behaviour by independent code verification of the same lines during cross-verification.

**Exploit scenario.** Malicious code in any content-script context (TM2) connects a `passkey` port, requests candidates for `origin: "https://github.com", rpId: "github.com"`, receives the user's github.com passkey entry paths, then sends `assert` with a `clientDataJSON` it crafted from a challenge fetched same-origin (e.g. by hijacking the page's own ceremony). The agent validates only rpId/origin consistency and passkey classification; the host - after whitelist, class, rpId-binding, allowCredentials, and rate-limit checks - signs the SHA-256 of the attacker's clientDataJSON. With a cached GPG-agent passphrase this is fully silent; the rate limiter bounds it to the burst (10) plus roughly one attempt per 360s (kimi-k3 phrases the same bound as "~10/hour"), and the audit log records attempts when enabled. The private key itself is never disclosed (host-enforced), which is why glm-5.3 bounds this below the F40M-accepted silent decrypt of login plaintexts.

**Severity.** Disputed - glm-5.3 rates MEDIUM (with the H question explicitly flagged in its calibration), kimi-k3 rates LOW. Both positions are quoted verbatim in Disagreements. The canonical ID carries M.

**Recommended fix.** Give the passkey port the same class of gate as decrypt/match: issue a one-time ceremony token in the `candidates` reply and require `assert`/`create` to present it together with an explicit consent acknowledgement received over a popup-authenticated port (the popup is the consent UI, so the ack must come from the popup port, not the content-script port). At minimum, bind `assert` to the same port instance that performed `candidates` and refuse ports that skip straight to `assert` (glm-5.3). Alternatively, document that consent is a page-facing control only, noting the F40M precedent that such a gate is not considered a TM2 defence (kimi-k3). Independently, reword SECURITY.md:134 to scope the consent claim to uncompromised extension code if the F40M position is intended to cover passkey signing too - today the document promises more than the implementation delivers (both models).

### F60L - Newline-embedded store filenames inject phantom whitelist entries; decrypting an existing phantom wedges the host (LOW)

**Provenance:** both models - originated by glm-5.3 (Phase 1); confirmed by kimi-k3 in cross-verification with an independent live PoC.
**Mapping:** glm-5.3-2 ≡ kimi-k3-3L.
**Threat model:** TM4 (hostile store contents - metacharacter filenames are explicitly in scope, e.g. a store synced from a hostile remote). TM2 amplifies convenience (a compromised extension can pick the phantom without user interaction) but adds no capability the extension lacks (glm-5.3); triggering the hang additionally requires the phantom name to match an existing CWD-relative file and someone (a user clicking the odd entry, or a TM2-compromised extension) to request its decryption (kimi-k3).
**Confidence:** High (both models; independently reproduced live by both).

**Description.** `action_list` assembles its output from newline-separated `find` output (src/parcel-host:532-544 per glm-5.3; 532-560 per kimi-k3): `MIXED` captures `find -print` verbatim, a separator loop splits it into lines, and the surviving lines are NUL-converted for `readlink -f` and then re-split on newlines inside the jq program. A store filename containing an embedded newline (glm-5.3's example `a\nstray.gpg\nb.gpg`; kimi-k3's `innocent2\ncwd-file.gpg`) therefore splits into multiple list lines, and the fragments become *phantom entries*: paths that are not store files at all, but which pass the line-count TOCTOU check (each fragment yields exactly one `readlink` line), pass rule matching like any derived name, and enter `ALLOWED_FILES` and the popup's entry list. Because a filename component cannot contain `/` (established by kimi-k3, capping impact), phantom paths are always single components relative to the host's CWD. Decrypting a phantom that matches an existing CWD file then hangs the host: the decrypt gate order is whitelist, then `[ -f ]`, then path policy, then gpg (src/parcel-host:743-783, kimi-k3), and `path_uses_links` (src/parcel-host:709-719) walks `dirname` upwards and terminates only at `$PASSWORD_STORE_DIR` or `/`, but a relative path collapses to the `.` fixed point (`dirname .` = `.`) and loops forever. The host wedges permanently (100% CPU, fork-spamming `dirname`), never answers again, and the extension's ping watchdog recovers by respawning a fresh host - a self-healing DoS and a wedgeable host channel.

**Evidence.** src/parcel-host:532-560 (find capture and line splitting), 709-719 (`path_uses_links` loop), 721-737 (`validate_decrypt_path_policy` calling it after the `-f` check, glm-5.3), 743-783 (decrypt gate order, kimi-k3). glm-5.3 drove the real `./parcel-host` + real `src/parcel-host` with a mock gpg: phantom entries `stray.gpg` and `b.gpg` appeared in the `list` output with `real` resolving to CWD; decrypt of the phantom against an existing CWD file hung the host (no response, no audit line, no log output until the process was killed); decrypt of a non-existent phantom failed cleanly with "File not found"; the excluded-entry control was correctly denied. kimi-k3 independently reproduced against the real host: the phantom `cwd-file.gpg` appeared in the `list` response, and a `decrypt` request for an existing CWD-relative phantom produced no response within 8s and wedged all subsequent messages including `ping`.

**Exploit scenario and impact bound.** A crafted or attacker-influenced store (synced, cloned, or shared) makes phantom entries appear in the popup: a phantom named for an origin (e.g. `evil.com`) is origin-matched and offered on that origin's popup - a phishing-adjacent confusion vector, though clicking it yields no credential (the fill fails with "File not found" or hangs). If a phantom matches an existing file in the host's CWD (typically `/` or `$HOME`, depending on how the browser was launched), a decrypt attempt wedges the host process until the watchdog respawns it - a persistent availability kill of the extension's host channel. No plaintext leak was constructible by either model: the hang precedes GPG, `-f` fails for non-existent phantoms, and the no-`/` constraint prevents targeting store-internal or other absolute paths. The whitelist-integrity premise ("the extension is incapable of accessing non-whitelisted files") is weakened in the sense that non-store paths enter `ALLOWED_FILES`, but no path to returning their plaintext was found under the scoped threat models (planting a decryptable file in CWD requires an actor with home-directory write access, which is the F46L-excluded same-UID class).

**Recommended fix.** NUL-delimit the pipeline end-to-end (`find -print0`, `readlink -z`, and split on `\0` before jq), or reject/skip any listed path containing a newline or not starting with a store-root prefix (glm-5.3); equivalently, filter `find` output to lines matching `$ROOT/` exactly or use `find -print0`/`read -d ''` throughout so newline bytes never split entries (kimi-k3). Separately, bound `path_uses_links` with an iteration cap or an explicit `.`/`/`-normalised termination check (kimi-k3).

### F61L - Strict-mode detection omits a writability check on the bootstrap file itself (LOW)

**Provenance:** both models - originated by glm-5.3 (Phase 1); confirmed by kimi-k3 in cross-verification.
**Mapping:** glm-5.3-3 ≡ kimi-k3-4L.
**Threat model:** TM5 (build/install integrity); TM2-adjacent user-level malware tampering (glm-5.3); TM5/TM0 (kimi-k3).
**Confidence:** High (both models).

**Description.** `parcel_strict_mode_enabled` (parcel-host:63-67) decides the bootstrap is "beyond the user's reach" - and therefore enables strict-mode PATH/binary hardening - by testing only `[ ! -O "$0" ]` (not owned by the caller) and `[ ! -w "$BOOTSTRAP_DIR" ]` (directory not writable). It never tests `[ ! -w "$0" ]`. A root-owned bootstrap file whose mode is user-writable (0666, or 0664 with the user in the owning group) inside a root-owned, non-user-writable directory therefore enables strict mode while remaining directly editable by user-level malware, which can then rewrite the bootstrap - including removing every check - while the host continues to advertise strict-mode guarantees. The documented promise is that strict mode means "the bootstrap is beyond the user's reach" (comment at parcel-host:62; SECURITY.md's system-wide-install language), so with a user-writable file that promise is false: the strict-mode binary vetting is enforced by a script the attacker can rewrite.

**Evidence.** parcel-host:63-67 (the condition); src/parcel-setup.sh:1513 (the setup script installs with `install -m 0755`, and distro packages do the same, so the precondition is a hand-installed or mode-corrupted bootstrap - admin misconfiguration or unusual packaging). glm-5.3 demonstrated live with a root-owned mode-0666 fixture in a root-owned directory: the function returns true while `[ -w file ]` is also true.

**Exploit scenario and impact bound.** A broken manual install leaves the bootstrap root-owned but user-writable in a root-owned directory; the user believes the strict-mode guarantees hold while user-level malware can edit the bootstrap directly. No privilege boundary is crossed (the bootstrap runs as the user either way) and the malware gains nothing it could not already do via the writable file - the finding is the false assurance and the check/posture mismatch, not a new privilege; hence LOW.

**Recommended fix.** Add `[ ! -w "$0" ]` to the condition so a user-writable bootstrap is treated as permissive (both models). The function's self-containment requirement (tests extract it verbatim) is unaffected (glm-5.3).

### F62L - http-auth token's intent restriction is transient (LOW)

**Provenance:** both models - originated by glm-5.3 (Phase 1); confirmed by kimi-k3 in cross-verification.
**Mapping:** glm-5.3-4 ≡ kimi-k3-5L.
**Threat model:** TM0 primarily (documentation/implementation divergence on an absolute phrasing); TM2 nominally. glm-5.3: a page cannot open runtime ports and the token never reaches page-readable storage, so no TM1 path exists. kimi-k3: the token is observable by the tab's content script (`trigger-http-auth` carries it) and by the popup, but under TM2 this adds nothing beyond the maintainer-accepted F40M posture.
**Confidence:** High (both models; glm-5.3 confirmed dynamically).

**Description.** The per-challenge http-auth token restricts decryption to `intent: "http-auth"` only while its challenge is pending: the guard at src/js/agent.js:861-864 fires only when `#pendingAuthCallbacks.has(token)`, and the token is removed from that map when the callback resolves (credentials supplied, cancel, popup disconnect, or the expiry timer at src/js/agent.js:1230-1232; deletion in `#resolveAuthCallback` at 1177-1183). A popup port that authenticated with the token earlier remains `authorised = true` (set at src/js/agent.js:792-794 within the auth gate at 778-806) with no intent restriction for the rest of the port session, and can thereafter send `decrypt` with `intent: "fill"` or `"detail"` unrestricted. SECURITY.md:158 states "Decryption is restricted to `intent: 'http-auth'`; form fills are not permitted from this token" as an absolute.

**Evidence.** src/js/agent.js:861-864 (guard scoped to pending callbacks), 1177-1183 (resolution deletes the entry), 1230-1232 (timer resolves and deletes), 778-806 (port stays authorised for its lifetime); SECURITY.md:158. glm-5.3 dynamically confirmed by subagent PoC: while pending, `intent: "fill"` was refused; after `http-auth-cancel`, the same port's `intent: "fill"` decrypt returned plaintext. kimi-k3 confirmed by code verification and emphasises the TM0 documentation divergence over the TM2 angle, since the F40M posture already grants equivalent capability via the `"broadcast"` token.

**Exploit scenario and impact bound.** A compromised content script observes a 401 challenge token, authenticates a popup-named port with it, waits out the challenge (or lets it time out), then drives `intent: "fill"` decryptions of whitelisted entries - which it could already do via `"broadcast"`, hence LOW and no incremental exploit; the substance is that a documented absolute restriction silently expires.

**Recommended fix.** Either make the restriction absolute for the token's lifetime - record on the port (at auth time) that it authenticated via an http-auth challenge token and enforce `intent === "http-auth"` for the lifetime of the port, or de-authorise the port when its challenge resolves (glm-5.3; kimi-k3 phrases this as tracking http-auth tokens until port disconnect, not until challenge resolution) - or soften SECURITY.md's phrasing to "while the challenge is pending" (kimi-k3).

### F63L - Documented from-source build cannot succeed without a release signer's secret key; no safe self-build path is documented (LOW)

**Provenance:** both models - originated by kimi-k3 (Phase 1); confirmed by glm-5.3 in cross-verification with an extended build-graph trace and empirical reproduction.
**Mapping:** kimi-k3-1L ≡ glm-5.3-8.
**Threat model:** TM0 (documentation tension) per both models; glm-5.3 adds TM5 relevance (self-build trust is funnelled exclusively to the release key).
**Confidence:** High (both models; reproduced live by both).

**Description.** Every documented build path funnels through a signature only the release signers can produce. The top-level `Makefile` routes `all`/`extension`/`chrome`/`firefox` into `make -C src`, whose default target builds `dist`, which hard-depends on `dist/parcel-host.asc` (src/Makefile:49-53); that rule signs the main host script with `gpg --default-key 88FF14D6294AF4036B7F00FF676A3C09E2E47A72` - Steve Gilberd's key, one of the two primary keys the constitution permits for release signing (CONSTITUTION.md:149, §2.2). `src/dist/` is not tracked in git (`git ls-files src/dist` is empty), so a fresh clone has no prebuilt signature and any `make all` / `make chrome` / `make firefox` invocation reaches this rule and aborts with a GPG "no secret key" error for anyone who is not the maintainer. README.md's "Installation from source / Build the extension" section (README.md:91-111 per glm-5.3; 130-145 per kimi-k3) documents `make all`, `make chrome`, and `make firefox` with no mention of the signing requirement, and no guidance toward the safe path (generate your own key, self-sign `src/parcel-host`, and add that fingerprint to `VALID_SIGNERS` in parcelrc). The runtime enforces the same dependency from the other side: the agent fetches the bundled host script and its `.asc` and passes both to the native `install` action (src/js/agent.js:160-165), where the bootstrap verifies the signature against `VALID_SIGNERS` (default includes the same key, parcel-host:474) - so stripping the signing step yields a bundle that fails closed at host install, and re-signing with one's own key requires editing src/Makefile:51 *and* overriding `VALID_SIGNERS` (and optionally `HOST_HASH`) in `parcelrc`, all documented options (README.md:265-277) that are never connected into any from-source instructions. The constitution explicitly invites forks ("The source code of the project may of course be freely forked and modified by anyone", CONSTITUTION.md:137) and the README leans on auditability ("The code that runs in your browser is identical to the code in this repository", README.md:17), yet the repository as documented cannot produce a working self-built copy. glm-5.3's own Phase-1 build-parity check had to improvise around the requirement (a local key generated in a throwaway keyring and `dist/parcel-host.asc` hand-produced, signed by fingerprint `99ED9C…` rather than the maintainer's key), which is the failure mode every from-source user will hit.

**Evidence.** src/Makefile:49-53 (hard-coded `--default-key`); `git ls-files src/dist` empty (untracked, so the rule always fires on a fresh clone); README.md:91-111 and 123-134 (no signing mention; native-host setup routed back to the official release artifacts). kimi-k3 reproduced live: `git archive HEAD` to a scratch dir, `make chrome` fails at the asc step. glm-5.3 ran the exact signing invocation against a scratch file (exit 2, signing failed), traced the full build graph (all four documented targets hard-depend on the asc), verified the gitignore closes the pre-built-trees escape, and searched README.md, CONTRIBUTING.md, and both Makefiles for any skip flag, environment override, or own-key instructions (none exist).

**Exploit scenario.** No direct exploit; the finding is the absent documentation/control. A user building from source cannot produce a working, verifiably-signed installation without out-of-band knowledge, and the failure message gives no safe direction. Fail-safe today (the build aborts rather than producing an unsigned bundle), hence LOW.

**Recommended fix.** Parameterise the signing key (e.g. `SIGNING_KEY ?= 88FF14D6...`, or `SIGN_KEY ?=` with a clear failure message when unset) and document the self-signing + `VALID_SIGNERS` workflow in README's source-install section, or explicitly document that the asc step requires a maintainer key and how to bypass it safely (both models).

### F64L - Test Dockerfile builds on unpinned, unverified third-party code (LOW)

**Provenance:** both models - originated by kimi-k3 (Phase 1); confirmed by glm-5.3 in cross-verification (which promoted its own Phase-1 base-tag residual to a finding after the exchange contributed the NodeSource vector and the posture argument).
**Mapping:** kimi-k3-2L ≡ glm-5.3-9.
**Threat model:** TM5 (supply chain / build integrity - dev tooling).
**Confidence:** High (both models).

**Description.** The test container - documented in CONTRIBUTING.md:111-121 as the optional isolated test environment - is built from `FROM ubuntu:latest` (Dockerfile:10), a moving tag with no digest pin, and installs Node.js by piping a remotely-fetched script straight into a root shell: `curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -` (Dockerfile:47), protected only by TLS with no version pin, checksum, or signature; the apt package set is likewise unpinned. The file's own header claims it "Provides a reproducible environment" (Dockerfile:4), which the recipe does not deliver. This is the same class as the fixed F37L (unpinned gitleaks download; contrast scripts/pre-commit-gitleaks:56-64, which pins v8.30.1 plus per-platform SHA-256 checksums) and is inconsistent with the project's own dev-machine supply-chain posture: the top-level Makefile's `DEPS_INSTALL_CUTOFF` exists specifically to "reduce the likelihood of supply-chain attacks against a developer machine" (Makefile:7-13).

**Evidence.** Dockerfile:10, Dockerfile:47. glm-5.3 verified both cited lines as described and that the only pinned install in the file is `npm ci` via the committed lockfile (no digest, checksum, or signature verification exists for the base image or the NodeSource script).

**Exploit scenario and mitigations.** A compromised NodeSource endpoint or poisoned `ubuntu:latest` tag yields code execution at image build time on maintainer/CI-adjacent machines. Mitigations that keep this LOW (kimi-k3): the image is a dev/test convenience only, never shipped; the repo is bind-mounted rather than baked in; and CI (`.github/workflows/ci-unit-tests.yml`) uses `actions/setup-node` instead of this path. glm-5.3 adds that the bind mount is exactly what turns a toolchain compromise into a source-tampering opportunity: code executing in the container can modify the working tree, and a developer could commit the result - the "unnoticed introduction of malicious extension code within the official repository" that TM2 explicitly scopes. Exploitation requires compromise of Docker Hub's `ubuntu` tag, NodeSource, or the TLS path, so likelihood is low, but the hardening is cheap and the project has already established the pinning pattern.

**Recommended fix.** Pin the base image by digest (updated deliberately), and install Node.js either from the distro repository or from official binaries with a published SHA256 (or pin and checksum the NodeSource setup script); then either drop the "reproducible" claim or make it true (glm-5.3). Mirrors the F37L fix pattern (both models).

### F65L - No popup-side regression test for the F36L origin carriage (LOW)

**Provenance:** both models - originated by glm-5.3 (Phase 1); confirmed by kimi-k3 in cross-verification.
**Mapping:** glm-5.3-5 ≡ kimi-k3-6L.
**Threat model:** TM5 (regression of a shipped protection via unnoticed repo change).
**Confidence:** High (both models).

**Description.** The F34M destination-origin guard (src/js/integration.js:1814-1819; `hasOwnProperty`-gated per kimi-k3) applies only when the fill message carries an `origin` property. The sole wiring that makes the F34M guard cover the *primary* fill path is the popup's `origin: frameOrigin` field (src/js/popup.js:1577-1584; the field itself at :1583). The existing tests cover the guard itself (integration.test.js:1101-1136) and the agent's broadcast fallback (agent.test.js:385-425), but no test asserts that the popup's fill message carries the origin - `test/popup.test.js:592-610` (kimi-k3 cites 592-608) asserts only `action`/`token`/`plaintext`/`config`. A future refactor that drops the field (e.g. during `postFillWithAck` evolution) would silently stop the guard applying to the primary path and re-open the F34M mid-decrypt-navigation cross-origin fill with zero test failures - the same silent-regression class F56L was filed against, for a MEDIUM-severity control.

**Evidence.** src/js/popup.js:1577-1584 (control); test/popup.test.js:592-610 (assertion set); src/js/integration.js:1814 (the `hasOwnProperty`-gated check).

**Exploit scenario.** No direct exploit; absent test control whose presence would catch re-opening of the F34M path.

**Recommended fix.** In the popup fill test, assert `msg.origin` equals the `frameOrigin` the content script reported, and that a fill without a prior `origin` message does not dispatch (glm-5.3); kimi-k3: assert `msg.origin` equals the frame origin in the popup fill-flow test.

### F66I - Fixed gates lacking regression tests (INFORMATIONAL)

**Provenance:** both models - originated by glm-5.3 (Phase 1, four gates); partially confirmed by kimi-k3 in cross-verification, which adopted the F48I and F57L halves (as kimi-k3-1I) and declined to re-report the audit-cap-truncation and per-container-isolation halves as duplicates of F50I's already-noted residuals.
**Mapping:** glm-5.3-6 ≡ kimi-k3-1I (partial).
**Threat model:** TM5 (regression detection for fixed gates).
**Confidence:** High (both models).

**Description.** Bundled per the F50I precedent. Four fixed controls would regress silently (reverting the fix passes the entire test suite): (a) the F48I `CSS.escape(entry.path)` at src/js/popup.js:1427; (b) the F57L `Object.prototype.hasOwnProperty` unknown-key gate at src/js/schema.js:115 (behaviourally verified by glm-5.3 this session: `constructor`/`__proto__` keys are rejected - a test should construct the payload via `JSON.parse`, since object literals cannot express these keys); (c) the F10L audit-log field caps at src/parcel-host:647 (control-char stripping is tested; the 128/1024/1024/4096 truncations are not); (d) per-container history isolation (src/js/agent.js:230-240, popup.js:1592-1595 - only the mock's event plumbing is tested). F50I listed (c) and (d) in v1.0.5; only port-action coverage was added in #132. kimi-k3's position: no test asserts the F48I or F57L gates and reverting either fails zero tests; the audit-truncation and per-container-isolation halves duplicate F50I's already-noted residuals and are not re-reported. Defence-regression detectors only; no live hole.

**Recommended fix.** One adversarial test per gate (glm-5.3): a popup render test with a selector-hostile entry path, and a schema test rejecting `__proto__`/`constructor` keys constructed via `JSON.parse` (both models).

### F67I - Stale "No clipboard auto-clear" tradeoff row (INFORMATIONAL)

**Provenance:** both models - originated by glm-5.3 (Phase 1); confirmed by kimi-k3 in cross-verification.
**Mapping:** glm-5.3-7 ≡ kimi-k3-2I.
**Threat model:** TM0.
**Confidence:** High (both models).

**Description.** SECURITY.md's Deliberate Tradeoffs table (line 169) states "Parcel does not implement this feature" for clipboard auto-clear, while the v1.0.7 Clipboard copy protection section (SECURITY.md:113 per glm-5.3; 113-118 per kimi-k3, including `clipboardTimeout` at :206) documents the host-side auto-clear after `clipboardTimeout` seconds (added in #167). The tradeoff row is stale pre-#167 wording; its *rationale* (avoiding the browser `clipboardRead` permission) remains valid for the browser-API approach/fallback path the row describes, but a reader of the table alone would wrongly conclude copies persist indefinitely. Documentation tension only; the implementation is stronger than documented.

**Recommended fix.** Rewrite or remove the row, pointing at the host-side mechanism and its residual limits (clipboard managers ignoring the sensitivity hint, documented in the protections section) (glm-5.3); kimi-k3: reword the row to scope the tradeoff to the browser-clipboard fallback path.

## Disagreements

### F59M - canonical severity letter (glm-5.3: MEDIUM vs kimi-k3: LOW)

The two component reviews agree on every fact of this finding (the `passkey` port has no authorisation or consent gate; the host-side controls hold; SECURITY.md:134 is contradicted) and disagree only on severity. The merge editor selected M for the canonical ID as the conservative editorial default (the higher of the two positions); this selection is not an adjudication, and the maintainer may take either position when responding. Both positions follow, verbatim.

**glm-5.3's position** (from its report, finding glm-5.3-1, "Severity calibration"):

> Rated M rather than H, with the uncertainty explicitly flagged: the H criterion lists "consent gating of passkey signing" as a documented protection, and this is a reachable bypass of it under TM2. It is calibrated to M for consistency with the project's own F20M rating of the structurally identical decrypt-gate gap (fixed in #69), because (a) the TM1-facing claim in SECURITY.md holds, (b) the docs' own TM2 "can do" list ("interact with the native host within the constraints of the supported action set") correctly describes this capability, and (c) the impact is bounded by host-side controls and discloses no key material. If the maintainers read SECURITY.md:134's second clause as an absolute (TM2-inclusive) promise, H is defensible. Not deduplicated: F40M concerns the popup-port token model, not the passkey port, which postdates the #69 fix.

**kimi-k3's position** (from its report, finding kimi-k3-7L, "Why LOW here (disagreement with glm-5.3's M)"):

> under this review's TM2 defence-in-depth scope, a gap exploitable only from an already-compromised extension context is not a finding unless it defeats a control specifically documented as a TM2 mitigation. The documented TM2 boundary is the host (whitelist, rate limiter, audit, no key material) - all of which hold here. The consent gate is documented as a page-facing protection ("A page cannot silently authenticate you"), and the compromised-extension "cannot" list makes no consent promise; the maintainer's F40M response additionally establishes that content-script compromise is treated as extension compromise and that extension-side tokens are not TM2 defences. The residual substance is the absolute sentence "there is no API for signing without the popup", which is true only against pages - a TM0 documentation tension. Confidence: Medium (the facts are certain; the severity hinges on how the documentation is read).

Neither model changed its verdict for consensus. glm-5.3: "The kimi-k3 table raised no challenges to my Phase-1 findings, and no verdict in this report was changed for consensus." kimi-k3: "The verdict was not changed to achieve consensus."

## Regression Checks

Both models verified all prior findings marked fixed/addressed/resolved in `findings.md` against the current tree; the table below is the deduplicated union (glm-5.3 verified 29; kimi-k3 verified 32, additionally covering F25T and F41L). Both models state no fix was found reverted, partially reverted, or bypassed.

| Finding | Status | glm-5.3 | kimi-k3 | Verification notes (merged) |
|---|---|---|---|---|
| F1M | PASS | yes | yes | Temp `mktemp` keyring, `--no-default-keyring --keyring`, `GNUPGHOME=/dev/null`, removed after use (parcel-host:581-603) |
| F2M | PASS | yes | yes | Control chars stripped from all four audit fields (src/parcel-host:640-646) |
| F9L | PASS | yes | yes | `SHA256` resolved after `load_parcelrc` (parcel-host:497) |
| F10L/F14L | PASS | yes | yes | Audit field caps 128/1024/1024/4096 (src/parcel-host:636-647) |
| F11L | PASS | yes | yes | Explicit `extension_pages` CSP (src/manifest.json:25-27) |
| F17L | PASS | yes | yes | Link policy applied before traversal in `collect_roots` (src/parcel-host:303-355, consumed at :502/:528) |
| F18M | PASS | yes | yes | `connect-src 'none'; frame-src 'none'; base-uri 'self'` (src/manifest.json:26; :30 in both built manifests) |
| F19M | PASS | yes | yes | Idempotent `#ensureNativeConnected` from onStartup/onInstalled (src/js/agent.js:88-93, 145-151) |
| F20M | PASS | yes | yes | decrypt/match popup-only; integration config-only; unknown rejected (src/js/agent.js:768-816) |
| F22L | PASS | yes | yes | `jq -rj '.script' \| "$SHA256"` hashes the raw bytes (parcel-host:639-641) |
| F25T | PASS | - | yes | `chmod 0600 "$LOGFILE"` on creation (parcel-host:471) - verified by kimi-k3 only |
| F29L | PASS | yes | yes | `"$SHA256"` quoted in command position (parcel-host:639-641) |
| F30L | PASS | yes | yes | GPG status output to log fd 5 only; static error text to the extension (parcel-host:596-634) |
| F31L | PASS | yes | yes | `^[a-zA-Z0-9_]+$` regex gate before dispatch (parcel-host:665-671) |
| F34M | PASS | yes | yes | Destination-origin guard (src/js/integration.js:1814-1819); broadcast fill carries origin (src/js/agent.js:925-931) |
| F35M | PASS | yes | yes | Bucket persisted to the state file (src/parcel-host:88-135, 649-703; test/native-host.test.js:2846) |
| F36L | PASS | yes | yes | `origin: frameOrigin` on the primary fill message (src/js/popup.js:1583); test gap recorded as F65L |
| F37L | PASS | yes | yes | gitleaks v8.30.1 pinned with per-arch SHA-256 checksums, verified pre-extraction (scripts/pre-commit-gitleaks:56-64) |
| F38I | PASS | yes | yes | PORT_ACTIONS comment matches the allow-list (src/js/agent.js:764-773) |
| F41L | PASS | - | yes | First-trusted-non-revoked VALIDSIG loop (parcel-host:612-635), covered by tests - verified by kimi-k3 only |
| F42L | PASS | yes | yes | passkeyDir rejects `..`/leading `/`/control/glob chars (src/parcel-host:1002-1007; schema-side pattern) |
| F45L | PASS | yes | yes | `rsync -av --delete` in both targets; `release: clean` (Makefile:38-76) |
| F47L | PASS | yes | yes | `return 0` after the invalid-timestamp error (src/parcel-host:472-475 per glm-5.3; :493-496 per kimi-k3) |
| F48I | PASS | yes | yes | `CSS.escape(entry.path)` (src/js/popup.js:1427); test gap recorded as F66I |
| F50I | PARTIAL | yes | yes | Non-whitelisted port actions tested (test/agent.test.js:601-619); the audit-truncation and per-container-isolation halves remain unasserted (F66I), as previously noted by maintainers |
| F52C | PASS | yes | yes | Anchored `grep '^\[GNUPG:\] VALIDSIG '` (parcel-host:628); live-verified against a malicious-UID key (GnuPG 2.4.9) by both models; F56L adversarial test present |
| F53M | PASS | yes | yes | Rename/noclobber lock with orphan recovery and fail-closed exhaustion (src/parcel-host:140-227, 649-703); glm-5.3: 8-process concurrency (exactly 10 successes/230 denials); kimi-k3: 20-way stress test could not multiply the budget |
| F54L | PASS | yes | yes | TOTP `step` 1-3600, `digits` 6-10, parseInt-coerced (src/js/helpers.js:50-54) |
| F55L | PASS | yes | yes | Real `crossOrigin`; `topOrigin` only when cross-origin and known (src/js/webauthn.js:233-241) |
| F56L | PASS | yes | yes | Malicious-UID GOODSIG adversarial regression test (test/native-host.test.js:593-629) |
| F57L | PASS | yes | yes | `Object.prototype.hasOwnProperty` gate (src/js/schema.js:115); behaviourally re-verified by glm-5.3 |
| F58L | PASS | yes | yes | Cyclic guard + object-level `items` recursion (src/js/schema.js:46-47, 119-124) |

## Deliberate Tradeoffs

Each documented/accepted tradeoff was re-examined against the current code by whichever model lists it; the table is the deduplicated union. No tradeoff was found to diverge from its documentation except the clipboard row (F67I).

| Tradeoff | glm-5.3 | kimi-k3 | Status |
|---|---|---|---|
| F40M broadcast/self-issued auth token | re-examined via related findings (F62L notes the http-auth phrasing divergence) | holds; implementation matches the documented correlation-identifier intent (src/js/agent.js:694-699); the port allow-list still bounds which actions any port can reach | Holds |
| F43L Firefox `ancestorOrigins` fallback to `"*"` | - | holds (src/js/integration.js:253-260); impact remains popup-position confusion only | Holds |
| F44L page-forged conflict event | - | holds; the conflict notice path still re-derives everything isolated-side; dismissal only suppresses future notices | Holds |
| F46L state-file fail-open / symlink-follow (same-UID actor) | related residual (save_state symlink asymmetry) | holds; see Residual Observations for the related lock-stall and save_state symlink notes | Holds |
| F33T `config` endpoint exposes passdir | - | holds | Holds |
| F21T backup keys in default `VALID_SIGNERS` | - | holds; the default list still contains all four release keys (parcel-host:473) | Holds |
| F23T default burst size | - | holds; defaults remain decryptBucket 10 / decryptRate 0.00277; the popup now additionally warns on disabled/excessive rate limiting (#177) | Holds |
| F24T `LOGFILE` unvalidated | - | holds; parcelrc remains a trusted file, now further hardened by the whitelist parser and 0600 enforcement | Holds |
| F15T audit line assembly unbounded | - | holds; per-field caps remain the only bound | Holds |
| F16T config-dir permissions | - | holds | Holds |
| F12T search ReDoS | related residual (config-controlled regexes) | holds | Holds |
| F13T `shadow.js` MAIN-world patch | related (WebAuthn interception in the page realm holds; bridge treated as untrusted) | holds | Holds |
| F8T history hashing | - | holds | Holds |
| F6T cross-origin fill warning-only | - | holds | Holds |
| F7T/F26T WAR breadth / fingerprintability | holds; WAR set re-verified as minimal (`popup.js` removed, `webauthn.js` added with need) | holds; the WAR list was re-verified entry-by-entry against actual code load sites | Holds |
| F39T page-stylable popup | - | holds | Holds |
| F4T default-allow-all / absent `.parcel.json` | holds; default-rules warning shown in the popup | holds | Holds |
| F3T no-network is governance | - | holds | Holds |
| F5T parcelrc as code | related (plaintext bash host holds; the whitelist parser hardens further) | holds | Holds |
| F32T non-constant-time hash compare | - | holds | Holds |
| F49I/F51I token growth; `fill-value` origin edge | - | holds | Holds |
| Signer-revocation best-effort caveat | related residuals (stale blacklist fail-closed; install-order window) | holds; the state-file blacklist is a replaceable cache as documented; `repair_state` ensures an unusable file is repaired so a later bootstrap enforces the shipped list (src/parcel-host:225-257) | Holds |
| Plaintext bash host | holds; auditable and verified | - | Holds |
| `HOST_HASH` off by default | holds; the `host-unpinned` popup warning (#177) now surfaces it in-session | - | Holds |
| Content script on all URLs | holds; Firefox optional-permission flow verified in popup.js | - | Holds |
| Entry rules don't dereference paths | holds; decrypt-time link revalidation verified (F60L is a newline issue, not a symlink-policy issue) | - | Holds |
| No clipboard auto-clear | divergent: the feature now exists host-side (#167); the tradeoff row is stale (F67I); the underlying rationale (no browser `clipboardRead` permission) still holds | divergent: same conclusion (F67I) | Divergent - see F67I |
| WebAuthn interception in the page realm | holds; bridge treated as untrusted, all decisions re-derived isolated-side/host-side | - | Holds |
| First-come-first-served interception | holds; non-configurable accessors, full back-off, conflict notice verified | - | Holds |
| `webRequest` for HTTP auth | holds; per-challenge token binding verified (with the F62L phrasing divergence noted) | - | Holds |
| Cards bypass origin-matching | holds; `originBound: false` + `scope: "context"` defaults verified in schema.js classDefaults, with the "spoofed includeClasses cannot widen origin scope" test passing | - | Holds |

## Residual Observations

No reachable exploit path was identified for any of the following by either model; the table is the deduplicated union of both residual lists (glm-5.3: 15; kimi-k3: 16; three overlaps merged).

| # | Observation | glm-5.3 | kimi-k3 | Notes (merged) |
|---|---|---|---|---|
| 1 | `save_state` writes through a symlinked state file while `repair_state` guards `[ ! -L ]` | yes | yes | Asymmetry (kimi-k3: `lock_state` renames a symlinked `$STATEFILE` to `.locked` and the `printf >` write follows it, src/parcel-host:132, vs the explicit `! -L` guard at :229). Same-UID actor (F46L scope); written content constrained to numeric bucket lines and hex fingerprints. A `[ ! -L ]` guard in `save_state` (or in `lock_state` after the rename) would close it cheaply |
| 2 | Audit-log origin remains attacker-controlled under TM2 | yes | - | `message.origin` is forwarded verbatim per the F20M/#69 disposition; the host cannot independently verify browser origins. Inherent to the design; noted for forensic-integrity expectations |
| 3 | `.gpg-id` walk follows directory symlinks for recipient lookup, including the passkey-create walk | yes | yes | kimi-k3: the `-f` test and read follow symlinks, so recipients could come from an out-of-store file (src/parcel-host:1057-1076); identical to `pass`'s own store-trust model. glm-5.3: a store-writing attacker can simply overwrite the in-store `.gpg-id`, so the symlink adds nothing |
| 4 | Stale state-file blacklist persists while the shipped list is empty | yes | - | Fail-closed only (a stale revocation keeps rejecting); no weakening path |
| 5 | `decryptBucket`/`decryptRate` are not range-capped host-side | yes | - | Int64 overflow fails closed (negative bucket leads to deny); a huge non-overflowing value is a config choice the popup warns about |
| 6 | Partial message (length prefix with short body) stalls `head -c` without a watchdog | yes | - | Wedges one host process; local TM2 DoS only; the extension can already spawn unbounded hosts |
| 7 | 32-bit length-prefix edge | - | yes | On a 32-bit `long`, `printf %ld "0xFFFFFFFF"` yields -1, bypassing the 16MiB check into `head -c -1` (parcel-host:651-657); verified impossible on 64-bit; extension-self-DoS only |
| 8 | `parcelrc_check_binary` validates only the final hop's directory for symlink chains | yes | - | Creating the root-owned link into user-writable space already requires root |
| 9 | Strict-mode checks do not walk grandparent directories | - | yes | Binary/PATH checks test the file and its immediate directory, not grandparents (e.g. a user-writable `/usr` would allow renaming `/usr/bin`); requires an already-broken system |
| 10 | In-session revocation install-order window | yes | - | The documented best-effort limitation of BLACKLIST_SIGNERS; the realistic service-worker restart flow closes it |
| 11 | `changes_since` sub-second race can permanently miss a store change | yes | - | Display-only; the host re-validates on every decrypt |
| 12 | Popup iframe URL (with correlation token) may be observable via resource timing | yes | - | Unverifiable without a live browser; no attack path beyond F39T-accepted presentation control even if real |
| 13 | Passkey popup-spam guard is per-frame | yes | - | N same-origin iframes get 2N popups before cooldown; consent itself is not bypassable |
| 14 | `base32ToArrayBuffer` silently maps invalid characters | yes | yes | kimi-k3: `indexOf` -1 becomes `& 0x1f` (src/js/helpers.js:15-33); a malformed store secret yields a wrong TOTP rather than an error; fail-visible |
| 15 | Config-controlled regexes (rule `strip`/`pattern`, target patterns) compile in popup/content-script contexts | yes | - | ReDoS surface from a hostile `.parcel.json`, the F12T-accepted class; SECURITY.md already warns to review synced stores |
| 16 | Unanchored user rule regexes | - | yes | jq `test()` is a partial match, so `"websites/.*"` also matches `evil/websites/x`; documented "regex matched against the entry name" semantics; the default injected rules are anchored; a README note could help |
| 17 | Rate-limit lock live-stall double-spend | - | yes | A lock holder stalled longer than the 5s orphan-recovery age (SIGSTOP, extreme load) can have its lock recovered by another host, and both spend from the same loaded state; the multiplier is bounded by concurrent hosts; same-UID action within F46L's scope; the critical section never waits on the extension, so TM2 cannot reach it |
| 18 | `passkey_op_create` consumes no rate-limit token | - | yes | No decryption occurs, so a compromised extension can CPU-spam key generation and obtain unlimited armored blobs - encrypted to the store's own recipients, hence unreadable by it; within the documented TM2 envelope |
| 19 | Far-future `DECRYPT_BUCKET_LAST` | - | yes | Refill goes negative and denies until wall-clock catches up; fail-closed; same-UID tamper within F46L's scope |
| 20 | `entry.rule.tag` without optional chaining (src/js/popup.js:1444) | - | yes | Reachable only if jq/Oniguruma and JS RegExp diverge on the same pattern+name (ConfigSchema already rejects patterns JS cannot compile); impact is a render exception caught by `scheduleRender`, not disclosure; consistency fix suggested (`entry.rule?.tag`) |
| 21 | History recorded on fill ack, pre-validation (src/js/popup.js:1585-1597) | - | yes | The ack precedes the destination-origin check, so a refused fill still writes history metadata; convenience metadata only (F8T); cosmetic |
| 22 | User-gestured docs link (src/js/popup.js:1395-1400) | - | yes | The passkey-conflict "Learn more" button opens the project's GitHub README via `window.open(..., "noopener,noreferrer")`; user-initiated navigation in mild tension with a literal reading of "no network access, for any reason"; not telemetry; informational only |
| 23 | Unasserted test halves | - | yes | The F1M anti-pollution flags (`--no-default-keyring`/`--keyring`) are unasserted because the mock gpg intercepts first; the F50I audit-truncation and per-container-isolation halves are recorded as F66I; defence-regression detectors, not live holes |
| 24 | Flatpak manifest path discrepancy (functional, uncertain) | - | yes | `install_flatpak_wrappers` (src/parcel-setup.sh:1690-1698) writes flatpak manifests to the browser's standard user-level manifest dir, while README's manual flatpak instructions use the `~/.var/app/$APP_ID/...` path; unverifiable without a flatpak environment; no security impact either way (the wrapper execs the same verified host) |
| 25 | The mock GPG performs no real cryptography | yes | - | Always-VALIDSIG, same plaintext; the suite pins the gpg invocation only implicitly; live signature verification was done manually during the review |
| 26 | Build/release nits | yes | - | `make extension` runs `prettier --write` over `src/` as part of the build (CI's `--check` gate makes it a no-op in practice); `make release` runs a bare `git reset` (maintainer footgun, no artifact impact); `chrome/` ships the dead `integration.es6.js` (harmless parity leftover) |
| 27 | shellcheck coverage | - | yes | `make test` shellchecks only the two hosts and the setup script; `scripts/*.sh` and `example/*.sh` get `bash -n` only |
| 28 | Newline-in-filename `find:` error-line injection | - | yes | A store file whose name contains a newline and a `find:` prefix injects a fake error line into `action_list`'s stderr separation, failing the scan closed; it also desyncs the readlink line-count check (src/parcel-host:545-560); the broader phantom-entry consequences of the same newline splitting are F60L; fail-closed |

## Methodology

- **Source reports:** post-phase-2 reports from two models, both reviewing commit `099857c` (exactly at tag `v1.0.7`, clean working tree) on 2026-09-12: glm-5.3 (`glm-5.3.md`) and kimi-k3 (`kimi-k3.md`). Both models completed the standard two-phase protocol including cross-verification: glm-5.3 confirmed both of kimi-k3's Phase-1 findings, and kimi-k3 confirmed all seven of glm-5.3's Phase-1 findings (one with a severity dispute, one with a partial dedup against F50I).
- **Merge date:** 2026-09-12.
- **Editorial confirmations:** the merge editor introduced no findings, removed none, and changed no severities. The only severity act was the one the merge protocol requires: selecting a single canonical severity letter for the one finding on which the component reviews disagree (F59M; M selected as the conservative default, with kimi-k3's L position recorded verbatim in Disagreements). Each deduplicated finding carries one canonical ID across all locations. The two component reports were modified only to replace their finding IDs with the canonical `F<N><S>` forms; no other aspect of either review was altered. `findings.md` was extended with the nine new findings and their canonical IDs (maintainer responses pending).
- **Conflicts:** where the two reports cite different line ranges for the same code (e.g. F47L) or report different test-suite totals (555/555 vs 595/595), both statements are presented with attribution; the merge editor did not reconcile them.

## About This Merge

- **Merge editor model:** glm-5.3-flash (glm-5.3-flash-flex; execution-tier suffix omitted per convention), via GitHub Copilot CLI - distinct from the glm-5.3 component reviewer.
- **Source reports:** `security-review/reviews/v1.0.7/glm-5.3.md` and `security-review/reviews/v1.0.7/kimi-k3.md`.
- **Merge date:** 2026-09-12. **Commit ref:** `099857c` (short hash), exactly at tag `v1.0.7`.
- The committed `security-review/prompt.md` is the canonical record of both prompts (not embedded here).

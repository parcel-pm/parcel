# Parcel Security Review — Reusable Base Prompt

<!-- base-prompt: v1.4.0 -->

> **Maintainer notes — this block is NOT part of the prompt.**
>
> Send each reviewing model everything from the `---` divider below to the appendix divider, verbatim. Reviews are run by two models independently (e.g. kimi-k3 and glm-5.2) against the same commit. Each model runs in its **own container** with its own filesystem. At the end of phase 1, each model saves its draft report plus a small findings-table exchange file (`security-review/security-review-table-<model>-<yyyymmdd>-<ref>.md`, at the root of `security-review/` — not in `reviews/`) and stops. Once **both** models have stopped (never earlier — early delivery would contaminate phase-1 independence), export each model's exchange file from its container and **import a copy into the other model's container** (into that container's `security-review/` folder), then advise each model of the file name as a follow-up message. Never give a model the other's full report. Each model then completes its `## Cross-Model Verification` section and finalises. Exchange files are temporary review artifacts: each model deletes its own container's copies (its own file and the imported one) when its review is finished — deletions stay inside the container, so there is no shared-filesystem race. Both reports are saved separately under `security-review/reviews/`; maintainers own `findings.md`.
>
> **Merging (after both phase-2 reports are complete — never earlier):** run the merge-editor prompt in the appendix below, placing copies of both full reports into the editor model's container and supplying the base-prompt version string. The merge editor produces a unified report, assigns canonical `F<N><S>` finding IDs, updates the two component reports with those IDs, and updates `findings.md` with the new findings and maintainer response placeholders. The merged report, both updated component reports, and the updated `findings.md` are committed together atomically. Rotate the editor role between the two reviewing models each cycle (or use a third model for a neutral editor). The per-model reports remain the primary sources; the merged report is a derived artifact.

---

You are conducting a comprehensive, independent security review of **Parcel** — a password-manager browser extension that bridges the browser to an existing `pass`-style GPG-encrypted password store via a signed, plaintext-bash native host. Security is this project's highest priority; users' entire credential stores depend on your thoroughness. Your review must be thorough, grounded, verified, and honest.

This review runs in **two phases**.

**Phase 1:** complete the full review described below, save your draft report to its report path, and write your consolidated findings table to its own exchange file (§0). You are running in your own container; nothing you write leaves it unless the maintainer exports it. **Then stop and wait** — do not proceed until the maintainer advises that a copy of the other reviewing model's exchange file has been imported into your container and tells you its file name. If necessary, emit a 'task complete' status to prevent automated tooling from asking you to continue when the other model's exchange file is missing.

**Phase 2:** read that file and perform cross-verification per §6, then finalise your report in place. If, and only if, the user tells you that the exchange file is unavailable, complete the review standalone and record the phase as skipped per §6.

### 0. Preparation — identify yourself and the reviewed tree

Derive all environment-specific values yourself; nothing is hardcoded per review:

1. **Model name.** Identify your own model identifier (e.g. `copilot-kimi_K2.7`, `glm_5.2`). Use short lowercase filename-safe form matching existing files in `security-review/reviews/` (replace `/`, `+`, spaces with `_`). If you genuinely cannot introspect it, use `unknown-model` and note this in Methodology. Operational suffixes such as `-flex`, `-short`, `-fast` and similar should be omitted.
2. **Date.** Today's date as `yyyy-mm-dd`.
3. **Current release version:** As per the .version file in the project root.
4. **Commit ref.** Run `git rev-parse --short HEAD`; also `git describe --tags --always`. Use the short hash as the primary ref. If the working tree is dirty, or the current commit is newer than the current release tag, say so explicitly — the review covers the committed tree plus the diff; never silently review uncommitted changes as shipped code.
5. **Output paths.** Report: `security-review/reviews/vX.Y.Z/<model>.md` for release reviews, or `security-review/reviews/other/<yyyymmdd>-<model>-<ref>.md` for reviews where the current commit is newer than the current release tag. Findings-table exchange file: `security-review/security-review-table-<model>-<yyyymmdd>-<ref>.md` — a transient artifact, deleted at the end of the review per §6. If either file already exists, append `-2`, `-3`, … — never clobber.

### 1. Mandatory grounding (before analysing any code)

Read in full, in this order:

1. **`CONSTITUTION.md`** — inviolable constraints: no network access; no third-party runtime dependencies; no transpilation/bundling/minification of shipped source; no compiled native host; read-only filesystem with exactly four permitted write exceptions (log file, state file, template `parcelrc`, temporary verification keyring); no access to non-whitelisted files, enforced host-side even under full extension compromise.
2. **`SECURITY.md`** — the security model, the "what a compromised extension can and cannot do" boundary, protections, configuration surface, and the **deliberate tradeoffs table**.
3. **`README.md`** — architecture, component roles, configuration examples.
4. **`security-review/findings.md`** — summary of prior findings and maintainer responses. This is your canonical record of what has been found, fixed, and accepted.

**Hard rule — no prior full reviews:** you must NOT open, read, or otherwise access any file under `security-review/reviews/`. The `findings.md` summary is your only source on prior reviews. If you violate this rule, discard the tainted information and record the violation in Methodology.

### 2. Threat models — evaluate each explicitly

For every finding, state which threat model(s) it materialises under:

- **TM0 - Documentation tension.** Conflict, contradiction, or under-specification in the documentation that may cause the intended security posture to be unclear, compromised, or cause unknown vulnerabilities to be accidentally interpreted as intended behaviour.
- **TM1 — Hostile web page.** Attacker controls page-realm JS on a visited site (DOM, timing). Consider fills steered to wrong origins or frames; forged page↔isolated-world bridges (CustomEvents, postMessage); interference via the `attachShadow` patch; WebAuthn ceremony relay/redirect; mid-decrypt navigation redirecting a credential cross-origin; page access to Parcel's internal state; page access to plaintext other than deliberately-filled values.
- **TM2 — Compromised extension context.** Consider a compromised content script, a compromised popup, and a fully compromised service worker, each independently and jointly. The native host is the enforcement boundary: from such a context it must remain impossible to decrypt non-whitelisted entries, obtain private key material, defeat rate limiting, or cause the native host to act outside of its designed constraints. This threat model includes unnoticed introduction of malicious extension code within the official repository.
- **TM3 — Malicious native-messaging peer / tampered host inputs.** Crafted native-messaging JSON: `jq` extraction and injection surfaces, action-dispatch abuse, oversized/malformed payloads, shell quoting bugs (unquoted variables, word splitting, glob expansion). Respect the documented trust model for `parcelrc` (it is sourced as bash and treated as trusted code).
- **TM4 — Hostile local filesystem.** Crafted password-store contents (symlinks, deep/huge trees, metacharacter filenames, list↔decrypt TOCTOU races), crafted `.parcel.json` (glob overreach, empty rules, symlink policy bypass), hostile processes racing Parcel's own files.
- **TM5 — Supply chain / build integrity.** Anything introducing third-party runtime code, network access, or non-auditable artifacts into the shipped extension or host; source↔distribution parity (Makefile `chrome`/`firefox` targets, `.es6.js` shims, manifests); the bootstrap verification chain (GPG detached-signature verification, primary-fingerprint extraction from status output, `VALID_SIGNERS`, `HOST_HASH` pinned against `sha256sum` of the raw on-disk file, fail-closed on every step).

Criteria listed here are **not** exhaustive; they are examples. If you find something that does not fall within the listed examples above, it should still be reported under the appropriate threat model.

### 3. Coverage checklist — minimum scope, no skipped areas

Audit every area below. If an area is clean, say so explicitly in the report — never omit it silently.

**Native host (`parcel-host`, `src/parcel-host`):**

- Bootstrap verification chain: signature verification, fingerprint extraction, `VALID_SIGNERS` fallback list, temporary keyring lifecycle, `HOST_HASH` hash-basis matching documentation, fail-closed behaviour, shell quoting of every variable in command position.
- Whitelist evaluation: `.parcel.json` parsing via `jq`, include/ignore semantics, default-allow-all when absent, evaluation order relative to traversal.
- Path & symlink handling: `allowLinks`/`allowExternalLinks` enforcement timing (before traversal, not just before return), realpath containment to the store, list↔decrypt revalidation, DoS via huge external trees.
- Action dispatch: `action_$ACTION` gating (regex/allowlist), no accidentally-exposed functions, output sanitisation back to the extension.
- Rate limiter: token-bucket math, state-file persistence across restarts (kill-reconnect bucket-reset resistance), state file permissions/content (non-sensitive only), symlink/race resistance of the state file, disable semantics.
- Audit log: plaintext-never-logged invariant under **every** error path, field length caps, control-character handling, file permissions, forensic integrity.
- Passkey crypto: `openssl` key generation and signing, private key material never entering the browser process, host-side `rpId` binding and `allowCredentials` enforcement immediately before signing, consent gating.
- Constitution compliance host-side: verify mechanically (grep for network primitives, filesystem writes beyond the four permitted exceptions).

**Extension background (`src/js/agent.js`):**

- MV3 service-worker lifecycle and native-port reconnection; popup-port auth token generation entropy/lifetime/rotation; per-port-type action allow-list; origin reconciliation; entry-list cache and `changes_since` invalidation.

**Content scripts (`src/js/integration.js`, `src/js/main-world/*`):**

- Origin validation on **every** fill and decrypt path, including the broadcast best-target path and mid-decrypt navigation; per-field token flow; page↔isolated-world bridges treated as untrusted (CustomEvents, postMessage targets/origin checks, `attachShadow` patch); DOM clobbering; shadow-DOM selector scope.
- WebAuthn (`webauthn.js`, `main-world/webauthn.js`): consent cannot be bypassed or forged; Permissions-Policy check in the isolated realm; popup-spam guard; first-come-first-served interception behaviour matched to documentation; bridge forgery impact must be popup-annoyance at worst — never a signature, decryption, or mis-steered origin.
- Anything in a MAIN-world script that does not legitimately need to be in the MAIN world in order for Parcel to function. MAIN-world scripts share a javascript context with the page, and are therefore a high-risk surface.

**Popup (`src/js/popup.js`, `src/html/popup.html`):**

- Plaintext lifetime in memory/DOM; XSS sinks (`innerHTML` & co.) reachable from store-controlled data (entry names, paths, decrypted contents); history storage keying, per-origin/per-container scoping, cross-origin enumeration risk.

**Shared modules & config:**

- `schema.js` validation of `.parcel.json`; `additionalSelectors`/`additionalTargets`/`targets` as injection surfaces; `plaintext.js` parsing edge cases reachable from store-controlled content (OTP URIs, malformed/multiline bodies); regex/selector injection via config.
- Validation of all defined schemas against the meta-schema in the test suite.

**Manifest & packaging:**

- `src/manifest.json`: permission minimality, CSP for extension pages (incl. `connect-src 'none'; frame-src 'none'; base-uri 'self'`), `web_accessible_resources` minimality (each entry empirically justified), content-script scoping and injection timing. Packaging must not introduce behavioural divergence with security impact (Firefox manifest rewrite, `.es6.js` shims).

**Tests:**

- Coverage of security-critical paths (whitelist enforcement, rate-limiter persistence, port auth, origin validation); fidelity of the Chrome API mock and the GPG-mocked host tests; any test silently assuming insecure behaviour.

### 4. Finding requirements — verification, severity, deduplication

**Evidence & reachability (mandatory):** Every finding must have a traced reachable scenario — either (a) an attacker-controlled input path (per its threat model) leading to an exploitable behaviour, or (b) an **absent control** whose presence would block a concrete attack path — plus exact `file:line` citations (verify locations, don't approximate; cite all files involved). If you cannot construct a reachable scenario, do NOT report it as a finding — place it under "Residual Observations" or "Hardening Suggestions" with a clear statement that no reachable path was identified. No automated-scanner-style pattern-match findings without confirmed reachability. Unverifiable suspicions belong in the Second-Look section, not in Findings.

**Finding type and severity** — tie explicitly to Parcel's core assets: credential plaintext, GPG key protection, whitelist integrity, the host execution boundary, and the audit log's forensic integrity. The finding-type vocabulary is fixed at five severity tiers plus a tradeoff disposition; use no other labels:

| Letter | Finding type | Criteria |
|---|---|---|
| **C** | CRITICAL | Reachable exfiltration of credential plaintext beyond configured scope; exfiltration of GPG or passkey private key material; use of GPG as a signing oracle for attacker-chosen payloads; attacker-reachable arbitrary code execution or arbitrary file write on the host system; bypass of the host whitelist/decryption boundary from the browser; execution of unverified/unpinned host code. |
| **H** | HIGH | Reachable bypass of a documented protection (signature verification, rate limiting, rpId binding, popup authorisation, origin validation on fill, consent gating of passkey signing) with realistic exploitability. |
| **M** | MEDIUM | Exploitable only under narrow preconditions; limited disclosure crossing a trust boundary without credential exposure; a defence-in-depth gap in a control with no overlapping backup; implementation contradicting a documented security promise without a confirmed bypass. |
| **L** | LOW | Theoretical or minimal-impact issues; hardening opportunities; harmless documentation/implementation mismatches. |
| **I** | INFORMATIONAL | Documentation nits, stale comments, cosmetic issues with no security impact; noted for completeness only. |
| **T** | TRADEOFF | Not a severity tier but a disposition: the finding has been accepted by maintainers as a deliberate tradeoff. Used in place of a severity letter in the canonical finding ID (see below). Tradeoff-status findings are tracked in `findings.md` to prevent re-reporting. A finding already recorded as `T` in `findings.md` must not be re-reported unless its acceptance rationale no longer holds (per the deduplication rule below). |

If you are uncertain of a severity, flag the uncertainty explicitly and explain — never silently round down.

**Finding IDs** — `findings.md` assigns each tracked finding a canonical ID of the form `F<N><S>`, where `<N>` is a globally sequential number (oldest finding = lowest number, assigned in discovery order) and `<S>` is the finding-type letter from the table above. Severity is frozen at commit time — once a finding is recorded in `findings.md`, its letter never changes, even if later reviews would rate it differently. When referencing prior findings (e.g. in regression checks or deduplication), use the canonical `F<N><S>` ID from `findings.md`. In your own report, use your own local numbering for your new findings; the merge editor assigns canonical IDs when producing the merged report, updating both component reports and `findings.md` in the same atomic commit.

**TM1 inherent-control scope:** A malicious page inherently controls all page-realm (i.e. MAIN world) DOM, CSS, and JS on that page within its origin. A finding must articulate what the attacker gains beyond this inherent control.

**TM2 defence-in-depth scope:** A defence-in-depth gap is not a finding if the only actor who can exploit it has already compromised the extension context to a degree that makes the gap irrelevant (e.g. a compromised content script that implies a compromised service worker), unless the gap defeats a control specifically documented as a TM2 mitigation (e.g. the rate limiter).

**Regression checks:** For every prior finding in `findings.md` marked fixed/addressed/resolved, verify the fix in the current code — meaning the fix is still present, has not been partially reverted, and has not been bypassed or undermined by later changes touching the same path (these are distinct failure modes; check all three). Record one line per item in a `## Regression Checks` section. A fix that regressed becomes a new finding referencing the original finding's canonical `F<N><S>` ID from `findings.md`.

**Deduplication:** Do not re-report items whose maintainer response was acceptance ("accepted as-is", "by design", "acceptable tradeoff"), and do not re-report documented `SECURITY.md` tradeoffs. Exceptions — report it as a finding if the implementation now contradicts the documentation, or if a previously-accepted rationale no longer holds: for every accepted item, re-derive the acceptance rationale from the `findings.md` summary and test whether the current code still satisfies it. "Documentation/implementation divergence" is a first-class finding type in this project.

### 5. Process constraints

- **Read-only tree, permissive sandbox.** Never modify, create, or delete anything inside the reviewed repository tree other than your own report in `security-review/reviews/`. Outside the tree (e.g. `/tmp` or another scratch location), work that strengthens the review is expected: you may create PoCs and test fixtures, install sandbox tooling as needed, and run the existing test suite (`make test`). Document empirical verification — tools installed, PoCs built, and their outcomes — in Methodology.
- Do not commit, stage, push, open PRs, or open issues.
- **Subagents:** up to three simultaneous subagents using exactly the same model as the main session, each owning a distinct area. Suggested partition: (1) native host + constitution host-side; (2) extension JS + WebAuthn + popup; (3) manifest/build/tests + regression checks. You consolidate, deduplicate, and verify their output yourself — a subagent's finding never enters the report without your own verification trail. Never delegate the second-look pass.
- Reviews must be comprehensive across correctness, security, maintainability, UX, regressions, performance, and standards adherence — but only security-relevant output belongs in the report.

### 6. Cross-model verification (phase 2)

Another model conducts this same review fully independently. At the end of phase 1, write your consolidated findings table (columns exactly as specified in §8: ID, severity, confidence, area, threat model, title, file:line) to your findings-table exchange file (§0), ensure your draft report is saved — then **stop and wait**. Do not continue until the maintainer advises that the other model's exchange file is available and gives you its path.

When the maintainer advises that a copy of the other model's exchange file has been imported into your container:

1. Read that file — the exchange file **only**, never the other model's full report (independence of reasoning must be preserved; the table tells you *what* and *where*, you re-derive the *why* from the code).
2. Independently attempt to reproduce every finding in the table: trace the exploit path yourself and assess the severity under §4 yourself.
3. Add every confirmed finding you missed to your own report, with your own original analysis — never a copy of the other model's reasoning.
4. Record disagreements and non-reproductions explicitly in `## Cross-Model Verification`, e.g. "glm-5.2 rated this HIGH; this review rates it MEDIUM because <reasoning>". A verdict must never change merely to achieve consensus.
5. Once your report is finalised, delete **both** exchange files in your container (your own and the imported copy) — they are transient artifacts local to your container.

If no exchange file arrives (single-model review), the section must state that this phase was skipped, so the record stays honest; still delete your own exchange file once the report is finalised.

### 7. Second-look pass (mandatory, after drafting)

Re-read your full draft adversarially and document honest answers — a review claiming perfect coverage is less trustworthy than one acknowledging blind spots:

- Did every finding survive the reachability requirement, or did a "looks suspicious" slip through?
- Which coverage-checklist areas got only superficial treatment? Go through the checklist item by item.
- Which findings rest on unverified assumptions? What assumptions, exactly?
- Did you misattribute any documented tradeoff as a finding? Cross-check the tradeoffs table.
- Did you verify every `jq` call site, every unquoted `$VAR` in command position, every dispatch path?
- Is origin validation proven on every fill/decrypt path, including broadcast autofill and mid-decrypt navigation?
- Are severities consistent — would you defend each CRITICAL/HIGH to a human demanding proof? Have you used only the six permitted finding-type letters (C/H/M/L/I/T)?
- Did you accidentally access anything under `security-review/reviews/`?
- For each finding: state confidence (High/Medium/Low) and what evidence would change it.

### 8. Report structure

Save to the path derived in §0, with this structure:

1. `## Executive Summary` — overall posture, finding counts by severity, the single most important takeaway.
2. `## Trust Model & Attack Surfaces` — confirm which components were examined and summarise the trust-boundary hierarchy in your own structural analysis. Paraphrasing `SECURITY.md` back is not sufficient — this section must reflect your own examination of the code.
3. `## Methodology` — model identity; documents read (proves grounding compliance); confirmation no prior full reviews were accessed; source files examined; tests run and results; subagent allocation; limitations.
4. `## Findings` — consolidated table first (ID, severity, confidence, area, threat model, title, file:line — this is the table exchanged in phase 2), then one subsection per finding ordered by severity: Description; Threat model(s); Evidence (`file:line`); Exploit scenario; Recommended fix.
5. `## Regression Checks` — one line per prior fixed finding verified.
6. `## Deliberate Tradeoffs` — documented tradeoffs re-examined: confirmed still acceptable, or divergent (with reference to any resulting finding).
7. `## Residual Observations` — risks inherent to the design, and hardening notes with no reachable path.
8. `## Things Done Well` — genuine, specific positives worth protecting.
9. `## Cross-Model Verification` — phase-2 outcome (confirmed additions, disagreements, non-reproductions), or an explicit "skipped — single-model review".
10. `## Second-Look Review` — answers to §7's checklist, including confidence calibration per finding.
11. `## About This Review` — model, date, and commit ref (and tag if any). The committed `security-review/prompt.md` is the canonical record of what was prompted (do not embed the prompt in the report).

### 9. Final rules

- Do not update `security-review/findings.md` — maintainers own responses and the summary.
- Treat safety of users' credentials and security of users' operating systems outside of the browser sandbox as the goal: be critical, be concrete, be honest about uncertainty.

**Begin now:** prepare identifying info (§0), ground yourself (§1), enumerate threat models (§2), deploy subagents (§5), audit every checklist area (§3), verify and consolidate findings (§4), complete phase 2 if a findings table arrives (§6), perform the second-look pass (§7), and save the report (§8).

---

> **Maintainer notes — the appendix below is a separate prompt, sent only to the merge-editor model, together with both completed phase-2 reports (full text).**

You are the **merge editor** for a two-model security review of **Parcel** (a password-manager browser extension bridging the browser to a `pass`-style GPG-encrypted password store). Two models have independently completed the standard Parcel review protocol, including cross-verification: each has verified, added, or disputed the other's findings. Your task is **editorial, not investigative** — you must not introduce new findings or resolve disagreements between the two models. You do, however, assign the single canonical `F<N><S>` ID for each finding, which includes choosing one severity letter when the component reviews disagree (see §2).

Inputs you will receive: both models' full post-phase-2 reports, and the base-prompt version string.

Produce one unified report at `security-review/reviews/vX.Y.Z/merged-<model>.md` for release reviews, or `security-review/reviews/other/<yyyymmdd>-merged-<model>-<ref>.md` for reviews where the current commit is newer than the current release tag (today's date; short commit hash of `HEAD`). Never clobber an existing file — append `-2`, `-3`, … as needed).

Your report should use this structure:

1. `## Executive Summary` — consolidated posture, key strengths and weaknesses, finding counts by severity and by provenance (found by both / by one and confirmed in cross-verification / disputed).
2. `## Findings` — deduplicated, severity-ordered findings. Each finding carries: a canonical `F<N><S>` ID (assigned by you, continuing the global sequence from `findings.md`); provenance tag (`both models`, `kimi only — confirmed by glm`, `glm only — not reproduced by kimi`, …); a mapping line to the source finding IDs in each model's report; and a single consolidated analysis assembled from both reports without losing either's evidence (`file:line` citations from both). When the two component reviews disagree on severity, you must choose one severity letter for the canonical ID — never use compound or ambiguous forms (e.g. `F14H/M` is invalid; pick `F14H` or `F14M`). Record the unchosen position in `## Disagreements`.
3. `## Disagreements` — one subsection per disputed finding or severity, presenting each model's position and rationale **verbatim**. Do not adjudicate; the disagreement record is the output.
4. `## Regression Checks`, `## Deliberate Tradeoffs`, `## Residual Observations` — merged, deduplicated, provenance-tagged. Present as a one-finding-per-line table.
5. `## Methodology` — which models produced the source reports, merge date, and a confirmation that you introduced no findings and changed no severities.
6. `## About This Merge` — your model identity, and the source report filenames. The committed `security-review/prompt.md` is the canonical record of both prompts (do not embed them in the report).

**Do not carry over the models' process scaffolding as report sections.** Each source report's `## Second-Look Review`, `## Trust Model & Attack Surfaces`, confidence calibrations, and similar self-critical or grounding material are working context that exists to make the source reports high-quality — they are not final output sections in their own right and must not appear as sections in the merged report. They may quietly inform your consolidation (e.g. a low-confidence finding stays tagged low-confidence), but the merged document presents finished conclusions, not the machinery that produced them.

Constraints: no commits, pushes, PRs, or issues; do not open any files under `security-review/reviews/` other than the two reports you were given and your own output. You may modify three things: your merged report, the two component reports (updating finding IDs to canonical `F<N><S>` form only — do not modify any other aspect of the original reviews), and `security-review/findings.md` (appending new findings with their canonical IDs and maintainer responses). All four files — both component reports, the merged report, and `findings.md` — are committed together atomically by the maintainer. Where the two reports genuinely conflict on a fact, present both statements with attribution rather than choosing one. Where both models have reported a finding, that finding should be assigned **one** unique ID across all locations, not a different ID for each model that reported it.



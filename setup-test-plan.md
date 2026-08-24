# Parcel Setup Script — Test Harness Plan

TODO: Delete this file before merging the PR.

Work-in-progress plan for adding a runtime test harness to `parcel-setup.sh`, mirroring
the conventions used for the extension and native host (`test/*.test.js`,
`node:test` + `node:assert`, isolated temp environments, mocked toolchain).

> Status: **draft — iterate before implementing.** Nothing here is implemented yet.

> ### Standalone requirement
>
> **The setup-script test suite must be entirely standalone from the rest of the
> project's tests.** It should not import, require, or otherwise depend on any other
> test file or shared fixture in `test/`. Concretely:
>
> - `test/setup/` must not `import` `test/chrome-api-mock.js`, nor reuse helpers from
>   `test/native-host.test.js` or any other `test/*.test.js`.
> - It must supply its own harness and fixtures (`test/setup/harness.js`), duplicating
>   any scaffolding it needs rather than reaching into the existing suite.
> - It must be runnable in isolation via its own Makefile target, without executing
>   any of the other `test/*.test.js` files.
> - No shared global state, temp layout, or generated files with the other suites —
>   every test manages its own `mkdtemp` environment.
>
> "Standalone" governs **code and state independence only** — it does not prohibit
> reusing the same *style/conventions* (`node:test`, `node:assert`, temp-dir mocking)
> as the rest of the suite.
>
> **Decided (during iteration):**
> - Runner: **`node:test` + `node:assert`** (zero new deps, consistent with the suite).
> - Sequencing: **incremental** — implement Stage 1 + Stage 2 first, pause for review,
>   then proceed to Tier 1/2/3 in later increments.
>
> ### Testing principles
>
> - **No trivial / low-value tests.** Every test must verify something substantial;
>   a test that only re-states the implementation is not worth writing.
> - **Prefer end-to-end coverage.** A test that exercises a large swathe of logic is
>   worth more than many micro-tests. Trivial mechanical helpers are covered
>   *incidentally* by the higher-value tests rather than given their own test.
> - **Do not test what `shellcheck` already catches.** Static syntax, quoting, and
>   pattern issues belong to the linter; the runtime suite asserts *behaviour* only.
> - **One `test()` per function where suitable.** Cover the whole of a substantial
>   function in a single `test()` (with multiple asserts inside) rather than one test
>   per branch — this keeps the test count from ballooning while a failure still points
>   unambiguously at one function.
> - **Every `test()` carries a brief JSDoc comment** explaining what it verifies. Keep
>   the description short — one line is ideal.
> - **100% path coverage is not required.** We target the *main* behaviour of each
>   function; leaving an occasional rarely-called branch untested is acceptable.

---

## 1. Background & motivation

`src/parcel-setup.sh` is the only substantial component of the project with **no
runtime coverage**. `make test-setup` currently runs only:

```bash
bash -n src/parcel-setup.sh
shellcheck -x src/parcel-setup.sh
```

That is static lint only. The script (~2,300 lines, 59 functions) contains a lot of
subtle, regression-prone logic that has already produced real bugs during review:

- `detect_rules` — rule sort order (path-element count, not string length), the
  `>=2` consolidation threshold, `.+/` vs `(.+/)?` wildcard choice, and the
  top-level fallback rule.
- `prompt_bool` — boolean input normalisation (previously a `jq --argjson` hard-crash
  and silent `1`/`0` → number corruption).
- `set_parcelrc_var` — insert-vs-force semantics, `0600` preservation.
- `generate_manifest` — chromium vs firefox JSON shape.

**Goal:** give each of these behaviours a regression test, using the same
zero-third-party-dependency approach as the rest of the suite.

**Non-goals (for now):** exhaustive coverage of every branch of every function;
stress/performance testing; testing the generated `parcel-setup.sh` distribution
artifact (we test `src/`).

---

## 2. Key architectural decision — make the script sourceable

The script is monolithic and ends with an unconditional dispatch:

```bash
main "$@"
```

To unit-test individual functions we must be able to `source` the file without
triggering the program. The standard idiom is a one-line guard:

```bash
[[ "${BASH_SOURCE[0]}" == "$0" ]] && main "$@"
```

- **Behaviour-neutral at runtime** — when executed, `BASH_SOURCE[0] == $0`, so
  `main` still runs.
- When *sourced* from a test, the guard skips `main` and the functions + globals are
  available for direct invocation.
- This is the **only** required change to the production script.
- Side-effect when sourced: the top-level `set -uo pipefail` and the global
  initialisations run in the sourcing shell. Tests must therefore source inside a
  fresh `bash` child (see §6).

---

## 3. Test location & runner

- **Location:** `test/setup/` (new subdirectory), as requested.
    - `test/setup/harness.js` — shared helpers (env builder, mock-tool shims, sourcing).
    - `test/setup/*.test.js` — one file per area (see stages below).
- **Runner:** ✅ `node:test` + `node:assert` (resolved). Zero new deps, consistent
  with the rest of `test/`. Each test spawns `bash` children to source the script and
  exercise functions.

---

## 4. Functional classification (testability tiers)

| Tier | Functions | Test style |
| --- | --- | --- |
| **1 — Pure logic** | `expand_tilde`, `normalize_os`, `command_exists`, `manifest_key`, `browser_in_filter`, `get_user_home`, `flatpak_wrapper_dir`, `indent_json`, `config_query`, `get_browser_config`, `browser_field`, `prompt`, `prompt_yesno`, `prompt_bool`, `generate_manifest`, `detect_rules`, `set_parcelrc_var` | Direct invocation after `source`; set globals, assert stdout/exit. |
| **2 — Filesystem/detection** | `detect_single_tool_path`, `detect_tool_paths`, `detect_password_store`, `detect_browsers`, `detect_flatpak_browsers`, `confirm_browsers`, `run_detect`, `offer_host_hash`, `resolve_prefix`, `resolve_install_level`, `detect_platform`, `detect_nixos`, `check_dependencies`, `parse_args`, `print_usage`, `load_dev_fallback` | Mocked PATH/shims + canned `SETUP_CONFIG` + temp HOME. Some need `--yes`/`SUDO_USER` faking. |
| **3 — Side-effectful integration** | `install_bootstrap_host`, `install_native_manifests`, `generate_flatpak_wrapper`, `install_flatpak_wrappers`, `run_host_as_user`, `first_smoke_test`, `second_smoke_test`, `apply_parcelrc_customisations`, `apply_host_hash`, `summary_report`, `apply_install`, `do_uninstall`, `run_config_builder`, `cleanup`, `on_signal`, `main` | End-to-end in isolated temp HOME with mocked `gpg`/`jq`/`openssl`/`sudo`/`uname`, `--yes` mode. |

Tier 1 has the highest bug-fix value per line of test; Tier 3 has the highest effort
and portability risk. The staged plan therefore front-loads Tier 1.

Per the testing principles (§0), the *trivial* Tier-1 helpers (`expand_tilde`,
`normalize_os`, `command_exists`, `manifest_key`, `browser_in_filter`,
`get_user_home`, `flatpak_wrapper_dir`, `indent_json`, `config_query`,
`get_browser_config`, `browser_field`) are **not** given individual tests — they are
covered incidentally by higher-value tests (or grouped into one consolidated test
only where they exhibit non-obvious behaviour). Focused tests target the substantive
functions: `prompt`/`prompt_yesno`/`prompt_bool`, `generate_manifest`, `detect_rules`,
and the parcelrc path (`set_parcelrc_var` + `apply_parcelrc_customisations` +
`apply_host_hash`).

---

## 5. Staged plan

### Stage 1 — Library-ability guard
- [ ] Add `[[ "${BASH_SOURCE[0]}" == "$0" ]] && main "$@"` in place of `main "$@"`.
- [ ] Verify `bash -n src/parcel-setup.sh` + `shellcheck -x` still clean.
- **Acceptance:** `make test-setup` green; script still runs end-to-end unchanged.

### Stage 2 — Harness foundation (`test/setup/harness.js` + smoke test)
- [ ] `harness.js` helpers:
    - `sourceScript(code)` — spawn `bash -c 'source …; <code>'` with a controlled env,
    returning `{ stdout, stderr, code }`.
    - `makeTempHome()` — `mkdtemp` isolated HOME. Deliberately **empty** at this
    stage: it returns a clean-slate HOME (plus a `cleanup()` remover) with no
    fixtures. Fixture population (fake password-store tree, `parcelrc`,
    `.parcel.json`) is added in Stage 3/4, where concrete assertions pin the
    exact fixture shape. Tests must pass `HOME` via `sourceScript`/`runBash`
    `opts.env` — it is not read from `process.env` (see §6).
    - `writeMockBin(dir, name, script)` — drop shim binaries (`gpg`, `jq`, `openssl`,
    `uname`, `sudo`) into a `bin/` dir and prepend to `PATH`.
    - `withSrcLoaded(fn)` — pattern to source once, run multiple assertions, in a
    single child where state must persist (e.g. globals set by a function).
- [ ] Smoke test proving sourcing reaches a known function (e.g. `manifest_key`).
- [ ] Add the runtime runner into `test-setup` (a `test-setup-run` recipe, or fold the
  `node --test` call directly into `test-setup`); `make test` stays unaffected.
- **Acceptance:** `node --test test/setup/smoke.test.js` passes.

### Stage 3 — Behavioural unit tests (substantial logic only)
- [ ] `test/setup/prompt.test.js` — one `test()` per function: `prompt_yesno` and
  `prompt_bool` (default/`--yes` short-circuit, case-insensitive accept list,
  re-prompt on invalid input), and `prompt` default handling.
- [ ] `test/setup/manifest.test.js` — one `test()` covering `generate_manifest`
  (chromium vs firefox JSON shape, flatpak description variant).
- [ ] Trivial helpers are **not** tested individually — see §4 note; they are covered
  incidentally by the higher-value tests.
- **Acceptance:** every asserted behaviour is substantial; one `test()` per function.

### Stage 4 — Behavioural core (highest regression value)
- [ ] `test/setup/detect-rules.test.js`:
    - sort by path-element count (regex wildcards `.+/`, `(.+/)?` included).
    - `>=2` direct-subdirectory consolidation (family/clients/projects patterns).
    - fallback top-level rule for containers with no class dirs.
    - proven against fixture trees mirroring the user's production `.parcel.json`.
- [ ] `test/setup/parcelrc.test.js`: `set_parcelrc_var` (insert-below-default,
  force-replace, already-set no-op, `0600`), `apply_parcelrc_customisations`,
  `apply_host_hash`.
- **Acceptance:** the exact behaviours that previously regressed are locked down.

### Stage 5 — Tier 2 detection (mocked toolchain)
- [ ] `test/setup/detect-tools.test.js`: `detect_single_tool_path` priority order
  (parcelrc → default-path → `command -v` → macOS fallback → prompt); broken-parcelrc
  clobber → sets `FORCE_*`; `detect_tool_paths` dispatcher.
- [ ] `test/setup/detect-passdir.test.js`: `detect_password_store` precedence
  (flag → parcelrc → env → `~/.password-store` → prompt).
- [ ] `test/setup/detect-browsers.test.js`: `detect_browsers`/`detect_flatpak_browsers`
  against mocked `uname` + manifest fixtures (verify no false positives from stray
  `NativeMessagingHosts` dirs).
- **Acceptance:** detection functions tested against controlled fixtures, no real
  `/usr/bin` short-circuit assumptions (steer around them — see §6).

### Stage 6 — Tier 3 end-to-end integration
- [ ] `test/setup/install.test.js`: full `apply_install` in temp HOME with mocked
  `gpg`/`jq`/`openssl`/`sudo`/`uname` + `--yes`; assert host binary, manifests,
  parcelrc (tool paths, `PASSWORD_STORE_DIR`, `HOST_HASH`), smoke-test pass.
- [ ] `test/setup/uninstall.test.js`: `do_uninstall` (+ `--remove-config`) asserts
  exact removals and preservation of parcelrc/`.parcel.json` by default, and the
  flatpak D-Bus revocation path.
- [ ] `test/setup/errors.test.js`: `die`/`on_signal`/`cleanup` behaviour, smoke-test
  failure → parcelrc rollback.
- **Acceptance:** a full install→smoke→uninstall round-trip is green in CI.

### Stage 7 — Finalise & integrate
- [ ] Confirm `make test-setup` runs the full suite (lint + runtime) end-to-end.
- [ ] Decouple `test-setup` from `make test`'s prerequisites (see §7).
- [ ] `make prettier` on new test files; confirm `make test-setup` green.
- [ ] Update `README`/`Makefile` help text (the `test-setup` description) if needed.
- **Acceptance:** `make test-setup` passes with the new suite included; `make test`
  (the rest of the project) is still green and fully independent of it.

---

## 6. Mocking strategy & known gotchas

- **`sudo`:** `resolve_install_level` re-execs via `sudo env …` in system mode; tests
  must force `INSTALL_LEVEL=user` (or `--user`), and shim `sudo` when the `SERVICES_USER`
  path is exercised (set `SUDO_USER` to simulate the post-`sudo` context).
- **`/dev/tty` prompts:** `prompt`/`prompt_yesno`/`prompt_bool` read `/dev/tty` and
  hard-fail without a TTY. Use `--yes` (`YES=true`) short-circuits for non-interactive
  paths; for the accept-list tests, drive via `stdin` rather than a pseudo-TTY to
  avoid `expect`/`script` (extra deps).
- **`/usr/bin/*` default paths:** `detect_single_tool_path` short-circuits when
  `/usr/bin/gpg` (etc.) is executable — not shimmable without root. Tests must set an
  existing-but-broken `parcelrc` value or otherwise route through `command -v` to
  avoid depending on the host's real `/usr/bin` layout.
- **`uname`/OS pinning:** `normalize_os`/`detect_platform` call `uname`; provide a mock
  `uname` on `PATH` to test the darwin/linux/bsd and unsupported-OS branches.
- **`set -uo pipefail` leakage:** sourcing applies the script's options and global
  initialisation to the calling shell. Always source in a disposable `bash` child;
  reset globals between assertions that share one child.
- **Stateful globals:** many functions write globals (`CUSTOM_GPG`, `DETECTED_BROWSERS`,
  `APPLIED_*`, …). Prefer a fresh child per focused test; use `withSrcLoaded` only
  when the test intentionally sequences calls.
- **Consistency (style only):** the *style/conventions* (temp dirs, `bin/` shims,
  `spawn`, `node:assert`) may mirror `test/native-host.test.js`, but **no code or
  fixtures are shared** — the standalone requirement (§0) applies to all imports and
  state.

---

## 7. Makefile wiring (summary)

- `test-setup` becomes the owner of the entire setup-script suite: `bash -n`,
  `shellcheck -x` **and** `node --test $(TEST_FLAGS) test/setup/*.test.js`.
- The runtime tests are wired into **`test-setup`** and **not** into `make test`.
- **Decoupling note:** the current `test` target lists `test-setup` as a prerequisite
  (`test: test-syntax test-setup`). To honour "not in `make test`", drop `test-setup`
  from the `test` target's prerequisites so the aggregate suite no longer transitively
  pulls in the setup-script tests. `make test-setup` remains the sole entry point for
  this suite.

---

## 8. Open decisions (for iteration)

1. **Runner:** ✅ resolved — `node:test` + `node:assert`. See §3.
2. **Scope of Stage 5/6:** is end-to-end (Tier 3) in scope now, or defer to a later
   PR and land Tier 1 + Tier 2 first?
3. **`detect_browsers` false-positive test:** how faithfully to model the
   `NativeMessagingHosts` dir from another tool — needs a fixture design decision.
4. **`get_user_home` darwin branch:** `dscl` only exists on macOS; decide whether to
   shim `dscl`/`getent` on PATH so both branches are CI-testable on any OS.
5. **Where `setup-test-plan.md` lives** (repo root vs `test/setup/` vs session
   artifacts) and whether it should be deleted after implementation.

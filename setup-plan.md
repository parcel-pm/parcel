# Parcel Setup Script — Design Plan

TODO: Delete this file before merging the PR.

## Overview

A bash setup script that handles the parts of Parcel installation that the
webstore extension install cannot: installing the bootstrap host, generating
native messaging manifests for detected browsers, generating a tailored
parcelrc, and optionally building an interactive `.parcel.json` ruleset.

The script is distributed as a single self-contained file with the bootstrap
host and setup config bundled inside it as heredocs. It is GPG-signed as part
of the existing `make release` flow.

## macOS compatibility

The script **must** run on the bash and system utilities shipped with macOS
out of the box. Specifically:

- **Bash 3.2**: macOS ships `/bin/bash` at version 3.2 (from 2007). The
  script must avoid bash 4+ features such as associative arrays
  (`declare -A`), `mapfile`/`readarray`, `${var^^}` case conversion, and
  `coproc`.
- **BSD utilities**: macOS ships BSD variants of `sed`, `find`, `cp`, `mv`,
  `install`, etc., not GNU coreutils. The script must use only
  portable/BSD-compatible flags (e.g. `sed -i ''` not `sed -i''`, `find …
  -maxdepth` works on both).
- **No sha256sum**: macOS ships `sha256` instead of `sha256sum` (GNU
  coreutils). Use `command -v sha256sum || command -v sha256` (the bootstrap
  host already does this).
- **No homebrew dependency for the script itself**: the script must not
  require homebrew, MacPorts, or any third-party package manager to run. It
  may *detect* homebrew-installed tools (e.g. gpg) and configure the
  parcelrc to use them, but the script itself must function with only
  macOS-shipped utilities. `jq` is present on macOS out of the box, so it
  is freely used for JSON parsing and generation. `gpg` is not shipped with
  macOS — it is a required dependency (the bootstrap host needs it), and
  the user must have it installed (e.g. via homebrew or GPG Suite).
- **Shebang**: `#!/usr/bin/env bash` — respects the user's PATH,
  consistent with the bootstrap `parcel-host`.

## Source files

| File | Role |
|---|---|
| `src/parcel-setup.sh` | Main setup script source (bash). Contains all install/detect/configure logic. References `$BOOTSTRAP_HOST`, `$SETUP_CONFIG`, and `$SIGNED_HOST_SHA256` as normal variables — no placeholders or markers in the source. In development these are unset; the script can detect this and fall back to reading from the actual source files. |
| `src/parcel-setup.json` | Declarative browser/platform/flatpak config. Defines browsers, their manifest paths per OS/install-level, detection paths, and flatpak app IDs. Parsed with jq at runtime. |
| `parcel-setup.sh` (repo root, generated) | Generated distributable. `make setup` prepends a heredoc preamble containing the bootstrap host (`parcel-host`), `parcel-setup.json`, and the SHA256 hash of the signed host (`src/parcel-host`), then appends `src/parcel-setup.sh` below it. The result is a single self-contained script. Copied to `dist/` and GPG-signed by `make release`. |

## Build flow changes

A new `make setup` target generates the distributable setup script. It is
independent of `make release`, but `make release` depends on it.

### `make setup` (new target)

1. Compute SHA256 of `src/parcel-host` (the signed host — this is what the
   extension pushes to the bootstrap host at runtime, and the hash is used
   for `HOST_HASH` pinning in the parcelrc). `src/parcel-host` is
   binary-identical to the distributed copy, so `make release` does not need
   to run first.
2. Generate `parcel-setup.sh` in the repo root by concatenating:
   - A heredoc preamble assigning `BOOTSTRAP_HOST` (from repo-root
     `parcel-host`), `SETUP_CONFIG` (from `src/parcel-setup.json`), and
     `SIGNED_HOST_SHA256` (hash of `src/parcel-host`)
   - The contents of `src/parcel-setup.sh` below the preamble

Note: `src/parcel-host` (the signed host) is not embedded in the setup
script — it comes through the extension at runtime via the `install` action.
Only its SHA256 is embedded, so the setup script can optionally set
`HOST_HASH` in the user's parcelrc for script-pinning (the user must review
and approve any future signed-host updates before they execute). The
variable names use `BOOTSTRAP_HOST` for the installed bootstrap and
`SIGNED_HOST_SHA256` for the hash of the signed host, to avoid confusion
between the two `parcel-host` files.

Bash does not hoist variable assignments — code after `exit` never runs.
Prepending the heredoc assignments before the main script body avoids the
need for any placeholders or markers in the source file. The source script
simply references `$BOOTSTRAP_HOST`, `$SETUP_CONFIG`, and
`$SIGNED_HOST_SHA256` as normal variables.

The generated `parcel-setup.sh` is added to `.gitignore` — it is a build
artifact, not source code.

### `make release` (existing target, updated)

`make release` gains a dependency on `make setup`. It copies the generated
`parcel-setup.sh` from the repo root into `dist/`, and the existing release
flow's GPG-signing loop (which already signs everything in `dist/`) covers
the setup script's `.asc` signature. The script and its signature are
included alongside the other release artifacts in `dist/`.

The user downloads `parcel-setup.sh` and its `.asc` signature, verifies with
GPG against the official release keys, and runs it. The GPG signature on the
setup script transitively covers the embedded bootstrap host — no separate
verification step needed.

## `parcel-setup.json` structure (conceptual)

```jsonc
{
  "browsers": [
    {
      "name": "chrome",
      "engine": "chromium",
      "detect": {
        "darwin": ["/Applications/Google Chrome.app"],
        "linux": ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]
      },
      "manifestDir": {
        "darwin-system": "/Library/Google/Chrome/NativeMessagingHosts",
        "darwin-user": "~/Library/Application Support/Google/Chrome/NativeMessagingHosts",
        "linux-system": "/etc/opt/chrome/native-messaging-hosts",
        "linux-user": "~/.config/google-chrome/NativeMessagingHosts"
      }
    }
    // brave, vivaldi, arc, edge, chromium, firefox, iridium, slimjet, yandex...
  ],
  "flatpak": {
    "browsers": [
      { "name": "firefox", "appId": "org.mozilla.firefox" },
      { "name": "chrome", "appId": "com.google.Chrome" }
    ],
    "wrapperDirTemplate": "~/.var/app/{appId}/config/parcel"
  },
  "extensionIds": {
    "chromium": "ciifpadakeohfnnneflckhojbldkkllp",
    "firefox": "parcel@erayd.net"
  },
  "hostName": "com.github.erayd.parcel"
}
```

## Setup script structure

The script operates in three phases: **detect**, **preview**, **apply**.
All detection happens first, the proposed changes are summarised for user
confirmation, and only then are any filesystem modifications made.

```
parcel-setup.sh
├── CLI argument parsing (--system/--user, --uninstall, --remove-config,
│   --create-config, --browser <name>, --yes, --prefix <path>,
│   --flatpak-only)
├── Platform detection (OS, arch, install level)
├── Dependency checks (jq, gpg, sha256)
├── Parse embedded parcel-setup.json
├── [Phase 1: DETECT] — no filesystem changes
│   ├── Resolve install prefix
│   ├── Extract bootstrap host (in temp file only)
│   ├── Detect installed browsers
│   ├── Detect flatpak browsers (if flatpak present)
│   ├── Detect password store location
│   ├── Interactively ask the user about custom gpg/jq paths and other
│   │   parcelrc customisations (presenting detected values as defaults)
├── [Phase 2: PREVIEW]
│   ├── Print summary of all proposed changes
│   │   - Files to install / overwrite
│   │   - Manifests to generate / overwrite
│   │   - Flatpak wrappers to install
│   │   - parcelrc settings to apply (stricter-only)
│   │   - Registry/override changes (flatpak)
│   └── Prompt user to proceed (default: no; requires explicit yes)
│       — with --yes, skip prompt and proceed automatically
│       — an empty/Enter response means "no, abort"
├── [Phase 3: APPLY]
│   ├── Install bootstrap host to target path
│   ├── Generate & install native messaging manifests
│   ├── Install flatpak wrappers & apply overrides
│   ├── First smoke test (cold start → creates parcelrc if needed)
│   ├── Apply parcelrc customisations (stricter-only, user-chosen paths)
│   ├── Second smoke test (verification → revert on failure)
│   └── Apply remaining parcelrc customisations (e.g. HOST_HASH)
├── Summary report (what was done)
└── Offer to run interactive config builder (--create-config)
```

For uninstall mode, the same detect → preview → apply flow applies: the
script detects what is installed, shows what it will remove, confirms, then
removes.

### Signal handling

The script installs a `trap` for `INT`, `TERM`, and `EXIT`. On interruption
during the APPLY phase, the trap cleans up temp files. Partial changes
already applied are not rolled back (the script reports what was completed
and what was interrupted).

### `--yes` behaviour

With `--yes`, the script auto-accepts all detected values without
prompting — including gpg/jq paths, browser selection, and the preview
confirmation. However, it does **not** override values the user has already
configured in their parcelrc. Existing user configuration always takes
precedence.

## Platform & browser detection

1. Detect OS (`uname -s` → Darwin/Linux/BSD variants)
2. Determine install prefix:
   - System-wide (default, requires sudo): `/usr/local` on Linux/BSD and macOS.
     The host binary goes to `/usr/local/bin/parcel-host`. When running with
     sudo, the script uses `sudo -u "$SUDO_USER"` to run the smoke test as
     the invoking user, so that `~/.config/parcel/parcelrc` and
     `~/.local/log/parcel-host.log` are created with correct ownership.
   - User-level (no sudo): `~/.local` on all platforms (including macOS).
     The host binary goes to `~/.local/bin/parcel-host`. If the directory
     doesn't exist, create it with `mkdir -p`.
   - Override with `--prefix`
3. For each browser in `parcel-setup.json`:
   - Check detection paths for the current OS
   - Also check if a NativeMessagingHosts dir already exists (user may have
     manually set up the directory)
   - If detected → generate + install manifest (clobber any existing
     manifest file — the host path may have changed)
   - If not detected → silently skip

## Manifest generation

Two native messaging host manifest formats (not to be confused with the
extension manifest in `src/manifest.json` — these are the install manifests
that tell the browser how to launch the bootstrap host). These match the
existing `example/` files:
- **Chromium-based**: uses `allowed_origins` with the Chrome extension ID
- **Firefox**: uses `allowed_extensions` with the Firefox extension ID
- Both: `path` field set to the installed bootstrap host location
- Generated with jq, written to the browser's NativeMessagingHosts directory

## Bootstrap host installation

1. Extract the heredoc-embedded bootstrap host (`$BOOTSTRAP_HOST`) to a temp
   file
2. Install to target path (`/usr/local/bin/parcel-host` or
   `~/.local/bin/parcel-host`)
3. `chmod 0755`

SHA256 verification of the signed host is handled by the bootstrap host
itself at runtime — the setup script does not perform hash verification.
The embedded `$SIGNED_HOST_SHA256` is used only for `HOST_HASH` pinning in
the parcelrc (see parcelrc customisation below).

## Flatpak handling

1. Detect if `flatpak` command is available
2. `flatpak list` to find installed flatpak browsers
3. For each flatpak browser found:
   - Install the wrapper script to
     `~/.var/app/<appId>/config/parcel/parcel-flatpak-wrapper.sh`
   - Set `PARCEL_HOST_PATH` in the wrapper to the actual installed bootstrap
     host path (e.g. `/usr/local/bin/parcel-host`)
   - Generate the flatpak manifest pointing to the wrapper
   - Install manifest to the flatpak-visible NativeMessagingHosts dir
   - Run `flatpak override --user --talk-name=org.freedesktop.Flatpak <appId>`

## Smoke test

The smoke test runs twice: once to bootstrap the default parcelrc, and once
to verify the final configured state.

### First smoke test (cold start)

1. Run the bootstrap host with empty stdin
2. Bootstrap host will:
   - Create `~/.config/parcel/parcelrc` if it doesn't exist (first run)
   - Send bootstrap-ready message to stdout (captured/ignored)
   - Exit when stdin closes (clean exit)
3. If this fails → report the error, abort (nothing to retry — the parcelrc
   doesn't exist yet)

### Apply user-chosen paths

After the first smoke test, apply the gpg/jq paths the user chose during
the DETECT phase (if any differ from defaults) to the parcelrc, following
the customisation rules below.

### Second smoke test (verification)

1. Run the bootstrap host again with empty stdin
2. Bootstrap host will:
   - Verify jq and gpg work with the configured paths (fails loudly if
     broken)
   - Send bootstrap-ready message to stdout (captured/ignored)
   - Exit when stdin closes (clean exit)
3. If this fails → revert any parcelrc change made during this step, report
   the error, abort

This serves double duty: config file generation (the first run creates the
default parcelrc) and a real-environment runtime test that verifies the
host actually functions with the user's chosen configuration (the second
run). Everything applied before the second smoke test was shown in the
preview, so there are no surprise changes.

## parcelrc customisation

1. Smoke test has already created the default parcelrc (or it already existed)
2. For each detected value the script wants to set:
   - Read current parcelrc value
   - If still at default (commented out or unset) → apply detected value
     on the line immediately below the commented-out line for the same
     variable. This keeps the documented defaults visible to the user
     even when a value has been customised.
   - If the script's value is stricter than the current → apply it (below
     the commented-out line, as above)
   - If user has already set a non-default value → leave it alone
3. Detected values include:
   - `HOST_HASH`: set to `$SIGNED_HOST_SHA256` (the hash of `src/parcel-host`)
     if not already set — this pins the signed host script so the user must
     review and approve any future updates before they execute (this is
     stricter than the default of no pinning). When an extension update
     pushes a new signed host that doesn't match the pinned hash, the
     extension proactively notifies the user and prompts them to review the
     new host and update the hash in parcelrc if they accept it — no
     setup-script re-run needed.
   - `GPG` path if gpg isn't in the default PATH (e.g. homebrew on macOS —
     set `GPG=/opt/homebrew/bin/gpg` rather than modifying `PATH`)
   - `JQ` path if jq isn't in the default PATH (e.g. homebrew on macOS —
     set `JQ=/opt/homebrew/bin/jq` rather than modifying `PATH`)
   - `PASSWORD_STORE_DIR` if `pass` uses a non-default location
   - `LOGFILE` / `STATEFILE` if the default paths don't make sense for the
     platform

The principle: only nudge settings toward stricter values, never loosen what
the user has explicitly set. User edits are always preserved.

## Interactive `.parcel.json` config builder (`--create-config`)

Invoked explicitly via flag, or offered as a prompt at the end of the main
setup process. Can be re-run independently without redoing the full install.
Covers all `.parcel.json` options, not just rules — the user is also asked
about `allowLinks`, `auditDecrypt`, `gitInPasskeyCommand`, `passkeyDir`, and
other non-rule settings.

1. Detect password store directory
2. Scan with `find` (respecting `.gitignore` if present, following symlinks
   if configured)
3. Build a directory tree
4. Auto-detect patterns:
   - Top-level dirs as candidate groups
   - Common credential-type subdir names (login, passkey/passkeys, card/cards)
   - Nested subgroup patterns (e.g. `family/<sub>/login/`)
5. Present suggested ruleset to the user:
   - Show each group with its suggested tag and rules
   - Allow editing tag per group (color is not asked — a future extension
     change will auto-generate tag colours based on the tag name when a
     colour is not set)
   - Allow adding/removing rules
   - Allow marking directories as ignored
6. Ask about non-rule settings (`allowLinks`, `auditDecrypt`,
   `gitInPasskeyCommand`, `passkeyDir`)
7. Generate `.parcel.json` with jq, show preview, write on confirm
8. Supports re-running: if `.parcel.json` exists, loads it as the starting
   point

## Uninstall

- `--uninstall`: removes host binary, all native messaging manifests (scans
  `parcel-setup.json` for paths), flatpak wrappers, flatpak overrides.
  Preserves parcelrc and `.parcel.json`.
- `--uninstall --remove-config`: also removes `~/.config/parcel/` and
  `.parcel.json` from the password store. The log file
  (`~/.local/log/parcel-host.log`) is never removed.

## CLI flags

| Flag | Purpose |
|---|---|
| `--system` | Install system-wide (default, requires sudo) |
| `--user` | Install user-level (no sudo) |
| `--prefix <path>` | Custom installation prefix |
| `--browser <name>` | Set up only the specified browser(s) |
| `--yes` / `-y` | Non-interactive mode, accept all defaults |
| `--create-config` | Run the `.parcel.json` config builder (rules + other settings) |
| `--uninstall` | Remove the installation |
| `--remove-config` | With `--uninstall`: also remove config files |
| `--flatpak-only` | Only handle flatpak browsers (skip native) |

## Idempotency guarantees

- Host binary: always overwritten with bundled version
- Manifests: always regenerated and overwritten
- parcelrc: created by bootstrap host if absent; never overwritten;
  customisations applied only to default/unset or stricter values
- `.parcel.json`: never touched by main install; config builder is explicitly
  invoked

## Error handling

- Missing jq/gpg: clear error message with platform-specific install hint
- Password store not found: warn, skip config builder offer, continue
- Manifest dir not writable: error per-browser, continue with other browsers
- Unsupported OS: error with "supported platforms: macOS, Linux, BSD"
- GPG verification failure (of the setup script itself): the user would catch
  this before running, since they verify the `.asc` signature

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error (missing dependencies, unsupported OS, smoke test failure) |
| 2 | User declined the preview confirmation |
| 3 | Interrupted by signal (Ctrl+C) — partial changes may exist |
| 4 | One or more browser setups failed, but others succeeded |

## Testing strategy

No automated test harness — the target environments (macOS, Linux
distributions, BSD variants, different browser combinations, flatpak vs
non-flatpak, system-wide vs user-level, varying password-store layouts) are
too varied to automate meaningfully. The script will be validated through
manual user acceptance testing across representative environments.

## Platform support

- **Now**: macOS, Linux, BSD
- **Deferred**: Windows (designed for extensibility — the platform dispatch
  structure will accommodate a Windows branch later without refactoring).
  Windows adds complexity because Chrome/Firefox on Windows require a native
  executable for the manifest `path`, registry-based manifest registration,
  and cross-environment path translation (WSL/Git Bash/Gpg4win). The
  constitution forbids compiled binaries, ruling out Browserpass's approach
  of shipping a native `.exe`.

## Constitutional considerations

- **No network access**: the setup script is downloaded and verified by the
  user via their browser; the script itself makes no network calls
- **No compiled binary**: the bootstrap host remains a plaintext bash script,
  embedded as a heredoc
- **No third-party deps**: the setup script relies only on bash, jq, gpg,
  find, and standard POSIX utilities
- **File modification**: the constitutional prohibition on file modification
  (§1.3.3) does not apply to the setup script. The setup script *installs*
  Parcel — it is not *itself* Parcel, and its entire purpose is to modify the
  user's filesystem. This interpretation has been agreed by Steve and Max.
  To respect the spirit of the constitution, the script prints a full summary
  of proposed changes before applying anything, giving the user the
  opportunity to review and decline.

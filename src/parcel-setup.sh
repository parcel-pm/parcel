#!/usr/bin/env bash
set -uo pipefail

# ISC License
#
# Copyright (c) 2023-2026 Erayd LTD
#
# Permission to use, copy, modify, and/or distribute this software for any
# purpose with or without fee is hereby granted, provided that the above
# copyright notice and this permission notice appear in all copies.
#
# THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
# WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
# MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
# ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
# WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
# ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
# OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

# Parcel setup script.
#
# In the distributed form, this file is preceded by a preamble that sets
# BOOTSTRAP_HOST, SETUP_CONFIG, and SIGNED_HOST_SHA256. In development, those
# variables are unset and the script falls back to reading from source files.
#
# @since 1.0.7

# ===========================================================================
# Global state
# ===========================================================================

# CLI arguments
ACTION="install"
INSTALL_LEVEL=""
PREFIX_OVERRIDE=""
BROWSER_FILTER=""
YES=false
FLATPAK_ONLY=false
REMOVE_CONFIG=false
VERBOSE=false

# Detected platform
OS=""
IS_NIXOS="${IS_NIXOS:-false}"

# Resolved install configuration
RESOLVED_LEVEL="system"
RESOLVED_PREFIX=""
HOST_BIN_PATH=""
HOST_BIN_DIR=""
SERVICES_USER="${SUDO_USER:-}"

# Detected browsers
DETECTED_BROWSERS=""
DETECTED_FLATPAK_BROWSERS=""
HAS_FLATPAK=false

# Detected configuration (preserve PASSWORD_STORE_DIR if set in the environment)
PASSWORD_STORE_DIR="${PASSWORD_STORE_DIR:-}"
PASS_DIR_EXPLICIT=false
CUSTOM_GPG=""
CUSTOM_JQ=""
FORCE_GPG=false
FORCE_JQ=false
CUSTOM_PASSWORD_STORE_DIR=""
WANTS_HOST_HASH=false
REVOKE_FLATPAK_DBUS=false

# Parsed config values
HOST_NAME=""
EXT_ID_CHROMIUM=""
EXT_ID_FIREFOX=""
FLATPAK_WRAPPER_DIR_TEMPLATE=""

# Tracking
PHASE="init"
TEMP_FILES=""
INSTALL_ERRORS=0
APPLIED_CHANGES=""

# Config data (set by preamble in distributed form, or loaded in dev mode)
# shellcheck disable=SC2034
BOOTSTRAP_HOST="${BOOTSTRAP_HOST:-}"
SETUP_CONFIG="${SETUP_CONFIG:-}"
SIGNED_HOST_SHA256="${SIGNED_HOST_SHA256:-}"

# ===========================================================================
# Utility functions
# ===========================================================================

# Print an informational message to stderr.
# @param {string} msg - Message to print.
# @since 1.0.7
log_info() {
    printf '  %s\n' "$*" >&2
}

# Print a success message to stderr.
# @param {string} msg - Message to print.
# @since 1.0.7
log_success() {
    printf '  \033[32m✓\033[0m %s\n' "$*" >&2
}

# Print a warning message to stderr.
# @param {string} msg - Message to print.
# @since 1.0.7
log_warn() {
    printf '  \033[33m!\033[0m %s\n' "$*" >&2
}

# Print an error message to stderr.
# @param {string} msg - Message to print.
# @since 1.0.7
log_error() {
    printf '  \033[31m✗\033[0m %s\n' "$*" >&2
}

# Print a section header.
# @param {string} title - Section title.
# @since 1.0.7
log_section() {
    printf '\n\033[1m=== %s ===\033[0m\n\n' "$1" >&2
}

# Exit with an error message and exit code.
# @param {string} msg - Error message.
# @param {number} [code=1] - Exit code.
# @since 1.0.7
die() {
    log_error "$1"
    exit "${2:-1}"
}

# Expand a leading ~ to $HOME.
# @param {string} path - Path that may start with ~.
# @returns {string} Expanded path on stdout.
# @since 1.0.7
expand_tilde() {
    local path="$1"
    case "$path" in
        \~) printf '%s\n' "$HOME" ;;
        \~/*) printf '%s%s\n' "$HOME" "${path#\~}" ;;
        *) printf '%s\n' "$path" ;;
    esac
}

# Check if a command exists on PATH.
# @param {string} cmd - Command name.
# @returns {boolean} 0 if found, 1 otherwise.
# @since 1.0.7
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Pretty-print JSON from stdin, indented under the log_info prefix.
# @since 1.0.7
indent_json() {
    jq '.' | sed 's/^/      /'
}

# Register a temp file for cleanup on exit.
# @param {string} path - Temp file path.
# @since 1.0.7
add_temp() {
    TEMP_FILES="$TEMP_FILES $1"
}

# Create a temp file and register it for cleanup.
# @returns {string} Path to temp file on stdout.
# @since 1.0.7
make_temp() {
    local tmp
    tmp="$(mktemp)" || die "Failed to create temp file"
    add_temp "$tmp"
    printf '%s' "$tmp"
}

# Normalise the OS name from uname.
# @returns {string} darwin | linux | bsd
# @since 1.0.7
normalize_os() {
    local kernel
    kernel="$(uname -s)"
    case "$kernel" in
        Darwin) printf 'darwin' ;;
        Linux) printf 'linux' ;;
        FreeBSD|OpenBSD|NetBSD|DragonFly) printf 'bsd' ;;
        *) printf '%s' "$kernel" | tr '[:upper:]' '[:lower:]' ;;
    esac
}

# Prompt the user for a string value (or return default in --yes mode).
# @param {string} prompt_msg - Prompt text.
# @param {string} [default_val] - Default value.
# @returns {string} User input or default on stdout.
# @since 1.0.7
prompt() {
    local prompt_msg="$1"
    local default_val="${2:-}"
    if $YES; then
        printf '%s' "$default_val"
        return
    fi
    local response
    if [ -n "$default_val" ]; then
        printf '%s [%s]: ' "$prompt_msg" "$default_val" >&2
    else
        printf '%s: ' "$prompt_msg" >&2
    fi
    read -r response </dev/tty || {
        log_error "No TTY available - non-interactive setup requires --yes"
        exit 1
    }
    printf '%s' "${response:-$default_val}"
}

# Prompt for a yes/no answer (or return default in --yes mode).
# @param {string} prompt_msg - Prompt text.
# @param {boolean} [default_no=true] - Default answer (true=no).
# @returns {boolean} 0 if yes, 1 if no.
# @since 1.0.7
prompt_yesno() {
    local prompt_msg="$1"
    local default_no="${2:-true}"
    if $YES; then
        if $default_no; then return 1; else return 0; fi
    fi
    local hint
    if $default_no; then
        hint="y/N"
    else
        hint="Y/n"
    fi
    local response
    printf '%s [%s]: ' "$prompt_msg" "$hint" >&2
    read -r response </dev/tty || {
        log_error "No TTY available - non-interactive setup requires --yes"
        exit 1
    }
    response="$(printf '%s' "$response" | tr '[:upper:]' '[:lower:]')"
    case "$response" in
        y|yes) return 0 ;;
        n|no) return 1 ;;
        '')
            if $default_no; then return 1; else return 0; fi
            ;;
        *) return 1 ;;
    esac
}

# Check if a browser is in the user-specified filter.
# @param {string} name - Browser name.
# @returns {boolean} 0 if browser should be processed.
# @since 1.0.7
browser_in_filter() {
    local name="$1"
    [ -z "$BROWSER_FILTER" ] && return 0
    case " $BROWSER_FILTER " in
        *" $name "*) return 0 ;;
        *) return 1 ;;
    esac
}

# Get the manifest directory key for the current OS and install level.
# @returns {string} e.g. darwin-system, linux-user, bsd-system
# @since 1.0.7
manifest_key() {
    local os_key="$OS"
    [ "$os_key" = "bsd" ] && os_key="linux"
    printf '%s-%s' "$os_key" "$RESOLVED_LEVEL"
}

# Escape regex metacharacters in a string for safe use in a pattern.
# @param {string} str - Input string.
# @returns {string} Escaped string on stdout.
# @since 1.0.7
escape_regex() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/[]^$*+?.{}|()[]/\\&/g'
}

# ===========================================================================
# Dev-mode fallback: load embedded data from source files
# ===========================================================================

# Determine the script's own directory for dev-mode file lookups.
# In the distributed form the variables are set by the preamble.
# @since 1.0.7
load_dev_fallback() {
    if [ -z "$BOOTSTRAP_HOST" ] || [ -z "$SETUP_CONFIG" ] || [ -z "$SIGNED_HOST_SHA256" ]; then
        local script_dir
        script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
        local repo_root
        repo_root="$(cd "$script_dir/.." 2>/dev/null && pwd)"

        if [ -z "$SETUP_CONFIG" ] && [ -f "$script_dir/parcel-setup.json" ]; then
            SETUP_CONFIG="$(cat "$script_dir/parcel-setup.json")"
        fi
        if [ -z "$BOOTSTRAP_HOST" ] && [ -f "$repo_root/parcel-host" ]; then
            BOOTSTRAP_HOST="$(cat "$repo_root/parcel-host")"
        fi
        if [ -z "$SIGNED_HOST_SHA256" ] && [ -f "$script_dir/parcel-host" ]; then
            local hash_bin
            hash_bin="$(command -v sha256sum 2>/dev/null || command -v sha256 2>/dev/null)"
            if [ -n "$hash_bin" ]; then
                SIGNED_HOST_SHA256="$("$hash_bin" "$script_dir/parcel-host" 2>/dev/null | awk '{print $1}')"
            fi
        fi
        log_warn "Running in development mode (reading from source files)"
    fi
}

# ===========================================================================
# Config access (jq wrappers)
# ===========================================================================

# Query the embedded JSON config with jq.
# @param {string} filter - jq filter expression.
# @param {string} [input] - Optional stdin input (defaults to $SETUP_CONFIG).
# @returns {string} jq output.
# @since 1.0.7
config_query() {
    local filter="$1"
    if [ -n "${2:-}" ]; then
        printf '%s' "$2" | jq -r "$filter"
    else
        printf '%s' "$SETUP_CONFIG" | jq -r "$filter"
    fi
}

# Get a browser definition from the config by name.
# @param {string} name - Browser name.
# @returns {string} JSON object for the browser.
# @since 1.0.7
get_browser_config() {
    config_query ".browsers[] | select(.name == \"$1\")"
}

# Expand the flatpak wrapper dir template for a given app ID.
# @param {string} app_id - Flatpak application ID.
# @returns {string} Expanded wrapper directory path on stdout.
# @since 1.0.7
flatpak_wrapper_dir() {
    local app_id="$1"
    expand_tilde "${FLATPAK_WRAPPER_DIR_TEMPLATE/\{appId\}/$app_id}"
}

# Get the value of a field from a browser definition.
# @param {string} browser_json - Browser JSON (from get_browser_config).
# @param {string} field - jq filter for the field.
# @returns {string} Field value.
# @since 1.0.7
browser_field() {
    local browser_json="$1"
    local field="$2"
    printf '%s' "$browser_json" | jq -r "$field"
}

# ===========================================================================
# CLI argument parsing
# ===========================================================================

# Resolve the install level when no explicit --system/--user flag was given.
# In non-interactive (--yes) mode, for the config action, or when already
# running as root, auto-detects without prompting. Otherwise asks the user and
# re-execs with sudo if system-wide is chosen.
# @param {string[]} orig_args - Original CLI arguments, preserved for re-exec.
# @since 1.0.7
resolve_install_level() {
    # Already root: system is the natural default, no prompt needed
    if [ "$(id -u)" -eq 0 ]; then
        INSTALL_LEVEL="system"
        return
    fi

    # NixOS: user-level only, no prompt
    if $IS_NIXOS; then
        if [ "$INSTALL_LEVEL" != "user" ]; then
        printf '  \033[1;31m!\033[0m \033[1;31mNixOS detected - proceeding with user-level install.\033[0m\n' >&2
        printf '  \033[1;31m!\033[0m \033[1;31mSystem-level install is not supported; use the manual setup per the README if needed.\033[0m\n' >&2
        fi
        INSTALL_LEVEL="user"
        return
    fi

    # Non-interactive or config-only: no prompt needed
    if $YES || [ "$ACTION" = "config" ]; then
        INSTALL_LEVEL="user"
        return
    fi

    # Interactive: ask whether to operate system-wide
    local verb="Install"
    [ "$ACTION" = "uninstall" ] && verb="Uninstall"
    if prompt_yesno "$verb system-wide? (requires sudo)" true; then
        log_info "Re-running with sudo for system-wide $ACTION..."
        exec sudo bash "$0" --system "$@"
    fi
    INSTALL_LEVEL="user"
}

# Parse command-line arguments.
# Sets global variables for action, install level, browser filter, etc.
# @since 1.0.7
parse_args() {
    local orig_args=("$@")
    while [ $# -gt 0 ]; do
        case "$1" in
            --system) INSTALL_LEVEL="system" ;;
            --user) INSTALL_LEVEL="user" ;;
            --prefix)
                shift
                [ $# -gt 0 ] || die "--prefix requires an argument"
                PREFIX_OVERRIDE="$1"
                ;;
            --browser)
                shift
                [ $# -gt 0 ] || die "--browser requires an argument"
                if [ -z "$BROWSER_FILTER" ]; then
                    BROWSER_FILTER="$1"
                else
                    BROWSER_FILTER="$BROWSER_FILTER $1"
                fi
                ;;
            --browser=*)
                BROWSER_FILTER="${1#*=}"
                BROWSER_FILTER="${BROWSER_FILTER//,/ }"
                ;;
            --yes|-y) YES=true ;;
            --create-config) ACTION="config" ;;
            --uninstall) ACTION="uninstall" ;;
            --remove-config) REMOVE_CONFIG=true ;;
            --flatpak-only) FLATPAK_ONLY=true ;;
            --verbose) VERBOSE=true ;;
            --passdir)
                shift
                [ $# -gt 0 ] || die "--passdir requires an argument"
                PASSWORD_STORE_DIR="$(expand_tilde "$1")"
                PASS_DIR_EXPLICIT=true
                ;;
            --passdir=*)
                PASSWORD_STORE_DIR="$(expand_tilde "${1#*=}")"
                PASS_DIR_EXPLICIT=true
                ;;
            --help|-h)
                print_usage
                exit 0
                ;;
            *)
                die "Unknown option: $1 (see --help)"
                ;;
        esac
        shift
    done

    # Resolve install level when not explicitly specified
    if [ -z "$INSTALL_LEVEL" ]; then
        resolve_install_level "${orig_args[@]}"
    fi

    # Refuse system-level install on NixOS
    if [ "$INSTALL_LEVEL" = "system" ] && $IS_NIXOS; then
        die "Automated system-level install is not supported on NixOS. Please use --user for a user-level install, or set up the native host manually per the README."
    fi

    # Auto re-exec with sudo for explicit --system when not root
    if [ "$INSTALL_LEVEL" = "system" ] && [ "$(id -u)" -ne 0 ]; then
        if $YES; then
            die "System install requires root (re-run with sudo, or use --user)"
        fi
        log_info "Re-running with sudo for system-wide $ACTION..."
        exec sudo bash "$0" "${orig_args[@]}"
    fi

    RESOLVED_LEVEL="$INSTALL_LEVEL"

    # Apply prefix override
    if [ -n "$PREFIX_OVERRIDE" ]; then
        RESOLVED_PREFIX="$(expand_tilde "$PREFIX_OVERRIDE")"
    fi
}

# Print usage information.
# @since 1.0.7
print_usage() {
    cat >&2 <<'USAGE'
Usage: parcel-setup.sh [options]

Install options:
  --system            Install system-wide (requires sudo, will prompt if omitted)
  --user              Install user-level (no sudo needed, no prompt if omitted)
  --prefix <path>     Custom installation prefix
  --passdir <path>    Custom password store directory (overrides PASSWORD_STORE_DIR)
  --browser <name>    Set up only the specified browser(s) (comma or space separated)
  --flatpak-only      Only handle flatpak browsers (skip native)
  --yes, -y           Non-interactive: accept all detected defaults
  --verbose           Show verbose output (e.g. full password-store tree)

Actions:
  --uninstall         Remove the installation (preserves parcelrc and .parcel.json)
  --remove-config     With --uninstall: also remove config files
  --create-config     Run the .parcel.json config builder

  -h, --help          Show this help message
USAGE
}

# ===========================================================================
# Platform detection
# ===========================================================================

# Detect the operating system.
# @since 1.0.7
detect_platform() {
    OS="$(normalize_os)"

    case "$OS" in
        darwin|linux|bsd) ;;
        *)
            die "Unsupported operating system: $(uname -s). Supported: macOS, Linux, BSD"
            ;;
    esac

    log_success "Platform: $OS"
}

# Detect whether running on NixOS or with the nix package manager.
# @since 1.0.7
detect_nixos() {
    if [ "${IS_NIXOS:-}" = "true" ]; then
        return
    fi
    IS_NIXOS=false
    if [ -d /nix/store ]; then
        IS_NIXOS=true
    fi
}

# ===========================================================================
# Dependency checks
# ===========================================================================

# Verify required dependencies are available.
# @since 1.0.7
check_dependencies() {
    local missing=""

    if ! command_exists jq; then
        missing="$missing jq"
    fi
    if ! command_exists gpg; then
        missing="$missing gpg"
    fi

    # sha256 is needed by the bootstrap host; check for it here so we can
    # give a better error message, but it is not fatal for the setup script.
    if ! command_exists sha256sum && ! command_exists sha256; then
        log_warn "Neither sha256sum nor sha256 found - the bootstrap host may not function correctly"
    fi

    if [ -n "$missing" ]; then
        for dep in $missing; do
            case "$dep" in
                jq)
                    log_error "jq is required but was not found"
                    if [ "$OS" = "darwin" ]; then
                        log_info "  jq should be available on macOS. If it's missing, install it via:"
                        log_info "    brew install jq"
                    else
                        log_info "  Install jq via your package manager, e.g.:"
                        log_info "    apt install jq / dnf install jq / pacman -S jq"
                    fi
                    ;;
                gpg)
                    log_error "gpg is required but was not found"
                    if [ "$OS" = "darwin" ]; then
                        log_info "  Install GPG via one of:"
                        log_info "    brew install gnupg"
                        log_info "    GPG Suite: https://gpgtools.org"
                    else
                        log_info "  Install GPG via your package manager, e.g.:"
                        log_info "    apt install gnupg / dnf install gnupg / pacman -S gnupg"
                    fi
                    ;;
            esac
        done
        die "Missing required dependencies. Install them and re-run."
    fi

    log_success "Dependencies: jq $(jq --version 2>/dev/null || echo '?'), gpg $(gpg --version 2>/dev/null | head -1 || echo '?')"

    # Detect flatpak
    if command_exists flatpak; then
        HAS_FLATPAK=true
    fi
}

# ===========================================================================
# Phase 1: DETECT
# ===========================================================================

# Resolve the install prefix based on level and platform.
# Sets RESOLVED_PREFIX, HOST_BIN_DIR, HOST_BIN_PATH.
# @since 1.0.7
resolve_prefix() {
    if [ -n "$RESOLVED_PREFIX" ]; then
        :
    elif [ "$RESOLVED_LEVEL" = "system" ]; then
        RESOLVED_PREFIX="/usr/local"
    else
        RESOLVED_PREFIX="$HOME/.local"
    fi

    HOST_BIN_DIR="$RESOLVED_PREFIX/bin"
    HOST_BIN_PATH="$HOST_BIN_DIR/parcel-host"

    # Check write access
    if [ "$RESOLVED_LEVEL" = "system" ] && [ "$(id -u)" -ne 0 ]; then
        if $YES; then
            die "System install requires root (re-run with sudo, or use --user)"
        fi
        die "System install requires root. Re-run with sudo, or use --user for a user-level install."
    fi

    log_success "Install prefix: $RESOLVED_PREFIX ($RESOLVED_LEVEL)"
}

# Detect installed browsers from the config.
# Populates DETECTED_BROWSERS with newline-separated browser names.
# @since 1.0.7
detect_browsers() {
    local browser_count
    browser_count="$(config_query '.browsers | length')"

    local i=0
    while [ "$i" -lt "$browser_count" ]; do
        local name engine browser_json
        name="$(config_query ".browsers[$i].name")"
        engine="$(config_query ".browsers[$i].engine")"

        # Skip if not in filter
        if ! browser_in_filter "$name"; then
            i=$((i + 1))
            continue
        fi

        # Skip flatpak-only mode for native detection
        if $FLATPAK_ONLY; then
            i=$((i + 1))
            continue
        fi

        # Get OS-specific detection paths
        local os_key="$OS"
        [ "$os_key" = "bsd" ] && os_key="linux"
        local detect_paths
        detect_paths="$(config_query ".browsers[$i].detect[\"$os_key\"][]?")"

        if [ -z "$detect_paths" ]; then
            i=$((i + 1))
            continue
        fi

        # Check if any detection path exists
        local found=false
        while IFS= read -r path; do
            if [ -e "$path" ]; then
                found=true
                break
            fi
        done <<< "$detect_paths"

        # Also check if a Parcel manifest already exists (i.e. Parcel was
        # previously set up for this browser even if the browser is no longer
        # detectable via its binary). This avoids false positives from
        # NativeMessagingHosts directories created by other tools.
        if ! $found; then
            local manifest_key
            manifest_key="$(manifest_key)"
            local manifest_dir
            manifest_dir="$(config_query ".browsers[$i].manifestDir[\"$manifest_key\"]?")"
            if [ -n "$manifest_dir" ]; then
                local resolved_manifest_dir
                resolved_manifest_dir="$(expand_tilde "$manifest_dir")"
                if [ -f "$resolved_manifest_dir/$HOST_NAME.json" ]; then
                    found=true
                fi
            fi
        fi

        if $found; then
            if [ -n "$DETECTED_BROWSERS" ]; then
                DETECTED_BROWSERS="$DETECTED_BROWSERS$newline$name"
            else
                DETECTED_BROWSERS="$name"
            fi
            log_success "Detected: $name"
        fi

        i=$((i + 1))
    done

    if [ -z "$DETECTED_BROWSERS" ] && ! $FLATPAK_ONLY; then
        log_warn "No native browsers detected"
    fi
}

# Detect flatpak browsers.
# Populates DETECTED_FLATPAK_BROWSERS.
# @since 1.0.7
detect_flatpak_browsers() {
    if ! $HAS_FLATPAK; then
        return
    fi

    local fp_count
    fp_count="$(config_query '.flatpak.browsers | length')"

    local i=0
    while [ "$i" -lt "$fp_count" ]; do
        local name app_id
        name="$(config_query ".flatpak.browsers[$i].name")"
        app_id="$(config_query ".flatpak.browsers[$i].appId")"

        # Skip if not in filter
        if ! browser_in_filter "$name"; then
            i=$((i + 1))
            continue
        fi

        # Check if the flatpak app is installed
        local flatpak_list_cmd
        if [ -n "$SERVICES_USER" ]; then
            flatpak_list_cmd="sudo -u $SERVICES_USER flatpak"
        else
            flatpak_list_cmd="flatpak"
        fi
        if $flatpak_list_cmd list --columns=application 2>/dev/null | grep -F -x -q "$app_id"; then
            if [ -n "$DETECTED_FLATPAK_BROWSERS" ]; then
                DETECTED_FLATPAK_BROWSERS="$DETECTED_FLATPAK_BROWSERS$newline$app_id"
            else
                DETECTED_FLATPAK_BROWSERS="$app_id"
            fi
            log_success "Detected flatpak: $name ($app_id)"
        fi

        i=$((i + 1))
    done

    if [ -z "$DETECTED_FLATPAK_BROWSERS" ] && $HAS_FLATPAK; then
        log_info "No flatpak browsers detected"
    fi
}

# Detect the password store directory.
# Sources, in priority order: an explicit --passdir flag, a value persisted by
# a prior install in parcelrc, the PASSWORD_STORE_DIR environment variable,
# ~/.password-store, then an interactive prompt. Uses $HOME, which main()
# rewrites to the invoking user's home when running under sudo.
# Sets PASSWORD_STORE_DIR and CUSTOM_PASSWORD_STORE_DIR (if non-default).
# @since 1.0.7
detect_password_store() {
    PASSWORD_STORE_DIR="${PASSWORD_STORE_DIR:-}"

    # A prior installation persists PASSWORD_STORE_DIR in parcelrc; it ranks
    # above the environment but below an explicit --passdir flag.
    if ! $PASS_DIR_EXPLICIT; then
        local parcelrc="$HOME/.config/parcel/parcelrc"
        local rc_passdir=""
        if [ -f "$parcelrc" ]; then
            rc_passdir="$(sed -n 's/^PASSWORD_STORE_DIR="\(.*\)"$/\1/p' "$parcelrc" 2>/dev/null)"
        fi
        if [ -n "$rc_passdir" ]; then
            PASSWORD_STORE_DIR="$(expand_tilde "$rc_passdir")"
        fi
    fi

    if [ -n "${PASSWORD_STORE_DIR:-}" ]; then
        :
    elif [ -d "$HOME/.password-store" ]; then
        PASSWORD_STORE_DIR="$HOME/.password-store"
    else
        # Ask the user
        local default_dir="$HOME/.password-store"
        PASSWORD_STORE_DIR="$(prompt "Password store directory" "$default_dir")"
        PASSWORD_STORE_DIR="$(expand_tilde "$PASSWORD_STORE_DIR")"
    fi

    # Track non-default locations for parcelrc persistence
    if [ -n "$PASSWORD_STORE_DIR" ] && [ "$PASSWORD_STORE_DIR" != "$HOME/.password-store" ]; then
        CUSTOM_PASSWORD_STORE_DIR="$PASSWORD_STORE_DIR"
    fi

    if [ ! -d "$PASSWORD_STORE_DIR" ]; then
        log_warn "Password store directory not found: $PASSWORD_STORE_DIR"
    else
        log_success "Password store: $PASSWORD_STORE_DIR"
    fi
}

# Detect gpg and jq paths.
# Priority: existing parcelrc value (if working) > default path > command -v > macOS fallbacks > interactive.
# If a parcelrc value is set but broken, it is clobbered (FORCE_GPG/FORCE_JQ).
# Sets CUSTOM_GPG, CUSTOM_JQ, FORCE_GPG, FORCE_JQ.
# @since 1.0.7
detect_tool_paths() {
    local parcelrc="$HOME/.config/parcel/parcelrc"
    local existing_gpg="" existing_jq=""

    # Read existing parcelrc values if the file exists
    if [ -f "$parcelrc" ]; then
        existing_gpg="$(sed -n 's/^GPG="\(.*\)"$/\1/p' "$parcelrc" 2>/dev/null)"
        existing_jq="$(sed -n 's/^JQ="\(.*\)"$/\1/p' "$parcelrc" 2>/dev/null)"
    fi

    detect_single_tool_path "gpg" "$existing_gpg" "/usr/bin/gpg" CUSTOM_GPG FORCE_GPG
    detect_single_tool_path "jq" "$existing_jq" "/usr/bin/jq" CUSTOM_JQ FORCE_JQ
}

# Detect a single tool's path.
# Checks parcelrc value first, then default path, then command -v + macOS fallbacks,
# then interactive entry as a final fallback.
# @param {string} tool - Tool name (e.g. gpg, jq).
# @param {string} existing - Existing parcelrc value (may be empty).
# @param {string} default_path - Default system path (e.g. /usr/bin/gpg).
# @param {string} custom_var - Name of the global to set with the custom path.
# @param {string} force_var - Name of the global to set true if clobbering.
# @since 1.0.7
detect_single_tool_path() {
    local tool="$1" existing="$2" default_path="$3"
    local custom_var="$4" force_var="$5"
    local found_path

    # 1. Existing parcelrc value - respect it if the binary is still executable
    if [ -n "$existing" ]; then
        if [ -x "$existing" ]; then
            log_info "$tool already set in parcelrc ($existing) - leaving as-is"
            return
        fi
        log_warn "$tool in parcelrc ($existing) is not executable - will overwrite"
    fi

    # 2. Default path visible to the host (no customisation needed)
    if [ -z "$existing" ] && [ -x "$default_path" ]; then
        return
    fi

    # 3. Fall back to command -v, then macOS-specific locations
    found_path="$(command -v "$tool" 2>/dev/null || echo "")"

    # macOS fallback: common Homebrew locations may not be in the shell's PATH
    # (e.g. when running under sudo with a sanitised PATH)
    if [ -z "$found_path" ]; then
        local candidate
        for candidate in "/opt/homebrew/bin/$tool" "/usr/local/bin/$tool"; do
            if [ -x "$candidate" ]; then
                found_path="$candidate"
                break
            fi
        done
    fi

    if [ -z "$found_path" ]; then
        # 4. Interactive fallback - let the user enter a path manually
        if ! $YES; then
            found_path="$(prompt "Enter path to $tool binary" "")"
            if [ -n "$found_path" ]; then
                found_path="$(expand_tilde "$found_path")"
                if [ ! -x "$found_path" ]; then
                    log_warn "$found_path is not executable"
                    found_path=""
                fi
            fi
        fi
    fi

    if [ -z "$found_path" ]; then
        if [ -n "$existing" ]; then
            log_error "No working $tool found to replace broken parcelrc entry ($existing)"
        fi
        return
    fi

    # Set the custom path; force if we're replacing a broken existing value
    printf -v "$custom_var" '%s' "$found_path"
    if [ -n "$existing" ]; then
        printf -v "$force_var" '%s' true
    fi
}

# Ask the user to confirm each detected browser (default Y).
# Filters DETECTED_BROWSERS and DETECTED_FLATPAK_BROWSERS to only include
# confirmed entries. Skipped entirely in --yes mode.
# @since 1.0.7
confirm_browsers() {
    if $YES; then
        return
    fi

    local confirmed=""

    if [ -n "$DETECTED_BROWSERS" ]; then
        printf '\n' >&2
        log_info "Confirm which browsers to set up:"
        local name
        while IFS= read -r name; do
            [ -z "$name" ] && continue
            if prompt_yesno "  Set up $name?" false; then
                if [ -n "$confirmed" ]; then
                    confirmed="$confirmed$newline$name"
                else
                    confirmed="$name"
                fi
            else
                log_info "    Skipping $name"
            fi
        done <<< "$DETECTED_BROWSERS"
        DETECTED_BROWSERS="$confirmed"
    fi

    if [ -n "$DETECTED_FLATPAK_BROWSERS" ]; then
        confirmed=""
        if [ -z "$DETECTED_BROWSERS" ]; then
            printf '\n' >&2
        fi
        log_info "Confirm which flatpak browsers to set up:"
        local app_id display_name
        while IFS= read -r app_id; do
            [ -z "$app_id" ] && continue
            display_name="$(config_query ".flatpak.browsers[] | select(.appId == \"$app_id\") | .name")"
            if prompt_yesno "  Set up $display_name (flatpak)?" false; then
                if [ -n "$confirmed" ]; then
                    confirmed="$confirmed$newline$app_id"
                else
                    confirmed="$app_id"
                fi
            else
                log_info "    Skipping $display_name (flatpak)"
            fi
        done <<< "$DETECTED_FLATPAK_BROWSERS"
        DETECTED_FLATPAK_BROWSERS="$confirmed"
    fi
}

# Run browser and tool detection.
# Platform, dependencies, prefix, and password store are already detected
# by main(), so this only runs the browser/tool-specific detection.
# @since 1.0.7
run_detect() {
    PHASE="detect"
    log_section "Detection"

    if $IS_NIXOS; then
        printf '  \033[1;31m!\033[0m \033[1;31mNixOS detected - native (non-flatpak) browsers require manual\033[0m\n' >&2
        printf '  \033[1;31m!\033[0m \033[1;31mmanifest setup. See the README'"'"'s Manual native host installation\033[0m\n' >&2
        printf '  \033[1;31m!\033[0m \033[1;31msection. Flatpak browsers are detected and configured automatically.\033[0m\n' >&2
        printf '\n' >&2
    else
        detect_browsers
    fi
    detect_flatpak_browsers
    confirm_browsers
    if ! $IS_NIXOS; then
        detect_tool_paths
    fi
    offer_host_hash
}

# Ask the user whether to pin HOST_HASH in their parcelrc.
# If HOST_HASH is already set, no prompt is offered. In --yes mode, the
# hash is not applied - pinning is an opt-in security decision.
# @since 1.0.7
offer_host_hash() {
    if [ -z "$SIGNED_HOST_SHA256" ]; then
        return
    fi

    # Check if HOST_HASH is already set in the parcelrc
    local parcelrc
    parcelrc="$HOME/.config/parcel/parcelrc"
    if [ -f "$parcelrc" ] && grep -q '^HOST_HASH=' "$parcelrc" 2>/dev/null; then
        log_info "HOST_HASH already set in parcelrc - leaving as-is"
        return
    fi

    if $YES; then
        return
    fi

    printf '\n' >&2
    log_info "The signed host script has SHA256: $SIGNED_HOST_SHA256"
    log_info "Pinning this hash in parcelrc means future host updates must be"
    log_info "reviewed and approved by you before they execute."
    if prompt_yesno "Pin HOST_HASH in parcelrc?" true; then
        WANTS_HOST_HASH=true
    fi
}

# ===========================================================================
# Phase 2: PREVIEW
# ===========================================================================

# Print a summary of all proposed changes for user confirmation.
# @returns {boolean} 0 if user confirms, 1 if declined.
# @since 1.0.7
preview_install() {
    PHASE="preview"
    log_section "Preview"

    log_info "The following changes will be made:"
    printf '\n' >&2

    # Bootstrap host
    if [ "$ACTION" = "install" ]; then
        log_info "  Install / overwrite bootstrap host:"
        log_info "    $HOST_BIN_PATH"
        printf '\n' >&2

        # Native manifests
        if ! $IS_NIXOS && [ -n "$DETECTED_BROWSERS" ]; then
            log_info "  Generate & install native messaging manifests:"
            local name
            for name in $DETECTED_BROWSERS; do
                local browser_json manifest_dir engine ext_id
                browser_json="$(get_browser_config "$name")"
                local key
                key="$(manifest_key)"
                manifest_dir="$(printf '%s' "$browser_json" | jq -r ".manifestDir[\"$key\"]?")"
                manifest_dir="$(expand_tilde "$manifest_dir")"
                local manifest_path="$manifest_dir/$HOST_NAME.json"
                log_info "    $name: $manifest_path"
                if $VERBOSE; then
                    engine="$(browser_field "$browser_json" '.engine')"
                    if [ "$engine" = "chromium" ]; then
                        ext_id="$EXT_ID_CHROMIUM"
                    else
                        ext_id="$EXT_ID_FIREFOX"
                    fi
                    generate_manifest "$engine" "$HOST_BIN_PATH" "$HOST_NAME" "$ext_id" false | indent_json >&2
                fi
            done
            printf '\n' >&2
        fi

        # Flatpak
        if [ -n "$DETECTED_FLATPAK_BROWSERS" ]; then
            log_info "  Install flatpak wrappers:"
            local app_id
            for app_id in $DETECTED_FLATPAK_BROWSERS; do
                local wrapper_dir
                wrapper_dir="$(flatpak_wrapper_dir "$app_id")"
                log_info "    $app_id: $wrapper_dir/parcel-flatpak-wrapper.sh"
            done
            log_info "  Apply flatpak overrides:"
            for app_id in $DETECTED_FLATPAK_BROWSERS; do
                log_info "    flatpak override --user --talk-name=org.freedesktop.Flatpak $app_id"
            done
            printf '\n' >&2
        fi

        # parcelrc customisations
        local rc_changes=""
        if [ -n "$CUSTOM_GPG" ]; then
            if $FORCE_GPG; then
                rc_changes="${rc_changes}GPG=$CUSTOM_GPG (overwrite)$newline"
            else
                rc_changes="${rc_changes}GPG=$CUSTOM_GPG$newline"
            fi
        fi
        if [ -n "$CUSTOM_JQ" ]; then
            if $FORCE_JQ; then
                rc_changes="${rc_changes}JQ=$CUSTOM_JQ (overwrite)$newline"
            else
                rc_changes="${rc_changes}JQ=$CUSTOM_JQ$newline"
            fi
        fi
        $WANTS_HOST_HASH && rc_changes="${rc_changes}HOST_HASH=$SIGNED_HOST_SHA256$newline"
        if [ -n "$CUSTOM_PASSWORD_STORE_DIR" ]; then
            local parcelrc_check existing_passdir
            parcelrc_check="$HOME/.config/parcel/parcelrc"
            existing_passdir=""
            if [ -f "$parcelrc_check" ]; then
                existing_passdir="$(sed -n 's/^PASSWORD_STORE_DIR="\(.*\)"$/\1/p' "$parcelrc_check" 2>/dev/null)"
            fi
            if [ -n "$existing_passdir" ] && [ "$existing_passdir" != "$CUSTOM_PASSWORD_STORE_DIR" ]; then
                rc_changes="${rc_changes}PASSWORD_STORE_DIR=$CUSTOM_PASSWORD_STORE_DIR (overwrite)$newline"
            else
                rc_changes="${rc_changes}PASSWORD_STORE_DIR=$CUSTOM_PASSWORD_STORE_DIR$newline"
            fi
        fi
        if [ -n "$rc_changes" ]; then
            log_info "  Apply parcelrc customisations:"
            local change
            while IFS= read -r change; do
                [ -z "$change" ] && continue
                log_info "    $change"
            done <<< "$rc_changes"
            printf '\n' >&2
        fi

        local parcelrc
        parcelrc="$HOME/.config/parcel/parcelrc"
        if [ -f "$parcelrc" ]; then
            log_info "  Smoke test will verify the existing parcelrc"
        else
            log_info "  Smoke test will create ~/.config/parcel/parcelrc"
        fi
        printf '\n' >&2
    fi

    if ! $YES; then
        if prompt_yesno "Proceed with these changes?" true; then
            return 0
        else
            log_info "Aborted by user."
            exit 2
        fi
    fi
    return 0
}

# Print preview of uninstall actions.
# @returns {boolean} 0 if user confirms.
# @since 1.0.7
preview_uninstall() {
    PHASE="preview"
    log_section "Preview (Uninstall)"

    log_info "The following will be removed:"
    printf '\n' >&2

    # Bootstrap host
    if [ -f "$HOST_BIN_PATH" ]; then
        log_info "  $HOST_BIN_PATH"
    fi

    # Native manifests
    if ! $IS_NIXOS; then
        local browser_count
        browser_count="$(config_query '.browsers | length')"
        local i=0
        while [ "$i" -lt "$browser_count" ]; do
            local name manifest_dir key
            name="$(config_query ".browsers[$i].name")"
            local os_key="$OS"
            [ "$os_key" = "bsd" ] && os_key="linux"
            key="$os_key-$RESOLVED_LEVEL"
            manifest_dir="$(config_query ".browsers[$i].manifestDir[\"$key\"]?")"
            if [ -n "$manifest_dir" ]; then
                manifest_dir="$(expand_tilde "$manifest_dir")"
                local manifest_path="$manifest_dir/$HOST_NAME.json"
                if [ -f "$manifest_path" ]; then
                    log_info "  $manifest_path"
                fi
            fi
            i=$((i + 1))
        done
    fi

    # Flatpak wrappers and overrides
    if $HAS_FLATPAK; then
        local fp_count
        fp_count="$(config_query '.flatpak.browsers | length')"
        i=0
        while [ "$i" -lt "$fp_count" ]; do
            local app_id wrapper_dir
            app_id="$(config_query ".flatpak.browsers[$i].appId")"
            wrapper_dir="$(flatpak_wrapper_dir "$app_id")"

            local os_key="$OS"
            [ "$os_key" = "bsd" ] && os_key="linux"
            local fp_name fp_manifest_dir fp_manifest_path
            fp_name="$(config_query ".flatpak.browsers[$i].name")"
            fp_manifest_dir="$(get_browser_config "$fp_name" | jq -r ".manifestDir[\"${os_key}-user\"]?")"
            if [ -n "$fp_manifest_dir" ]; then
                fp_manifest_dir="$(expand_tilde "$fp_manifest_dir")"
                fp_manifest_path="$fp_manifest_dir/$HOST_NAME.json"
                if [ -f "$fp_manifest_path" ]; then
                    log_info "  $fp_manifest_path"
                fi
            fi

            if [ -f "$wrapper_dir/parcel-flatpak-wrapper.sh" ]; then
                log_info "  $wrapper_dir/parcel-flatpak-wrapper.sh"
            fi
            # Flatpak override: we can't easily check, just note it
            i=$((i + 1))
        done

        # Ask whether to revoke the D-Bus talk grant the wrapper needs.
        # Default no; --yes mode keeps the default (no).
        printf '\n' >&2
        if prompt_yesno "Revoke the flatpak D-Bus talk grant (org.freedesktop.Flatpak) from Parcel-set-up browsers?" true; then
            REVOKE_FLATPAK_DBUS=true
        fi
    fi

    # Config files
    if $REMOVE_CONFIG; then
        local parcelrc="$HOME/.config/parcel"
        local parcelfile="$PASSWORD_STORE_DIR/.parcel.json"
        log_info "  $parcelrc (directory)"
        if [ -f "$parcelfile" ]; then
            log_info "  $parcelfile"
        fi
    fi

    printf '\n' >&2
    log_info "Note: parcelrc and .parcel.json are preserved (use --remove-config to also remove them)"
    printf '\n' >&2

    if ! $YES; then
        if prompt_yesno "Proceed with uninstall?" true; then
            return 0
        else
            log_info "Aborted by user."
            exit 2
        fi
    fi
    return 0
}

# ===========================================================================
# Phase 3: APPLY
# ===========================================================================

# Install the bootstrap host to the target path.
# @since 1.0.7
install_bootstrap_host() {
    log_info "Installing bootstrap host..."

    # Write the bootstrap host to a temp file first
    local tmp_host
    tmp_host="$(make_temp)"
    printf '%s' "$BOOTSTRAP_HOST" > "$tmp_host"

    # Install
    if [ "$RESOLVED_LEVEL" = "system" ]; then
        mkdir -p "$HOST_BIN_DIR"
        install -m 0755 "$tmp_host" "$HOST_BIN_PATH"
    elif [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ]; then
        mkdir -p "$HOST_BIN_DIR"
        chown "$SERVICES_USER" "$HOST_BIN_DIR" 2>/dev/null || true
        local primary_group
        primary_group="$(id -gn "$SERVICES_USER" 2>/dev/null || true)"
        if [ -n "$primary_group" ]; then
            install -m 0755 -o "$SERVICES_USER" -g "$primary_group" "$tmp_host" "$HOST_BIN_PATH" || \
            install -m 0755 -o "$SERVICES_USER" "$tmp_host" "$HOST_BIN_PATH"
        else
            install -m 0755 -o "$SERVICES_USER" "$tmp_host" "$HOST_BIN_PATH"
        fi
    else
        mkdir -p "$HOST_BIN_DIR"
        install -m 0755 "$tmp_host" "$HOST_BIN_PATH"
    fi

    if [ ! -f "$HOST_BIN_PATH" ]; then
        die "Failed to install bootstrap host to $HOST_BIN_PATH"
    fi

    log_success "Bootstrap host installed to $HOST_BIN_PATH"
    APPLIED_CHANGES="$APPLIED_CHANGES bootstrap-host"
}

# Generate a native messaging manifest using jq.
# @param {string} engine - chromium or firefox.
# @param {string} host_path - Path to the host binary.
# @param {string} host_name - Host name (e.g. com.github.erayd.parcel).
# @param {string} ext_id - Extension ID.
# @param {boolean} is_flatpak - Whether this is a flatpak manifest.
# @returns {string} JSON manifest on stdout.
# @since 1.0.7
generate_manifest() {
    local engine="$1" host_path="$2" host_name="$3" ext_id="$4" is_flatpak="$5"
    local description="Native host component for the Parcel extension"
    if [ "$is_flatpak" = "true" ]; then
        description="Native host component for the Parcel extension (Flatpak wrapper)"
    fi

    if [ "$engine" = "chromium" ]; then
        jq -n \
            --arg name "$host_name" \
            --arg desc "$description" \
            --arg path "$host_path" \
            --arg origin "chrome-extension://${ext_id}/" \
            '{name: $name, description: $desc, path: $path, type: "stdio", allowed_origins: [$origin]}'
    else
        jq -n \
            --arg name "$host_name" \
            --arg desc "$description" \
            --arg path "$host_path" \
            --arg ext "$ext_id" \
            '{name: $name, description: $desc, path: $path, type: "stdio", allowed_extensions: [$ext]}'
    fi
}

# Generate and install native messaging manifests for detected browsers.
# @since 1.0.7
install_native_manifests() {
    if [ -z "$DETECTED_BROWSERS" ]; then
        return
    fi

    log_info "Installing native messaging manifests..."

    local name
    for name in $DETECTED_BROWSERS; do
        local browser_json engine key manifest_dir manifest_path
        browser_json="$(get_browser_config "$name")"
        engine="$(browser_field "$browser_json" '.engine')"
        key="$(manifest_key)"
        manifest_dir="$(browser_field "$browser_json" ".manifestDir[\"$key\"]?")"

        if [ -z "$manifest_dir" ]; then
            log_warn "No manifest directory for $name on $OS - skipping"
            INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
            continue
        fi

        manifest_dir="$(expand_tilde "$manifest_dir")"
        manifest_path="$manifest_dir/$HOST_NAME.json"

        # Create the manifest directory
        if [ ! -d "$manifest_dir" ]; then
            if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ] && [ "$RESOLVED_LEVEL" = "user" ]; then
                mkdir -p "$manifest_dir"
                chown "$SERVICES_USER" "$manifest_dir" 2>/dev/null || true
            else
                mkdir -p "$manifest_dir" || {
                    log_error "Cannot create manifest directory: $manifest_dir"
                    INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
                    continue
                }
            fi
        fi

        # Determine the extension ID based on engine
        local ext_id
        if [ "$engine" = "chromium" ]; then
            ext_id="$EXT_ID_CHROMIUM"
        else
            ext_id="$EXT_ID_FIREFOX"
        fi

        # Generate and write the manifest
        if generate_manifest "$engine" "$HOST_BIN_PATH" "$HOST_NAME" "$ext_id" false > "$manifest_path" 2>/dev/null \
            && [ -f "$manifest_path" ]; then
            log_success "Manifest installed: $name"
            APPLIED_CHANGES="$APPLIED_CHANGES manifest-$name"

            # Fix ownership if running as root
            if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ] && [ "$RESOLVED_LEVEL" = "user" ]; then
                chown "$SERVICES_USER" "$manifest_path" 2>/dev/null || true
            fi
        else
            log_error "Failed to install manifest for $name"
            INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
        fi
    done
}

# Generate the flatpak wrapper script content.
# @param {string} host_path - Path to the installed bootstrap host.
# @returns {string} Wrapper script content on stdout.
# @since 1.0.7
generate_flatpak_wrapper() {
    local host_path="$1"
    cat <<FLATPAK_WRAPPER
#!/usr/bin/env bash
# Auto-generated by parcel-setup.sh
# Wrapper that launches the Parcel native host on the host system via flatpak-spawn.
exec flatpak-spawn --host "$host_path"
FLATPAK_WRAPPER
}

# Install flatpak wrappers and apply overrides for detected flatpak browsers.
# @since 1.0.7
install_flatpak_wrappers() {
    if [ -z "$DETECTED_FLATPAK_BROWSERS" ]; then
        return
    fi

    log_info "Installing flatpak wrappers..."

    local app_id
    for app_id in $DETECTED_FLATPAK_BROWSERS; do
        local wrapper_dir wrapper_path manifest_dir
        wrapper_dir="$(flatpak_wrapper_dir "$app_id")"
        wrapper_path="$wrapper_dir/parcel-flatpak-wrapper.sh"

        # Create wrapper directory
        mkdir -p "$wrapper_dir" || {
            log_error "Cannot create flatpak wrapper directory: $wrapper_dir"
            INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
            continue
        }

        # Generate and install wrapper
        if generate_flatpak_wrapper "$HOST_BIN_PATH" > "$wrapper_path" && [ -s "$wrapper_path" ]; then
            chmod 0755 "$wrapper_path"
        else
            log_error "Failed to write flatpak wrapper: $wrapper_path"
            INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
            continue
        fi

        # Fix ownership if running as root
        if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ]; then
            chown -R "$SERVICES_USER" "$wrapper_dir" 2>/dev/null || true
        fi

        # Find the browser's name to get its engine and manifest dir
        local fp_count browser_name engine ext_id
        fp_count="$(config_query '.flatpak.browsers | length')"
        browser_name=""
        engine="chromium"
        local i=0
        while [ "$i" -lt "$fp_count" ]; do
            local candidate_id
            candidate_id="$(config_query ".flatpak.browsers[$i].appId")"
            if [ "$candidate_id" = "$app_id" ]; then
                browser_name="$(config_query ".flatpak.browsers[$i].name")"
                break
            fi
            i=$((i + 1))
        done

        if [ -n "$browser_name" ]; then
            local browser_json
            browser_json="$(get_browser_config "$browser_name")"
            engine="$(browser_field "$browser_json" '.engine')"
        fi

        # Determine extension ID
        if [ "$engine" = "chromium" ]; then
            ext_id="$EXT_ID_CHROMIUM"
        else
            ext_id="$EXT_ID_FIREFOX"
        fi

        # Install manifest pointing to the wrapper
        # For flatpak, the user-level manifest dir is what matters
        local os_key="$OS"
        [ "$os_key" = "bsd" ] && os_key="linux"
        manifest_dir="$(get_browser_config "$browser_name" | jq -r ".manifestDir[\"${os_key}-user\"]?")"
        manifest_dir="$(expand_tilde "$manifest_dir")"
        local manifest_path="$manifest_dir/$HOST_NAME.json"

        if [ -n "$manifest_dir" ]; then
            mkdir -p "$manifest_dir" 2>/dev/null || true
            if generate_manifest "$engine" "$wrapper_path" "$HOST_NAME" "$ext_id" true > "$manifest_path" 2>/dev/null \
                && [ -f "$manifest_path" ]; then
                if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ]; then
                    chown "$SERVICES_USER" "$manifest_path" 2>/dev/null || true
                fi
            else
                log_error "Failed to install flatpak manifest for $app_id"
                INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
            fi
        fi

        # Apply flatpak override (must run as the real user)
        if [ -n "$SERVICES_USER" ]; then
            sudo -u "$SERVICES_USER" flatpak override --user --talk-name=org.freedesktop.Flatpak "$app_id" 2>/dev/null || \
                log_warn "Failed to apply flatpak override for $app_id"
        else
            flatpak override --user --talk-name=org.freedesktop.Flatpak "$app_id" 2>/dev/null || \
                log_warn "Failed to apply flatpak override for $app_id"
        fi

        log_success "Flatpak wrapper installed: $app_id"
        APPLIED_CHANGES="$APPLIED_CHANGES flatpak-$app_id"
    done
}

# ===========================================================================
# Smoke test
# ===========================================================================

# Get the home directory of the invoking user (respects sudo).
# @returns {string} Home directory path.
# @since 1.0.7
get_user_home() {
    if [ -n "$SERVICES_USER" ]; then
        if [ "$OS" = "darwin" ]; then
            dscl . -read "/Users/$SERVICES_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || echo "$HOME"
        else
            getent passwd "$SERVICES_USER" 2>/dev/null | cut -d: -f6 || echo "$HOME"
        fi
    else
        echo "$HOME"
    fi
}

# Run the bootstrap host as the correct user.
# Stdout is discarded - the native messaging protocol output is not needed
# during the smoke test, and leaking it to the terminal is confusing.
# @param {string} host_bin - Path to the bootstrap host binary.
# @returns {number} Exit code of the host.
# @since 1.0.7
run_host_as_user() {
    local host_bin="$1"

    if [ -n "$SERVICES_USER" ]; then
        printf '' | sudo -u "$SERVICES_USER" env "HOME=$HOME" "$host_bin" >/dev/null 2>/dev/null
        return $?
    else
        printf '' | "$host_bin" >/dev/null 2>/dev/null
        return $?
    fi
}

# Run the first smoke test (cold start).
# Creates the default parcelrc if it doesn't exist.
# @since 1.0.7
first_smoke_test() {
    log_info "Running first smoke test (cold start)..."
    PHASE="apply-smoke1"

    run_host_as_user "$HOST_BIN_PATH"
    local rc=$?

    local parcelrc
    parcelrc="$HOME/.config/parcel/parcelrc"

    if [ $rc -ne 0 ] && [ ! -f "$parcelrc" ]; then
        log_error "First smoke test failed and parcelrc was not created"
        log_error "This usually means jq or gpg are not in the default PATH"
        die "Smoke test failed (exit code $rc)"
    fi

    if [ ! -f "$parcelrc" ]; then
        log_error "First smoke test completed but parcelrc was not created"
        die "Smoke test failed (parcelrc not found at $parcelrc)"
    fi

    if [ $rc -ne 0 ]; then
        log_warn "First smoke test exited with code $rc (likely gpg not in default PATH)"
        log_info "  Custom tool paths will be applied before the second smoke test"
    else
        log_success "First smoke test passed (parcelrc created/verified)"
    fi
}

# Run the second smoke test (verification).
# @since 1.0.7
second_smoke_test() {
    log_info "Running second smoke test (verification)..."
    PHASE="apply-smoke2"

    run_host_as_user "$HOST_BIN_PATH"
    local rc=$?

    if [ $rc -ne 0 ]; then
        log_error "Second smoke test failed (exit code $rc)"

        # Revert parcelrc customisations if we have a backup
        local parcelrc="$HOME/.config/parcel/parcelrc"
        if [ -n "$PARCELRC_BACKUP" ] && [ -f "$PARCELRC_BACKUP" ]; then
            cp "$PARCELRC_BACKUP" "$parcelrc"
            log_error "Reverted parcelrc customisations: $APPLIED_PARCELRC_CHANGES"
        fi

        log_error "Check the parcel-host log for details:"
        log_error "  $HOME/.local/log/parcel-host.log"
        die "Smoke test verification failed"
    fi

    log_success "Second smoke test passed"
}

# ===========================================================================
# parcelrc customisation
# ===========================================================================

# Set a variable in parcelrc if not already set.
# Inserts the value below the commented-out default line for the same variable.
# Does nothing if the variable is already set, unless "force" is specified.
# @param {string} parcelrc_path - Path to the parcelrc file.
# @param {string} varname - Variable name (e.g. GPG, JQ, HOST_HASH).
# @param {string} value - Value to set.
# @param {string} [force] - If "force", overwrites an existing value.
# @returns {boolean} 0 if value was applied, 1 if already set and not forced.
# @since 1.0.7
set_parcelrc_var() {
    local parcelrc_path="$1" varname="$2" value="$3" force="${4:-}"
    local tmpfile
    tmpfile="$(make_temp)"

    if [ "$force" = "force" ] && grep -q "^${varname}=" "$parcelrc_path" 2>/dev/null; then
        # Replace the existing uncommented line
        awk -v var="$varname" -v val="$value" '
            $0 ~ "^" var "=" { print var "=\"" val "\""; next }
            { print }
        ' "$parcelrc_path" > "$tmpfile"
    else
        # Check if the variable is already set (uncommented)
        if grep -q "^${varname}=" "$parcelrc_path" 2>/dev/null; then
            return 1  # Already set, leave it alone
        fi

        # Insert below the commented-out default line, or append to end
        awk -v var="$varname" -v val="$value" '
            {
                print
                if (!found && $0 ~ "^#[[:space:]]*" var "=") {
                    print var "=\"" val "\""
                    found = 1
                }
            }
            END {
                if (!found) {
                    print var "=\"" val "\""
                }
            }
        ' "$parcelrc_path" > "$tmpfile"
    fi

    # Preserve permissions (0600)
    cp "$tmpfile" "$parcelrc_path" || die "Failed to write parcelrc"
    chmod 0600 "$parcelrc_path"

    return 0
}

# The list of parcelrc changes applied (for revert tracking).
APPLIED_PARCELRC_CHANGES=""

# Backup of parcelrc taken before applying customisations (for revert on failure).
PARCELRC_BACKUP=""

# Apply parcelrc customisations for tool paths and password store.
# Applied before the second smoke test so they are included in verification.
# GPG/JQ are only overwritten if the existing value was broken (FORCE_GPG/FORCE_JQ).
# PASSWORD_STORE_DIR always uses force mode (user explicitly chose a different path).
# @since 1.0.7
apply_parcelrc_customisations() {
    local parcelrc
    parcelrc="$HOME/.config/parcel/parcelrc"

    if [ ! -f "$parcelrc" ]; then
        log_warn "parcelrc not found at $parcelrc - skipping customisations"
        return
    fi

    log_info "Applying parcelrc customisations..."

    # Back up parcelrc so we can revert if the second smoke test fails
    PARCELRC_BACKUP="$(make_temp)"
    cp "$parcelrc" "$PARCELRC_BACKUP" 2>/dev/null || PARCELRC_BACKUP=""

    # Fix ownership if running as root
    if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ]; then
        chown "$SERVICES_USER" "$parcelrc" 2>/dev/null || true
    fi

    # GPG path
    if [ -n "$CUSTOM_GPG" ]; then
        local gpg_force=""
        $FORCE_GPG && gpg_force="force"
        if set_parcelrc_var "$parcelrc" "GPG" "$CUSTOM_GPG" "$gpg_force"; then
            log_success "Set GPG=$CUSTOM_GPG in parcelrc"
            APPLIED_PARCELRC_CHANGES="$APPLIED_PARCELRC_CHANGES GPG"
        else
            log_info "GPG already set in parcelrc - leaving as-is"
        fi
    fi

    # JQ path
    if [ -n "$CUSTOM_JQ" ]; then
        local jq_force=""
        $FORCE_JQ && jq_force="force"
        if set_parcelrc_var "$parcelrc" "JQ" "$CUSTOM_JQ" "$jq_force"; then
            log_success "Set JQ=$CUSTOM_JQ in parcelrc"
            APPLIED_PARCELRC_CHANGES="$APPLIED_PARCELRC_CHANGES JQ"
        else
            log_info "JQ already set in parcelrc - leaving as-is"
        fi
    fi

    # PASSWORD_STORE_DIR if non-default (overwrite - user explicitly chose a different path)
    if [ -n "$CUSTOM_PASSWORD_STORE_DIR" ] && [ "$CUSTOM_PASSWORD_STORE_DIR" != "$HOME/.password-store" ]; then
        if set_parcelrc_var "$parcelrc" "PASSWORD_STORE_DIR" "$CUSTOM_PASSWORD_STORE_DIR" force; then
            log_success "Set PASSWORD_STORE_DIR=$CUSTOM_PASSWORD_STORE_DIR in parcelrc"
            APPLIED_PARCELRC_CHANGES="$APPLIED_PARCELRC_CHANGES PASSWORD_STORE_DIR"
        else
            log_info "PASSWORD_STORE_DIR already set in parcelrc - leaving as-is"
        fi
    fi
}

# Apply HOST_HASH to parcelrc after the second smoke test passes.
# Only applied if the user opted in via offer_host_hash().
# @since 1.0.7
apply_host_hash() {
    local parcelrc
    parcelrc="$HOME/.config/parcel/parcelrc"

    if [ ! -f "$parcelrc" ]; then
        log_warn "parcelrc not found at $parcelrc - skipping HOST_HASH"
        return
    fi

    if $WANTS_HOST_HASH && [ -n "$SIGNED_HOST_SHA256" ]; then
        if set_parcelrc_var "$parcelrc" "HOST_HASH" "$SIGNED_HOST_SHA256"; then
            log_success "Set HOST_HASH in parcelrc (pins signed host for review)"
            APPLIED_PARCELRC_CHANGES="$APPLIED_PARCELRC_CHANGES HOST_HASH"
        else
            log_info "HOST_HASH already set in parcelrc - leaving as-is"
        fi
    fi
}

# ===========================================================================
# Summary report
# ===========================================================================

# Print a summary of what was done.
# @since 1.0.7
summary_report() {
    log_section "Summary"

    for change in $APPLIED_CHANGES; do
        case "$change" in
            bootstrap-host) log_success "Bootstrap host installed: $HOST_BIN_PATH" ;;
            manifest-*) log_success "Manifest installed: ${change#manifest-}" ;;
            flatpak-*) log_success "Flatpak wrapper installed: ${change#flatpak-}" ;;
        esac
    done

    for change in $APPLIED_PARCELRC_CHANGES; do
        log_success "parcelrc customised: $change"
    done

    if [ "$INSTALL_ERRORS" -gt 0 ]; then
        log_warn "$INSTALL_ERRORS browser setup(s) failed"
    fi

    printf '\n' >&2
    log_info "parcelrc: $HOME/.config/parcel/parcelrc"
    log_info "Log file: $HOME/.local/log/parcel-host.log"
    printf '\n' >&2

    # NixOS guidance
    if $IS_NIXOS; then
        log_info "For nix-native browsers, set up native messaging manually per"
        log_info "the README (or use flatpak browsers, which are configured automatically)."
        printf '\n' >&2
    fi

    # Offer config builder
    if [ "$ACTION" = "install" ] && ! $YES; then
        if [ -d "$PASSWORD_STORE_DIR" ]; then
            local parcelfile="$PASSWORD_STORE_DIR/.parcel.json"
            local config_question="Would you like to create a .parcel.json config now?"
            if [ -f "$parcelfile" ]; then
                config_question="Would you like to modify your existing .parcel.json config?"
            fi
            if prompt_yesno "$config_question" true; then
                run_config_builder
            fi
        else
            log_info "Password store not found - skipping config builder offer"
        fi
    fi

    # Exit code
    if [ "$INSTALL_ERRORS" -gt 0 ]; then
        exit 4
    fi
    exit 0
}

# ===========================================================================
# Apply phase (install)
# ===========================================================================

# Run the full apply phase for installation.
# @since 1.0.7
apply_install() {
    PHASE="apply"
    log_section "Applying"

    install_bootstrap_host
    if ! $IS_NIXOS; then
        install_native_manifests
    fi
    install_flatpak_wrappers

    # First smoke test (creates parcelrc)
    first_smoke_test

    # Apply tool paths and password store - before second smoke test so they're verified
    apply_parcelrc_customisations

    # Second smoke test (verification)
    second_smoke_test

    # Apply HOST_HASH - after verification passes (pinning only, doesn't affect functionality)
    apply_host_hash

    summary_report
}

# ===========================================================================
# Uninstall
# ===========================================================================

# Run the uninstall phase.
# Removes host binary, manifests, flatpak wrappers, and optionally config.
# @since 1.0.7
do_uninstall() {
    PHASE="uninstall-detect"
    log_section "Uninstall"

    # Detect what exists
    local removed=""

    # Remove bootstrap host
    if [ -f "$HOST_BIN_PATH" ]; then
        rm -f "$HOST_BIN_PATH"
        log_success "Removed: $HOST_BIN_PATH"
        removed="$removed host-binary"
    fi

    # Remove native messaging manifests
    if ! $IS_NIXOS; then
        local browser_count
        browser_count="$(config_query '.browsers | length')"
        local i=0
        while [ "$i" -lt "$browser_count" ]; do
            local name
            name="$(config_query ".browsers[$i].name")"
            # Only remove manifests for the current install level
            local os_key="$OS"
            [ "$os_key" = "bsd" ] && os_key="linux"
            local key="$os_key-$RESOLVED_LEVEL"
            local manifest_dir
            manifest_dir="$(config_query ".browsers[$i].manifestDir[\"$key\"]?")"
            if [ -n "$manifest_dir" ]; then
                manifest_dir="$(expand_tilde "$manifest_dir")"
                local manifest_path="$manifest_dir/$HOST_NAME.json"
                if [ -f "$manifest_path" ]; then
                    rm -f "$manifest_path"
                    log_success "Removed: $manifest_path"
                    removed="$removed manifest-$name-$RESOLVED_LEVEL"
                fi
            fi
            i=$((i + 1))
        done
    fi

    # Remove flatpak wrappers, manifests, and overrides
    if $HAS_FLATPAK; then
        local fp_count
        fp_count="$(config_query '.flatpak.browsers | length')"
        i=0
        while [ "$i" -lt "$fp_count" ]; do
            local app_id wrapper_dir
            app_id="$(config_query ".flatpak.browsers[$i].appId")"
            wrapper_dir="$(flatpak_wrapper_dir "$app_id")"

            # Flatpak manifests are always written to the user-level manifest
            # dir (see install_flatpak_wrappers), even for system installs, so
            # remove them here rather than via the level-scoped loop above.
            local os_key="$OS"
            [ "$os_key" = "bsd" ] && os_key="linux"
            local fp_name fp_manifest_dir fp_manifest_path
            fp_name="$(config_query ".flatpak.browsers[$i].name")"
            fp_manifest_dir="$(get_browser_config "$fp_name" | jq -r ".manifestDir[\"${os_key}-user\"]?")"
            if [ -n "$fp_manifest_dir" ]; then
                fp_manifest_dir="$(expand_tilde "$fp_manifest_dir")"
                fp_manifest_path="$fp_manifest_dir/$HOST_NAME.json"
                if [ -f "$fp_manifest_path" ]; then
                    rm -f "$fp_manifest_path"
                    log_success "Removed flatpak manifest: $app_id"
                    removed="$removed flatpak-manifest-$app_id"
                fi
            fi

            if [ -f "$wrapper_dir/parcel-flatpak-wrapper.sh" ]; then
                rm -f "$wrapper_dir/parcel-flatpak-wrapper.sh"
                rmdir "$wrapper_dir" 2>/dev/null || true
                log_success "Removed flatpak wrapper: $app_id"
                removed="$removed flatpak-$app_id"

                if $REVOKE_FLATPAK_DBUS; then
                    # Revoke the D-Bus talk grant that flatpak-spawn depends on.
                    if [ -n "$SERVICES_USER" ]; then
                        sudo -u "$SERVICES_USER" flatpak override --user --no-talk-name=org.freedesktop.Flatpak "$app_id" 2>/dev/null || \
                            log_warn "Failed to revoke flatpak D-Bus grant for $app_id"
                    else
                        flatpak override --user --no-talk-name=org.freedesktop.Flatpak "$app_id" 2>/dev/null || \
                            log_warn "Failed to revoke flatpak D-Bus grant for $app_id"
                    fi
                fi
            fi
            i=$((i + 1))
        done
    fi

    # Remove config if requested
    if $REMOVE_CONFIG; then
        local parcelrc_dir="$HOME/.config/parcel"
        local parcelfile="$PASSWORD_STORE_DIR/.parcel.json"
        case "$parcelrc_dir" in
            /*/.config/parcel)
                if [ -d "$parcelrc_dir" ]; then
                    rm -rf "$parcelrc_dir"
                    log_success "Removed: $parcelrc_dir"
                    removed="$removed parcelrc-dir"
                fi
                ;;
            *)
                # Refuse to remove anything other than the dedicated absolute config path.
                log_warn "Refusing to remove unexpected config path: $parcelrc_dir"
                ;;
        esac
        if [ -f "$parcelfile" ]; then
            rm -f "$parcelfile"
            log_success "Removed: $parcelfile"
            removed="$removed parcelfile"
        fi
    fi

    # Note about log file
    log_info "Note: log file ($HOME/.local/log/parcel-host.log) is preserved"

    if [ -z "$removed" ]; then
        log_info "Nothing to remove - Parcel does not appear to be installed"
    fi

    exit 0
}

# ===========================================================================
# Interactive .parcel.json config builder
# ===========================================================================

# Run the interactive config builder for .parcel.json.
# Scans the password store, suggests rules, and lets the user edit.
# @since 1.0.7
run_config_builder() {
    PHASE="config"
    log_section "Config Builder (.parcel.json)"

    local parcelfile="$PASSWORD_STORE_DIR/.parcel.json"

    # Check password store
    if [ ! -d "$PASSWORD_STORE_DIR" ]; then
        die "Password store not found: $PASSWORD_STORE_DIR"
    fi

    # Start with existing config or default
    local config_json
    if [ -f "$parcelfile" ]; then
        config_json="$(cat "$parcelfile")"
        log_info "Loaded existing .parcel.json"
    else
        config_json="{}"
        log_info "Creating new .parcel.json"
    fi

    # Scan the password store
    log_info "Scanning password store..."
    local tree_output
    tree_output="$(find "$PASSWORD_STORE_DIR" -type d -not -path '*/.git/*' -not -name '.git' 2>/dev/null | sort)"

    # Show directory structure
    printf '\n' >&2
    if $VERBOSE; then
        log_info "Directory structure:"
        local dir
        while IFS= read -r dir; do
            local rel_dir="${dir#"$PASSWORD_STORE_DIR"}"
            [ -z "$rel_dir" ] && rel_dir="/"
            local count
            count="$(find "$dir" -maxdepth 1 -name '*.gpg' 2>/dev/null | wc -l | tr -d ' ')"
            if [ "$count" -gt 0 ]; then
                log_info "  $rel_dir ($count entries)"
            fi
        done <<< "$tree_output"
        printf '\n' >&2
    fi

    # Auto-detect rules based on common patterns
    local rules_json="[]"

    # Detect top-level credential-type subdirs
    # Skip the password-store root itself and any dotfile/dotdir
    local top_level
    top_level="$(find "$PASSWORD_STORE_DIR" -maxdepth 1 -mindepth 1 -type d -not -path '*/.git/*' -not -name '.git' -not -name '.*' 2>/dev/null | sort)"
    while IFS= read -r dir; do
        [ -z "$dir" ] && continue
        local basename_dir rel_pattern
        basename_dir="${dir##*/}"
        # Skip dotfile dirs (basename starts with .)
        case "$basename_dir" in .*) continue ;; esac
        rel_pattern="${dir#"$PASSWORD_STORE_DIR"/}"

        # Detect credential type from directory name
        local entry_class="login"
        case "$basename_dir" in
            passkey|passkeys|webauthn) entry_class="passkey" ;;
            card|cards) entry_class="card" ;;
            login|logins|credentials) entry_class="login" ;;
        esac

        # Create a rule for this directory
        local escaped_pattern
        escaped_pattern="$(escape_regex "$rel_pattern")"
        rules_json="$(printf '%s' "$rules_json" | jq \
            --arg pattern "^${escaped_pattern}/" \
            --arg class "$entry_class" \
            --arg tag "$basename_dir" \
            '. += [{pattern: $pattern, class: $class, tag: $tag, color: "333333"}]')"
    done <<< "$top_level"

    # Also check for nested login/passkey/card dirs
    while IFS= read -r dir; do
        [ -z "$dir" ] && continue
        local basename_dir rel_pattern
        basename_dir="${dir##*/}"
        # Skip dotfile dirs (basename starts with .)
        case "$basename_dir" in .*) continue ;; esac
        rel_pattern="${dir#"$PASSWORD_STORE_DIR"/}"

        case "$basename_dir" in
            login|logins)
                local escaped_pattern
                escaped_pattern="$(escape_regex "$rel_pattern")"
                rules_json="$(printf '%s' "$rules_json" | jq \
                    --arg pattern "^${escaped_pattern}/" \
                    --arg tag "$(printf '%s' "$rel_pattern" | cut -d/ -f1)" \
                    '. += [{pattern: $pattern, class: "login", tag: $tag, color: "333333"}]')"
                ;;
            passkey|passkeys)
                local escaped_pattern
                escaped_pattern="$(escape_regex "$rel_pattern")"
                rules_json="$(printf '%s' "$rules_json" | jq \
                    --arg pattern "^${escaped_pattern}/" \
                    --arg tag "$(printf '%s' "$rel_pattern" | cut -d/ -f1)" \
                    '. += [{pattern: $pattern, class: "passkey", tag: $tag, color: "333333"}]')"
                ;;
            card|cards)
                local escaped_pattern
                escaped_pattern="$(escape_regex "$rel_pattern")"
                rules_json="$(printf '%s' "$rules_json" | jq \
                    --arg pattern "^${escaped_pattern}/" \
                    --arg tag "$(printf '%s' "$rel_pattern" | cut -d/ -f1)" \
                    '. += [{pattern: $pattern, class: "card", tag: $tag, color: "333333"}]')"
                ;;
        esac
    done <<< "$(find "$PASSWORD_STORE_DIR" -mindepth 2 -type d -not -path '*/.git/*' \( -name '.*' -prune -o -print \) 2>/dev/null | sort)"

    # Sort rules by specificity: longer (more-specific) patterns first,
    # so that e.g. ^clients/help/cards/ matches before ^clients/
    rules_json="$(printf '%s' "$rules_json" | jq 'sort_by(.pattern | length) | reverse')"

    # Present suggested rules
    printf '\n' >&2
    log_info "Suggested rules:"
    local rule_count
    rule_count="$(printf '%s' "$rules_json" | jq 'length')"
    if [ "$rule_count" -eq 0 ]; then
        log_info "  No rules detected. You can add rules manually."
    else
        local ri=0
        while [ "$ri" -lt "$rule_count" ]; do
            local pattern class tag
            pattern="$(printf '%s' "$rules_json" | jq -r ".[$ri].pattern")"
            class="$(printf '%s' "$rules_json" | jq -r ".[$ri].class")"
            tag="$(printf '%s' "$rules_json" | jq -r ".[$ri].tag")"
            log_info "  [$((ri+1))] pattern: $pattern | class: $class | tag: $tag"
            ri=$((ri + 1))
        done
    fi
    printf '\n' >&2

    # Allow rule editing
    if ! $YES && [ "$rule_count" -gt 0 ]; then
        local has_existing_rules
        has_existing_rules="$(printf '%s' "$config_json" | jq '.rules | length > 0')"
        local rules_prompt="Accept these rules?"
        if [ "$has_existing_rules" = "true" ]; then
            rules_prompt="Replace your existing rules with these suggested rules?"
        fi
        if ! prompt_yesno "$rules_prompt" true; then
            log_info "Keeping existing rules from your .parcel.json."
            rules_json="$(printf '%s' "$config_json" | jq '.rules // []')"
        fi
    elif $YES; then
        # In --yes mode, keep existing rules if any, otherwise use detected
        if [ "$(printf '%s' "$config_json" | jq '.rules | length')" -gt 0 ]; then
            rules_json="$(printf '%s' "$config_json" | jq '.rules')"
        fi
    elif [ "$rule_count" -eq 0 ]; then
        # No suggestions detected - keep existing rules if any
        rules_json="$(printf '%s' "$config_json" | jq '.rules // []')"
    fi

    # Ask about non-rule settings
    local passkey_dir allow_links allow_external_links audit_decrypt
    local git_in_passkey handle_http_auth handle_passkeys save_history
    local fill_related disable_context_popup

    passkey_dir="$(prompt "passkeyDir" "$(printf '%s' "$config_json" | jq -r '.passkeyDir // "passkeys"')")"
    allow_links="$(prompt "allowLinks (true/false)" "$(printf '%s' "$config_json" | jq -r '.allowLinks // false')")"
    allow_external_links="$(prompt "allowExternalLinks (true/false)" "$(printf '%s' "$config_json" | jq -r '.allowExternalLinks // false')")"
    audit_decrypt="$(prompt "auditDecrypt (true/false)" "$(printf '%s' "$config_json" | jq -r '.auditDecrypt // false')")"
    git_in_passkey="$(prompt "gitInPasskeyCommand (true/false)" "$(printf '%s' "$config_json" | jq -r '.gitInPasskeyCommand // false')")"
    handle_http_auth="$(prompt "handleHttpAuth (true/false)" "$(printf '%s' "$config_json" | jq -r '.handleHttpAuth // true')")"
    handle_passkeys="$(prompt "handlePasskeys (true/false)" "$(printf '%s' "$config_json" | jq -r '.handlePasskeys // true')")"
    save_history="$(prompt "saveHistory (true/false)" "$(printf '%s' "$config_json" | jq -r '.saveHistory // true')")"
    fill_related="$(prompt "fillRelated (true/false)" "$(printf '%s' "$config_json" | jq -r '.fillRelated // true')")"
    disable_context_popup="$(prompt "disableContextPopup (true/false)" "$(printf '%s' "$config_json" | jq -r '.disableContextPopup // false')")"

    # Normalise booleans
    normalise_bool() {
        case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
            true|t|yes|y|1) echo "true" ;;
            *) echo "false" ;;
        esac
    }

    allow_links="$(normalise_bool "$allow_links")"
    allow_external_links="$(normalise_bool "$allow_external_links")"
    audit_decrypt="$(normalise_bool "$audit_decrypt")"
    git_in_passkey="$(normalise_bool "$git_in_passkey")"
    handle_http_auth="$(normalise_bool "$handle_http_auth")"
    handle_passkeys="$(normalise_bool "$handle_passkeys")"
    save_history="$(normalise_bool "$save_history")"
    fill_related="$(normalise_bool "$fill_related")"
    disable_context_popup="$(normalise_bool "$disable_context_popup")"

    # Build the final config. Only include a setting if:
    #   - it was already present in the existing .parcel.json, OR
    #   - the user's value differs from the schema default
    # passdir, modified, and defaultRules are internal, never written.
    local final_config
    final_config="$(printf '%s' "$config_json" | jq \
        --arg passkeyDir "$passkey_dir" \
        --argjson allowLinks "$allow_links" \
        --argjson allowExternalLinks "$allow_external_links" \
        --argjson auditDecrypt "$audit_decrypt" \
        --argjson gitInPasskeyCommand "$git_in_passkey" \
        --argjson handleHttpAuth "$handle_http_auth" \
        --argjson handlePasskeys "$handle_passkeys" \
        --argjson saveHistory "$save_history" \
        --argjson fillRelated "$fill_related" \
        --argjson disableContextPopup "$disable_context_popup" \
        --argjson rules "$rules_json" \
        '
        # Start from existing config, strip internal fields
        del(.passdir, .modified, .defaultRules)
        # Only set each field if value differs from default or was already present
        | if $allowLinks != false or has("allowLinks") then .allowLinks = $allowLinks else del(.allowLinks) end
        | if $allowExternalLinks != false or has("allowExternalLinks") then .allowExternalLinks = $allowExternalLinks else del(.allowExternalLinks) end
        | if $auditDecrypt != false or has("auditDecrypt") then .auditDecrypt = $auditDecrypt else del(.auditDecrypt) end
        | if $gitInPasskeyCommand != false or has("gitInPasskeyCommand") then .gitInPasskeyCommand = $gitInPasskeyCommand else del(.gitInPasskeyCommand) end
        | if $handleHttpAuth != true or has("handleHttpAuth") then .handleHttpAuth = $handleHttpAuth else del(.handleHttpAuth) end
        | if $handlePasskeys != true or has("handlePasskeys") then .handlePasskeys = $handlePasskeys else del(.handlePasskeys) end
        | if $saveHistory != true or has("saveHistory") then .saveHistory = $saveHistory else del(.saveHistory) end
        | if $fillRelated != true or has("fillRelated") then .fillRelated = $fillRelated else del(.fillRelated) end
        | if $disableContextPopup != false or has("disableContextPopup") then .disableContextPopup = $disableContextPopup else del(.disableContextPopup) end
        | if $passkeyDir != "passkeys" or has("passkeyDir") then .passkeyDir = $passkeyDir else del(.passkeyDir) end
        | if ($rules | length) > 0 then .rules = $rules else del(.rules) end
        ')"

    # Preview
    printf '\n' >&2
    log_info "Generated .parcel.json:"
    printf '%s\n' "$final_config" | jq '.' >&2
    printf '\n' >&2

    # Confirm and write
    if $YES || prompt_yesno "Write this config to $parcelfile?" true; then
        printf '%s\n' "$final_config" > "$parcelfile"
        # Fix ownership if running as root
        if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICES_USER" ]; then
            chown "$SERVICES_USER" "$parcelfile" 2>/dev/null || true
        fi
        log_success "Written: $parcelfile"
    else
        log_info "Config not written."
    fi
}

# ===========================================================================
# Signal handling
# ===========================================================================

# Clean up temporary files.
# @since 1.0.7
cleanup() {
    local f
    for f in $TEMP_FILES; do
        rm -f "$f" 2>/dev/null || true
    done
}

# Handle interrupt signals.
# @param {number} signal_name - Name of the signal.
# @since 1.0.7
on_signal() {
    printf '\n' >&2
    log_warn "Interrupted during $PHASE phase"
    if [ "${PHASE#apply}" != "$PHASE" ]; then
        log_warn "Partial changes may exist - check what was completed"
    fi
    cleanup
    exit 3
}

# ===========================================================================
# Main dispatch
# ===========================================================================

# Main entry point. Parses args, loads config, and dispatches to the right phase.
# @since 1.0.7
main() {
    newline='
'
    trap on_signal INT TERM
    trap cleanup EXIT

    detect_nixos
    load_dev_fallback
    detect_platform

    # Override HOME for the real user when running under sudo
    if [ -n "$SERVICES_USER" ]; then
        HOME="$(get_user_home)"
    fi
    parse_args "$@"
    check_dependencies

    # Parse config values needed for all actions
    HOST_NAME="$(config_query '.hostName')"
    EXT_ID_CHROMIUM="$(config_query '.extensionIds.chromium')"
    EXT_ID_FIREFOX="$(config_query '.extensionIds.firefox')"
    FLATPAK_WRAPPER_DIR_TEMPLATE="$(config_query '.flatpak.wrapperDirTemplate')"

    case "$ACTION" in
        install)
            resolve_prefix
            detect_password_store
            run_detect
            preview_install
            apply_install
            ;;
        uninstall)
            resolve_prefix
            # Resolve PASSWORD_STORE_DIR only when it is needed, so a plain
            # --uninstall does not prompt for a store directory.
            if $REMOVE_CONFIG; then
                detect_password_store
            fi
            preview_uninstall
            do_uninstall
            ;;
        config)
            detect_password_store
            run_config_builder
            ;;
    esac
}

main "$@"

#!/usr/bin/env bash
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
# ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTUOUS ACTION, ARISING OUT OF
# OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

# Wrapper script that launches the Parcel native host on the host system (i.e.
# *outside* the Flatpak sandbox) via flatpak-spawn(1).
#
# This is needed because Flatpak browsers run in an isolated container and
# cannot see or execute the host's parcel-host binary, ~/.password-store, or
# gpg directly. By using `flatpak-spawn --host`, the actual parcel-host process
# runs on the host system with full access to the user's password store and GPG
# keyring — identical to a non-containerised browser.
#
# USAGE
# -----
# 1. Copy this script to a location inside your browser's Flatpak-visible
#    config directory, e.g.:
#      ~/.var/app/org.mozilla.firefox/config/parcel/parcel-flatpak-wrapper.sh
# 2. Make it executable:
#      chmod +x <path>/parcel-flatpak-wrapper.sh
# 3. Grant the Flatpak app permission to talk to the host via flatpak-spawn:
#      flatpak override --user --talk-name=org.freedesktop.Flatpak <BROWSER_APP_ID>
# 4. Reference this script's path in the `path` field of the native messaging
#    host manifest.
#
# SECURITY NOTES
# --------------
# This script is a trivial passthrough — it does not interpret or modify the
# native messaging protocol in any way. It simply relays stdin/stdout between
# the browser and parcel-host. All of Parcel's existing security protections
# (GPG signature verification, whitelist enforcement, rate limiting, and audit
# logging) apply unchanged, because parcel-host runs on the host exactly as it
# would for a non-containerised browser.
#
# The PARCEL_HOST_PATH variable below should point to the parcel-host bootstrap
# binary as installed on the host system. Adjust this if parcel-host is not in
# the default PATH on your host.

PARCEL_HOST_PATH="${PARCEL_HOST_PATH:-parcel-host}"

exec flatpak-spawn --host "$PARCEL_HOST_PATH"

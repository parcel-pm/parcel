"use strict";

/**
 * Behavioural tests for the tool-path detector. detect_single_tool_path's
 * priority order (parcelrc value > default path > command -v) and broken-value
 * clobber, plus the detect_tool_paths dispatcher over all three tools.
 *
 * The macOS `/opt/homebrew|/usr/local` fallbacks and the interactive prompt
 * fallback are not exercised — they depend on host paths/state that cannot be
 * shimmed portably.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome, writeMockBin } from "./harness.js";

// A path that never exists, so `-x` on it is always false.
const NOENT = "/nonexistent/parcel-setup/tool";

/**
 * Run detect_single_tool_path with the mock bin prepended to PATH and report the
 * resulting custom/force globals as "custom|force".
 * @param {string} bin - Mock bin dir (prepended to PATH and used as USER_PATH).
 * @param {string} tool - Tool name (e.g. gpg).
 * @param {string} existing - parcelrc value (may be empty).
 * @param {string} defaultPath - Default system path.
 * @param {object} [opts] - Options.
 * @param {string} [opts.home] - HOME for the child.
 * @param {boolean} [opts.yes] - Set YES=true (skips the interactive fallback).
 * @returns {{stdout:string, stderr:string, code:number|null}} Result tuple.
 * @since 1.0.7
 */
function detectOne(bin, tool, existing, defaultPath, opts = {}) {
    const yes = opts.yes === true ? "YES=true\n" : "";
    const code = `${yes}CUST="c"; FORCE="f"
detect_single_tool_path ${tool} '${existing}' '${defaultPath}' CUST FORCE
printf '%s|%s' "$CUST" "$FORCE"`;
    return sourceScript(code, {
        env: { PATH: `${bin}:${process.env.PATH}`, USER_PATH: bin, HOME: opts.home ?? "" },
    });
}

/** Verifies detect_single_tool_path's priority order and broken-value clobber. */
test("detect_single_tool_path respects priority and clobbers broken values", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "gpg", "exit 0");
        writeMockBin(bin, "jq", "exit 0");
        writeMockBin(bin, "openssl", "exit 0");
        const gpg = join(bin, "gpg");

        // 1. Usable parcelrc value (absolute, executable) leaves CUST/FORCE untouched.
        const respected = detectOne(bin, "gpg", gpg, NOENT, { home });
        assert.strictEqual(respected.stdout, "c|f", "usable parcelrc value must short-circuit without touching globals");

        // 2. Broken parcelrc value is clobbered via command -v, and FORCE is set.
        const clobbered = detectOne(bin, "gpg", NOENT, "/usr/bin/gpg", { home });
        assert.strictEqual(clobbered.stdout, `${gpg}|true`, "broken value must be replaced and flagged FORCE=true");

        // 3. Default path, when unshadowed by parcelrc, needs no customisation.
        const defaultHit = detectOne(bin, "gpg", "", gpg, { home });
        assert.strictEqual(defaultHit.stdout, "c|f", "an executable default path must leave CUST empty");

        // 4. Missing default path falls back to command -v without forcing.
        const viaPath = detectOne(bin, "gpg", "", NOENT, { home });
        assert.strictEqual(viaPath.stdout, `${gpg}|f`, "command -v result sets CUST but not FORCE");

        // 5. Nothing found (no default, no PATH hit, no mac fallback) leaves CUST empty.
        const none = detectOne(bin, "parcel-no-such-tool", "", NOENT, { home, yes: true });
        assert.strictEqual(none.stdout, "c|f", "no working tool must leave CUST untouched");
    } finally {
        cleanup();
    }
});

/** Verifies tool_acceptable mirrors the bootstrap's strict-mode binary rules. */
test("tool_acceptable rejects user-owned binaries on system installs", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        const gpg = writeMockBin(bin, "gpg", "exit 0");
        const env = { env: { HOME: home } };
        const acceptable = (level, path) => sourceScript(`INSTALL_LEVEL="${level}"\ntool_acceptable '${path}'`, env).code === 0;

        assert.ok(acceptable("user", gpg), "user-level install must accept a user-owned binary");
        assert.ok(!acceptable("system", gpg), "system install must reject a user-owned binary");
        assert.ok(acceptable("system", "/bin/ls"), "system install must accept a root-owned system binary");
        assert.ok(!acceptable("user", NOENT), "missing paths are never acceptable");
    } finally {
        cleanup();
    }
});

/** Verifies tool_acceptable also rejects binaries in user-writable directories. */
test("tool_acceptable rejects root-owned binaries in writable directories on system installs", () => {
    if (process.getuid?.() === 0) return; // as root the /022 heuristic cannot see owner-only write bits
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        const gpg = writeMockBin(bin, "gpg", "exit 0");
        chmodSync(gpg, 0o555);
        // A lying stat (any stat output is uid 0) launders the fixture past the
        // ownership gate so the directory rejection is exercised in isolation.
        const statDir = join(home, "statbin");
        writeMockBin(statDir, "stat", "echo 0");
        const env = { env: { HOME: home, PATH: `${statDir}:${process.env.PATH ?? ""}` } };
        const acceptable = (level, path) => sourceScript(`INSTALL_LEVEL="${level}"\ntool_acceptable '${path}'`, env).code === 0;

        assert.ok(acceptable("system", "/bin/ls"), "root-owned binary in a non-writable dir stays acceptable");
        assert.ok(!acceptable("system", gpg), "system install must reject a binary whose directory is user-writable");
        assert.ok(acceptable("user", gpg), "user-level install must accept the same binary");
    } finally {
        cleanup();
    }
});

/** Verifies warn_nonroot_tools validates the paths detection accepted, not re-resolved USER_PATH lookups. */
test("warn_nonroot_tools validates the accepted path instead of re-resolving it via USER_PATH", () => {
    if (process.getuid?.() === 0) return; // ownership semantics are distorted as root
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "gpg", "exit 0");
        // detection accepts the root-owned default, so a user-owned gpg earlier in
        // USER_PATH must not produce a strict-mode warning the bootstrap can never hit
        const res = sourceScript(
            `YES=true
INSTALL_LEVEL=system
CUSTOM_GPG=""
CUSTOM_JQ=""
CUSTOM_OPENSSL=""
detect_single_tool_path gpg '' /bin/ls CUSTOM_GPG FORCE_GPG
warn_nonroot_tools`,
            { env: { PATH: `${bin}:${process.env.PATH}`, USER_PATH: bin, HOME: home } },
        );
        assert.strictEqual(res.code, 0, `run failed (stderr:\n${res.stderr})`);
        assert.ok(!res.stderr.includes("GPG ("), `must not warn about the unaccepted USER_PATH entry, got:\n${res.stderr}`);
        assert.ok(res.stderr.includes("No acceptable jq binary was found"), `expected a missing-jq warning, got:\n${res.stderr}`);
        assert.ok(res.stderr.includes("No acceptable openssl binary was found"), `expected a missing-openssl warning, got:\n${res.stderr}`);

        // an effective path that fails the strict-mode bar is still called out
        const strict = sourceScript(
            `INSTALL_LEVEL=system
CUSTOM_GPG=""
CUSTOM_JQ=""
CUSTOM_OPENSSL=""
EFFECTIVE_GPG="${join(bin, "gpg")}"
warn_nonroot_tools`,
            { env: { HOME: home } },
        );
        assert.strictEqual(strict.code, 0, `run failed (stderr:\n${strict.stderr})`);
        assert.ok(strict.stderr.includes("is not root-owned"), `expected a strict-mode warning, got:\n${strict.stderr}`);
    } finally {
        cleanup();
    }
});

/** Verifies $HOME-prefixed parcelrc values are left in place and recorded expanded. */
test("detect_single_tool_path respects a $HOME-prefixed parcelrc value", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "fakebin");
        const gpg = writeMockBin(bin, "gpg", "exit 0");
        for (const form of ["$HOME", "${HOME}"]) {
            const res = sourceScript(
                `INSTALL_LEVEL=user
CUST="c"; FORCE="f"
detect_single_tool_path gpg '${form}/fakebin/gpg' '${NOENT}' CUST FORCE
printf '%s|%s|%s' "$CUST" "$FORCE" "$EFFECTIVE_GPG"`,
                { env: { HOME: home } },
            );
            assert.strictEqual(res.code, 0, `run failed (stderr:\n${res.stderr})`);
            assert.strictEqual(res.stdout, `c|f|${gpg}`, "a usable $HOME-prefixed value must be left alone and recorded expanded");
        }
    } finally {
        cleanup();
    }
});

/** Verifies detect_tool_paths reads all three parcelrc values and delegates correctly. */
test("detect_tool_paths dispatches over gpg, jq, and openssl", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        const gpg = writeMockBin(bin, "gpg", "exit 0");
        const jq = writeMockBin(bin, "jq", "exit 0");
        writeMockBin(bin, "openssl", "exit 0");

        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });
        // gpg: usable absolute path -> respected. jq: broken -> clobbered. openssl: bare name -> resolved via USER_PATH.
        writeFileSync(join(cfg, "parcelrc"), `GPG="${gpg}"\nJQ="/broken/jq"\nOPENSSL="openssl"\n`);

        const res = sourceScript(
            `CONFIG_DIR="$HOME/.config/parcel"
detect_tool_paths
printf '%s|%s|%s|%s|%s|%s' "$CUSTOM_GPG" "$FORCE_GPG" "$CUSTOM_JQ" "$FORCE_JQ" "$CUSTOM_OPENSSL" "$FORCE_OPENSSL"`,
            { env: { PATH: `${bin}:${process.env.PATH}`, USER_PATH: bin, HOME: home } },
        );
        assert.strictEqual(res.code, 0);
        // gpg respected (empty|false), jq clobbered (path|true), openssl respected as bare name (empty|false).
        assert.strictEqual(res.stdout, `|false|${jq}|true||false`, "dispatcher must respect gpg/openssl and clobber jq");
    } finally {
        cleanup();
    }
});

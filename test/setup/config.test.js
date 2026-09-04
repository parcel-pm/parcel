"use strict";

/**
 * End-to-end tests for the .parcel.json config builder (`--create-config`).
 *
 * Each case drives the real `main` dispatch (not `run_config_builder` directly)
 * so that argument parsing, dependency checks, password-store resolution, and
 * the `--yes` prompt short-circuit are all exercised alongside the jq config
 * transform. Assertions target the output effects of the builder — the written
 * file's contents and mode, and the exit code — never a restatement of the jq
 * source.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runBash, SETUP_SCRIPT, makeTempHome, writeMockBin } from "./harness.js";

/**
 * Run a full `--create-config --yes` invocation against a temporary store.
 * @param {string} home - Temp HOME (bin dir is derived under it).
 * @param {string} store - Password store directory.
 * @param {string} [existing] - Optional pre-seeded .parcel.json content.
 * @param {number} [existingMode] - Optional mode to chmod the seed to (e.g. 0o644).
 * @returns {{code:number|null, stderr:string, json:object|null, raw:string|null}}
 *   The exit code, stderr, parsed final config, and raw bytes of .parcel.json.
 * @since 1.0.7
 */
function runCreateConfig(home, store, existing, existingMode) {
    mkdirSync(store, { recursive: true });

    const parcelfile = join(store, ".parcel.json");
    if (existing !== undefined) {
        writeFileSync(parcelfile, existing);
        if (existingMode !== undefined) {
            chmodSync(parcelfile, existingMode);
        }
    }

    // gpg must exist for check_dependencies; jq is the host's real jq.
    const bin = join(home, "bin");
    writeMockBin(bin, "gpg", `[ "\${1:-}" = "--version" ] && echo "gpg (GnuPG) 2.4.0"`);

    const res = runBash(`"${SETUP_SCRIPT}" --create-config --yes`, {
        env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: home,
            TMPDIR: home,
            PASSWORD_STORE_DIR: store,
        },
    });

    let json = null;
    let raw = null;
    if (existsSync(parcelfile)) {
        raw = readFileSync(parcelfile, "utf8");
        try {
            json = JSON.parse(raw);
        } catch {
            // Existing but unparseable: raw stays set, json stays null.
        }
    }

    return { code: res.code, stderr: res.stderr, json, raw };
}

/** Verifies a fresh store yields an empty (default-only) config, written 0600. */
test("create-config on a fresh store writes an empty config", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const store = join(home, "store");
        const { code, stderr, json } = runCreateConfig(home, store);

        assert.strictEqual(code, 0, `create-config must exit 0 (stderr:\n${stderr})`);
        // All fields answered with defaults and nothing pre-existing => every key elided.
        assert.deepStrictEqual(json, {}, "fresh store must produce a config with no optional keys");
        assert.strictEqual(statSync(join(store, ".parcel.json")).mode & 0o777, 0o600, "config must be 0600");
    } finally {
        cleanup();
    }
});

/** Verifies existing values (and unknown keys) are preserved while internal fields are stripped. */
test("create-config preserves existing values and unknown keys, and strips internal fields", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const store = join(home, "store");
        const existing = JSON.stringify({
            allowLinks: true, // non-default value -> preserved via the `!=` half of the guard
            handleHttpAuth: true, // present-but-default -> preserved via the has() half of the guard
            customThing: 1,
            passdir: "/should/be/dropped",
            modified: "2026-01-01",
            defaultRules: [1, 2, 3],
            hostPinned: true,
        });
        const { code, stderr, json } = runCreateConfig(home, store, existing, 0o644);

        assert.strictEqual(code, 0, `create-config must exit 0 (stderr:\n${stderr})`);

        // Present-but-default values are preserved via the has() half of the
        // guard (a regression dropping it silently empties pinned-default
        // configs); absent defaults are not added.
        assert.strictEqual(json.allowLinks, true, "existing allowLinks must be preserved");
        assert.strictEqual(json.handleHttpAuth, true, "present-but-default handleHttpAuth must be preserved");
        assert.strictEqual(json.customThing, 1, "unknown keys must pass through untouched");
        assert.ok(!("allowExternalLinks" in json), "absent default must not be added");

        // Internal fields are never written.
        for (const field of ["passdir", "modified", "defaultRules", "hostPinned"]) {
            assert.ok(!(field in json), `${field} must be stripped`);
        }

        // The in-place write preserves the pre-existing (loose) mode, so the
        // builder's unconditional chmod is the only thing re-privatising the file.
        assert.strictEqual(statSync(join(store, ".parcel.json")).mode & 0o777, 0o600, "loose 0644 seed must be re-privatised to 0600");
    } finally {
        cleanup();
    }
});
/** Verifies rule auto-detection on a fresh store and rule preservation on an existing one. */
test("create-config detects rules on a fresh store and keeps pre-existing rules", () => {
    const { home, cleanup } = makeTempHome();
    try {
        // Fresh store: an erayd/login dir yields a literal login rule.
        const fresh = join(home, "fresh");
        mkdirSync(join(fresh, "erayd", "login"), { recursive: true });
        const detected = runCreateConfig(home, fresh);
        assert.strictEqual(detected.code, 0, `fresh create-config must exit 0 (stderr:\n${detected.stderr})`);
        assert.deepStrictEqual(
            detected.json.rules,
            [{ pattern: "^erayd/login/", class: "login", tag: "erayd" }],
            "a detected class dir must become an auto-detected rule",
        );

        // Existing config with its own rules: --yes keeps them, does not replace.
        const seeded = join(home, "seeded");
        mkdirSync(join(seeded, "other", "login"), { recursive: true });
        const existingRules = JSON.stringify({ rules: [{ pattern: "^custom/", class: "login", tag: "custom" }] });
        const kept = runCreateConfig(home, seeded, existingRules);
        assert.strictEqual(kept.code, 0, `seeded create-config must exit 0 (stderr:\n${kept.stderr})`);
        assert.deepStrictEqual(
            kept.json.rules,
            [{ pattern: "^custom/", class: "login", tag: "custom" }],
            "pre-existing rules must be preserved verbatim in --yes mode",
        );
    } finally {
        cleanup();
    }
});

/** Verifies a corrupt .parcel.json aborts the run without modifying the file. */
test("create-config aborts on a corrupt .parcel.json without modifying it", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const store = join(home, "store");
        const corrupt = "{ definitely not json";
        const { code, stderr } = runCreateConfig(home, store, corrupt);

        assert.notStrictEqual(code, 0, "corrupt config must abort with a non-zero exit");
        assert.match(stderr, /not valid JSON/, "the failure must name the corrupt config");
        assert.strictEqual(
            readFileSync(join(store, ".parcel.json"), "utf8"),
            corrupt,
            "the corrupt file must be left byte-for-byte unchanged",
        );
    } finally {
        cleanup();
    }
});

/** Verifies a missing password store fails cleanly, naming the path and creating nothing. */
test("create-config with no password store fails without side effects", () => {
    const { home, cleanup } = makeTempHome();
    try {
        writeMockBin(join(home, "bin"), "gpg", `[ "\${1:-}" = "--version" ] && echo "gpg (GnuPG) 2.4.0"`);

        // PASSWORD_STORE_DIR deliberately unset: detection falls through to the
        // --yes prompt default ($HOME/.password-store), which does not exist.
        const res = runBash(`"${SETUP_SCRIPT}" --create-config --yes`, {
            env: { PATH: `${join(home, "bin")}:${process.env.PATH}`, HOME: home, TMPDIR: home },
        });

        assert.notStrictEqual(res.code, 0, "a missing store must be a hard failure");
        assert.match(res.stderr, /Password store not found/, "the failure must name the missing store");
        assert.ok(!existsSync(join(home, ".password-store")), "the default store path must not be created");
    } finally {
        cleanup();
    }
});

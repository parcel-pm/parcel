"use strict";

/**
 * Smoke test for the setup-script harness: proves the source guard exposes the
 * script's functions without invoking `main`, and that a known function is
 * reachable and behaves.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";

import { sourceScript, withSrcLoaded } from "./harness.js";

/** Ensures the guard defines functions but does not execute `main`. */
test("sourcing defines functions without running main", () => {
    const loaded = sourceScript("declare -F main >/dev/null 2>&1 && printf defined");
    assert.strictEqual(loaded.stdout, "defined", "main must be defined after sourcing");

    // If main ran it would populate OS (via detect_platform) and CONFIG_DIR; both
    // are still empty here, proving the guard skipped it.
    const bare = sourceScript('printf "%s|%s" "$OS" "$CONFIG_DIR"');
    assert.strictEqual(bare.stdout, "|", "main must not populate OS or CONFIG_DIR");
    // Empty stderr is a deliberate canary: it fails if anyone adds a top-level
    // diagnostic (e.g. log_warn) instead of keeping it inside a function.
    assert.strictEqual(bare.stderr, "", "sourcing must produce no diagnostics");
    assert.strictEqual(bare.code, 0, "sourcing must exit cleanly");
});

/** Verifies manifest_key reflects OS + install level, including bsd->linux. */
test("manifest_key reflects OS and install level", () => {
    const cases = [
        ["OS=darwin RESOLVED_LEVEL=system", "darwin-system"],
        ["OS=linux RESOLVED_LEVEL=user", "linux-user"],
        ["OS=bsd RESOLVED_LEVEL=user", "linux-user"], // bsd is normalised to linux
    ];
    for (const [setup, expected] of cases) {
        const { stdout, code } = sourceScript(`${setup}\nmanifest_key`);
        assert.strictEqual(code, 0, `expected exit 0 for ${setup}`);
        assert.strictEqual(stdout, expected, `expected ${expected} for ${setup}`);
    }
});

/** Confirms globals set in one snippet persist into later snippets in one child. */
test("state persists across snippets in a single sourced child", () => {
    const { outputs, code } = withSrcLoaded([
        'OS="linux"; RESOLVED_LEVEL="user"',
        "manifest_key",
        'OS="darwin"; RESOLVED_LEVEL="system"',
        "manifest_key",
    ]);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(outputs, ["", "linux-user", "", "darwin-system"]);
});

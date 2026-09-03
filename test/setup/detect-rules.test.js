"use strict";

/**
 * Behavioural test for detect_rules: verifies rule sort order is by path
 * depth (not raw string length), the >=2 consolidation threshold, the
 * `.+/` vs `(.+/)?` wildcard choice, the top-level fallback rule, and the
 * exclusion of `.git`/dotdirs.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome } from "./harness.js";

/**
 * Create the given relative directories under `root` (recursively).
 * @param {string} root - Base directory for the fixture store.
 * @param {string[]} dirs - Relative directory paths to create.
 * @returns {void}
 * @since 1.0.7
 */
function buildStore(root, dirs) {
    for (const d of dirs) {
        mkdirSync(join(root, d), { recursive: true });
    }
}

/** Verifies detect_rules consolidates nested class dirs, keeps lone dirs literal, and emits a fallback rule. */
test("detect_rules sorts by path depth and consolidates/falls back correctly", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const store = join(home, "store");
        buildStore(store, [
            "erayd/login", // direct class -> literal rule
            "clients/foo/login", // two direct subdirs -> ^clients/.+/login/
            "clients/bar/login",
            "family/login", // direct *and* nested -> ^family/(.+/)?login/
            "family/member/login",
            "springbroker/client/login", // single subdir -> stays literal
            "a/login", // short-name container, direct class -> literal (length-sort discriminator)
            "verylongtagname", // long name, no class dirs -> top-level fallback (length-sort discriminator)
            "monica/notes", // no class dirs -> top-level fallback
            ".git/objects", // must never yield a rule
        ]);

        const res = sourceScript(`printf '%s' "$(detect_rules)"`, { env: { PASSWORD_STORE_DIR: store } });
        assert.strictEqual(res.code, 0, "detect_rules must exit cleanly");
        const rules = JSON.parse(res.stdout);
        assert.ok(Array.isArray(rules) && rules.length > 0, "detect_rules must emit a non-empty array");

        // Exact rule set — one per expected pattern, with the matching class/tag.
        const expected = {
            "^erayd/login/": { class: "login", tag: "erayd" },
            "^clients/.+/login/": { class: "login", tag: "clients" },
            "^family/(.+/)?login/": { class: "login", tag: "family" },
            "^springbroker/client/login/": { class: "login", tag: "springbroker" },
            "^a/login/": { class: "login", tag: "a" },
            "^verylongtagname/": { class: "", tag: "verylongtagname" },
            "^monica/": { class: "", tag: "monica" },
        };
        assert.strictEqual(rules.length, Object.keys(expected).length, "exactly the expected rules are emitted");
        for (const [pattern, want] of Object.entries(expected)) {
            assert.deepStrictEqual(
                rules.find((r) => r.pattern === pattern),
                { pattern, ...want },
                `rule for ${pattern}`,
            );
        }

        // Dotdirs (incl. .git) never surface as a tag or a rule.
        assert.ok(
            rules.every((r) => !r.tag.startsWith(".")),
            "no dotdir container yields a tag",
        );
        assert.ok(
            rules.every((r) => !r.pattern.includes(".git")),
            "no .git-derived rule",
        );

        // Sorting is by path depth, so a deeper (longer-string) rule precedes erayd/login.
        const slashCount = (p) => (p.match(/\//g) ?? []).length;
        for (let i = 1; i < rules.length; i++) {
            assert.ok(slashCount(rules[i - 1].pattern) >= slashCount(rules[i].pattern), "patterns sorted most-specific first");
        }
        assert.ok(
            rules.findIndex((r) => r.pattern === "^springbroker/client/login/") < rules.findIndex((r) => r.pattern === "^erayd/login/"),
            "a deeper string must sort before the shallower ^erayd/login/ (depth, not length)",
        );
        // A raw length sort would place ^verylongtagname/ (17 chars, 1 slash) before
        // ^a/login/ (9 chars, 2 slashes); depth sorting must keep them this way round.
        assert.ok(
            rules.findIndex((r) => r.pattern === "^a/login/") < rules.findIndex((r) => r.pattern === "^verylongtagname/"),
            "a deeper (shorter) pattern must sort before the longer, shallower ^verylongtagname/ (depth, not length)",
        );
    } finally {
        cleanup();
    }
});

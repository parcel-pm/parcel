/**
 * Tests for src/js/helpers.js
 *
 * @since 1.0.0
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import { Helpers } from "../src/js/helpers.js";

describe("Helpers", () => {
    // -----------------------------------------------------------------------
    // base32ToArrayBuffer
    // -----------------------------------------------------------------------
    test("base32ToArrayBuffer decodes known vectors without padding", () => {
        const testVectors = [
            { input: "MY", expected: [0x66] },
            { input: "MZXQ", expected: [0x66, 0x6f] },
            { input: "MZXW6", expected: [0x66, 0x6f, 0x6f] },
            { input: "MZXW6YQ", expected: [0x66, 0x6f, 0x6f, 0x62] },
            { input: "MZXW6YTB", expected: [0x66, 0x6f, 0x6f, 0x62, 0x61] },
            { input: "MZXW6YTBOI", expected: [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72] },
        ];

        for (const { input, expected } of testVectors) {
            const buf = Helpers.base32ToArrayBuffer(input);
            const actual = Array.from(new Uint8Array(buf));
            assert.deepStrictEqual(actual, expected, `Failed for input: ${input}`);
        }
    });

    test("base32ToArrayBuffer is case-insensitive", () => {
        const lower = Helpers.base32ToArrayBuffer("mzxw6ytb");
        const upper = Helpers.base32ToArrayBuffer("MZXW6YTB");
        assert.deepStrictEqual(Array.from(new Uint8Array(lower)), Array.from(new Uint8Array(upper)));
    });

    test("base32ToArrayBuffer ignores padding", () => {
        assert.deepStrictEqual(Array.from(new Uint8Array(Helpers.base32ToArrayBuffer("MZXW6YTB"))), [0x66, 0x6f, 0x6f, 0x62, 0x61]);
    });

    // -----------------------------------------------------------------------
    // sha256
    // -----------------------------------------------------------------------
    test("sha256 produces expected hex digests", async () => {
        // SHA-256("hello") — verified against `echo -n hello | sha256sum`
        const digest = await Helpers.sha256("hello");
        assert.strictEqual(digest, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    test("sha256 handles empty string", async () => {
        const digest = await Helpers.sha256("");
        assert.strictEqual(digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    // -----------------------------------------------------------------------
    // generateTOTP
    // -----------------------------------------------------------------------
    test("generateTOTP returns correctly-formatted token and metadata", async () => {
        // Secret "JBSWY3DPEHPK3PXP" (the standard "Hello!" base32 secret).
        // At epoch counter 1 the expected token is 996554 (verified independently).
        const step = 30;
        const before = Date.now();
        const result = await Helpers.generateTOTP("JBSWY3DPEHPK3PXP", step, 6);

        assert.strictEqual(result.value.length, 6);
        assert.match(result.value, /^\d{6}$/);

        assert.ok(
            result.refreshAt >= Math.floor(before / (step * 1000)) * step * 1000 + step * 1000,
            "refreshAt should be the next epoch boundary",
        );
        assert.ok(
            result.generatedAt >= Math.floor(before / (step * 1000)) * step * 1000,
            "generatedAt should be the current epoch boundary",
        );
        assert.strictEqual(result.interval, step * 1000);
    });

    test("generateTOTP computes deterministic value for a fixed time", async () => {
        // Patch Date.now to a known timestamp and verify the token.
        const realNow = Date.now;
        const fixedTs = 30_000; // exactly epoch 1 boundary
        Date.now = () => fixedTs;
        try {
            const result = await Helpers.generateTOTP("JBSWY3DPEHPK3PXP", 30, 6);
            assert.strictEqual(result.value, "996554");
            assert.strictEqual(result.generatedAt, fixedTs);
            assert.strictEqual(result.refreshAt, fixedTs + 30_000);
        } finally {
            Date.now = realNow;
        }
    });

    // -----------------------------------------------------------------------
    // getValue
    // -----------------------------------------------------------------------
    test("getValue extracts matching line", async () => {
        const plaintext = "login: alice\nsecret: 1234\nemail: alice@example.com";
        const config = {
            targets: [
                { name: "login", pattern: "^login:", onMissing: "null", transform: [] },
                { name: "secret", pattern: "^secret:", onMissing: "null", transform: [] },
            ],
        };
        const login = await Helpers.getValue(plaintext, config, "login");
        assert.strictEqual(login, "login: alice");

        const secret = await Helpers.getValue(plaintext, config, "secret");
        assert.strictEqual(secret, "secret: 1234");
    });

    test("getValue strips pattern when strip=true", async () => {
        const config = {
            targets: [{ name: "login", pattern: "^login:", strip: true, onMissing: "null", transform: [] }],
        };
        const result = await Helpers.getValue("login: alice", config, "login");
        assert.strictEqual(result, " alice");
    });

    test("getValue throws for unknown type", async () => {
        await assert.rejects(async () => await Helpers.getValue("anything", { targets: [] }, "nope"), /Invalid target type: nope/);
    });

    test("getValue onMissing 'top' returns first line", async () => {
        const config = {
            targets: [
                {
                    name: "mystery",
                    pattern: "^nope:",
                    onMissing: "top",
                    transform: [],
                },
            ],
        };
        const result = await Helpers.getValue("first line\nsecond line", config, "mystery");
        assert.strictEqual(result, "first line");
    });

    test("getValue onMissing 'naked-top' returns first line without key:value", async () => {
        const config = {
            targets: [
                {
                    name: "mystery",
                    pattern: "^nope:",
                    onMissing: "naked-top",
                    transform: [],
                },
            ],
        };
        const result = await Helpers.getValue("MyPassword\nkey: value", config, "mystery");
        assert.strictEqual(result, "MyPassword");
    });

    test("getValue onMissing 'naked-top' skips key:value lines", async () => {
        const config = {
            targets: [
                {
                    name: "mystery",
                    pattern: "^nope:",
                    onMissing: "naked-top",
                    transform: [],
                },
            ],
        };
        // first line is key:value, so naked-top should skip it and return nothing
        const result = await Helpers.getValue("login: alice\nsecret: 1234", config, "mystery");
        assert.strictEqual(result, null);
    });

    test("getValue onMissing 'ntop' returns every line *except* the first", async () => {
        const config = {
            targets: [
                {
                    name: "mystery",
                    pattern: "^nope:",
                    onMissing: "ntop",
                    transform: [],
                },
            ],
        };
        const result = await Helpers.getValue("skip this\nreturn this\nextra", config, "mystery");
        assert.strictEqual(result, "return this\nextra");
    });

    test("getValue onMissing 'all' returns whole plaintext", async () => {
        const config = {
            targets: [
                {
                    name: "mystery",
                    pattern: "^nope:",
                    onMissing: "all",
                    transform: [],
                },
            ],
        };
        const pt = "line one\nline two";
        const result = await Helpers.getValue(pt, config, "mystery");
        assert.strictEqual(result, pt);
    });

    test("getValue onMissing 'fallback' delegates to fallback type", async () => {
        const config = {
            targets: [
                {
                    name: "alias",
                    pattern: "^alias:",
                    onMissing: "fallback",
                    fallback: "login",
                    transform: [],
                },
                {
                    name: "login",
                    pattern: "^login:",
                    onMissing: "null",
                    transform: [],
                },
            ],
        };
        const result = await Helpers.getValue("login: alice\n", config, "alias");
        assert.strictEqual(result, "login: alice");
    });

    test("getValue fallbackMatch extracts capture group", async () => {
        const config = {
            targets: [
                {
                    name: "alias",
                    pattern: "^alias:",
                    onMissing: "fallback",
                    fallback: "login",
                    fallbackMatch: "^login: (.+)",
                    transform: [],
                },
                {
                    name: "login",
                    pattern: "^login:",
                    onMissing: "null",
                    transform: [],
                },
            ],
        };
        const result = await Helpers.getValue("login: alice\n", config, "alias");
        assert.strictEqual(result, "alice");
    });

    test("getValue fallback throws when fallback has no match", async () => {
        const config = {
            targets: [
                {
                    name: "alias",
                    pattern: "^alias:",
                    onMissing: "fallback",
                    fallback: "login",
                    transform: [],
                },
                {
                    name: "login",
                    pattern: "^login:",
                    onMissing: "null",
                    transform: [],
                },
            ],
        };
        // Suppress the expected console.info from the fallback error path.
        const originalInfo = console.info;
        console.info = () => {};
        try {
            await assert.rejects(async () => await Helpers.getValue("no data", config, "alias"), /No value found for field type: alias/);
        } finally {
            console.info = originalInfo;
        }
    });

    test("getValue onMissing 'null' throws", async () => {
        const config = {
            targets: [
                {
                    name: "x",
                    pattern: "^x:",
                    onMissing: "null",
                    transform: [],
                },
            ],
        };
        await assert.rejects(async () => await Helpers.getValue("abc", config, "x"), /No value found for field type: x/);
    });

    test("getValue config can be a promise", async () => {
        const configPromise = Promise.resolve({
            targets: [{ name: "login", pattern: "^login:", onMissing: "null", transform: [] }],
        });
        const result = await Helpers.getValue("login: bob", configPromise, "login");
        assert.strictEqual(result, "login: bob");
    });

    test("getValue trims when trim=true", async () => {
        const config = {
            targets: [
                {
                    name: "x",
                    pattern: "^x:",
                    strip: true,
                    trim: true,
                    onMissing: "null",
                    transform: [],
                },
            ],
        };
        const result = await Helpers.getValue("x:  spaces  ", config, "x");
        assert.strictEqual(result, "spaces");
    });

    test("getValue applies totp transform from secret string", async () => {
        const realNow = Date.now;
        // fixedTs=30000 means epoch counter = 1
        Date.now = () => 30_000;
        try {
            const config = {
                targets: [
                    {
                        name: "totp",
                        pattern: "^totp:",
                        strip: true,
                        onMissing: "null",
                        transform: ["totp"],
                    },
                ],
            };
            const result = await Helpers.getValue("totp:JBSWY3DPEHPK3PXP", config, "totp");
            assert.strictEqual(typeof result, "object");
            // Token at epoch counter 1 for secret "JBSWY3DPEHPK3PXP"
            assert.strictEqual(result.value, "996554");
        } finally {
            Date.now = realNow;
        }
    });

    test("getValue applies totp-url transform", async () => {
        const realNow = Date.now;
        Date.now = () => 30_000;
        try {
            const config = {
                targets: [
                    {
                        name: "totp-url",
                        pattern: "^totp:",
                        strip: true,
                        onMissing: "null",
                        transform: ["totp-url"],
                    },
                ],
            };
            const link = "otpauth://totp/Example:user?secret=JBSWY3DPEHPK3PXP&period=30&digits=6";
            const result = await Helpers.getValue(`totp: ${link}`, config, "totp-url");
            assert.strictEqual(typeof result, "object");
            assert.strictEqual(result.value, "996554");
        } finally {
            Date.now = realNow;
        }
    });

    // -----------------------------------------------------------------------
    // shadowSelectorAll / shadowSelector
    // -----------------------------------------------------------------------
    test("shadowSelectorAll returns shallow matches", () => {
        const root = _fakeRoot({
            querySelectorAll: (sel) => (sel === ".foo" ? [{ id: "a" }, { id: "b" }] : []),
        });
        const results = Helpers.shadowSelectorAll(".foo", root);
        assert.deepStrictEqual(
            results.map((r) => r.id),
            ["a", "b"],
        );
    });

    test("shadowSelectorAll recurses into shadow roots", () => {
        const nested = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "inner" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const host = _fakeHost(nested);
        const root = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "outer" }];
                if (sel === "[is-shadow]") return [host];
                return [];
            },
        });
        const results = Helpers.shadowSelectorAll(".foo", root);
        assert.deepStrictEqual(
            results.map((r) => r.id),
            ["outer", "inner"],
        );
    });

    test("shadowSelector returns first match", () => {
        const root = _fakeRoot({
            querySelector: (sel) => (sel === ".foo" ? { id: "first" } : null),
        });
        const result = Helpers.shadowSelector(".foo", root);
        assert.deepStrictEqual(result, { id: "first" });
    });

    test("shadowSelector recurses into shadow roots when no shallow match", () => {
        const nested = _fakeRoot({
            querySelector: (sel) => (sel === ".foo" ? { id: "inner" } : null),
            querySelectorAll: () => [],
        });
        const host = _fakeHost(nested);
        const root = _fakeRoot({
            querySelector: (sel) => (sel === ".foo" ? null : null),
            querySelectorAll: (sel) => (sel === "[is-shadow]" ? [host] : []),
        });
        const result = Helpers.shadowSelector(".foo", root);
        assert.deepStrictEqual(result, { id: "inner" });
    });

    // -----------------------------------------------------------------------
    // shadowSelectorAll / shadowSelector — rootSelector filtering
    // -----------------------------------------------------------------------
    test("shadowSelectorAll with rootSelector only searches matching hosts", () => {
        const matchingNested = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "matching" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const skippedNested = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "skipped" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const matchingHost = _fakeHost(matchingNested, { matches: (sel) => sel === ".host-a" });
        const skippedHost = _fakeHost(skippedNested, { matches: (sel) => sel === ".host-b" });
        const root = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [];
                if (sel === "[is-shadow]") return [matchingHost, skippedHost];
                return [];
            },
        });
        const results = Helpers.shadowSelectorAll(".foo", root, ".host-a");
        assert.deepStrictEqual(
            results.map((r) => r.id),
            ["matching"],
        );
    });

    test("shadowSelectorAll with rootSelector recurses through matching nested hosts", () => {
        const inner = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "deep" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const innerHost = _fakeHost(inner, { matches: (sel) => sel === ".host-outer" });
        const outerShadow = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [];
                if (sel === "[is-shadow]") return [innerHost];
                return [];
            },
        });
        const outerHost = _fakeHost(outerShadow, { matches: (sel) => sel === ".host-outer" });
        const root = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [];
                if (sel === "[is-shadow]") return [outerHost];
                return [];
            },
        });
        // Both outer and inner hosts match the rootSelector, so recursion continues.
        const results = Helpers.shadowSelectorAll(".foo", root, ".host-outer");
        assert.deepStrictEqual(
            results.map((r) => r.id),
            ["deep"],
        );
    });

    test("shadowSelectorAll with rootSelector skips non-matching hosts at nested depth", () => {
        // The outer host matches the rootSelector, so its shadow root is
        // searched. Inside that shadow root are two nested hosts: one that
        // matches the rootSelector (searched) and one that does not (skipped).
        // This pins down that rootSelector is forwarded to recursive calls,
        // not just applied at the top level.
        const matchingNested = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "matching-nested" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const skippedNested = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "skipped-nested" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const matchingInnerHost = _fakeHost(matchingNested, { matches: (sel) => sel === ".host-a" });
        const skippedInnerHost = _fakeHost(skippedNested, { matches: (sel) => sel === ".host-b" });
        const outerShadow = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [];
                if (sel === "[is-shadow]") return [matchingInnerHost, skippedInnerHost];
                return [];
            },
        });
        const outerHost = _fakeHost(outerShadow, { matches: (sel) => sel === ".host-a" });
        const root = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [];
                if (sel === "[is-shadow]") return [outerHost];
                return [];
            },
        });
        const results = Helpers.shadowSelectorAll(".foo", root, ".host-a");
        assert.deepStrictEqual(
            results.map((r) => r.id),
            ["matching-nested"],
        );
    });

    test("shadowSelectorAll with rootSelector null behaves like no filter", () => {
        const nested = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "inner" }];
                if (sel === "[is-shadow]") return [];
                return [];
            },
        });
        const host = _fakeHost(nested, { matches: () => false });
        const root = _fakeRoot({
            querySelectorAll: (sel) => {
                if (sel === ".foo") return [{ id: "outer" }];
                if (sel === "[is-shadow]") return [host];
                return [];
            },
        });
        const results = Helpers.shadowSelectorAll(".foo", root, null);
        assert.deepStrictEqual(
            results.map((r) => r.id),
            ["outer", "inner"],
        );
    });

    test("shadowSelector with rootSelector skips non-matching hosts", () => {
        const skippedNested = _fakeRoot({
            querySelector: (sel) => (sel === ".foo" ? { id: "skipped" } : null),
            querySelectorAll: () => [],
        });
        const matchingNested = _fakeRoot({
            querySelector: (sel) => (sel === ".foo" ? { id: "matching" } : null),
            querySelectorAll: () => [],
        });
        const skippedHost = _fakeHost(skippedNested, { matches: () => false });
        const matchingHost = _fakeHost(matchingNested, { matches: () => true });
        const root = _fakeRoot({
            querySelector: () => null,
            querySelectorAll: (sel) => (sel === "[is-shadow]" ? [skippedHost, matchingHost] : []),
        });
        const result = Helpers.shadowSelector(".foo", root, ".host-matching");
        assert.deepStrictEqual(result, { id: "matching" });
    });

    test("shadowSelector with rootSelector returns null when no host matches", () => {
        const nested = _fakeRoot({
            querySelector: (sel) => (sel === ".foo" ? { id: "inner" } : null),
            querySelectorAll: () => [],
        });
        const host = _fakeHost(nested, { matches: () => false });
        const root = _fakeRoot({
            querySelector: () => null,
            querySelectorAll: (sel) => (sel === "[is-shadow]" ? [host] : []),
        });
        const result = Helpers.shadowSelector(".foo", root, ".host-other");
        assert.strictEqual(result, null);
    });

    // -----------------------------------------------------------------------
    // shadowClosest
    // -----------------------------------------------------------------------
    test("shadowClosest returns match within the current root", () => {
        const parent = _fakeElement({ closest: () => null });
        const el = _fakeElement({ closest: (sel) => (sel === ".group" ? parent : null) });
        assert.strictEqual(Helpers.shadowClosest(el, ".group"), parent);
    });

    test("shadowClosest crosses shadow boundaries when no match in current root", () => {
        const host = _fakeElement({ closest: (sel) => (sel === ".group" ? host : null) });
        const shadowRoot = { host };
        const el = _fakeElement({
            closest: () => null,
            getRootNode: () => shadowRoot,
        });
        assert.strictEqual(Helpers.shadowClosest(el, ".group"), host);
    });

    test("shadowClosest returns null when no match exists in any root", () => {
        const shadowRoot = { host: null };
        const el = _fakeElement({
            closest: () => null,
            getRootNode: () => shadowRoot,
        });
        assert.strictEqual(Helpers.shadowClosest(el, ".group"), null);
    });

    test("shadowClosest finds a matching host across nested shadow boundaries", () => {
        const outerHost = _fakeElement({ closest: (sel) => (sel === ".group" ? outerHost : null) });
        const outerRoot = { host: outerHost };
        const innerHost = _fakeElement({
            closest: () => null,
            getRootNode: () => outerRoot,
        });
        const innerRoot = { host: innerHost };
        const el = _fakeElement({
            closest: () => null,
            getRootNode: () => innerRoot,
        });
        assert.strictEqual(Helpers.shadowClosest(el, ".group"), outerHost);
    });

    // -----------------------------------------------------------------------
    // getLuma
    // -----------------------------------------------------------------------
    test("getLuma for black is 0", () => {
        assert.strictEqual(Helpers.getLuma("000000"), 0);
    });

    test("getLuma for white is 1", () => {
        assert.ok(Math.abs(Helpers.getLuma("FFFFFF") - 1.0) < 1e-6);
    });

    test("getLuma for medium grey is moderate", () => {
        const luma = Helpers.getLuma("808080");
        assert.ok(luma > 0.1 && luma < 0.5, `Expected luma between 0.1 and 0.5, got ${luma}`);
    });
});

// --- minimal DOM fakes for shadow selector tests --------------------------------

function _fakeRoot(opts) {
    return {
        querySelector: opts.querySelector ?? (() => null),
        querySelectorAll: opts.querySelectorAll ?? (() => []),
    };
}

function _fakeHost(shadowRoot, opts = {}) {
    return {
        shadowRoot,
        matches: opts.matches ?? (() => true),
    };
}

function _fakeElement(opts) {
    return {
        closest: opts.closest ?? (() => null),
        getRootNode: opts.getRootNode ?? (() => ({ host: null })),
    };
}

/**
 * Tests for src/js/plaintext.js
 *
 * @since 1.0.0
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import { Plaintext } from "../src/js/plaintext.js";
import { Helpers } from "../src/js/helpers.js";

describe("Plaintext", () => {
    const minimalConfig = {
        targets: [
            { name: "login", pattern: "^(user|username|login|email):", onMissing: "null", transform: [] },
            { name: "secret", pattern: "^(secret|password):", onMissing: "null", transform: [] },
            { name: "totp", pattern: "^(otc|otp|totp|code|2fa|two-factor|two_factor):", onMissing: "null", transform: ["totp"] },
            { name: "tel", pattern: "^(tel|phone|number|ph):", onMissing: "null", transform: [] },
        ],
    };

    // -----------------------------------------------------------------------
    // getPlaintext / getConfig
    // -----------------------------------------------------------------------
    test("getPlaintext returns the raw plaintext", () => {
        const pt = new Plaintext("hello\nworld", minimalConfig);
        assert.strictEqual(pt.getPlaintext(), "hello\nworld");
    });

    test("getConfig returns the config object", () => {
        const pt = new Plaintext("x", minimalConfig);
        assert.strictEqual(pt.getConfig(), minimalConfig);
    });

    // -----------------------------------------------------------------------
    // normaliseName
    // -----------------------------------------------------------------------
    test("normaliseName canonicalises login aliases", () => {
        for (const alias of ["login", "user", "username"]) {
            assert.strictEqual(Helpers.normaliseName(minimalConfig, alias), "login", `Failed for ${alias}`);
        }
    });

    test("normaliseName maps email to login", () => {
        assert.strictEqual(Helpers.normaliseName(minimalConfig, "email"), "login");
    });

    test("normaliseName canonicalises secret aliases", () => {
        for (const alias of ["secret", "password"]) {
            assert.strictEqual(Helpers.normaliseName(minimalConfig, alias), "secret", `Failed for ${alias}`);
        }
    });

    test("normaliseName canonicalises totp aliases", () => {
        for (const alias of ["totp", "otp", "otc", "code", "2fa", "two-factor", "two_factor"]) {
            assert.strictEqual(Helpers.normaliseName(minimalConfig, alias), "totp", `Failed for ${alias}`);
        }
    });

    test("normaliseName canonicalises phone aliases", () => {
        for (const alias of ["tel", "number", "phone", "ph"]) {
            assert.strictEqual(Helpers.normaliseName(minimalConfig, alias), "tel", `Failed for ${alias}`);
        }
    });

    test("normaliseName lowercases unknown names", () => {
        assert.strictEqual(Helpers.normaliseName(minimalConfig, "CUSTOM_FIELD"), "custom_field");
        assert.strictEqual(Helpers.normaliseName(minimalConfig, "MyField"), "myfield");
    });

    // -----------------------------------------------------------------------
    // getValue via Helpers.getValue
    // -----------------------------------------------------------------------
    test("getValue returns matching line via Helpers.getValue", async () => {
        const pt = new Plaintext("login: alice\nsecret: 1234", minimalConfig);
        const value = await pt.getValue("login");
        assert.strictEqual(value, "login: alice");
    });

    test("getValue normalises name before lookup", async () => {
        const pt = new Plaintext("login: alice\n", minimalConfig);
        const value = await pt.getValue("username");
        assert.strictEqual(value, "login: alice");
    });

    test("getValue returns null when no match and no fallback", async () => {
        const pt = new Plaintext("nothing here", minimalConfig);
        const value = await pt.getValue("login");
        assert.strictEqual(value, null);
    });

    // -----------------------------------------------------------------------
    // getValue fallback path (line scan after Helpers throws)
    // -----------------------------------------------------------------------
    test("getValue falls back to line scan for unknown field types", async () => {
        const config = {
            targets: [{ name: "login", pattern: "^login:", onMissing: "null", transform: [] }],
        };
        const pt = new Plaintext("custom_field: myvalue\n", config);
        const value = await pt.getValue("custom_field");
        assert.strictEqual(value, "myvalue");
    });

    test("getValue fallback is case-insensitive", async () => {
        const config = { targets: [] };
        const pt = new Plaintext("UPPER: VALUE\n", config);
        const value = await pt.getValue("upper");
        assert.strictEqual(value, "VALUE");
    });

    test("getValue fallback trims whitespace around value", async () => {
        const config = { targets: [] };
        const pt = new Plaintext("key:   spaced value  \n", config);
        const value = await pt.getValue("key");
        assert.strictEqual(value, "spaced value");
    });

    test("getValue fallback scans multi-line plaintext", async () => {
        const config = { targets: [] };
        const pt = new Plaintext("first: 1\nsecond: 2\nthird: 3\n", config);
        assert.strictEqual(await pt.getValue("first"), "1");
        assert.strictEqual(await pt.getValue("second"), "2");
        assert.strictEqual(await pt.getValue("third"), "3");
    });

    test("getValue fallback returns null for missing key", async () => {
        const config = { targets: [] };
        const pt = new Plaintext("only: this\n", config);
        const value = await pt.getValue("missing");
        assert.strictEqual(value, null);
    });

    test("getValue fallback returns null for empty plaintext", async () => {
        const config = { targets: [] };
        const pt = new Plaintext("", config);
        const value = await pt.getValue("anything");
        assert.strictEqual(value, null);
    });

    // -----------------------------------------------------------------------
    // getValue with TOTP transform in fallback path
    // -----------------------------------------------------------------------
    test("getValue fallback transforms totp", async () => {
        const realNow = Date.now;
        Date.now = () => 30_000;
        try {
            const config = { targets: [] };
            const pt = new Plaintext("totp: JBSWY3DPEHPK3PXP\n", config);
            const result = await pt.getValue("totp");
            assert.strictEqual(typeof result, "object");
            assert.strictEqual(result.value, "996554");
        } finally {
            Date.now = realNow;
        }
    });

    test("getValue normalises totp alias before transform", async () => {
        const realNow = Date.now;
        Date.now = () => 30_000;
        try {
            const config = {
                targets: [
                    {
                        name: "totp",
                        pattern: "^(otc|otp|totp|code|2fa|two-factor|two_factor):",
                        onMissing: "null",
                        strip: true,
                        trim: true,
                        transform: ["totp"],
                    },
                ],
            };
            const pt = new Plaintext("totp: JBSWY3DPEHPK3PXP\n", config);
            const result = await pt.getValue("otp");
            assert.strictEqual(typeof result, "object");
            assert.strictEqual(result.value, "996554");
        } finally {
            Date.now = realNow;
        }
    });

    // -----------------------------------------------------------------------
    // hasValue
    // -----------------------------------------------------------------------
    test("hasValue returns true for existing values", async () => {
        const pt = new Plaintext("login: alice\n", minimalConfig);
        assert.strictEqual(await pt.hasValue("login"), true);
    });

    test("hasValue returns false for missing values", async () => {
        const pt = new Plaintext("nothing\n", { targets: [] });
        assert.strictEqual(await pt.hasValue("login"), false);
    });

    // -----------------------------------------------------------------------
    // transform
    // -----------------------------------------------------------------------
    test("transform returns value unchanged by default", () => {
        const pt = new Plaintext("", minimalConfig);
        assert.strictEqual(pt.transform("login", "alice"), "alice");
        assert.strictEqual(pt.transform("secret", "1234"), "1234");
        assert.strictEqual(pt.transform("unknown", "whatever"), "whatever");
    });

    test("transform generates TOTP for totp name", async () => {
        const realNow = Date.now;
        Date.now = () => 30_000;
        try {
            const pt = new Plaintext("", minimalConfig);
            const result = pt.transform("totp", "JBSWY3DPEHPK3PXP");
            assert.ok(result instanceof Promise);
            const resolved = await result;
            assert.strictEqual(resolved.value, "996554");
        } finally {
            Date.now = realNow;
        }
    });
});

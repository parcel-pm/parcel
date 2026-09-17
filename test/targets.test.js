/**
 * Tests for src/js/targets.js
 *
 * @since 1.0.0
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import { defaultTargets } from "../src/js/targets.js";
import { TargetSchema, Schema } from "../src/js/schema.js";
import { Plaintext } from "../src/js/plaintext.js";

describe("Default targets", () => {
    test("every entry validates against TargetSchema", () => {
        for (const target of defaultTargets) {
            assert.doesNotThrow(() => Schema.validate(TargetSchema, target), `Target "${target.name}" failed validation`);
        }
    });

    test("entries have unique names", () => {
        const names = defaultTargets.map((t) => t.name);
        const unique = new Set(names);
        assert.strictEqual(unique.size, names.length, "Duplicate target names detected");
    });

    test("fallback targets point to existing names", () => {
        const names = new Set(defaultTargets.map((t) => t.name));
        for (const target of defaultTargets) {
            if (target.fallback) {
                assert.ok(names.has(target.fallback), `Target "${target.name}" references unknown fallback "${target.fallback}"`);
            }
        }
    });

    test("card targets use class 'card'", () => {
        const cardTargetNames = ["card", "cardholder", "cardexp", "cardexp-month", "cardexp-year", "cardcsc"];
        for (const name of cardTargetNames) {
            const target = defaultTargets.find((t) => t.name === name);
            assert.ok(target, `Card target "${name}" not found in default targets`);
            assert.strictEqual(target.class, "card", `Target "${name}" should have class "card"`);
        }
    });

    test("card only resolves when the entry actually contains a card number", async () => {
        const config = { targets: defaultTargets };
        // a regular password entry must not hoist the secret as a card
        assert.strictEqual(await new Plaintext("supersecretpassword\nlogin: user@example.com", config).getValue("card"), null);
        // a numeric password of plausible card length must not hoist without a valid Luhn checksum
        assert.strictEqual(await new Plaintext("1234567812345671\nlogin: user@example.com", config).getValue("card"), null);
        // a naked card-number top line still resolves
        assert.strictEqual(await new Plaintext("4111111111111111\nholder: alice", config).getValue("card"), "4111111111111111");
        // grouped formats still resolve
        assert.strictEqual(await new Plaintext("4111-1111-1111-1111\nholder: alice", config).getValue("card"), "4111-1111-1111-1111");
    });

    test("non-card targets default to class 'login'", () => {
        const cardTargetNames = new Set(["card", "cardholder", "cardexp", "cardexp-month", "cardexp-year", "cardcsc"]);
        for (const target of defaultTargets) {
            if (!cardTargetNames.has(target.name)) {
                // targets without an explicit class default to "login" via schema validation
                assert.ok(!("class" in target) || target.class === "login", `Target "${target.name}" must not declare a non-login class`);
            }
        }
    });
});

/**
 * Tests for src/js/schema.js
 *
 * Uses node:test (built-in) so there are zero third-party dependencies.
 *
 * @since 1.0.0
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import {
    MetaSchema,
    SelectorSchema,
    TargetSchema,
    ConfigSchema,
    PasskeyRequestSchema,
    PasskeyAbortSchema,
    PasskeyConflictSchema,
    Schema,
} from "../src/js/schema.js";

describe("Schema.validate", () => {
    // ----------------------------------------------------------------
    // undefined / required
    // ----------------------------------------------------------------
    test("passes when field missing and not required", () => {
        assert.doesNotThrow(() => Schema.validate({ type: "string" }, undefined));
    });

    test("throws when field missing and required", () => {
        assert.throws(() => Schema.validate({ type: "string", required: true }, undefined), /Missing required property/);
    });

    // ----------------------------------------------------------------
    // primitives — string
    // ----------------------------------------------------------------
    test("string: accepts valid strings", () => {
        assert.doesNotThrow(() => Schema.validate({ type: "string" }, "hello"));
    });

    test("string: rejects non-strings", () => {
        assert.throws(() => Schema.validate({ type: "string" }, 42), /Invalid type.*expected string.*got number/);
        assert.throws(() => Schema.validate({ type: "string" }, []), /Invalid type.*expected string.*got array/);
        assert.throws(() => Schema.validate({ type: "string" }, {}), /Invalid type.*expected string.*got object/);
    });

    test("string: enforces exact value", () => {
        Schema.validate({ type: "string", value: "exact" }, "exact");
        assert.throws(() => Schema.validate({ type: "string", value: "exact" }, "other"), /Invalid value.*must be exact/);
    });

    test("string: enforces minLength", () => {
        Schema.validate({ type: "string", minLength: 3 }, "abc");
        assert.throws(() => Schema.validate({ type: "string", minLength: 3 }, "ab"), /at least 3 characters/);
    });

    test("string: enforces maxLength", () => {
        Schema.validate({ type: "string", maxLength: 3 }, "abc");
        assert.throws(() => Schema.validate({ type: "string", maxLength: 3 }, "abcd"), /at most 3 characters/);
    });

    test("string: enforces pattern", () => {
        Schema.validate({ type: "string", pattern: "^[a-z]+$" }, "abc");
        assert.throws(() => Schema.validate({ type: "string", pattern: "^[a-z]+$" }, "ABC"), /must match \^\[a-z\]\+\$/);
    });

    test("string: custom flags for pattern", () => {
        Schema.validate({ type: "string", pattern: "^[A-Z]+$", flags: "i" }, "abc");
    });

    test("string: enforces enum", () => {
        Schema.validate({ type: "string", enum: ["a", "b"] }, "a");
        assert.throws(() => Schema.validate({ type: "string", enum: ["a", "b"] }, "c"), /must be one of/);
    });

    test("string: format=regex validates regex syntax", () => {
        Schema.validate({ type: "string", format: "regex" }, "^[a-z]+$");
        assert.throws(() => Schema.validate({ type: "string", format: "regex" }, "[invalid"), /must be a valid regular expression/);
    });

    // ----------------------------------------------------------------
    // primitives — number / integer
    // ----------------------------------------------------------------
    test("number: accepts numbers", () => {
        Schema.validate({ type: "number" }, 42.5);
    });

    test("number: rejects non-numbers", () => {
        assert.throws(() => Schema.validate({ type: "number" }, "42"), /Invalid type.*expected number.*got string/);
    });

    test("integer: accepts integers", () => {
        Schema.validate({ type: "integer" }, 42);
    });

    test("integer: rejects floats", () => {
        assert.throws(() => Schema.validate({ type: "integer" }, 3.14), /Invalid type.*expected integer.*got number/);
    });

    test("integer: accepts integers as number fallback", () => {
        Schema.validate({ type: "integer" }, 42);
    });

    test("integer: does not mutate schema type on integer validation", () => {
        const schema = { type: "integer", minimum: 0 };
        Schema.validate(schema, 42);
        assert.strictEqual(schema.type, "integer", "schema.type must not be mutated");
    });

    test("integer: still rejects floats after a prior integer validation (shared singleton)", () => {
        // Use the same schema object twice to catch mutation regressions.
        const schema = { type: "integer", minimum: 0 };
        Schema.validate(schema, 42);
        assert.throws(() => Schema.validate(schema, 3.14), /Invalid type.*expected integer.*got number/);
    });

    test("integer: number rules (minimum/maximum/value) are applied to integers", () => {
        // Integers are a subset of numbers; minimum, maximum, and value must still be enforced.
        assert.throws(() => Schema.validate({ type: "integer", minimum: 10 }, 5), /too low/);
        assert.throws(() => Schema.validate({ type: "integer", maximum: 100 }, 200), /too high/);
        assert.throws(() => Schema.validate({ type: "integer", value: 42 }, 7), /must be 42/);
    });

    test("number: enforces minimum", () => {
        Schema.validate({ type: "number", minimum: 0 }, 0.5);
        assert.throws(() => Schema.validate({ type: "number", minimum: 10 }, 5), /Value for .* is too low/);
    });

    test("number: enforces maximum", () => {
        Schema.validate({ type: "number", maximum: 100 }, 99);
        assert.throws(() => Schema.validate({ type: "number", maximum: 10 }, 20), /Value for .* is too high/);
    });

    // ----------------------------------------------------------------
    // primitives — boolean
    // ----------------------------------------------------------------
    test("boolean: accepts booleans", () => {
        Schema.validate({ type: "boolean" }, true);
        Schema.validate({ type: "boolean" }, false);
    });

    test("boolean: rejects non-booleans", () => {
        assert.throws(() => Schema.validate({ type: "boolean" }, 0), /Invalid type.*expected boolean.*got number/);
        assert.throws(() => Schema.validate({ type: "boolean" }, "true"), /Invalid type.*expected boolean.*got string/);
    });

    test("boolean: enforces exact value", () => {
        Schema.validate({ type: "boolean", value: true }, true);
        assert.throws(() => Schema.validate({ type: "boolean", value: true }, false), /Invalid value.*must be true/);
    });

    // ----------------------------------------------------------------
    // object
    // ----------------------------------------------------------------
    test("object: applies defaults for missing properties", () => {
        const data = {};
        Schema.validate(
            {
                type: "object",
                properties: {
                    x: { type: "number", required: true, default: 10 },
                },
            },
            data,
        );
        assert.strictEqual(data.x, 10);
    });

    test("object: does not apply default when property already present", () => {
        const data = { x: 5 };
        Schema.validate(
            {
                type: "object",
                properties: {
                    x: { type: "number", required: true, default: 10 },
                },
            },
            data,
        );
        assert.strictEqual(data.x, 5);
    });

    test("object: validates nested properties", () => {
        Schema.validate(
            {
                type: "object",
                properties: {
                    name: { type: "string", required: true },
                },
            },
            { name: "alice" },
        );
    });

    test("object: throws on unknown properties", () => {
        assert.throws(
            () =>
                Schema.validate(
                    {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                        },
                    },
                    { name: "alice", extra: "bad" },
                ),
            /Unknown property \/extra/,
        );
    });

    test("object: reports correct nested path in errors", () => {
        assert.throws(
            () =>
                Schema.validate(
                    {
                        type: "object",
                        properties: {
                            a: {
                                type: "object",
                                properties: {
                                    b: { type: "string", required: true },
                                },
                            },
                        },
                    },
                    { a: {} },
                ),
            /Missing required property \/a\/b/,
        );
    });

    test("object: allows unknown keys when 'properties' is undefined", () => {
        // object with no properties allows any keys
        Schema.validate({ type: "object" }, { a: 1, b: "two" });
    });

    // ----------------------------------------------------------------
    // array
    // ----------------------------------------------------------------
    test("array: accepts arrays", () => {
        Schema.validate({ type: "array" }, []);
        Schema.validate({ type: "array" }, [1, 2, 3]);
    });

    test("array: rejects non-arrays", () => {
        assert.throws(() => Schema.validate({ type: "array" }, "not array"), /Invalid type.*expected array.*got string/);
        assert.throws(() => Schema.validate({ type: "array" }, { 0: "a", length: 1 }), /Invalid type.*expected array.*got object/);
    });

    test("array: validates items", () => {
        Schema.validate(
            {
                type: "array",
                items: { type: "string" },
            },
            ["a", "b"],
        );
        assert.throws(
            () =>
                Schema.validate(
                    {
                        type: "array",
                        items: { type: "string" },
                    },
                    ["a", 2],
                ),
            /Invalid type for \[1\]/,
        );
    });

    test("array: enforces minItems", () => {
        Schema.validate({ type: "array", items: { type: "number" }, minItems: 2 }, [1, 2]);
        assert.throws(() => Schema.validate({ type: "array", items: { type: "number" }, minItems: 2 }, [1]), /has too few items/);
    });

    test("array: enforces maxItems", () => {
        Schema.validate({ type: "array", items: { type: "number" }, maxItems: 2 }, [1, 2]);
        assert.throws(() => Schema.validate({ type: "array", items: { type: "number" }, maxItems: 1 }, [1, 2]), /has too many items/);
    });

    test("array: path includes index", () => {
        assert.throws(
            () =>
                Schema.validate(
                    {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                x: { type: "string", required: true },
                            },
                        },
                    },
                    [{ x: "ok" }, { y: "bad" }],
                ),
            /Missing required property \[1\]\/x/,
        );
    });
});

describe("Meta-schema", () => {
    test("validates a simple schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, { type: "string" }));
    });

    test("validates an object schema with properties", () => {
        assert.doesNotThrow(() =>
            Schema.validate(MetaSchema, {
                type: "object",
                properties: {
                    name: { type: "string", required: true },
                    age: { type: "integer", minimum: 0 },
                },
            }),
        );
    });

    test("validates an array schema with items", () => {
        assert.doesNotThrow(() =>
            Schema.validate(MetaSchema, {
                type: "array",
                items: { type: "string", minLength: 1 },
                minItems: 0,
            }),
        );
    });

    test("rejects invalid meta-schema keys", () => {
        assert.throws(() => Schema.validate(MetaSchema, { type: "object", badKey: true }), /Unknown property/);
    });

    test("Meta-schema validates itself", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, MetaSchema));
    });
});

describe("Defined schemas", () => {
    test("SelectorSchema is a valid schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, SelectorSchema));
    });

    test("TargetSchema is a valid schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, TargetSchema));
    });

    test("ConfigSchema is a valid schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, ConfigSchema));
    });

    test("PasskeyRequestSchema is a valid schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, PasskeyRequestSchema));
    });

    test("PasskeyAbortSchema is a valid schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, PasskeyAbortSchema));
    });

    test("PasskeyConflictSchema is a valid schema", () => {
        assert.doesNotThrow(() => Schema.validate(MetaSchema, PasskeyConflictSchema));
    });

    test("ConfigSchema: passkeyDir defaults to 'passkeys'", () => {
        const config = { modified: 1, passdir: "/tmp/store", rules: [{ pattern: "." }] };
        Schema.validate(ConfigSchema, config);
        assert.strictEqual(config.passkeyDir, "passkeys");
    });

    test("ConfigSchema: passkeyDir permits unicode, spaces, dots and traversal", () => {
        for (const passkeyDir of ["我的密钥", "My Keys", "../elsewhere", ".hidden", "a//b", "/abs", "a.b/c"]) {
            const config = { modified: 1, passdir: "/tmp/store", rules: [{ pattern: "." }], passkeyDir };
            assert.doesNotThrow(() => Schema.validate(ConfigSchema, config), `expected ${passkeyDir} to be accepted`);
        }
    });

    test("ConfigSchema: rejects control characters and glob metacharacters in passkeyDir", () => {
        for (const passkeyDir of ["bad\ndir", "bad\tdir", "bad*dir", "bad?dir", "bad[dir", "bad\\dir"]) {
            assert.throws(
                () => Schema.validate(ConfigSchema, { modified: 1, passdir: "/tmp/store", rules: [{ pattern: "." }], passkeyDir }),
                /passkeyDir/,
                `expected ${JSON.stringify(passkeyDir)} to be rejected`,
            );
        }
    });

    test("SelectorSchema: accepts relatedNever boolean and defaults to false", () => {
        const data = [{ selector: "input[name=test]", type: "login" }];
        Schema.validate(SelectorSchema, data);
        assert.strictEqual(data[0].relatedNever, false);
    });

    test("SelectorSchema: accepts relatedNever true", () => {
        assert.doesNotThrow(() => Schema.validate(SelectorSchema, [{ selector: "input[name=test]", type: "login", relatedNever: true }]));
    });

    test("SelectorSchema: rejects non-boolean relatedNever", () => {
        assert.throws(
            () => Schema.validate(SelectorSchema, [{ selector: "input[name=test]", type: "login", relatedNever: "yes" }]),
            /expected boolean.*got string/,
        );
    });
});

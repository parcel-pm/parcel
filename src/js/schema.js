"use strict";

import { defaultTargets } from "./targets.js";

/**
 * A basic data validation class.
 * @since 1.0.0
 */
export class Schema {
    /**
     * Validate a data instance against a schema.
     *
     * Applies defaults for missing required properties, mutating `data`.
     *
     * @param {object} schema - The schema to validate against.
     * @param {any}    data - The data instance to validate.
     * @param {string} [path="/"] - The path to the data object being validated.
     * @returns {void}
     * @throws {Error} If the data instance is invalid.
     */
    static validate(schema, data, path = "/") {
        if (data === undefined) {
            if (schema.required) throw new Error(`Missing required property ${path}.`);
            return;
        }
        let type = typeof data;
        if (type === "object" && Array.isArray(data)) type = "array";
        if (type !== schema.type) {
            if (schema.type === "integer" && type === "number" && Number.isInteger(data)) {
                schema.type = "number"; // Other than ensuring it's an integer, the rest of the validation is done as a number.
            } else {
                throw new Error(`Invalid type for ${path}: expected ${schema.type}, got ${type}.`);
            }
        }

        if (["string", "number", "boolean"].includes(type)) {
            if (Object.prototype.hasOwnProperty.call(schema, "value") && data !== schema.value)
                throw new Error(`Invalid value for ${path}: must be ${schema.value}.`);
        }
        switch (type) {
            case "string": {
                if (Object.prototype.hasOwnProperty.call(schema, "minLength") && data.length < schema.minLength)
                    throw new Error(`Invalid value for ${path}: must be at least ${schema.minLength} characters long.`);
                if (Object.prototype.hasOwnProperty.call(schema, "maxLength") && data.length > schema.maxLength)
                    throw new Error(`Invalid value for ${path}: must be at most ${schema.maxLength} characters long.`);
                if (schema.pattern && !new RegExp(schema.pattern, schema.flags || "u").test(data))
                    throw new Error(`Invalid value for ${path}: must match ${schema.pattern}.`);
                if (schema.enum && !schema.enum.includes(data))
                    throw new Error(`Invalid value for ${path}: must be one of [${schema.enum.join(", ")}].`);
                if (schema.format) {
                    switch (schema.format) {
                        case "regex":
                            try {
                                new RegExp(data, "u");
                            } catch {
                                throw new Error(`Invalid value for ${path}: must be a valid regular expression.`);
                            }
                    }
                    break;
                }
                // falls through
            }
            case "number":
                {
                    if (Object.prototype.hasOwnProperty.call(schema, "minimum") && data < schema.minimum)
                        throw new Error(`Value for ${path} is too low.`);
                    if (Object.prototype.hasOwnProperty.call(schema, "maximum") && data > schema.maximum)
                        throw new Error(`Value for ${path} is too high.`);
                }
                break;
            case "object":
                {
                    if (schema.properties) {
                        for (const key of Object.keys(schema.properties)) {
                            if (
                                data[key] === undefined &&
                                schema.properties[key].required &&
                                schema.properties[key].default !== undefined
                            ) {
                                data[key] = structuredClone(schema.properties[key].default);
                            }
                            Schema.validate(schema.properties[key], data[key], `${path === "/" ? "" : path}/${key}`);
                        }
                        for (const key of Object.keys(data)) {
                            const keyPath = `${path === "/" ? "" : path}/${key}`;
                            if (!schema.properties[key]) throw new Error(`Unknown property ${keyPath}.`);
                        }
                    }
                }
                break;
            case "array":
                {
                    if (schema.items) {
                        if (Object.prototype.hasOwnProperty.call(schema, "minItems") && data.length < schema.minItems)
                            throw new Error(`Array at ${path} has too few items.`);
                        if (Object.prototype.hasOwnProperty.call(schema, "maxItems") && data.length > schema.maxItems)
                            throw new Error(`Array at ${path} has too many items.`);
                        for (let i = 0; i < data.length; i++) {
                            Schema.validate(schema.items, data[i], `${path === "/" ? "" : path}[${i}]`);
                        }
                    }
                }
                break;
        }
    }
}

/**
 * The meta-schema for validating schema definitions.
 * @type {object}
 * @since 1.0.0
 */
export const MetaSchema = {
    type: "object",
    properties: {
        type: { type: "string", required: true, enum: ["string", "number", "boolean", "integer", "object", "array"] },
        required: { type: "boolean" },
        default: {},
        minLength: { type: "integer", minimum: 0 },
        maxLength: { type: "integer", minimum: 0 },
        pattern: { type: "string", minLength: 1 },
        flags: { type: "string" },
        format: { type: "string", enum: ["regex"] },
        enum: { type: "array", items: { type: "string" } },
        minimum: { type: "number" },
        maximum: { type: "number" },
        minItems: { type: "integer", minimum: 0 },
        maxItems: { type: "integer", minimum: 0 },
        value: {},
        properties: { type: "object" },
        items: {},
    },
};

// Self-reference: properties values and items must themselves be valid schemas.
MetaSchema.properties.properties.items = MetaSchema;
MetaSchema.properties.items = MetaSchema;

/**
 * The schema for selectors.
 * @type {object}
 * @since 1.0.0
 */
export const SelectorSchema = {
    type: "array",
    items: {
        type: "object",
        properties: {
            host: { type: "array", items: { type: "string" } },
            relatedOnly: { type: "boolean", required: true, default: false },
            selector: { type: "string", required: true, minLength: 1 },
            shadow: { type: "string", minLength: 1 },
            single: { type: "boolean", required: true, default: false },
            type: { type: "string", required: true, minLength: 1 },
        },
    },
};

/**
 * The schema for targets.
 * @type {object}
 * @since 1.0.0
 */
export const TargetSchema = {
    type: "object",
    properties: {
        class: { type: "string", required: true, enum: ["login"], default: "login" },
        dynamic: { type: "boolean", required: true, default: false },
        fallback: { type: "string", minLength: 1 },
        fallbackMatch: { type: "string", format: "regex", minLength: 1 },
        hoist: { type: "boolean", required: true, default: false },
        highlightSpecial: { type: "boolean", required: true, default: false },
        label: { type: "string" },
        name: { type: "string", required: true },
        onMissing: {
            type: "string",
            required: true,
            enum: ["top", "naked-top", "ntop", "all", "null", "fallback"],
            default: "null",
        },
        pattern: { type: "string", required: true, format: "regex", minLength: 1 },
        related: { type: "array", required: true, items: { type: "string" }, default: [] },
        strip: { type: "boolean", required: true, default: true },
        transform: { type: "array", items: { type: "string", enum: ["totp", "totp-url"] }, required: true, default: [] },
        trim: { type: "boolean", required: true, default: true },
    },
};

/**
 * The main configuration schema.
 * @type {object}
 * @since 1.0.0
 */
export const ConfigSchema = {
    type: "object",
    properties: {
        additionalSelectors: SelectorSchema,
        additionalTargets: { type: "array", items: TargetSchema },
        allowExternalLinks: { type: "boolean", required: true, default: false },
        allowLinks: { type: "boolean", required: true, default: false },
        auditDecrypt: { type: "boolean", required: true, default: false },
        cacheTTL: { type: "number", required: true, minimum: 0, default: 10 },
        decryptBucket: { type: "integer", required: true, minimum: 0, default: 24 }, // default also set in parcel-host (DECRYPT_BUCKET_SIZE_DEFAULT)
        decryptRate: { type: "number", required: true, minimum: 0, default: 0.006667 }, // default also set in parcel-host (DECRYPT_BUCKET_RATE_DEFAULT)
        decryptTimeout: { type: "number", required: true, minimum: 1, default: 60 },
        defaultRules: { type: "boolean", required: true, default: false },
        disableContextPopup: { type: "boolean", required: true, default: false },
        fillRelated: { type: "boolean", required: true, default: true },
        historyLength: { type: "integer", required: true, minimum: 0, default: 40 },
        modified: { type: "integer", required: true, minimum: 1 },
        passdir: { type: "string", required: true },
        realPassdir: { type: "string" },
        saveHistory: { type: "boolean", required: true, default: true },
        rules: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    class: { type: "string", required: true, enum: ["login"], default: "login" },
                    color: { type: "string", required: true, pattern: "^[0-9a-f]{6}$", flags: "ui", default: "333333" },
                    ignore: { type: "boolean", required: true, default: false },
                    pattern: { type: "string", required: true, format: "regex" },
                    strip: { type: "string", format: "regex" },
                    tag: { type: "string" },
                },
            },
            required: true,
        },
        targets: {
            type: "array",
            items: TargetSchema,
            required: true,
            default: defaultTargets,
        },
    },
};

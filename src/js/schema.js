"use strict";

/**
 * A basic data validation class.
 * @since 1.0.0
 */
export class Schema {
    /**
     * Validate a data instance against a schema.
     * @param {object} schema - The JSON schema to validate against.
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
            if (schema.hasOwnProperty("value") && data !== schema.value)
                throw new Error(`Invalid value for ${path}: must be ${schema.value}.`);
        }
        switch (type) {
            case "string": {
                if (schema.minLength && data.length < schema.minLength)
                    throw new Error(`Invalid value for ${path}: must be at least ${schema.minLength} characters long.`);
                if (schema.maxLength && data.length > schema.maxLength)
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
            }
            case "number":
                {
                    if (schema.minimum && data < schema.minimum) throw new Error(`Value for ${path} is too low.`);
                    if (schema.maximum && data > schema.maximum) throw new Error(`Value for ${path} is too high.`);
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
                            if (!schema.properties[key]) throw new Error(`Unknown property ${path}/${key}.`);
                        }
                    }
                }
                break;
            case "array":
                {
                    if (schema.items) {
                        if (schema.minItems && data.length < schema.minItems) throw new Error(`Array at ${path} has too few items.`);
                        if (schema.maxItems && data.length > schema.maxItems) throw new Error(`Array at ${path} has too many items.`);
                        for (let i = 0; i < data.length; i++) {
                            Schema.validate(schema.items, data[i], `${path}[${i}]`);
                        }
                    }
                }
                break;
        }
    }
}

/**
 * The schema for selectors.
 * @since 1.0.0
 */
export const SelectorSchema = {
    type: "array",
    items: {
        type: "object",
        properties: {
            selector: { type: "string", required: true, minLength: 1 },
            type: { type: "string", required: true, minLength: 1 },
            host: { type: "array", items: { type: "string" } },
        },
    },
};

/**
 * The main configuration schema.
 * @since 1.0.0
 */
export const ConfigSchema = {
    type: "object",
    properties: {
        additionalSelectors: SelectorSchema,
        cacheTTL: { type: "number", required: true, minimum: 0, default: 300 },
        cacheTTLInteractive: { type: "number", required: true, minimum: 0, default: 10 },
        decryptTimeout: { type: "number", required: true, minimum: 1, default: 60 },
        fillRelated: { type: "boolean", required: true, default: true },
        historyLength: { type: "integer", required: true, minimum: 0, default: 40 },
        modified: { type: "integer", required: true, minimum: 1 },
        passdir: { type: "string", required: true },
        rules: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    class: { type: "string", required: true, enum: ["login"], default: "login" },
                    color: { type: "string", pattern: "^[0-9a-f]{6}$", flags: "ui" },
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
            items: {
                type: "object",
                properties: {
                    class: { type: "string", required: true, enum: ["login"], default: "login" },
                    dynamic: { type: "boolean", required: true, default: false },
                    fallback: { type: "string", minLength: 1 },
                    hoist: { type: "boolean", required: true, default: false },
                    label: { type: "string" },
                    name: { type: "string", required: true },
                    onMissing: { type: "string", required: true, enum: ["top", "ntop", "all", "null", "fallback"], default: "null" },
                    pattern: { type: "string", required: true, format: "regex", minLength: 1 },
                    strip: { type: "boolean", required: true, default: true },
                    transform: { type: "array", items: { type: "string", enum: ["totp", "totp-url"] }, required: true, default: [] },
                    trim: { type: "boolean", required: true, default: true },
                },
            },
            required: true,
            default: [
                { name: "secret", label: "Secret", hoist: true, pattern: "^(secret|password):", onMissing: "top" },
                { name: "login", label: "Login", hoist: true, pattern: "^(user|username|login|email):" },
                {
                    name: "totp",
                    label: "TOTP",
                    dynamic: true,
                    fallback: "totp-url",
                    hoist: true,
                    onMissing: "fallback",
                    pattern: "^(otc|otp|totp|2fa|authenticator|(?:two|2)[_\-]factor):(?!.*otpauth://)",
                    transform: ["totp"],
                },
                {
                    name: "totp-url",
                    fallback: "totp-url-raw",
                    onMissing: "fallback",
                    pattern: "^(otc|otp|totp|2fa|authenticator|(?:two|2)[_\-]factor):",
                    transform: ["totp-url"],
                },
                { name: "totp-url-raw", pattern: "^otpauth://totp/.*", strip: false, transform: ["totp-url"] },
            ],
        },
    },
};

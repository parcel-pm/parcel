"mode strict";

import { Helpers } from "./helpers.js";

/**
 * Class for manipulating plaintext data.
 * @since 1.0.0
 */
export class Plaintext {
    #plaintext;
    #config;

    constructor(plaintext, config) {
        this.#plaintext = plaintext;
        this.#config = config;
    }

    /**
     * Get the original plaintext.
     * @since 1.0.0
     * @returns {string}
     */
    getPlaintext() {
        return this.#plaintext;
    }

    /**
     * Get the current config.
     * @since 1.0.0
     * @returns {object}
     */
    getConfig() {
        return this.#config;
    }

    /**
     * Get the value for a given field name.
     * @since 1.0.0
     * @param {string} name - The field name to get the value for
     * @returns {string|null}
     */
    async getValue(name) {
        name = this.normaliseName(name);
        try {
            return await Helpers.getValue(this.#plaintext, this.#config, name);
        } catch (err) {
            let lines = this.#plaintext.split(/\r\n|\n|\r/iu);
            if (!lines.length) return null;
            for (let line of lines) {
                line = line.trim();
                if (line.toLowerCase().startsWith(`${name}:`)) return this.transform(name, line.substring(name.length + 1).trim());
            }
        }
        return null;
    }

    /**
     * Check if a value exists for a given field name.
     * @since 1.0.0
     * @param {string} name - The field name to check for
     * @returns {boolean}
     */
    async hasValue(name) {
        return (await this.getValue(name)) !== null;
    }

    /**
     * Normalise a field name to a known type.
     * @since 1.0.0
     * @param {string} name - The field name to normalise
     * @returns {string}
     */
    normaliseName(name) {
        switch (name) {
            case "login":
            case "user":
            case "username":
                return "login";
            case "email":
                return "email";
            case "secret":
            case "password":
                return "secret";
            case "totp":
            case "otp":
            case "otc":
            case "code":
            case "2fa":
            case "two-factor":
            case "two_factor":
                return "totp";
            case "tel":
            case "number":
            case "phone":
            case "ph":
                return "tel";
            default:
                return name.toLowerCase();
        }
    }

    /**
     * Transform a value based on the field name.
     * @since 1.0.0
     * @param {string} name - The field name to transform for
     * @param {string} value - The value to transform
     * @returns {string}
     */
    transform(name, value) {
        switch (name) {
            case "totp":
                return Helpers.generateTOTP(value);
            default:
                return value;
        }
    }
}

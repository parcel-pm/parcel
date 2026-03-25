"use strict";

export class Helpers {
    /**
     * Convert a base32 string to an ArrayBuffer.
     * @since 1.0.0
     * @param {string} s - The base32 string to convert.
     * @returns {ArrayBuffer} The converted ArrayBuffer.
     */
    static base32ToArrayBuffer(s) {
        const dict = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        s = s.toUpperCase();
        const bytes = new Uint8Array(Math.floor((s.length * 5) / 8));
        let buf = 0,
            j = 0,
            val = 0,
            bits = 0;
        for (let i of s) {
            val = dict.indexOf(i);
            buf = (buf << 5) | (val & 0x1f);
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                bytes[j++] = (buf >> bits) & 0xff;
            }
        }
        return bytes.buffer;
    }

    /**
     * Generate a TOTP token.
     * @since 1.0.0
     * @param {string} secret - The base32 secret key.
     * @param {number} [step=30] - The time step in seconds.
     * @param {number} [digits=6] - The number of digits in the token.
     * @returns {Promise<string>} The generated TOTP token.
     */
    static async generateTOTP(secret, step = 30, digits = 6) {
        const counter = new Uint8Array(8);
        let now = Date.now();
        let epoch = Math.floor(now / (step * 1000));
        let when = epoch * step * 1000;
        let next = (epoch + 1) * step * 1000;

        for (let i = 7; i >= 0; i--) {
            counter[i] = epoch & 0xff;
            epoch >>= 8;
        }

        const key = await crypto.subtle.importKey("raw", Helpers.base32ToArrayBuffer(secret), { name: "HMAC", hash: "SHA-1" }, false, [
            "sign",
        ]);
        const HS = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
        const offset = HS[19] & 0x0f;
        const num = ((HS[offset] & 0x7f) << 24) | (HS[offset + 1] << 16) | (HS[offset + 2] << 8) | HS[offset + 3];

        return {
            value: (num % Math.pow(10, digits)).toString().padStart(digits, "0"),
            refreshAt: next,
            generatedAt: when,
            interval: step * 1000,
        };
    }

    /**
     * Generate a SHA-256 hash of a string.
     * @since 1.0.0
     * @param {string} str - The string to hash.
     * @returns {Promise<string>} The SHA-256 hash of the string.
     */
    static async sha256(s) {
        const data = new TextEncoder().encode(s);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));

        return hashArray.map((i) => i.toString(16).padStart(2, "0")).join("");
    }

    /**
     * Get the appropriate value for the target type
     * @since 1.0.0
     * @param {string} plaintext - The plaintext to fill from
     * @param {object} config - The current parcel config
     * @param {string} type - The target type to use
     */
    static async getValue(plaintext, config, type) {
        config = await config;
        const targetRule = config.targets.reduce((acc, rule) => {
            if (rule.name === type) {
                acc = rule;
            }
            return acc;
        }, false);
        if (!targetRule) throw new Error(`Invalid target type: ${type}`);
        const plaintextLines = plaintext.split(/\r\n|\n|\r/iu);
        const pattern = new RegExp(targetRule.pattern, "ui");
        let fillValue = null;
        for (const line of plaintextLines) {
            if (line.match(pattern)) {
                fillValue = targetRule.strip ? line.replace(pattern, "") : line;
                break;
            }
        }
        if (!fillValue) {
            if (targetRule.onMissing === "top") {
                fillValue = plaintextLines[0];
            } else if (targetRule.onMissing === "ntop") {
                fillValue = plaintext.match(/(?<=\r\n|\n|\r).+/isu)?.[0];
            } else if (targetRule.onMissing === "all") {
                fillValue = plaintext;
            } else if (targetRule.onMissing === "fallback") {
                if (!targetRule.fallback) throw new Error(`No fallback defined for field type: ${type}`);
                return await Helpers.getValue(plaintext, config, targetRule.fallback);
            } else if (targetRule.onMissing === "null") {
                throw new Error(`No value found for field type: ${type}`);
            }
        }

        // trim the value if configured
        if (targetRule.trim) fillValue = fillValue.trim();

        // transform the value if configured
        for (let transform of targetRule?.transform) {
            if (transform === "totp-url") {
                const url = new URL(fillValue);
                const secret = url.searchParams.get("secret");
                if (!secret) throw new Error(`No secret found in TOTP URL: ${fillValue}`);
                fillValue = await Helpers.generateTOTP(secret, url.searchParams.get("period") || 30, url.searchParams.get("digits") || 6);
            } else if (transform === "totp") {
                fillValue = await Helpers.generateTOTP(fillValue);
            }
        }

        return fillValue;
    }

    /**
     * querySelectorAll that also searches inside shadow roots
     * @since 1.0.0
     * @param {string} selector - The CSS selector to search for
     */
    static shadowSelectorAll(selector, root = document) {
        const results = [];
        results.push(...root.querySelectorAll(selector));
        const shadowHosts = root.querySelectorAll("[is-shadow]");
        for (let host of shadowHosts) {
            if (host.shadowRoot) {
                results.push(...Helpers.shadowSelectorAll(selector, host.shadowRoot));
            }
        }
        return results;
    }

    /**
     * querySelector that also searches inside shadow roots
     * @since 1.0.0
     * @param {string} selector - The CSS selector to search for
     */
    static shadowSelector(selector, root = document) {
        const result = root.querySelector(selector);
        if (result) return result;
        const shadowHosts = root.querySelectorAll("[is-shadow]");
        for (let host of shadowHosts) {
            if (host.shadowRoot) {
                const shadowResult = Helpers.shadowSelector(selector, host.shadowRoot);
                if (shadowResult) return shadowResult;
            }
        }
        return null;
    }
}

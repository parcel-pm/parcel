"use strict";

/**
 * Static helper utilities that are used across multiple calling classes.
 * @since 1.0.0
 */
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
     * @returns {Promise<{value: string, refreshAt: number, generatedAt: number, interval: number}>} The generated TOTP token and timing metadata. Timestamps are in milliseconds.
     * @throws {TypeError|DOMException} If the SubtleCrypto interface is unavailable or `importKey`/`sign` rejects (propagated from the underlying WebCrypto calls).
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
     * @param {string} s - The string to hash.
     * @returns {Promise<string>} The SHA-256 hash of the string.
     * @throws {Error} If the Web Crypto API is unavailable.
     */
    static async sha256(s) {
        if (!crypto.subtle) throw new Error("Crypto API is not available in this environment.");
        const data = new TextEncoder().encode(s);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));

        return hashArray.map((i) => i.toString(16).padStart(2, "0")).join("");
    }

    /**
     * Normalise a field name to the canonical target name defined in the config
     * @since 1.0.0
     * @param {object} config - The current parcel config
     * @param {string} name - The field name to normalise
     * @returns {string}
     */
    static normaliseName(config, name) {
        name = name.toLowerCase();
        for (const target of config.targets?.concat(config.additionalTargets || []) || []) {
            if (!target.pattern) continue;
            const pattern = new RegExp(target.pattern, "ui");
            if (pattern.test(`${name}:`)) return target.name;
        }
        return name;
    }

    /**
     * Get the appropriate value for the target type.
     * @since 1.0.0
     * @param {string} plaintext - The plaintext to fill from.
     * @param {object} config - The current parcel config.
     * @param {string} type - The target type to use.
     * @returns {Promise<string|object|null>} The resolved value, or a TOTP metadata object if a TOTP transform was applied.
     * @throws {Error} If the target type is invalid, no value is found, the target pattern is malformed, a fallback is misconfigured, or a TOTP transform fails.
     */
    static async getValue(plaintext, config, type) {
        config = await config;
        type = Helpers.normaliseName(config, type);
        const targetRule = config.targets.concat(config.additionalTargets || []).reduce((acc, rule) => {
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
            } else if (targetRule.onMissing === "naked-top" && !plaintextLines[0].match(/^[a-z0-9_\-]+:\s+/iu)) {
                fillValue = plaintextLines[0];
            } else if (targetRule.onMissing === "ntop") {
                fillValue = plaintext.match(/(?<=\r\n|\n|\r).+/isu)?.[0];
            } else if (targetRule.onMissing === "all") {
                fillValue = plaintext;
            } else if (targetRule.onMissing === "fallback") {
                if (!targetRule.fallback) throw new Error(`No fallback defined for field type: ${type}`);
                try {
                    let value = await Helpers.getValue(plaintext, config, targetRule.fallback);
                    if (!targetRule.fallbackMatch) return value;
                    let matches = value.match(new RegExp(targetRule.fallbackMatch, "ui"));
                    if (!matches) throw new Error(`Unable to extract fallback match for field type: ${type}`);
                    return matches[1];
                } catch (err) {
                    // If the fallback fails, we should throw a new error from here rather than exposing the fallback error
                    console.info(err);
                    throw new Error(`No value found for field type: ${type}`);
                }
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
     * querySelectorAll that also searches inside shadow roots.
     * @since 1.0.0
     * @param {string} selector - The CSS selector to search for.
     * @param {ParentNode} [root=document] - The root to search from.
     * @returns {Element[]} All matching elements, including those inside shadow roots.
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
     * querySelector that also searches inside shadow roots.
     * @since 1.0.0
     * @param {string} selector - The CSS selector to search for.
     * @param {ParentNode} [root=document] - The root to search from.
     * @returns {?Element} The first matching element, or null if none is found.
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

    /**
     * Get luma for an RGB hex colour.
     * @since 1.0.0
     * @param {string} hex - The RGB hex colour to get the luminance for.
     * @returns {number} The luminance of the colour (0-1). Returns `NaN` if `hex` is not exactly six hexadecimal digits.
     */
    static getLuma(hex) {
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;

        const linearR = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
        const linearG = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
        const linearB = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

        return 0.2126 * linearR + 0.7152 * linearG + 0.0722 * linearB;
    }
}

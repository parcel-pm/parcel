/**
 * List of default URL scopes
 * @type {object[]}
 * @since 1.0.8
 */
export const defaultScope = [
    { match: "^https://", features: ["context", "fill", "http", "passkey"] },
    { match: "^http://", features: ["context", "fill", "http"] },
    { match: "^(blob|file|ftp)://", features: ["blacklist", "global"] },
    { match: "^(chrome|edge|about):", features: ["blacklist", "global"] },
    { match: "^(chrome-extension|moz-extension)://", features: ["blacklist", "global"] },
];

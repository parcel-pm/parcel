"use strict";

/**
 * List of valid targets.
 * @since 1.0.0
 */
export const targetSelectors = [
    // type: login
    { selector: "input[autocomplete~=username i]", type: "login" },
    { selector: "input[autocomplete~=email i]", type: "login" },
    { selector: "input[type=email i]", type: "login" },
    { selector: "input[name^=user i]", type: "login" },
    { selector: "input[name^=tel i]", type: "login" },
    { selector: "input[name$=username i]", type: "login" },
    { selector: "input[id$=name i]", type: "login" },

    // type: secret
    { selector: "input[autocomplete~=current-password i]", type: "secret" },
    { selector: "input[type=password i]", type: "secret" },

    // type: totp
    { selector: "input[autocomplete~=one-time-code i]", type: "totp" },
    { selector: "input[name$=otp i]", type: "totp" },

    // type: blacklist
    { selector: "input[example=blacklist i]", type: "blacklist", host: ["example.com", "example.org"] },
];

"use strict";

/**
 * List of valid targets.
 * @since 0.1.2
 */
export const targetSelectors = [
    { selector: "input[type=email i]", type: "login" },
    { selector: "input[name^=user i]", type: "login" },
    { selector: "input[name^=tel i]", type: "login" },
    { selector: "input[autocomplete=username i]", type: "login" },
    { selector: "input[autocomplete=email i]", type: "login" },
    { selector: "input[name$=username i]", type: "login" },
    { selector: "input[type=password i]", type: "secret" },
    { selector: "input[autocomplete=current-password i]", type: "secret" },
    { selector: "input[example=blacklist i]", type: "blacklist", host: ["example.com", "example.org"] },
    { selector: "input[example=totp i]", type: "totp" },
];

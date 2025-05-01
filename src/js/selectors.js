"use strict";

/**
 * List of valid targets.
 * @since 1.0.0
 */
export var targetSelectors = [
    // type: login
    { selector: "input[autocomplete~=username i]", type: "login" },
    { selector: "input[autocomplete~=email i]", type: "login" },
    { selector: "input[type=email i]", type: "login" },
    { selector: "input[type=tel i]", type: "login" },
    { selector: "input[type=number i]", type: "login" },

    // type: secret
    { selector: "input[autocomplete~=current-password i]", type: "secret" },
    { selector: "input[type=password i]", type: "secret" },
    { selector: "input[name=password i]", type: "secret" },
    { selector: "input[id=password i]", type: "secret" },
    { selector: "input[class~=password i]", type: "secret" },

    // type: totp
    { selector: "input[autocomplete~=one-time-code i]", type: "totp" },
    { selector: "input[name$=otp i]", type: "totp" },

    // type: blacklist
    { selector: "input[example=blacklist i]", type: "blacklist", host: ["example.com", "example.org"] },
];

for (let s of ["login", "user", "username", "email", "alias", "name"]) {
    targetSelectors.push({ selector: `input[name*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[id*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[class*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[placeholder*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[title*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[aria-label*=${s} i]`, type: "login" });
}

for (let s of ["login", "log-in", "log_in", "signin", "sign-in", "sign_in", "submit", "submit-login", "continue"]) {
    for (let t of ["input[type=button]", "button"]) {
        targetSelectors.push({ selector: `${t}[name*=${s} i]`, type: "submit" });
        targetSelectors.push({ selector: `${t}[id*=${s} i]`, type: "submit" });
        targetSelectors.push({ selector: `${t}[class*=${s} i]`, type: "submit" });
        targetSelectors.push({ selector: `${t}[placeholder*=${s} i]`, type: "submit" });
        targetSelectors.push({ selector: `${t}[title*=${s} i]`, type: "submit" });
        targetSelectors.push({ selector: `${t}[aria-label*=${s} i]`, type: "submit" });
    }
}

"use strict";

/**
 * List of valid targets.
 * @since 1.0.0
 */
export var targetSelectors = [
    // type: blacklist
    { selector: "input[example=blacklist i]", type: "blacklist", host: ["example.com", "example.org"] },

    // type: secret
    { selector: "input[autocomplete~=current-password i]", type: "secret" },
    { selector: "input[type=password i]", type: "secret" },
    { selector: "input[name=password i]", type: "secret" },
    { selector: "input[id=password i]", type: "secret" },
    { selector: "input[type=pin i]", type: "secret" },
    { selector: "input[name=pin i]", type: "secret" },
    { selector: "input[id=pin i]", type: "secret" },
    { selector: "input[class~=password i]", type: "secret" },
    { selector: "input[class~=pin i]", type: "secret" },
    { selector: "input[placeholder=password i]", type: "secret" },

    // type: totp
    { selector: "input[autocomplete~=one-time-code i]", type: "totp" },
    { selector: "input[name$=otp i]", type: "totp" },
    { selector: "input[name$=otc i]", type: "totp" },
    { selector: "input[name$=code i]", type: "totp" },
    { selector: "input[name$=otpcode i]", type: "totp" },
    { selector: "input[name$='2fa' i]", type: "totp" },
    { selector: "input[name$=two-factor i]", type: "totp" },
    { selector: "input[name$=two_factor i]", type: "totp" },

    // type: login
    { selector: "input[autocomplete~=username i]", type: "login" },
    { selector: "input[aria-label=username i]", type: "login" },
    { selector: "input[autocomplete~=email i]", type: "login" },
    { selector: "input[type=email i]", type: "login" },
    { selector: "input[type=tel i]", type: "login" },
    { selector: "input[type=number i]", type: "login" },
    { selector: "input[id=vrNetKey i]", type: "login" }, // various German banks
];

for (let s of ["login", "user", "username", "email"]) {
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

for (let s of ["new", "confirm", "change"]) {
    for (let t of ["password", "pass", "secret"]) {
        targetSelectors.push({ selector: `input[name*=${s} i][name*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[id*=${s} i][id*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[class*=${s} i][class*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[placeholder*=${s} i][placeholder*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[title*=${s} i][title*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[aria-label*=${s} i][aria-label*=${t} i]`, type: "blacklist" });
    }
}

"use strict";

/**
 * Default CSS selector rules used to identify fill targets.
 * @type {Array<{selector: string, type: string, host?: string[], relatedOnly?: boolean}>}
 * @since 1.0.0
 */
export var targetSelectors = [
    // type: blacklist
    { selector: "input[example=blacklist i]", type: "blacklist", host: ["example.com", "example.org"] },
    { selector: "input[autocomplete~=new-password i]", type: "blacklist" },
    { selector: "input[type=search i]", type: "blacklist" },
    { selector: "input[type=hidden i]", type: "blacklist" },

    // type: related
    { selector: "form", type: "aggregate" },
    { selector: "#form", type: "aggregate" },

    // type: secret
    { selector: "input[autocomplete~=current-password i]", type: "secret" },
    { selector: "input[type=password i]", type: "secret" },
    { selector: "input[name=password i]", type: "secret" },
    { selector: "input[id=password i]", type: "secret" },
    { selector: "input[name~=pwd i]", type: "secret" },
    { selector: "input[type=pin i]", type: "secret" },
    { selector: "input[name=pin i]", type: "secret" },
    { selector: "input[id=pin i]", type: "secret" },
    { selector: "input[class~=password i]", type: "secret" },
    { selector: "input[class~=pwd i]", type: "secret" },
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
    { selector: "input[id^=IDToken i]", type: "login" }, // spark.co.nz
    { selector: "form[class*=login i] input[name=name i]", type: "login" }, // nz-cms.nz
    { selector: "#login input#name, #login input.name, #login input[name*=name i]", type: "login" }, // Mikrotik + various
    { selector: "form[action*=login i] input[name=name i]", type: "login" }, // Supermicro IPMI
    { selector: "select[name=user_level i]", type: "login", relatedOnly: true }, // IBM TS3100

    // type: submit
    { selector: "input[type=submit i]", type: "submit" },
    { selector: "button[type=submit i]", type: "submit" },

    // type: card
    { selector: "input[autocomplete~=cc-number i]", type: "card" },

    // type: cardholder
    { selector: "input[autocomplete~=cc-name i]", type: "cardholder", relatedOnly: true },

    // type: cardexp
    { selector: "input[autocomplete~=cc-exp i]", type: "cardexp" },
    { selector: "input[placeholder='MM/YY' i]", type: "cardexp", relatedOnly: true },

    // type: cardexp-month
    { selector: "input[autocomplete~=cc-exp-month i]", type: "cardexp-month" },

    // type: cardexp-year
    { selector: "input[autocomplete~=cc-exp-year i]", type: "cardexp-year" },

    // type: cardcsc
    { selector: "input[autocomplete~=cc-csc i]", type: "cardcsc" },
];

// bulk aggregation selectors
for (let u of ["login", "sign", "auth", "account", "user"]) {
    for (let t of ["div", "section", "p", "table"]) {
        for (let s of ["class", "id"]) {
            targetSelectors.push({ selector: `${t}[${s}*=${u} i]`, type: "aggregate" });
        }
    }
}

// bulk login selectors
for (let s of ["login", "user", "username", "email"]) {
    targetSelectors.push({ selector: `input[name*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[id*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[class*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[placeholder*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[title*=${s} i]`, type: "login" });
    targetSelectors.push({ selector: `input[aria-label^=${s} i]`, type: "login" });
}

// bulk submit button selectors
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

// bulk card selectors
for (let s of ["name", "id", "class", "placeholder", "title", "aria-label"]) {
    targetSelectors.push({ selector: `input[${s}^=ccn i]`, type: "card" });
    targetSelectors.push({ selector: `input[${s}=card i]`, type: "card" });
    targetSelectors.push({ selector: `input[${s}^=card i][${s}*=num i]`, type: "card" });
    targetSelectors.push({ selector: `input[${s}^=cc i][${s}*=num i]`, type: "card" });
    targetSelectors.push({ selector: `input[${s}^=credit i][${s}*=card i]`, type: "card" });
    targetSelectors.push({ selector: `input[${s}^=debit i][${s}*=card i]`, type: "card" });
}

// bulk cardholder selectors
for (let s of ["name", "id", "class", "placeholder", "title", "aria-label"]) {
    targetSelectors.push({ selector: `input[${s}^=name i]`, type: "card", relatedOnly: true });
    targetSelectors.push({ selector: `input[${s}^=card i][${s}*=holder i]`, type: "cardholder" });
    targetSelectors.push({ selector: `input[${s}^=cc i][${s}*=name i]`, type: "cardholder" });
    targetSelectors.push({ selector: `input[${s}^=holder i]`, type: "cardholder" });
}

// bulk cardexp selectors
for (let s of ["name", "id", "class", "placeholder", "title", "aria-label"]) {
    targetSelectors.push({ selector: `input[${s}^=exp i]`, type: "cardexp" });
    targetSelectors.push({ selector: `input[${s}^=card i][${s}*=exp i]`, type: "cardexp" });
}

// bulk cardexp-month selectors
for (let s of ["name", "id", "class", "placeholder", "title", "aria-label"]) {
    targetSelectors.push({ selector: `input[${s}^=exp i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `input[${s}^=expiry i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `input[${s}^=expiration i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `input[${s}^=cc i][${s}*=exp i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `input[${s}^=card i][${s}*=exp i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `select[${s}^=exp i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `select[${s}^=expiry i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `select[${s}^=expiration i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `select[${s}^=cc i][${s}*=exp i][${s}*=mon i]`, type: "cardexp-month" });
    targetSelectors.push({ selector: `select[${s}^=card i][${s}*=exp i][${s}*=mon i]`, type: "cardexp-month" });
}

// bulk cardexp-year selectors
for (let s of ["name", "id", "class", "placeholder", "title", "aria-label"]) {
    targetSelectors.push({ selector: `input[${s}^=exp i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `input[${s}^=expiry i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `input[${s}^=expiration i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `input[${s}^=cc i][${s}*=exp i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `input[${s}^=card i][${s}*=exp i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `select[${s}^=exp i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `select[${s}^=expiry i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `select[${s}^=expiration i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `select[${s}^=cc i][${s}*=exp i][${s}*=year i]`, type: "cardexp-year" });
    targetSelectors.push({ selector: `select[${s}^=card i][${s}*=exp i][${s}*=year i]`, type: "cardexp-year" });
}

// bulk cardcsc selectors
for (let s of ["name", "id", "class", "placeholder", "title", "aria-label"]) {
    for (let t of ["csc", "cvv", "cvc"]) targetSelectors.push({ selector: `input[${s}^=${t} i]`, type: "cardcsc" });
    targetSelectors.push({ selector: `input[${s}^=security i][${s}*=code i]`, type: "cardcsc", relatedOnly: true });
    targetSelectors.push({ selector: `input[${s}^=code i]`, type: "cardcsc", relatedOnly: true });
    targetSelectors.push({ selector: `input[${s}^=card i][${s}*=security i][${s}*=code i]`, type: "cardcsc" });
}

// exclude password change fields
for (let s of ["new", "confirm", "change", "edit"]) {
    for (let t of ["password", "pass", "secret"]) {
        targetSelectors.push({ selector: `input[name*=${s} i][name*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[id*=${s} i][id*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[class*=${s} i][class*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[placeholder*=${s} i][placeholder*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[title*=${s} i][title*=${t} i]`, type: "blacklist" });
        targetSelectors.push({ selector: `input[aria-label*=${s} i][aria-label*=${t} i]`, type: "blacklist" });
    }
}

// exclude search fields
for (let s of ["search", "find", "lookup", "query"]) {
    targetSelectors.push({ selector: `input[name*=${s} i]`, type: "blacklist" });
    targetSelectors.push({ selector: `input[id*=${s} i]`, type: "blacklist" });
    targetSelectors.push({ selector: `input[class*=${s} i]`, type: "blacklist" });
    targetSelectors.push({ selector: `input[placeholder*=${s} i]`, type: "blacklist" });
    targetSelectors.push({ selector: `input[title*=${s} i]`, type: "blacklist" });
    targetSelectors.push({ selector: `input[aria-label*=${s} i]`, type: "blacklist" });
}

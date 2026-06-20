"use strict";

/**
 * List of default targets.
 * @type {object[]}
 * @since 1.0.0
 */
export const defaultTargets = [
    {
        name: "secret",
        label: "Secret",
        hoist: true,
        highlightSpecial: true,
        pattern: "^(secret|password):",
        onMissing: "naked-top",
        related: ["login", "totp"],
    },
    { name: "login", label: "Login", hoist: true, pattern: "^(user|username|login|email):", related: ["secret", "totp"] },
    {
        name: "totp",
        label: "TOTP",
        dynamic: true,
        fallback: "totp-url",
        hoist: true,
        onMissing: "fallback",
        pattern: "^(otc|otp|totp|code|2fa|authenticator|(?:two|2)[_\-]factor):(?!.*otpauth://)",
        related: ["login", "secret"],
        transform: ["totp"],
    },
    {
        name: "totp-url",
        fallback: "totp-url-raw",
        onMissing: "fallback",
        pattern: "^(otc|otp|totp|code|2fa|authenticator|(?:two|2)[_\-]factor):",
        transform: ["totp-url"],
    },
    { name: "totp-url-raw", pattern: "^otpauth://totp/.*", strip: false, transform: ["totp-url"] },
    {
        name: "card",
        label: "Card",
        hoist: true,
        pattern: "^(card|card-number|ccn|credit-?card|debit-?card|card-?num):",
        related: ["cardholder", "cardexp", "cardexp-month", "cardexp-year", "cardcsc"],
    },
    {
        name: "cardholder",
        label: "Name",
        hoist: true,
        pattern: "^((cc-?)?name|(card-?)?holder):",
        related: ["card", "cardexp", "cardexp-month", "cardexp-year", "cardcsc"],
    },
    {
        name: "cardexp",
        label: "Expiry",
        hoist: true,
        pattern: "^((cc|card)[_-]?)?(exp(iry)?):",
        related: ["card", "cardholder", "cardcsc"],
    },
    {
        name: "cardexp-month",
        fallback: "cardexp",
        fallbackMatch: "^([0-9]{1,2})",
        onMissing: "fallback",
        pattern: "^((cc|card)[_-]?)?exp(iry)?[-_]?mon(th)?:",
        related: ["card", "cardholder", "cardexp-year", "cardcsc"],
    },
    {
        name: "cardexp-year",
        fallback: "cardexp",
        fallbackMatch: "/([0-9]{1,2})",
        onMissing: "fallback",
        pattern: "^((cc|card)[_-]?)?exp(iry)?[-_]?(year|yr):",
        related: ["card", "cardholder", "cardexp-month", "cardcsc"],
    },
    {
        name: "cardcsc",
        label: "CSC",
        hoist: true,
        pattern: "^((card|cc)[_-]?)?(csc|cvv|cvc):",
        related: ["card", "cardholder", "cardexp", "cardexp-month", "cardexp-year"],
    },
    { name: "tel", pattern: "^(tel|phone|number|ph):", related: [] },
];

"use strict";

import { test, describe, before } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import nodeCrypto from "node:crypto";
import { limits, ConfigSchema } from "../src/js/schema.js";
import { createChromeMock } from "./chrome-api-mock.js";

function settleAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeValidConfig(overrides = {}) {
    return {
        modified: 1,
        passdir: "/home/test/.password-store",
        rules: [{ pattern: "^test/.*$", class: "login", color: "ff0000", ignore: false }],
        cacheTTL: 10,
        clipboardTimeout: 60,
        decryptTimeout: 60,
        auditDecrypt: true,
        hostPinned: true,
        decryptBucket: ConfigSchema.properties.decryptBucket.default,
        decryptRate: ConfigSchema.properties.decryptRate.default,
        suppressWarnings: [],
        disableContextPopup: false,
        fillRelated: true,
        historyLength: 40,
        saveHistory: true,
        targets: [],
        additionalSelectors: [],
        ...overrides,
    };
}

let scenario = 0;

/**
 * Load a fresh popup instance against a fresh JSDOM and chrome mock, answering
 * its config request with the given config.
 * @param {object} config - The config to serve to the popup.
 * @returns {Promise<Document>} The popup document for banner assertions.
 */
async function loadPopup(config) {
    const popupHtml = readFileSync("src/html/popup.html", "utf8");
    const dom = new JSDOM(popupHtml, { url: "http://localhost/", pretendToBeVisual: true });
    const window = dom.window;
    const document = window.document;

    const origAttachShadow = window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow = function (opts) {
        const root = origAttachShadow.call(this, opts);
        Object.defineProperty(this, "shadowRoot", { value: root, configurable: true });
        return root;
    };

    globalThis.window = window;
    globalThis.document = document;
    globalThis.Event = window.Event;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.MouseEvent = window.MouseEvent;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    try {
        globalThis.navigator = window.navigator;
    } catch {
        Object.defineProperty(globalThis, "navigator", { value: window.navigator, writable: true, configurable: true });
    }
    globalThis.location = window.location;
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.alert = () => {};
    window.close = () => {};
    window.Element.prototype.scrollIntoView = function () {};

    Object.defineProperty(globalThis, "crypto", {
        value: {
            randomUUID: () => nodeCrypto.randomUUID(),
            get subtle() {
                return {
                    async digest(algorithm, data) {
                        const hash = nodeCrypto.createHash(
                            typeof algorithm === "string" ? algorithm.toLowerCase().replace("-", "") : "sha256",
                        );
                        hash.update(Buffer.from(data));
                        return hash.digest().buffer;
                    },
                };
            },
        },
        configurable: true,
        writable: true,
    });

    const mock = createChromeMock({ baseUrl: "file://" + process.cwd() + "/src/" });
    mock.installChrome();
    mock.installBrowserPolyfills();
    mock.setCurrentTab({ id: 42, url: "https://example.com/login", cookieStoreId: undefined });

    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "popup") return;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") receiver.postMessage({ action: "config", config });
        });
    });

    await import(`../src/js/popup.js?warnings=${++scenario}`);
    await settleAsync();
    return document;
}

/**
 * Get the text of the current security-warning banners.
 * @param {Document} document - The popup document.
 * @returns {string[]} Banner texts, topmost first.
 */
function warningTexts(document) {
    return [...document.querySelectorAll("p.warning")].map((p) => p.textContent);
}

before(() => {
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };
});

describe("Popup security warnings", { concurrency: false }, () => {
    test("no warnings for the default rate limits", async () => {
        const texts = warningTexts(await loadPopup(makeValidConfig()));
        assert.deepStrictEqual(texts, []);
    });

    test("each warning is shown for its triggering config", async () => {
        const cases = [
            ["host-unpinned", "host script hash is not pinned", { hostPinned: false }],
            ["audit-disabled", "audit logging is disabled", { auditDecrypt: false }],
            ["rate-limit-disabled", "rate limiting is disabled", { decryptBucket: 0 }],
            ["rate-limit-disabled", "rate limiting is disabled", { decryptRate: 0 }],
            // disabled takes precedence over high
            ["rate-limit-disabled", "rate limiting is disabled", { decryptBucket: 0, decryptRate: 1 }],
            ["rate-limit-high", "rate limit is set quite high", { decryptBucket: limits.rateBucketThreshold + 1 }],
            ["rate-limit-high", "rate limit is set quite high", { decryptRate: limits.rateRefillThreshold + 0.000001 }],
        ];
        for (const [id, fragment, overrides] of cases) {
            const texts = warningTexts(await loadPopup(makeValidConfig(overrides)));
            assert.strictEqual(texts.length, 1, `expected only '${id}' for ${JSON.stringify(overrides)}`);
            assert.match(texts[0], new RegExp(fragment), `wrong banner for ${JSON.stringify(overrides)}`);
            assert.match(texts[0], new RegExp(`'${id}'`), `wrong banner for ${JSON.stringify(overrides)}`);
        }
    });

    test("warnings are individually suppressable via suppressWarnings", async () => {
        const texts = warningTexts(
            await loadPopup(makeValidConfig({ hostPinned: false, auditDecrypt: false, suppressWarnings: ["host-unpinned"] })),
        );
        assert.strictEqual(texts.length, 1);
        assert.match(texts[0], /'audit-disabled'/);
    });

    test("active warnings stack in severity order", async () => {
        const texts = warningTexts(
            await loadPopup(makeValidConfig({ hostPinned: false, auditDecrypt: false, decryptBucket: limits.rateBucketThreshold + 1 })),
        );
        assert.strictEqual(texts.length, 3);
        assert.match(texts[0], /'host-unpinned'/);
        assert.match(texts[1], /'rate-limit-high'/);
        assert.match(texts[2], /'audit-disabled'/);
    });
});

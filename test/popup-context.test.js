"use strict";

import { test, describe, before } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import nodeCrypto from "node:crypto";
import { createChromeMock } from "./chrome-api-mock.js";

function settleAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function nextMessage(port, action = null, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for message${action ? ` action=${action}` : ""}`)), timeout);
        const listener = (msg) => {
            if (action === null || msg.action === action) {
                clearTimeout(timer);
                port.onMessage.removeListener(listener);
                resolve(msg);
            }
        };
        port.onMessage.addListener(listener);
    });
}

function makeValidConfig() {
    return {
        modified: 1,
        passdir: "/home/test/.password-store",
        rules: [{ pattern: "^test/.*$", class: "login", color: "ff0000", ignore: false }],
        cacheTTL: 10,
        decryptTimeout: 60,
        auditDecrypt: false,
        disableContextPopup: false,
        fillRelated: true,
        historyLength: 40,
        saveHistory: true,
        targets: [
            {
                name: "login",
                pattern: "^(user|username|login|email):",
                related: ["secret"],
                onMissing: "null",
                strip: true,
                transform: [],
                trim: true,
                hoist: true,
                label: "User",
            },
            {
                name: "secret",
                pattern: "^(secret|password):",
                related: [],
                onMissing: "null",
                strip: true,
                transform: [],
                trim: true,
                hoist: true,
                label: "Pass",
            },
        ],
        additionalSelectors: [],
        showDelegateTooltips: false,
    };
}

let document, window, mock, tabPortReceiver, popupPortReceiver;

before(async () => {
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };

    const popupHtml = readFileSync("src/html/popup.html", "utf8");
    const dom = new JSDOM(popupHtml, { url: "http://localhost/?token=inline-token&frameId=0", pretendToBeVisual: true });
    window = dom.window;
    document = window.document;

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
    window.focus = () => {};
    window.Element.prototype.scrollIntoView = function () {};

    Object.defineProperty(globalThis, "crypto", {
        value: {
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

    mock = createChromeMock({ baseUrl: "file://" + process.cwd() + "/src/" });
    mock.installChrome();
    mock.installBrowserPolyfills();
    mock.setCurrentTab({ id: 42, url: "https://example.com/login", cookieStoreId: undefined });

    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "popup") return;
        popupPortReceiver = receiver;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") receiver.postMessage({ action: "config", config: makeValidConfig() });
        });
    });

    const origTabsConnect = chrome.tabs.connect.bind(chrome.tabs);
    chrome.tabs.connect = function (tabId, info = {}) {
        const caller = origTabsConnect(tabId, info);
        tabPortReceiver = mock.findTabPort(tabId, info.frameId ?? 0);
        return caller;
    };

    await import(`../src/js/popup.js?context=${Date.now()}`);
    await settleAsync();
});

describe("Context popup", { concurrency: false }, () => {
    async function sendDetail(plaintext) {
        popupPortReceiver.postMessage({ action: "plaintext", intent: "detail", plaintext });
        await settleAsync();
    }

    test("does not focus search input on load", () => {
        assert.notStrictEqual(document.activeElement, document.getElementById("searchPattern"));
    });

    test("focus-popup message focuses selected search input", async () => {
        const search = document.getElementById("searchPattern");
        tabPortReceiver.postMessage({ action: "focus-popup" });
        await settleAsync();
        assert.strictEqual(document.activeElement, search);
    });

    test("shift-tab from search requests target focus", async () => {
        const search = document.getElementById("searchPattern");
        search.focus();
        const focusTargetPromise = nextMessage(tabPortReceiver, "focus-target", 3000);
        search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
        const msg = await focusTargetPromise;
        assert.strictEqual(msg.action, "focus-target");
    });

    test("typing a line number fills the matching plaintext line value", async () => {
        await sendDetail("user: alice\nsecret: hunter2\nurl: https://example.com");

        const detail = document.querySelector("parcel-detail");
        assert.ok(detail, "parcel-detail element created");
        const lines = detail.shadowRoot.querySelectorAll("parcel-plaintext-line");
        assert.strictEqual(lines.length, 3, "three plaintext lines rendered");

        document.activeElement?.blur?.();

        const fillValuePromise = nextMessage(tabPortReceiver, "fill-value", 3000);
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
        const msg = await fillValuePromise;
        assert.strictEqual(msg.action, "fill-value");
        assert.strictEqual(msg.value, "hunter2");

        detail.remove();
    });

    test("with fewer than ten lines the fill is immediate", async () => {
        await sendDetail("user: alice\nsecret: hunter2");

        const detail = document.querySelector("parcel-detail");
        assert.ok(detail, "parcel-detail element created");

        document.activeElement?.blur?.();

        let msg = null;
        const listener = (m) => {
            if (m?.action === "fill-value") msg = m;
        };
        tabPortReceiver.onMessage.addListener(listener);
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
        // Yield once so any synchronously-queued microtasks/timers settle
        await new Promise((resolve) => setTimeout(resolve, 0));
        tabPortReceiver.onMessage.removeListener(listener);
        assert.ok(msg, "fill-value sent immediately for a sub-ten line count");
        assert.strictEqual(msg.value, "hunter2");

        detail.remove();
    });

    test("out-of-range line number does nothing", async () => {
        await sendDetail("user: bob\nsecret: s3cret");

        const detail = document.querySelector("parcel-detail");
        assert.ok(detail, "parcel-detail element created");

        document.activeElement?.blur?.();

        let received = false;
        const listener = (msg) => {
            if (msg?.action === "fill-value") received = true;
        };
        tabPortReceiver.onMessage.addListener(listener);
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "9", bubbles: true, cancelable: true }));
        // Wait beyond the fill timeout for an out-of-range index (no fill expected)
        await new Promise((resolve) => setTimeout(resolve, 1000));
        tabPortReceiver.onMessage.removeListener(listener);
        assert.strictEqual(received, false, "no fill-value sent for out-of-range line number");

        detail.remove();
    });

    test("digit input fills even when focus is on the search input", async () => {
        await sendDetail("user: carol\nsecret: p@ss");

        const detail = document.querySelector("parcel-detail");
        assert.ok(detail, "parcel-detail element created");

        const search = document.getElementById("searchPattern");
        search.focus();

        const fillValuePromise = nextMessage(tabPortReceiver, "fill-value", 3000);
        search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
        const msg = await fillValuePromise;
        assert.strictEqual(msg.action, "fill-value");
        assert.strictEqual(msg.value, "carol");

        detail.remove();
    });

    test("multi-digit line number selects the correct line", async () => {
        const plaintext = Array.from({ length: 12 }, (_, i) => `field${i + 1}: value${i + 1}`).join("\n");
        await sendDetail(plaintext);

        const detail = document.querySelector("parcel-detail");
        assert.ok(detail, "parcel-detail element created");
        const lines = detail.shadowRoot.querySelectorAll("parcel-plaintext-line");
        assert.strictEqual(lines.length, 12, "twelve plaintext lines rendered");

        document.activeElement?.blur?.();

        const fillValuePromise = nextMessage(tabPortReceiver, "fill-value", 3000);
        for (const ch of "10") {
            window.dispatchEvent(new window.KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        }
        const msg = await fillValuePromise;
        assert.strictEqual(msg.action, "fill-value");
        assert.strictEqual(msg.value, "value10");

        detail.remove();
    });
});

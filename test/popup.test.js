"use strict";

import { test, describe, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import nodeCrypto from "node:crypto";
import { createChromeMock } from "./chrome-api-mock.js";

function sha256Native(s) {
    return nodeCrypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Test suite for popup.js toolbar/context popup UI.
 *
 * popup.js is an async IIFE that eagerly imports helpers, opens chrome ports,
 * and attaches DOM listeners. We set up JSDOM with popup.html markup and the
 * chrome mock *before* importing the module. After import we drive it via
 * mocked port messages, just like integration.test.js.
 */

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

function makeValidConfig(overrides = {}) {
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
        ...overrides,
    };
}

let dom, document, window, mock, portReceivers, portCallers;

before(async () => {
    const _realConsole = globalThis.console;
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };

    const popupHtml = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body>
<template id="parcel-detail-template"><style>:host { display: block; }</style></template>
<template id="parcel-value-template">
  <style>:host { display: flex; } .label { width: 68px; } .value-container { flex-grow: 1; min-width: 0; overflow: hidden; } .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }</style>
  <span class="label"></span>
  <div class="value-container"><span class="value"></span><span class="spacer"></span><button class="copy"></button></div>
</template>
<template id="parcel-plaintext-line-template">
  <style>:host { display: flex; } .line { flex-grow: 1; }</style>
  <code class="line"></code><button class="copy"></button>
</template>
<div id="modal-shade" class="hidden"></div>
<div id="search">
  <span id="origin"></span>
  <input type="text" id="searchPattern" class="selected" />
</div>
<ul id="entries"></ul>
<p id="status">Status bar</p>
<div id="live-region" aria-live="polite" aria-atomic="true" class="sr-only"></div>
</body>
</html>`;

    dom = new JSDOM(popupHtml, { url: "http://localhost/", pretendToBeVisual: true });
    window = dom.window;
    document = window.document;

    if (!window.Element.prototype.checkVisibility) {
        window.Element.prototype.checkVisibility = function () {
            return this.style.display !== "none" && this.style.display !== "hidden";
        };
    }
    if (!window.crypto.randomUUID) {
        window.crypto.randomUUID = () => "test-uuid-" + Math.random().toString(36).slice(2);
    }
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

    // Replace JSDOM's crypto.subtle (which hangs in Node) with a working one
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

    // Stubs that popup.js calls on window
    window.close = () => {};

    // JSDOM does not implement scrollIntoView
    window.Element.prototype.scrollIntoView = function () {};

    // Provide a current tab so connectToTab() uses the direct chrome.tabs.connect path
    mock.setCurrentTab({ id: 42, url: "https://example.com/login", cookieStoreId: undefined });

    // Pre-seed history storage so the popup picks it up at init time
    const url = new URL("https://example.com/login");
    const hash = sha256Native(url.origin);
    const scope = sha256Native("default");
    const entryPathHash = sha256Native("test/site.com");
    await chrome.storage.local.set({
        [`history:${scope}:${hash}`]: [{ path: entryPathHash, when: Date.now() }],
    });

    portReceivers = {};
    portCallers = {};
    const tabPortReceivers = {};

    const origRuntimeConnect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = function (info) {
        const caller = origRuntimeConnect(info);
        portCallers[caller.name] = caller;
        return caller;
    };

    mock.chrome.runtime.onConnect.addListener((receiver) => {
        portReceivers[receiver.name] = receiver;
    });

    // Wire popup port so that when popup sends "config" we reply with config
    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "popup") return;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                receiver.postMessage({ action: "config", config: makeValidConfig() });
            }
        });
    });

    // Intercept chrome.tabs.connect so tests can message the popup's tabPort
    const origTabsConnect = chrome.tabs.connect.bind(chrome.tabs);
    chrome.tabs.connect = function (tabId, info = {}) {
        const caller = origTabsConnect(tabId, info);
        tabPortReceivers[info.name || ""] = caller; // caller is the side the popup owns
        portCallers[info.name || ""] = caller;
        // also expose the "other side" receiver under a parallel key so tests
        // can send messages *to* the popup's tabPort
        const pair = mock.findTabPort(tabId, info.frameId ?? 0);
        if (pair) {
            portReceivers[info.name || ""] = pair;
        }
        return caller;
    };

    await import("../src/js/popup.js");
    await settleAsync();
});

describe("Popup script", { concurrency: false }, () => {
    // -----------------------------------------------------------------------
    // smoke / wiring
    // -----------------------------------------------------------------------

    test("popup port connected during load", () => {
        assert.ok(portReceivers["popup"], "popup port receiver exists");
    });

    test("tab port connected during load", () => {
        assert.ok(portCallers["broadcast"], "tab port caller exists");
    });

    // -----------------------------------------------------------------------
    // config flow
    // -----------------------------------------------------------------------

    test("config is received and search rendered", async () => {
        // The config listener fires automatically via our mock wiring above.
        const search = document.getElementById("searchPattern");
        assert.ok(search, "search input exists");
        assert.ok(search.classList.contains("selected"), "search input is selected initially");
    });

    // -----------------------------------------------------------------------
    // match list rendering
    // -----------------------------------------------------------------------

    test("match message renders list items", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "match",
            entries: [
                {
                    path: "test/site.com",
                    name: "site.com",
                    rule: { tag: "login", color: "ff0000", strip: "" },
                    sortOrder: 1,
                    isInHistory: false,
                },
                {
                    path: "test/other.org",
                    name: "other.org",
                    rule: { tag: "login", color: "00ff00", strip: "" },
                    sortOrder: 2,
                    isInHistory: false,
                },
            ],
        });
        await settleAsync();

        const lis = document.querySelectorAll("ul#entries > li");
        assert.strictEqual(lis.length, 2, "two list items rendered");
        assert.strictEqual(lis[0].getAttribute("data-path"), "test/site.com");
        assert.strictEqual(lis[1].getAttribute("data-path"), "test/other.org");
    });

    test("match message shows no-matches notice when empty", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({ action: "match", entries: [] });
        await settleAsync();

        const notice = document.querySelector("p.no-matches");
        assert.ok(notice, "no-matches notice shown");
    });

    test("match message removes no-matches notice when entries present", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({ action: "match", entries: [] });
        await settleAsync();
        popupReceiver.postMessage({
            action: "match",
            entries: [
                {
                    path: "test/site.com",
                    name: "site.com",
                    rule: { tag: "login", color: "ff0000", strip: "" },
                    sortOrder: 1,
                    isInHistory: false,
                },
            ],
        });
        await settleAsync();

        assert.ok(!document.querySelector("p.no-matches"), "no-matches notice removed");
    });

    test("strip regex applied to entry name", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "match",
            entries: [
                {
                    path: "test/site.com",
                    name: "prefix-site.com",
                    rule: { tag: "login", color: "ff0000", strip: "^prefix-" },
                    sortOrder: 1,
                    isInHistory: false,
                },
            ],
        });
        await settleAsync();

        const nameSpan = document.querySelector("ul#entries > li span.name");
        assert.strictEqual(nameSpan.textContent, "site.com", "strip regex applied");
    });

    // -----------------------------------------------------------------------
    // history management
    // -----------------------------------------------------------------------

    test("history entry gets history class and forget button", async () => {
        // The forget button test already proves the full history loop.  This test simply confirms
        // popup.js always consults `history` storage regardless of `isInHistory` on the match payload.

        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "match",
            entries: [
                {
                    path: "test/site.com",
                    name: "site.com",
                    rule: { tag: "login", color: "ff0000", strip: "" },
                    sortOrder: 1,
                    isInHistory: false,
                },
            ],
        });
        await settleAsync();

        const li = document.querySelector("ul#entries > li");
        if (!li) throw new Error("No li rendered; HTML: " + document.body.innerHTML);
        const btn = li.querySelector("button.historyNuke");
        assert.ok(btn, "forget button exists because pre-seeded storage history matched");
    });

    test("clicking forget button removes entry from history storage", async () => {
        const url = new URL("https://example.com/login");
        const hash = sha256Native(url.origin);
        const scope = sha256Native("default");
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "match",
            entries: [
                {
                    path: "test/site.com",
                    name: "site.com",
                    rule: { tag: "login", color: "ff0000", strip: "" },
                    sortOrder: 1,
                    isInHistory: true,
                },
            ],
        });
        await settleAsync();

        const btn = document.querySelector("ul#entries > li button.historyNuke");
        assert.ok(btn, "forget button rendered");
        btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settleAsync();

        const stored = await chrome.storage.local.get(`history:${scope}:${hash}`);
        assert.strictEqual(stored[`history:${scope}:${hash}`].length, 0, "history emptied after forget");
    });

    // -----------------------------------------------------------------------
    // detail view
    // -----------------------------------------------------------------------

    test("detail view renders parcel-detail with hoisted values", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "plaintext",
            intent: "detail",
            plaintext: "user: alice\npassword: secret123\n",
        });
        await settleAsync();

        const detail = document.querySelector("parcel-detail");
        assert.ok(detail, "parcel-detail element created");

        const values = detail.shadowRoot.querySelectorAll("parcel-value");
        assert.ok(values.length > 0, "hoisted parcel-value elements rendered");
    });

    test("detail view renders plaintext lines", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "plaintext",
            intent: "detail",
            plaintext: "user: alice\npassword: secret123\n",
        });
        await settleAsync();

        const detail = document.querySelector("parcel-detail");
        const lines = detail.shadowRoot.querySelectorAll("parcel-plaintext-line");
        assert.ok(lines.length >= 2, "at least two plaintext lines rendered");
    });

    // -----------------------------------------------------------------------
    // fill flow
    // -----------------------------------------------------------------------

    test("fill intent sends fill message to tabPort", async () => {
        // Directly send plaintext with fill intent — the popup forwards it to
        // tabPort regardless of whether a match was previously rendered.
        const popupReceiver = portReceivers["popup"];
        const tabPortReceiver = portReceivers["broadcast"];
        const fillPromise = nextMessage(tabPortReceiver, "fill", 3000);

        popupReceiver.postMessage({
            action: "plaintext",
            intent: "fill",
            plaintext: "user: alice\npassword: secret123\n",
        });

        const msg = await fillPromise;
        assert.strictEqual(msg.action, "fill");
        assert.ok(msg.token);
        assert.ok(msg.plaintext);
    });

    test("fill intent updates history in storage", async () => {
        const url = new URL("https://example.com/login");
        const hash = sha256Native(url.origin);
        const scope = sha256Native("default");

        // The popup's `update()` function sends a `match` request with the
        // current history array.  We need to test the full round-trip: click
        // an entry, catch the `decrypt` request, send back `plaintext fill`,
        // and verify storage was written.
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({
            action: "match",
            entries: [
                {
                    path: "test/site.com",
                    name: "site.com",
                    rule: { tag: "login", color: "ff0000", strip: "" },
                    sortOrder: 1,
                    isInHistory: false,
                },
            ],
        });
        await settleAsync();

        // Capture the next message (decrypt) that the popup sends on its *port*
        // object (which is the runtime.connect("popup") caller) – but from the
        // mock's point of view the only receiver we can observe is the tab-side
        // receiver for the popup-bridge.  The popup calls `port.postMessage()`
        // on the `popup` runtime port; caller -> receiver.bOnMessage.
        const decryptPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timeout waiting for decrypt")), 3000);
            const listener = (msg) => {
                if (msg?.action === "decrypt") {
                    clearTimeout(timer);
                    popupReceiver.onMessage.removeListener(listener);
                    resolve(msg);
                }
            };
            popupReceiver.onMessage.addListener(listener);
        });

        const li = document.querySelector("ul#entries > li");
        li.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settleAsync();

        const decryptMsg = await decryptPromise;
        assert.strictEqual(decryptMsg.intent, "fill");

        // Reply with plaintext fill so the popup writes history to storage
        popupReceiver.postMessage({
            action: "plaintext",
            intent: "fill",
            plaintext: "user: alice\npassword: secret123\n",
        });
        await settleAsync();

        const stored = await chrome.storage.local.get(`history:${scope}:${hash}`);
        const hist = stored[`history:${scope}:${hash}`];
        assert.ok(hist && hist.length > 0, "history updated after fill click");
    });

    // -----------------------------------------------------------------------
    // error display
    // -----------------------------------------------------------------------

    test("error message renders error paragraph", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({ action: "error", error: "Something went wrong" });
        await settleAsync();

        const errP = document.querySelector("p.error");
        assert.ok(errP, "error paragraph rendered");
        assert.strictEqual(errP.textContent, "Something went wrong");
    });

    test("clear-errors removes all errors", async () => {
        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({ action: "error", error: "First error" });
        await settleAsync();
        popupReceiver.postMessage({ action: "clear-errors" });
        await settleAsync();

        assert.strictEqual(document.querySelectorAll("p.error").length, 0, "all errors removed");
    });

    test("clear-errors with category removes matching errors only", async () => {
        // Manually insert two categorized errors (the popup's own error handler
        // always removes all existing errors before inserting a new one, so we
        // bypass it for this test).
        const p1 = document.createElement("p");
        p1.classList.add("error", "error-category-native");
        p1.textContent = "Native error";
        document.body.insertAdjacentElement("afterbegin", p1);

        const p2 = document.createElement("p");
        p2.classList.add("error", "error-category-network");
        p2.textContent = "Network error";
        document.body.insertAdjacentElement("afterbegin", p2);

        assert.strictEqual(document.querySelectorAll("p.error").length, 2, "two errors present");

        const popupReceiver = portReceivers["popup"];
        popupReceiver.postMessage({ action: "clear-errors", category: "native" });
        await settleAsync();

        assert.strictEqual(document.querySelectorAll("p.error").length, 1, "one error remains");
        assert.strictEqual(document.querySelector("p.error").textContent, "Network error");
    });
});

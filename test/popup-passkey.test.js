"use strict";

import { test, describe, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import { createChromeMock } from "./chrome-api-mock.js";

/**
 * Tests for popup.js in passkey consent mode (?mode=passkey&token=...). The passkey
 * consent markup is driven by a "passkey-context" message from the content script;
 * these tests exercise the create flow's rendering, including the note that lists
 * passkeys already held for the site (its substitute for excludeCredentials, which
 * Parcel cannot honour without decrypting candidates).
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

const TOKEN = "tok-passkey-test";
let dom, document, window, mock, tabReceiver;

before(async () => {
    const _realConsole = globalThis.console;
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };

    // Drive the popup against the real shipped markup so the tests rot loudly if
    // popup.html changes, instead of silently passing against a stale inline copy
    const popupHtml = readFileSync(new URL("../src/html/popup.html", import.meta.url), "utf8");

    dom = new JSDOM(popupHtml, { url: `http://localhost/?mode=passkey&token=${TOKEN}`, pretendToBeVisual: true });
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

    window.close = () => {};
    window.Element.prototype.scrollIntoView = function () {};

    // Provide a current tab so connectToTab() uses the direct chrome.tabs.connect path
    mock.setCurrentTab({ id: 42, url: "https://example.com/login", cookieStoreId: undefined });

    // Reply to config requests on the background port
    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "popup") return;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                receiver.postMessage({
                    action: "config",
                    config: { passdir: "/home/test/.password-store", saveHistory: true, historyLength: 40 },
                });
            }
        });
    });

    // Capture the popup's tab port and expose the content-script side of it
    const origTabsConnect = chrome.tabs.connect.bind(chrome.tabs);
    chrome.tabs.connect = function (tabId, info = {}) {
        const caller = origTabsConnect(tabId, info);
        const pair = mock.findTabPort(tabId, info.frameId ?? 0);
        if (pair) {
            tabReceiver = pair;
        }
        return caller;
    };

    await import("../src/js/popup.js");
    await settleAsync();
});

describe("Popup script (passkey mode)", { concurrency: false }, () => {
    test("popup announces ready on the tab port", async () => {
        assert.ok(tabReceiver, "content-script side of the tab port exists");
        const ready = await nextMessage(tabReceiver, "ready");
        assert.strictEqual(ready.action, "ready");
    });

    test("create context lists existing passkeys for the site", async () => {
        tabReceiver.postMessage({
            action: "passkey-context",
            context: {
                op: "create",
                rpId: "example.com",
                origin: "https://example.com",
                user: { name: "alice", displayName: "Alice A" },
                candidates: [
                    {
                        name: "passkeys/example.com/alice",
                        path: "/home/test/.password-store/passkeys/example.com/alice.gpg",
                        rule: { strip: "^passkeys/", tag: "Personal", color: "1a7f37" },
                    },
                    {
                        name: "passkeys/example.com/shared",
                        path: "/home/test/.password-store/passkeys/example.com/shared.gpg",
                    },
                ],
            },
        });
        await settleAsync();

        const note = document.getElementById("passkey-existing");
        const list = document.getElementById("passkey-existing-list");
        assert.ok(!note.classList.contains("hidden"), "existing-passkeys note is visible");
        assert.ok(!list.classList.contains("hidden"), "existing-passkeys list is visible");
        assert.match(note.textContent, /2 passkeys/);
        const items = list.querySelectorAll("li");
        assert.strictEqual(items.length, 2);
        const tags = [...items].map((li) => li.querySelector(".tag")?.textContent ?? null);
        assert.deepStrictEqual(tags, ["Personal", null], "rule tags rendered");
        const names = [...items].map((li) => li.textContent.replace(li.querySelector(".tag")?.textContent ?? "", ""));
        assert.deepStrictEqual(names, ["example.com/alice", "passkeys/example.com/shared"], "strip rule applied, name shown not path");
        // candidates must not render as clickable assertion rows in create mode
        assert.strictEqual(document.querySelectorAll("#passkey-entries button").length, 0);
    });

    test("create context with no candidates keeps the note hidden", async () => {
        tabReceiver.postMessage({
            action: "passkey-context",
            context: {
                op: "create",
                rpId: "example.com",
                origin: "https://example.com",
                user: { name: "alice", displayName: "Alice A" },
                candidates: [],
            },
        });
        await settleAsync();

        assert.ok(document.getElementById("passkey-existing").classList.contains("hidden"), "note stays hidden");
        assert.ok(document.getElementById("passkey-existing-list").classList.contains("hidden"), "list stays hidden");
    });

    test("get context hides the note and renders assertion candidates", async () => {
        tabReceiver.postMessage({
            action: "passkey-context",
            context: {
                op: "get",
                rpId: "example.com",
                origin: "https://example.com",
                candidates: [{ name: "alice", path: "/home/test/.password-store/passkeys/example.com/alice.gpg" }],
            },
        });
        await settleAsync();
        await settleAsync(); // candidate rendering awaits config for path display

        assert.ok(document.getElementById("passkey-existing").classList.contains("hidden"), "note hidden for get");
        assert.ok(document.getElementById("passkey-existing-list").classList.contains("hidden"), "list hidden for get");
        assert.strictEqual(document.querySelectorAll("#passkey-entries button").length, 1, "assertion row rendered");
    });

    test("violated hints render a warning notice", async () => {
        tabReceiver.postMessage({
            action: "passkey-context",
            context: {
                op: "create",
                rpId: "example.com",
                origin: "https://example.com",
                user: { name: "alice", displayName: "Alice A" },
                candidates: [],
                hintWarning: { violated: ["security-key", "hybrid"], nonCompliant: [] },
            },
        });
        await settleAsync();

        const hints = document.getElementById("passkey-hints");
        assert.ok(!hints.classList.contains("hidden"), "hints warning is visible");
        assert.match(hints.textContent, /security-key/);
        assert.match(hints.textContent, /hybrid/);
    });

    test("non-compliant hints are surfaced to the user", async () => {
        tabReceiver.postMessage({
            action: "passkey-context",
            context: {
                op: "create",
                rpId: "example.com",
                origin: "https://example.com",
                user: { name: "alice" },
                candidates: [],
                hintWarning: { violated: [], nonCompliant: ["<script>alert(1)</script>"] },
            },
        });
        await settleAsync();

        const hints = document.getElementById("passkey-hints");
        assert.ok(!hints.classList.contains("hidden"), "hints warning is visible for non-compliant hint");
        assert.match(hints.textContent, /Non-compliant WebAuthn hint/);
        assert.ok(hints.textContent.includes("<script>alert(1)</script>"), "raw hint shown as text, not executed");
    });

    test("no hints keeps the warning hidden", async () => {
        tabReceiver.postMessage({
            action: "passkey-context",
            context: {
                op: "create",
                rpId: "example.com",
                origin: "https://example.com",
                user: { name: "alice" },
                candidates: [],
                hintWarning: { violated: [], nonCompliant: [] },
            },
        });
        await settleAsync();

        assert.ok(document.getElementById("passkey-hints").classList.contains("hidden"), "hints warning hidden");
    });
});

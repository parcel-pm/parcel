"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createChromeMock } from "./chrome-api-mock.js";

/**
 * Tests for integration.js URL-scope gating.
 *
 * Each scenario needs a distinct `features` set in the config reply, which a
 * shared module instance cannot provide - and coexisting instances cross-talk
 * over shared documents/ports. Each scenario therefore installs a fresh JSDOM
 * window and chrome mock into the globals, then performs a cache-busted import
 * of integration.js so every instance only ever sees its own environment.
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
        passkeyDir: "passkeys",
        rules: [{ pattern: "^test/.*$", class: "login", color: "ff0000", ignore: false }],
        cacheTTL: 10,
        decryptTimeout: 60,
        auditDecrypt: false,
        hostPinned: true,
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
            },
        ],
        additionalSelectors: [],
        showDelegateTooltips: false,
        ...overrides,
    };
}

// Timers created by imported integration.js instances, cleared in after().
const trackedTimers = [];
let origSetInterval;

/**
 * Load a fresh integration.js instance into a clean JSDOM/chrome environment.
 * @param {string[]} features - The URL-scope features to report in the config reply.
 * @returns {Promise<object>} Handles for the scenario: document, window, mock, and recorded ports.
 */
async function loadScenario(features) {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
    const window = dom.window;
    const document = window.document;

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
    try {
        globalThis.navigator = window.navigator;
    } catch {
        Object.defineProperty(globalThis, "navigator", { value: window.navigator, writable: true, configurable: true });
    }
    globalThis.location = window.location;
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

    const mock = createChromeMock({ baseUrl: "file:///" + process.cwd() + "/src/" });
    mock.installChrome();

    // Record both ends of every port the content script opens.
    const ports = []; // {name, caller, receiver}
    const origConnect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = function (info) {
        const caller = origConnect(info);
        ports.push({ name: caller.name, caller });
        return caller;
    };
    mock.chrome.runtime.onConnect.addListener((receiver) => {
        const entry = ports.find((p) => p.name === receiver.name && !p.receiver);
        if (entry) entry.receiver = receiver;

        if (receiver.name !== "integration") return;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                receiver.postMessage({ action: "config", config: makeValidConfig(), frameId: 0, features });
            } else if (msg?.action === "frame-id") {
                receiver.postMessage({ action: "frame-id", frameId: 0 });
            }
        });
    });
    // auth ports only need to accept messages without erroring
    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name === "auth") receiver.onMessage.addListener(() => {});
    });

    await import(
        `../src/js/integration.js?scope-scenario=${ports.length === 0 && features.join(",")}${Math.random().toString(36).slice(2)}`
    );
    await settleAsync();
    return { window, document, mock, ports };
}

before(() => {
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };
    origSetInterval = globalThis.setInterval;
    globalThis.setInterval = function (...args) {
        const id = origSetInterval.apply(this, args);
        trackedTimers.push(id);
        return id;
    };
});

after(() => {
    for (const id of trackedTimers) clearInterval(id);
    globalThis.setInterval = origSetInterval;
});

describe("URL-scope gating", { concurrency: false }, () => {
    test("blacklisted frames skip setup but still answer webauthn requests with a fallback", async () => {
        const { document, ports } = await loadScenario(["blacklist"]);

        // the early bail means no worker-facing ports other than the config request
        assert.ok(!ports.some((p) => p.name === "trigger" || p.name === "auth"), "a blacklisted frame must not open trigger/auth ports");

        // but the page's own WebAuthn ceremony must not hang on the absent interceptor
        const response = nextWebauthnResponse(document, "r-bl");
        document.dispatchEvent(
            new CustomEvent("parcel-webauthn-request", {
                detail: JSON.stringify({ requestId: "r-bl", op: "get", options: { rpId: "localhost" } }),
            }),
        );
        const msg = await response;
        assert.strictEqual(msg.type, "fallback", "blacklisted frames must defer WebAuthn ceremonies to the browser");
    });

    test("passkey ceremonies fall back when the passkey feature is out of scope", async () => {
        const { window, document, ports } = await loadScenario(["context", "fill", "http"]);
        await settleAsync();
        assert.ok(
            ports.some((p) => p.name === "trigger"),
            "a non-blacklisted frame must complete setup",
        );

        const response = nextWebauthnResponse(document, "r-np");
        document.dispatchEvent(
            new CustomEvent("parcel-webauthn-request", {
                detail: JSON.stringify({ requestId: "r-np", op: "get", options: { rpId: "localhost" } }),
            }),
        );
        const msg = await response;
        assert.strictEqual(msg.type, "fallback", "passkey requests must defer to the browser when out of scope");
        assert.ok(!ports.some((p) => p.name === "passkey"), "no passkey port may be opened");

        // a conflict report must likewise produce no UI
        const trigger = ports.find((p) => p.name === "trigger");
        const triggerMessages = [];
        trigger.caller.onMessage.addListener((m) => triggerMessages.push(m));
        document.dispatchEvent(new CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "locked" }) }));
        await settleAsync();
        await settleAsync();
        assert.deepStrictEqual(triggerMessages, [], "an out-of-scope passkey conflict must not surface UI");
        window.close();
    });

    test("popup ports receive the frame's features, and fills are refused without the fill feature", async () => {
        const { window, document } = await loadScenario(["context", "http", "passkey"]);
        await settleAsync();

        const input = document.createElement("input");
        input.setAttribute("type", "text");
        input.setAttribute("name", "user");
        document.body.appendChild(input);

        input._lastClicked = 0;
        input.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
        await new Promise((r) => setTimeout(r, 0));

        const token = input._parcelToken;
        assert.ok(token, "the context feature must still detect fill targets");

        const port = chrome.runtime.connect({ name: token });
        await settleAsync();
        await settleAsync();

        const originPromise = nextMessage(port, "origin");
        port.postMessage({ action: "ready" });
        const origin = await originPromise;
        assert.deepStrictEqual(origin.features, ["context", "http", "passkey"], "the origin reply must carry the frame's scoped features");

        for (const fillMsg of [
            { action: "fill", config: makeValidConfig(), plaintext: "user: alice" },
            { action: "fill-value", value: "annie" },
        ]) {
            const errorPromise = nextMessage(port, "error");
            port.postMessage(fillMsg);
            const err = await errorPromise;
            assert.ok(
                err.error.includes("Filling is disabled"),
                `expected a scope refusal for ${fillMsg.action}, got: ${JSON.stringify(err)}`,
            );
        }
        assert.strictEqual(input.value, "", "refused fills must not touch the DOM");
        window.close();
    });

    /**
     * Await the parcel-webauthn-response CustomEvent with the given request ID.
     * @param {Document} document - The scenario document.
     * @param {string} requestId - The request ID to match.
     * @returns {Promise<object>} The parsed response payload.
     */
    function nextWebauthnResponse(document, requestId) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout waiting for webauthn response ${requestId}`)), 5000);
            document.addEventListener("parcel-webauthn-response", (ev) => {
                const payload = JSON.parse(ev.detail);
                if (payload.requestId !== requestId) return;
                clearTimeout(timer);
                resolve(payload);
            });
        });
    }
});

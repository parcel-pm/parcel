"use strict";

import { JSDOM } from "jsdom";
import { createChromeMock } from "./chrome-api-mock.js";

/**
 * Shared bootstrap harness for integration.js content-script tests.
 *
 * integration.js is an async IIFE: it eagerly opens chrome ports and
 * attaches DOM listeners. Node ESM caches the module after the first
 * import, so each test file performs one global setup and only resets the
 * DOM between tests. The chrome mock fires port connections asynchronously
 * via queueMicrotask, so we flush many microtasks before marking setup
 * complete.
 *
 * State is returned in a context object so callers can keep their local
 * variable bindings; mutable scalars (ctx.liveFrameId) are read through the
 * context so onConnect responders observe later reassignments.
 */

export function flushMicrotasks() {
    return new Promise((resolve) => queueMicrotask(resolve));
}

/**
 * Yield until the microtask queue is fully drained.
 *
 * A macrotask (setTimeout) only executes after the event loop has emptied
 * the *entire* microtask queue, including all chained promise resolutions.
 * This is the deterministic alternative to guessing a loop count.
 */
export function settleAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export function nextMessage(port, action = null, timeout = 5000) {
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

export function makeValidConfig(overrides = {}) {
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
            { name: "secret", pattern: "^(secret|password):", related: [], onMissing: "null", strip: true, transform: [], trim: true },
            {
                name: "cardexp-month",
                pattern: "^((cc|card)[_-]?)?exp(iry)?[-_]?mon(th)?:",
                related: [],
                onMissing: "null",
                strip: true,
                transform: [],
                trim: true,
            },
            {
                name: "card",
                class: "card",
                pattern: "^(card|card-number|ccn|credit-?card|debit-?card|card-?num):",
                related: [],
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

export function clearBody() {
    document.body.innerHTML = "";
    document.querySelectorAll(".parcel-popup").forEach((el) => el.remove());
}

export function makeInput(attrs = {}) {
    const el = document.createElement("input");
    for (const [k, v] of Object.entries({ type: "text", value: "", ...attrs })) {
        el.setAttribute(k, String(v));
    }
    document.body.appendChild(el);
    return el;
}

export async function click(el) {
    el._lastClicked = 0;
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await new Promise((r) => setTimeout(r, 0));
}

/**
 * Bootstrap a JSDOM environment with integration.js loaded and ready.
 *
 * @returns {Promise<object>} Context: dom, window, document, mock,
 *   portReceivers, portCallers, stashReports, initStashReports,
 *   trackedTimers, and the mutable liveFrameId scalar.
 */
export async function setupIntegration() {
    const ctx = { trackedTimers: [], stashReports: [], liveFrameId: 0, initStashReports: [] };

    // Wrap setInterval to track handles created by integration.js, so they
    // can be cleaned up after tests and don't keep the process alive. The
    // callback and delay are retained so tests can also inspect what was
    // scheduled (e.g. the 25s worker keepalive).
    ctx.origSetInterval = globalThis.setInterval;
    globalThis.setInterval = function (...args) {
        const id = ctx.origSetInterval.apply(this, args);
        ctx.trackedTimers.push({ id, cb: args[0], delay: args[1] });
        return id;
    };

    // Keep console stubbed during tests - integration.js logs elements and
    // warnings on routine error paths (blacklist, missing config, etc.) that
    // we don't want polluting test output.  Node's runner still reports
    // assertion failures via its own reporter.
    ctx.origConsole = globalThis.console;
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };

    ctx.dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
    ctx.window = ctx.dom.window;
    ctx.document = ctx.window.document;
    const window = ctx.window;

    if (!window.Element.prototype.checkVisibility) {
        window.Element.prototype.checkVisibility = function () {
            return this.style.display !== "none" && this.style.display !== "hidden";
        };
    }
    if (!window.crypto.randomUUID) {
        window.crypto.randomUUID = () => "test-uuid-" + Math.random().toString(36).slice(2);
    }
    // JSDOM returns null for shadowRoot with mode: "closed"; expose it for tests.
    const origAttachShadow = window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow = function (opts) {
        const root = origAttachShadow.call(this, opts);
        Object.defineProperty(this, "shadowRoot", { value: root, configurable: true });
        return root;
    };

    globalThis.window = window;
    globalThis.document = ctx.document;
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

    ctx.mock = createChromeMock({ baseUrl: "file:///" + process.cwd() + "/src/" });
    ctx.mock.installChrome();

    ctx.portReceivers = {};
    ctx.portCallers = {};

    const origConnect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = function (info) {
        const caller = origConnect(info);
        ctx.portCallers[caller.name] = caller;
        return caller;
    };

    ctx.mock.chrome.runtime.onConnect.addListener((receiver) => {
        ctx.portReceivers[receiver.name] = receiver;
    });

    ctx.mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "integration") return;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                receiver.postMessage({
                    action: "config",
                    config: makeValidConfig(),
                    frameId: 0,
                    features: ["context", "fill", "http", "passkey"],
                });
            } else if (msg?.action === "frame-id") {
                receiver.postMessage({ action: "frame-id", frameId: ctx.liveFrameId });
            }
        });
    });

    ctx.mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "auth") return;
        receiver.onMessage.addListener(() => {});
    });

    // Record stash reports the content script sends to the worker.
    ctx.mock.chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "parcel-error-stash") ctx.stashReports.push(msg);
    });

    await import("../src/js/integration.js");
    await settleAsync(); // wait for dynamic imports & onConnect microtasks

    // The integration port may already be disconnected by the content script
    // after it received its first config reply; only re-send if still live.
    if (ctx.portReceivers["integration"] && !ctx.portReceivers["integration"].disconnected) {
        ctx.portReceivers["integration"].postMessage({
            action: "config",
            config: makeValidConfig(),
            frameId: 0,
            features: ["context", "fill", "http", "passkey"],
        });
    }
    await settleAsync();

    // Snapshot of the reports produced during module init (before any test truncates them).
    ctx.initStashReports = [...ctx.stashReports];
    return ctx;
}

/**
 * Restore globals patched by setupIntegration(): cancel tracked intervals,
 * restore the original setInterval, and unstub globalThis.console.
 * @param {object} ctx - Context returned by setupIntegration().
 */
export function teardownIntegration(ctx) {
    ctx.trackedTimers.forEach((t) => clearInterval(t.id));
    globalThis.setInterval = ctx.origSetInterval;
    globalThis.console = ctx.origConsole;
}

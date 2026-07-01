"use strict";

import { test, describe, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createChromeMock } from "./chrome-api-mock.js";

/**
 * Test suite for integration.js content script.
 *
 * integration.js is an async IIFE: it eagerly opens chrome ports and
 * attaches DOM listeners. Node ESM caches the module after the first
 * import, so we perform one global setup and only reset the DOM between
 * tests. The chrome mock fires port connections asynchronously via
 * queueMicrotask, so we flush many microtasks before marking setup complete.
 */

function flushMicrotasks() {
    return new Promise((resolve) => queueMicrotask(resolve));
}

/**
 * Yield until the microtask queue is fully drained.
 *
 * A macrotask (setTimeout) only executes after the event loop has emptied
 * the *entire* microtask queue, including all chained promise resolutions.
 * This is the deterministic alternative to guessing a loop count.
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
        ],
        additionalSelectors: [],
        showDelegateTooltips: false,
        ...overrides,
    };
}

let dom, document, window, mock, portReceivers, portCallers;

before(async () => {
    // Keep console stubbed during tests — integration.js logs elements and
    // warnings on routine error paths (blacklist, missing config, etc.) that
    // we don't want polluting test output.  Node's runner still reports
    // assertion failures via its own reporter.
    const _realConsole = globalThis.console;
    globalThis.console = { log() {}, error() {}, warn() {}, info() {}, debug() {} };

    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
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
    // JSDOM returns null for shadowRoot with mode: "closed"; expose it for tests.
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

    mock = createChromeMock({ baseUrl: "file:///" + process.cwd() + "/src/" });
    mock.installChrome();

    portReceivers = {};
    portCallers = {};

    const origConnect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = function (info) {
        const caller = origConnect(info);
        portCallers[caller.name] = caller;
        return caller;
    };

    mock.chrome.runtime.onConnect.addListener((receiver) => {
        portReceivers[receiver.name] = receiver;
    });

    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "integration") return;
        receiver.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                receiver.postMessage({ action: "config", config: makeValidConfig(), frameId: 0 });
            }
        });
    });

    mock.chrome.runtime.onConnect.addListener((receiver) => {
        if (receiver.name !== "auth") return;
        receiver.onMessage.addListener(() => {});
    });

    await import("../src/js/integration.js");
    await settleAsync(); // wait for dynamic imports & onConnect microtasks

    if (portReceivers["integration"]) {
        portReceivers["integration"].postMessage({ action: "config", config: makeValidConfig(), frameId: 0 });
    }
    await settleAsync();
});

describe("Integration script", { concurrency: false }, () => {
    function clearBody() {
        document.body.innerHTML = "";
        document.querySelectorAll(".parcel-popup").forEach((el) => el.remove());
    }

    function makeInput(attrs = {}) {
        const el = document.createElement("input");
        for (const [k, v] of Object.entries({ type: "text", value: "", ...attrs })) {
            el.setAttribute(k, String(v));
        }
        document.body.appendChild(el);
        return el;
    }

    async function click(el) {
        el._lastClicked = 0;
        el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
        await new Promise((r) => setTimeout(r, 0));
    }

    // -----------------------------------------------------------------------
    // smoke
    // -----------------------------------------------------------------------

    test("ports are connected during load", () => {
        assert.ok(portReceivers["auth"]);
        assert.ok(portReceivers["trigger"]);
        assert.ok(portReceivers["integration"]);
    });

    // -----------------------------------------------------------------------
    // click / target detection
    // -----------------------------------------------------------------------

    test("click on login field sends trigger-popup message", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "username" });
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await promise;
        assert.ok(input._parcelToken);
    });

    test("click on untargeted div sends untargeted-click", async () => {
        clearBody();
        const div = document.createElement("div");
        div.textContent = "just a div";
        document.body.appendChild(div);
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "untargeted-click", 3000);
        await click(div);
        await promise;
    });

    test("blacklist input triggers untargeted-click", async () => {
        clearBody();
        const input = makeInput({ type: "search", name: "q" });
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "untargeted-click", 3000);
        await click(input);
        await promise;
    });

    test("simple username field is detected as login type", async () => {
        clearBody();
        const input = makeInput({ type: "email", name: "user" });
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await promise;

        assert.strictEqual(input.getAttribute("parcel-type"), "login");
    });

    // -----------------------------------------------------------------------
    // triggerPopup
    // -----------------------------------------------------------------------

    test("trigger-popup message creates a .parcel-popup element", async () => {
        clearBody();
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "trigger-popup", 3000);

        const input = makeInput({ type: "email", name: "user" });
        await click(input);
        await promise;

        const popup = document.querySelector(".parcel-popup");
        assert.ok(popup, "popup element should exist");
    });

    test("popup contains a shadow root and iframe", async () => {
        clearBody();
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "trigger-popup", 3000);

        const input = makeInput({ type: "email", name: "user" });
        await click(input);
        await promise;

        const popup = document.querySelector(".parcel-popup");
        assert.ok(popup.shadowRoot, "popup should have shadow root");
        const iframe = popup.shadowRoot.querySelector("iframe");
        assert.ok(iframe, "shadow root should contain iframe");
        assert.ok(iframe.src.includes("popup.html"), "iframe src should point to popup.html");
    });

    test("resize-popup message adjusts popup dimensions", async () => {
        clearBody();
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "trigger-popup", 3000);

        const input = makeInput({ type: "email", name: "user" });
        await click(input);
        await promise;

        const triggerCaller = portCallers["trigger"];
        triggerCaller.postMessage({ action: "resize-popup", width: 250, height: 300 });
        await flushMicrotasks();

        const popup = document.querySelector(".parcel-popup");
        assert.ok(popup.style.width.includes("250"));
    });

    test("close-popup message removes popup from DOM", async () => {
        clearBody();
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "trigger-popup", 3000);

        const input = makeInput({ type: "email", name: "user" });
        await click(input);
        await promise;

        assert.ok(document.querySelector(".parcel-popup"));
        const triggerCaller = portCallers["trigger"];
        triggerCaller.postMessage({ action: "close-popup" });
        await flushMicrotasks();
        assert.strictEqual(document.querySelector(".parcel-popup"), null);
    });

    // -----------------------------------------------------------------------
    // fill via port
    // -----------------------------------------------------------------------

    test("fill-value sets input value and green outline", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "user" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({ action: "fill-value", value: "secret-user" });
        await nextMessage(port, "close", 3000);

        assert.strictEqual(input.value, "secret-user");
        assert.strictEqual(input.style.outline, "2px solid green");
    });

    test("fill message fills target and related fields", async () => {
        clearBody();
        const form = document.createElement("form");
        const user = makeInput({ type: "text", name: "username" });
        const pass = makeInput({ type: "password", name: "password" });
        form.appendChild(user);
        form.appendChild(pass);
        document.body.appendChild(form);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(user);
        await popupPromise;

        const token = user._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({
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
                    {
                        name: "secret",
                        pattern: "^(secret|password):",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "login: bob\nsecret: hunter2",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(user.value, "bob");
        assert.strictEqual(pass.value, "hunter2");
    });

    test("fill message handles select element (month)", async () => {
        clearBody();
        const sel = document.createElement("select");
        sel.setAttribute("name", "exp-month");
        for (const m of ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]) {
            const opt = document.createElement("option");
            opt.setAttribute("value", m.toLowerCase());
            opt.textContent = m;
            sel.appendChild(opt);
        }
        document.body.appendChild(sel);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(sel);
        await popupPromise;

        const token = sel._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({
                targets: [
                    {
                        name: "cardexp-month",
                        pattern: "^((cc|card)[_-]?)?exp(iry)?[-_]?mon(th)?:",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "cardexp-month: mar",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(sel.value, "mar");
    });

    test("fill-value sends close-popup via trigger port", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "login" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const closePopupPromise = nextMessage(triggerReceiver, "close-popup", 3000);
        port.postMessage({ action: "fill-value", value: "x" });

        const msg = await closePopupPromise;
        assert.strictEqual(msg.action, "close-popup");
    });

    test("fill without config errors", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "login" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        // Error messages are synchronous here; send and capture.
        const errPromise = nextMessage(port, "error", 3000);
        port.postMessage({ action: "fill", plaintext: "" });
        const msg = await errPromise;
        assert.ok(msg.error.includes("Config is missing"));
    });

    test("fill without plaintext errors", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "login" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const errPromise = nextMessage(port, "error", 3000);
        port.postMessage({ action: "fill", config: makeValidConfig() });
        const msg = await errPromise;
        assert.ok(msg.error.includes("Plaintext is missing"));
    });

    test("fill after element removal reports removed error", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "login" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        input.remove();
        const errPromise = nextMessage(port, "error", 3000);
        port.postMessage({ action: "fill", config: makeValidConfig(), plaintext: "login: x" });
        const msg = await errPromise;
        assert.ok(msg.error.includes("Target element has been removed"));
    });

    test("fill message truncates value to maxLength", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "user" });
        input.setAttribute("maxlength", "4");

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({ action: "fill-value", value: "super-long-secret" });
        await nextMessage(port, "close", 3000);

        assert.strictEqual(input.value, "supe");
    });

    test("port disconnect removes target binding", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "user" });

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;

        // First connection: complete a ready/origin exchange, then disconnect.
        const port1 = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise1 = nextMessage(port1, "origin", 3000);
        port1.postMessage({ action: "ready" });
        await originPromise1;
        port1.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Second connection: binding is gone, so integration should emit close immediately.
        const port2 = mock.chrome.runtime.connect({ name: token });
        // Listen for any message (to tell whether close arrives or something else happens)
        const anyMessagePromise = nextMessage(port2, null, 3000);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const msg = await anyMessagePromise;
        assert.strictEqual(msg.action, "close");
    });

    test("fill respects fillRelated=false", async () => {
        clearBody();
        const form = document.createElement("form");
        const user = makeInput({ type: "text", name: "username" });
        const pass = makeInput({ type: "password", name: "password" });
        form.appendChild(user);
        form.appendChild(pass);
        document.body.appendChild(form);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(user);
        await popupPromise;

        const token = user._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({ fillRelated: false }),
            plaintext: "login: bob\nsecret: hunter2",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(user.value, "bob");
        assert.strictEqual(pass.value, "");
    });

    test("resize message resizes popup", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "user" });

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const resizePromise = nextMessage(triggerReceiver, "resize-popup", 3000);
        port.postMessage({ action: "resize", height: 123, width: 456 });
        const msg = await resizePromise;

        assert.strictEqual(msg.action, "resize-popup");
        assert.strictEqual(msg.height, 123);
        assert.strictEqual(msg.width, 456);
    });

    test("tab on bound target sends focus-popup", async () => {
        clearBody();
        const input = makeInput({ type: "password", name: "password" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const focusPromise = nextMessage(port, "focus-popup", 3000);
        const ev = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        input.dispatchEvent(ev);
        const msg = await focusPromise;

        assert.strictEqual(msg.action, "focus-popup");
        assert.strictEqual(ev.defaultPrevented, true);
    });

    test("focus-target message refocuses bound target", async () => {
        clearBody();
        const input = makeInput({ type: "password", name: "password" });
        const button = document.createElement("button");
        document.body.appendChild(button);
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        button.focus();
        assert.strictEqual(document.activeElement, button);
        port.postMessage({ action: "focus-target" });
        await settleAsync();

        assert.strictEqual(document.activeElement, input);
    });

    test("input on target before popup connects closes popup", async () => {
        clearBody();
        const input = makeInput({ type: "password", name: "password" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const closePopupPromise = nextMessage(triggerReceiver, "close-popup", 3000);
        input.value = "typed";
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        const msg = await closePopupPromise;

        assert.strictEqual(msg.action, "close-popup");
    });

    test("input on bound target closes popup and disconnects", async () => {
        clearBody();
        const input = makeInput({ type: "password", name: "password" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const closePopupPromise = nextMessage(triggerReceiver, "close-popup", 3000);
        input.value = "typed";
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        const tabEvent = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        input.dispatchEvent(tabEvent);
        const msg = await closePopupPromise;
        await settleAsync();

        assert.strictEqual(msg.action, "close-popup");
        assert.strictEqual(port.disconnected, true);
        assert.strictEqual(tabEvent.defaultPrevented, false);
    });

    test("close message stops intercepting tab on target", async () => {
        clearBody();
        const input = makeInput({ type: "password", name: "password" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const closePopupPromise = nextMessage(triggerReceiver, "close-popup", 3000);
        port.postMessage({ action: "close" });
        await closePopupPromise;

        const tabEvent = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        input.dispatchEvent(tabEvent);
        assert.strictEqual(tabEvent.defaultPrevented, false);
    });

    // -----------------------------------------------------------------------
    // broadcast
    // -----------------------------------------------------------------------

    test("broadcast fills best target in root frame", async () => {
        clearBody();
        const input = makeInput({ type: "email", name: "user" });

        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const fillPromise = nextMessage(port, "close", 3000);
        port.postMessage({
            action: "fill",
            config: makeValidConfig({
                targets: [
                    {
                        name: "login",
                        pattern: "^(user|username|login|email):",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "login: broadcast-user",
        });
        await fillPromise;

        assert.strictEqual(input.value, "broadcast-user");
    });

    test("broadcast errors when no fillable target exists", async () => {
        clearBody();
        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        // Attach listener to the caller's onMessage BEFORE the microtask that fires onConnect completes.
        const errPromise = nextMessage(port, "error", 3000);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const msg = await errPromise;
        assert.ok(msg.error.includes("Cannot find a suitable autofill target"));
    });

    test("broadcast token is regenerated when retriggering context popup (issue #79)", async () => {
        // Simulate the toolbar popup: open a broadcast connection against a
        // target, then close it without filling. The element retains a stale
        // _parcelToken === "broadcast". A subsequent click to open a context
        // popup must NOT reuse that broadcast token, because the context popup
        // loads in an iframe and a broadcast token would trip the anti-framing
        // guard in popup.js.
        clearBody();
        const input = makeInput({ type: "email", name: "user" });

        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        port.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual(input._parcelToken, "broadcast");

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        const msg = await popupPromise;

        assert.notStrictEqual(msg.token, "broadcast", "context popup must not use a broadcast token");
        assert.notStrictEqual(input._parcelToken, "broadcast", "element token must be regenerated");

        const popup = document.querySelector(".parcel-popup");
        assert.ok(popup, "popup element should exist");
        const iframe = popup.shadowRoot.querySelector("iframe");
        assert.ok(iframe, "shadow root should contain iframe");
        assert.ok(!iframe.src.includes("token=broadcast"), "iframe src must not carry token=broadcast");
    });

    // -----------------------------------------------------------------------
    // shadow DOM target detection
    // -----------------------------------------------------------------------

    /**
     * Build a shadow host containing the given light-DOM children and return
     * both the host (attached to document.body) and its shadow root.
     * The host is tagged with `is-shadow` so Helpers.shadowSelectorAll can
     * locate it.
     */
    function makeShadowHost(attrs = {}) {
        const host = document.createElement("div");
        for (const [k, v] of Object.entries(attrs)) host.setAttribute(k, String(v));
        document.body.appendChild(host);
        const root = host.attachShadow({ mode: "open" });
        // Mimic src/js/shadow.js which tags hosts asynchronously; tests need
        // the attribute synchronously so Helpers.shadowSelectorAll can recurse.
        host.setAttribute("is-shadow", "");
        return { host, root };
    }

    /**
     * Click an element that lives inside a shadow root.
     *
     * src/js/shadow.js re-dispatches shadow-DOM clicks as a
     * `parcel-shadow-click` CustomEvent on document, tagging the real target
     * with a `parcel-shadow-event` attribute so integration.js can locate it
     * across the shadow boundary. The test harness replaces attachShadow and
     * does not install that click intercept, so we simulate it here.
     */
    async function clickShadow(el) {
        const evUUID = "test-shadow-" + Math.random().toString(36).slice(2);
        el.setAttribute("parcel-shadow-event", evUUID);
        document.dispatchEvent(
            new window.CustomEvent("parcel-shadow-click", { detail: { host: "test-host", target: evUUID, x: 10, y: 10 } }),
        );
        await new Promise((r) => setTimeout(r, 0));
    }

    test("login field inside shadow host is detected as login type", async () => {
        clearBody();
        // The host attribute is decorative: getTargetInfo classifies the
        // clicked element via el.matches(target.selector) only — it never
        // consults target.shadow (which is a rootSelector for related-field
        // and submit-button lookups, not type detection). A bare
        // input[type=text] matches the shadow login selector whose `selector`
        // field is "input[type=text i]".
        const { root } = makeShadowHost();
        const input = document.createElement("input");
        input.setAttribute("type", "text");
        root.appendChild(input);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await clickShadow(input);
        await popupPromise;

        assert.strictEqual(input.getAttribute("parcel-type"), "login");
    });

    test("shadow login target is filled via fill message", async () => {
        clearBody();
        // As above, the host attribute is not consulted for classification.
        const { root } = makeShadowHost();
        const input = document.createElement("input");
        input.setAttribute("type", "text");
        root.appendChild(input);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await clickShadow(input);
        await popupPromise;

        const token = input._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({
                targets: [
                    {
                        name: "login",
                        pattern: "^(user|username|login|email):",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "login: shadow-user",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(input.value, "shadow-user");
    });

    test("related password field in light DOM is filled when login is in a shadow root", async () => {
        // The shadow host is a direct child of a <form> in the light DOM.
        // The login field's root is the ShadowRoot, so getTargetInfo marks
        // it isShadowSingle = true (no related targets share the shadow
        // root). However, the isShadowSingle group-bypass path
        // (group = el.getRootNode().host.getRootNode()) yields the document
        // here, which getRelatedFields nullifies — so it falls
        // through to the shadowClosest fallback path. That walk crosses the
        // shadow boundary to find the <form class=login-form> aggregate
        // group, and the related password field is then located in the
        // light DOM via shadowSelectorAll with target.shadow as
        // rootSelector. The actual isShadowSingle group-bypass path is
        // exercised by the nested-shadow-host test below.
        clearBody();
        const form = document.createElement("form");
        form.setAttribute("class", "login-form");
        const { root, host } = makeShadowHost();
        const user = document.createElement("input");
        user.setAttribute("type", "text");
        user.setAttribute("name", "username");
        root.appendChild(user);
        const pass = document.createElement("input");
        pass.setAttribute("type", "password");
        pass.setAttribute("name", "password");
        form.appendChild(host);
        form.appendChild(pass);
        document.body.appendChild(form);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await clickShadow(user);
        await popupPromise;

        const token = user._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({
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
                    {
                        name: "secret",
                        pattern: "^(secret|password):",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "login: bob\nsecret: hunter2",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(user.value, "bob");
        assert.strictEqual(pass.value, "hunter2");
    });

    test("related password field is filled via isShadowSingle group-bypass for nested shadow host", async () => {
        // The isShadowSingle group-bypass path in getRelatedFields
        // (group = el.getRootNode()?.host?.getRootNode()) only produces a
        // useful (non-document) group when the shadow host containing the
        // filled field lives inside *another* shadow root. In that case
        // host.getRootNode() returns the outer ShadowRoot, which becomes
        // the group, and related fields are searched within it via
        // shadowSelectorAll — bypassing the shadowClosest fallback.
        //
        // Structure:
        //   document
        //     └ outerHost (div, is-shadow) — outerShadow
        //         └ innerHost (div, is-shadow) — innerShadow
        //             ├ input[type=text name=username]  (login, filled)
        //         └ input[type=password name=password]  (related secret)
        //
        // The login field is the only related target in innerShadow, so
        // getTargetInfo marks it isShadowSingle = true. The related
        // password field lives in the outer shadow root (the group), so it
        // is found via the isShadowSingle group path — NOT via
        // shadowClosest (there is no <form>/aggregate ancestor here).
        clearBody();
        const outerHost = document.createElement("div");
        document.body.appendChild(outerHost);
        const outerShadow = outerHost.attachShadow({ mode: "open" });
        outerHost.setAttribute("is-shadow", "");

        const innerHost = document.createElement("div");
        outerShadow.appendChild(innerHost);
        const innerShadow = innerHost.attachShadow({ mode: "open" });
        innerHost.setAttribute("is-shadow", "");

        const user = document.createElement("input");
        user.setAttribute("type", "text");
        user.setAttribute("name", "username");
        innerShadow.appendChild(user);

        const pass = document.createElement("input");
        pass.setAttribute("type", "password");
        pass.setAttribute("name", "password");
        outerShadow.appendChild(pass);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await clickShadow(user);
        await popupPromise;

        const token = user._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({
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
                    {
                        name: "secret",
                        pattern: "^(secret|password):",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "login: bob\nsecret: hunter2",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(user.value, "bob");
        assert.strictEqual(pass.value, "hunter2");
    });

    test("submit button inside shadow host is focused after fill", async () => {
        // After a successful fill, integration.js looks up the aggregate
        // group containing the filled field (via Helpers.shadowClosest,
        // which crosses shadow boundaries) and then uses
        // Helpers.shadowSelector to find a submit button within that
        // group. Because the submit button lives inside the shadow root,
        // shadowSelector must recurse across the shadow boundary to find
        // it. This test verifies that cross-shadow submit detection works.
        clearBody();
        const form = document.createElement("form");
        form.setAttribute("class", "login-form");
        const { root, host } = makeShadowHost();
        const user = document.createElement("input");
        user.setAttribute("type", "text");
        user.setAttribute("name", "username");
        const submit = document.createElement("button");
        submit.setAttribute("type", "submit");
        submit.setAttribute("name", "login");
        root.appendChild(user);
        root.appendChild(submit);
        form.appendChild(host);
        document.body.appendChild(form);

        let focused = false;
        submit.focus = () => {
            focused = true;
        };

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await clickShadow(user);
        await popupPromise;

        const token = user._parcelToken;
        assert.ok(token);

        const port = mock.chrome.runtime.connect({ name: token });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        port.postMessage({
            action: "fill",
            config: makeValidConfig({
                targets: [
                    {
                        name: "login",
                        pattern: "^(user|username|login|email):",
                        related: [],
                        onMissing: "null",
                        strip: true,
                        transform: [],
                        trim: true,
                    },
                ],
            }),
            plaintext: "login: shadow-user",
        });

        await nextMessage(port, "close", 3000);
        // submit focus runs inside requestAnimationFrame, which the test
        // harness maps to setTimeout(0); settle the macrotask queue.
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(user.value, "shadow-user");
        assert.ok(focused, "submit button inside shadow host should be focused after fill");
    });
});

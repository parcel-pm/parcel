"use strict";

import { test, describe, before, after } from "node:test";
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
        passkeyDir: "passkeys",
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

// Track timers created by integration.js so they can be cleared in after().
const trackedTimers = [];

// The original setInterval is captured before before() wraps it, so after()
// can restore it.
let origSetInterval;

before(async () => {
    // Wrap setInterval to track handles created by integration.js, so they
    // can be cleaned up after tests and don't keep the process alive. The
    // callback and delay are retained so tests can also inspect what was
    // scheduled (e.g. the 25s worker keepalive).
    origSetInterval = globalThis.setInterval;
    globalThis.setInterval = function (...args) {
        const id = origSetInterval.apply(this, args);
        trackedTimers.push({ id, cb: args[0], delay: args[1] });
        return id;
    };

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

    // The integration port may already be disconnected by the content script
    // after it received its first config reply; only re-send if still live.
    if (portReceivers["integration"] && !portReceivers["integration"].disconnected) {
        portReceivers["integration"].postMessage({ action: "config", config: makeValidConfig(), frameId: 0 });
    }
    await settleAsync();
});

after(() => {
    trackedTimers.forEach((t) => clearInterval(t.id));
    globalThis.setInterval = origSetInterval;
});

describe("Integration script", { concurrency: false }, () => {
    test("keepalive: registers a 25s interval that pings the service worker", () => {
        const entries = trackedTimers.filter((t) => t.delay === 25_000);
        assert.ok(entries.length >= 1, "integration.js should register a keepalive interval with a 25s cadence");

        // Invoking the interval callback must send the keepalive message the
        // service worker's MV3 idle timer depends on.
        let received = null;
        const listener = (msg) => {
            if (msg?.type === "keepalive") received = msg;
        };
        mock.chrome.runtime.onMessage.addListener(listener);
        try {
            entries[0].cb();
        } finally {
            mock.chrome.runtime.onMessage.removeListener(listener);
        }
        assert.deepStrictEqual(received, { type: "keepalive" }, "keepalive callback should send {type: 'keepalive'} to the worker");
    });

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

    test("trigger port reconnects after disconnect and still delivers trigger-popup", async () => {
        clearBody();
        // Simulate the race where the MV3 service worker / cross-frame relay
        // tears down the trigger port before the user clicks (the
        // "Attempting to use a disconnected port object" / "Receiving end does
        // not exist" errors reported on first load).
        assert.ok(portCallers["trigger"], "trigger caller should exist from load");
        portCallers["trigger"].disconnect();
        await flushMicrotasks(); // let onDisconnect null the internal port

        const input = makeInput({ type: "text", name: "username" });
        await click(input);
        // allow the reconnect microtask and the buffered message delivery to settle
        await settleAsync();

        assert.ok(input._parcelToken, "target should still receive a token");
        assert.ok(document.querySelector(".parcel-popup"), "popup should be created after port reconnect");
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

    test("button without type attribute triggers untargeted-click", async () => {
        clearBody();
        // A <button> without an explicit type attribute defaults to
        // type="submit" per the HTML spec, but hasAttribute("type") is
        // false. The type guard in getTargetInfo must still reject it so
        // the popup does not appear when clicking a submit button.
        const button = document.createElement("button");
        button.setAttribute("name", "login");
        button.textContent = "Log In";
        document.body.appendChild(button);
        const triggerReceiver = portReceivers["trigger"];
        const promise = nextMessage(triggerReceiver, "untargeted-click", 3000);
        await click(button);
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
        assert.ok(
            (iframe.getAttribute("allow") || "").includes("clipboard-write"),
            "iframe should delegate clipboard-write so popup copy buttons work",
        );
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

    test("relatedNever field is not filled as a related field", async () => {
        clearBody();
        const form = document.createElement("form");
        const user = makeInput({ type: "text", name: "username" });
        const realPass = makeInput({ type: "password", name: "password" });
        const textPass = makeInput({ type: "text", name: "password" });
        form.appendChild(user);
        form.appendChild(realPass);
        form.appendChild(textPass);
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
        assert.strictEqual(realPass.value, "hunter2");
        assert.strictEqual(textPass.value, "", "text field with name=password should not be filled as a related field");
    });

    test("relatedNever field is still detected as a primary target", async () => {
        clearBody();
        const form = document.createElement("form");
        const textPass = makeInput({ type: "text", name: "password" });
        form.appendChild(textPass);
        document.body.appendChild(form);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(textPass);
        await popupPromise;

        const token = textPass._parcelToken;
        assert.ok(token, "relatedNever field should be detected as a primary target");

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
            plaintext: "secret: hunter2",
        });

        await nextMessage(port, "close", 3000);
        assert.strictEqual(textPass.value, "hunter2");
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

    test("transient port disconnect keeps binding so popup can reconnect", async () => {
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

        // Second connection with the SAME token: the binding must still be
        // alive so the popup can recover after a transient disconnect (bfcache,
        // cold service worker, relay tear-down). Integration should re-accept
        // the connection and respond to "ready" with "origin", not "close".
        const port2 = mock.chrome.runtime.connect({ name: token });
        const originPromise2 = nextMessage(port2, "origin", 3000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        port2.postMessage({ action: "ready" });
        const msg = await originPromise2;
        assert.strictEqual(msg.action, "origin");

        // fill-value must still work after the reconnect — this is the
        // user-visible symptom: "decrypts, but does not fill".
        port2.postMessage({ action: "fill-value", value: "reconnected-secret" });
        await nextMessage(port2, "close", 3000);
        assert.strictEqual(input.value, "reconnected-secret");
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

    test("broadcast fill drops the credential when the intended origin does not match", async () => {
        // The agent's fire-and-forget fallback carries the origin the decrypt was
        // requested for. When this page's origin differs (a mid-decrypt navigation),
        // the credential must be dropped rather than filled into the wrong origin.
        clearBody();
        const input = makeInput({ type: "email", name: "user" });

        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const errPromise = nextMessage(port, "error", 3000);
        port.postMessage({
            action: "fill",
            origin: "https://attacker.example",
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
        const err = await errPromise;
        assert.ok(err.error.includes("Origin mismatch"), "a mismatch must be rejected, not filled");
        assert.strictEqual(input.value, "", "the credential must not be filled into a mismatched origin");
    });

    test("broadcast fill succeeds when the intended origin matches", async () => {
        // A matching origin is a no-op for the guard: the credential must still fill.
        clearBody();
        const input = makeInput({ type: "email", name: "user" });

        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;

        const closePromise = nextMessage(port, "close", 3000);
        port.postMessage({
            action: "fill",
            origin: window.location.origin,
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
        await closePromise;
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
        // Mimic src/js/main-world/shadow.js which tags hosts asynchronously; tests need
        // the attribute synchronously so Helpers.shadowSelectorAll can recurse.
        host.setAttribute("is-shadow", "");
        return { host, root };
    }

    /**
     * Click an element that lives inside a shadow root.
     *
     * src/js/main-world/shadow.js re-dispatches shadow-DOM clicks as a
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
        // getTargetInfo validates target.shadow against the enclosing shadow
        // host: a shadow-scoped login descriptor requires the host to match
        // the host selector (e.g. [name*=login i]). A bare input[type=text]
        // inside a host that doesn't satisfy target.shadow is not classified
        // as a login field.
        const { root } = makeShadowHost({ name: "login" });
        const input = document.createElement("input");
        input.setAttribute("type", "text");
        root.appendChild(input);

        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await clickShadow(input);
        await popupPromise;

        assert.strictEqual(input.getAttribute("parcel-type"), "login");
    });

    test("bare text input in shadow host without matching host selector is not classified", async () => {
        clearBody();
        // A bare input[type=text] inside a shadow host whose attributes don't
        // satisfy any shadow login descriptor should not be detected as a
        // login target.
        const { root } = makeShadowHost();
        const input = document.createElement("input");
        input.setAttribute("type", "text");
        root.appendChild(input);

        const triggerReceiver = portReceivers["trigger"];
        await clickShadow(input);

        // No trigger-popup should be emitted because getTargetInfo rejects
        // the element.
        await assert.rejects(nextMessage(triggerReceiver, "trigger-popup", 500), /timeout/i);
    });

    test("shadow login target is filled via fill message", async () => {
        clearBody();
        // The shadow host must satisfy target.shadow for the login descriptor
        // to apply.
        const { root } = makeShadowHost({ name: "login" });
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

    // -----------------------------------------------------------------------
    // passkey bridge (parcel-webauthn CustomEvent bridge + consent popup)
    // -----------------------------------------------------------------------

    describe("Passkey bridge", () => {
        const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
        const GET_OPTIONS = (overrides = {}) => ({
            challenge: "Y2hhbGxlbmdl",
            rpId: "example.com",
            timeout: 30000,
            userVerification: "preferred",
            ...overrides,
        });
        const CREATE_OPTIONS = (overrides = {}) => ({
            challenge: "Y2hhbGxlbmdl",
            rp: { id: "example.com", name: "Example" },
            user: { id: "dXNlcg", name: "alice", displayName: "Alice" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            ...overrides,
        });

        /**
         * Register a scripted background agent for one-shot "passkey" ports.
         * @param {(port: object, msg: object) => void} handler - Replies to each phase message.
         * @returns {() => void} A teardown removing the listener.
         */
        function fakePasskeyAgent(handler) {
            const listener = (receiver) => {
                if (receiver.name !== "passkey") return;
                receiver.onMessage.addListener((msg) => handler(receiver, msg));
            };
            mock.chrome.runtime.onConnect.addListener(listener);
            return () => mock.chrome.runtime.onConnect.removeListener(listener);
        }

        /**
         * Dispatch a parcel-webauthn-request and resolve with its matching response.
         * @param {object} detail - `{requestId, op, options}` for the interceptor bridge.
         * @returns {Promise<object>} The dispatched parcel-webauthn-response detail.
         */
        function dispatchPasskey(detail) {
            const reply = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    document.removeEventListener("parcel-webauthn-response", listener);
                    reject(new Error(`Timeout waiting for parcel-webauthn-response: ${detail.requestId}`));
                }, 3000);
                const listener = (ev) => {
                    const d = JSON.parse(ev.detail);
                    if (d.requestId === detail.requestId) {
                        clearTimeout(timer);
                        document.removeEventListener("parcel-webauthn-response", listener);
                        resolve(d);
                    }
                };
                document.addEventListener("parcel-webauthn-response", listener);
            });
            document.dispatchEvent(new window.CustomEvent("parcel-webauthn-request", { detail: JSON.stringify(detail) }));
            return reply;
        }

        /**
         * Run one complete, consented get ceremony (with its own scripted agent).
         * Doubles as a reset for the popup-spam guard's dismissal streak between
         * cancel-based tests, since a consented ceremony clears it. Registers its own
         * ephemeral fake agent, so callers must have torn theirs down first.
         * @param {string} requestId - Unique request identifier for this ceremony.
         * @returns {Promise<object>} The parcel-webauthn-response detail.
         */
        async function runSuccessfulAssertion(requestId) {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") {
                    port.postMessage({
                        action: "passkey-candidates",
                        rpId: "example.com",
                        candidates: [{ name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" }],
                    });
                } else if (msg.phase === "assert") {
                    port.postMessage({
                        action: "passkey-result",
                        result: {
                            op: "get",
                            credentialId: "Y3JlZA",
                            authenticatorData: Buffer.from([1, 2, 3]).toString("base64"),
                            signature: Buffer.from([4, 5, 6]).toString("base64"),
                            userHandle: "dXNlcg",
                        },
                    });
                }
            });
            try {
                const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
                const replyPromise = dispatchPasskey({ requestId, op: "get", options: GET_OPTIONS() });
                const trigger = await popupPromise;
                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                popup.postMessage({ action: "passkey-assert", path: "/abs/passkeys/example.com/alice.gpg" });
                const response = await replyPromise;
                assert.strictEqual(response.type, "response");
                return response;
            } finally {
                teardown();
            }
        }

        test("get with no stored candidates falls back to the browser silently", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            });
            try {
                const response = await dispatchPasskey({ requestId: "pw-no-candidates", op: "get", options: GET_OPTIONS() });
                assert.strictEqual(response.type, "fallback");
            } finally {
                teardown();
            }
        });

        // NOTE: these conflict tests must run in declaration order - the
        // once-per-frame notice flag in integration.js is deliberately sticky,
        // so the silent path must be exercised before the modal path.
        test("conflict without stored passkeys stays silent", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "localhost", candidates: [] });
            });
            try {
                const triggerReceiver = portReceivers["trigger"];
                const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 250);
                document.dispatchEvent(
                    new window.CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "wrapped" }) }),
                );
                await settleAsync();
                await assert.rejects(popupPromise, /Timeout waiting for message/);
                assert.ok(!document.querySelector(".parcel-popup"), "no modal without stored passkeys");
            } finally {
                teardown();
            }
        });

        test("conflict with stored passkeys opens the notice, persists dismissal, and never re-shows", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates")
                    port.postMessage({
                        action: "passkey-candidates",
                        rpId: "localhost",
                        candidates: [{ name: "passkeys/localhost/alice", path: "/abs/passkeys/localhost/alice.gpg" }],
                    });
            });
            try {
                const triggerReceiver = portReceivers["trigger"];
                const authReceiver = portReceivers["auth"];
                const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
                const authPromise = nextMessage(authReceiver, null, 3000);
                document.dispatchEvent(
                    new window.CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "locked" }) }),
                );
                const trigger = await popupPromise;
                await settleAsync();
                assert.strictEqual(trigger.mode, "passkey-conflict");
                assert.ok(document.querySelector(".parcel-popup"), "conflict modal should be on the page");
                // the token is announced on the auth port so the popup iframe's background
                // connection is authorised (otherwise the panel renders "Unauthorised port")
                assert.strictEqual(await authPromise, trigger.token);

                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const contextPromise = nextMessage(popup, "passkey-conflict-context", 3000);
                popup.postMessage({ action: "ready" });
                const context = await contextPromise;
                assert.strictEqual(context.context.origin, "http://localhost");
                assert.strictEqual(context.context.reason, "locked");

                const closePromise = nextMessage(triggerReceiver, "close-popup", 3000);
                popup.postMessage({ action: "passkey-conflict-dismiss" });
                await closePromise;
                await settleAsync();
                const stored = await mock.chrome.storage.local.get("passkeyConflictDismissed");
                assert.strictEqual(stored?.passkeyConflictDismissed?.["http://localhost"], true, "dismissal must be persisted per origin");

                // a later conflict in this frame must not raise the modal again
                document.dispatchEvent(
                    new window.CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "locked" }) }),
                );
                await settleAsync();
                await assert.rejects(nextMessage(triggerReceiver, "trigger-popup", 250), /Timeout waiting for message/);
            } finally {
                teardown();
            }
        });

        test("get ceremony shows candidates, signs via the host, and returns an assertion", async () => {
            clearBody();
            let assertPhase = null;
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") {
                    port.postMessage({
                        action: "passkey-candidates",
                        rpId: "example.com",
                        candidates: [{ name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" }],
                    });
                } else if (msg.phase === "assert") {
                    assertPhase = msg;
                    port.postMessage({
                        action: "passkey-result",
                        result: {
                            op: "get",
                            credentialId: "Y3JlZA",
                            authenticatorData: Buffer.from([0xfb, 0xff, 0x3e]).toString("base64"),
                            signature: Buffer.from([0xfb, 0xfe, 0x00]).toString("base64"),
                            userHandle: "dXNlcg",
                        },
                    });
                }
            });
            try {
                const triggerReceiver = portReceivers["trigger"];
                const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
                const replyPromise = dispatchPasskey({
                    requestId: "pw-get",
                    op: "get",
                    options: GET_OPTIONS({ allowCredentials: [{ type: "public-key", id: "Y3JlZA" }] }),
                });
                const trigger = await popupPromise;
                assert.strictEqual(trigger.mode, "passkey");
                assert.ok(trigger.token, "consent popup must receive a token");

                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const contextPromise = nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "ready" });
                const context = await contextPromise;
                assert.strictEqual(context.context.op, "get");
                assert.strictEqual(context.context.rpId, "example.com");
                assert.strictEqual(context.context.origin, "http://localhost");
                assert.deepStrictEqual(context.context.candidates, [
                    { name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" },
                ]);
                assert.strictEqual(context.context.user, null);

                popup.postMessage({ action: "passkey-assert", path: "/abs/passkeys/example.com/alice.gpg" });
                const response = await replyPromise;

                // the agent received the exact signing inputs, including allowCredentials
                assert.ok(assertPhase, "assert phase should have been requested");
                assert.strictEqual(assertPhase.rpId, "example.com");
                assert.strictEqual(assertPhase.origin, "http://localhost");
                assert.strictEqual(assertPhase.path, "/abs/passkeys/example.com/alice.gpg");
                assert.deepStrictEqual(assertPhase.allowCredentials, ["Y3JlZA"]);
                const clientData = JSON.parse(Buffer.from(assertPhase.clientDataJSON, "base64").toString("utf8"));
                assert.deepStrictEqual(clientData, {
                    type: "webauthn.get",
                    challenge: "Y2hhbGxlbmdl",
                    origin: "http://localhost",
                    crossOrigin: false,
                });

                // standard base64 from the host must be converted to base64url for the page
                assert.strictEqual(response.type, "response");
                assert.strictEqual(response.credential.op, "get");
                assert.strictEqual(response.credential.id, "Y3JlZA");
                assert.strictEqual(response.credential.response.authenticatorData, "-_8-");
                assert.strictEqual(response.credential.response.signature, "-_4A");
                assert.strictEqual(response.credential.response.userHandle, "dXNlcg");
            } finally {
                teardown();
            }
        });

        test("create ceremony mints then completes on ack with an attestation", async () => {
            clearBody();
            let createPhase = null;
            const pubKeyHex = "aa".repeat(32) + "bb".repeat(32);
            const spkiB64 = Buffer.from(new Uint8Array(91).fill(0x01)).toString("base64");
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") {
                    port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
                } else if (msg.phase === "create") {
                    createPhase = msg;
                    port.postMessage({
                        action: "passkey-result",
                        result: {
                            op: "create",
                            credentialId: b64url(new Uint8Array(32).fill(0x42)),
                            publicKey: pubKeyHex,
                            spki: spkiB64,
                            path: msg.path,
                            armored: "-----BEGIN PGP MESSAGE-----\nciphertext\n-----END PGP MESSAGE-----",
                        },
                    });
                }
            });
            try {
                const triggerReceiver = portReceivers["trigger"];
                const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
                const replyPromise = dispatchPasskey({ requestId: "pw-create", op: "create", options: CREATE_OPTIONS() });
                const trigger = await popupPromise;

                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const contextPromise = nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "ready" });
                const context = await contextPromise;
                assert.strictEqual(context.context.op, "create");
                assert.strictEqual(context.context.user.name, "alice");

                popup.postMessage({ action: "passkey-create" });
                const created = await nextMessage(popup, "passkey-created", 3000);
                assert.strictEqual(created.path, "passkeys/example.com/alice.gpg");
                assert.ok(created.armored.includes("BEGIN PGP MESSAGE"));
                assert.ok(createPhase, "create phase should have been requested");
                assert.strictEqual(createPhase.userName, "alice");
                assert.strictEqual(createPhase.userDisplayName, "Alice");
                assert.strictEqual(createPhase.path, "passkeys/example.com/alice.gpg");

                popup.postMessage({ action: "passkey-create-ack" });
                const response = await replyPromise;
                assert.strictEqual(response.type, "response");
                assert.strictEqual(response.credential.op, "create");
                assert.strictEqual(response.credential.id, b64url(new Uint8Array(32).fill(0x42)));
                // SPKI must be base64url; authData must end with the COSE key for the given key pair
                const authData = Buffer.from(response.credential.response.authData, "base64url");
                assert.strictEqual(authData.length, 164);
                // COSE key is a5 01 02 03 26 20 01 21 58 20 <x32> 22 58 20 <y32>: x starts at offset 10
                assert.strictEqual(Buffer.from(pubKeyHex.slice(0, 64), "hex").equals(authData.subarray(-77 + 10, -77 + 42)), true);
                assert.strictEqual(Buffer.from(pubKeyHex.slice(64), "hex").equals(authData.subarray(-32)), true);
                const attestationObject = Buffer.from(response.credential.response.attestationObject, "base64url");
                assert.ok(attestationObject.subarray(0, 32).toString("hex").startsWith("a363666d74646e6f6e65")); // {"fmt":"none",...}
                assert.strictEqual(Buffer.from(response.credential.response.spki, "base64url").toString("base64"), spkiB64);
            } finally {
                teardown();
            }
        });

        test("a second create is refused while a minted credential awaits saving", async () => {
            clearBody();
            let mintCount = 0;
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") {
                    port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
                } else if (msg.phase === "create") {
                    mintCount++;
                    port.postMessage({
                        action: "passkey-result",
                        result: {
                            op: "create",
                            credentialId: b64url(new Uint8Array(32).fill(0x42)),
                            publicKey: "aa".repeat(32) + "bb".repeat(32),
                            spki: Buffer.from(new Uint8Array(91).fill(0x01)).toString("base64"),
                            path: msg.path,
                            armored: "-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----",
                        },
                    });
                }
            });
            try {
                const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
                dispatchPasskey({ requestId: "pw-first", op: "create", options: CREATE_OPTIONS() });
                const trigger = await popupPromise;
                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                popup.postMessage({ action: "ready" });
                await nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "passkey-create" });
                await nextMessage(popup, "passkey-created", 3000);

                // a new ceremony must not supersede the minted, unsaved credential
                const second = await dispatchPasskey({ requestId: "pw-second", op: "create", options: CREATE_OPTIONS() });
                assert.strictEqual(second.type, "error");
                assert.strictEqual(second.name, "NotAllowedError");
                assert.strictEqual(mintCount, 1, "no second credential may be minted");

                // the original ceremony is still alive and can finish its save flow
                const firstReply = new Promise((resolve) => {
                    const listener = (ev) => {
                        const d = JSON.parse(ev.detail);
                        if (d.requestId === "pw-first") {
                            document.removeEventListener("parcel-webauthn-response", listener);
                            resolve(d);
                        }
                    };
                    document.addEventListener("parcel-webauthn-response", listener);
                });
                popup.postMessage({ action: "passkey-cancel" });
                const first = await firstReply;
                assert.strictEqual(first.type, "error");
                assert.ok(first.message.includes("not completed"), `Expected minted-cancel message, got: ${first.message}`);
            } finally {
                teardown();
                // consented ceremony resets the dismissal streak the cancel grew
                await runSuccessfulAssertion("pw-second-created-cleanse");
            }
        });

        test("forged events from cross-origin frames with policy denial are refused before agent contact", async () => {
            clearBody();
            let contacted = false;
            const teardown = fakePasskeyAgent(() => {
                contacted = true;
            });
            // Simulate a cross-origin iframe: jsdom's window.top is non-configurable,
            // so shadow the global window with a derived object whose top accessor throws.
            const fakeWindow = Object.create(window);
            Object.defineProperty(fakeWindow, "top", {
                get() {
                    return Object.defineProperty({}, "location", {
                        get() {
                            throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
                        },
                    });
                },
            });
            // Provide a Permissions-Policy that denies WebAuthn — this is the
            // ISOLATED-world gate that blocks forged events when the top frame
            // has not opted in via the allow attribute
            Object.defineProperty(document, "permissionsPolicy", {
                value: { allowsFeature: () => false },
                configurable: true,
            });
            const realWindow = globalThis.window;
            const reply = (() => {
                globalThis.window = fakeWindow;
                try {
                    return dispatchPasskey({ requestId: "pw-forged", op: "get", options: GET_OPTIONS() });
                } finally {
                    globalThis.window = realWindow;
                }
            })();
            try {
                const response = await reply;
                assert.strictEqual(response.type, "fallback");
                assert.strictEqual(contacted, false, "the background worker must not be contacted");
            } finally {
                delete document.permissionsPolicy;
                teardown();
            }
        });

        test("requests denied by permissions policy fall back to the browser", async () => {
            clearBody();
            let contacted = false;
            const teardown = fakePasskeyAgent(() => {
                contacted = true;
            });
            Object.defineProperty(document, "permissionsPolicy", {
                value: { allowsFeature: () => false },
                configurable: true,
            });
            try {
                const response = await dispatchPasskey({ requestId: "pw-policy", op: "create", options: CREATE_OPTIONS() });
                assert.strictEqual(response.type, "fallback");
                assert.strictEqual(contacted, false, "the background worker must not be contacted");
            } finally {
                delete document.permissionsPolicy;
                teardown();
            }
        });

        /**
         * Assert that a create ceremony reaches the consent popup under the given permissions
         * policy, then cancel it via the popup so the ceremony settles cleanly.
         * @param {string} requestId - Unique request identifier for this ceremony.
         * @param {(name: string) => boolean} allowsFeature - Mocked PermissionsPolicy.allowsFeature.
         * @returns {Promise<void>}
         */
        async function assertCreateReachesPopup(requestId, allowsFeature) {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            });
            Object.defineProperty(document, "permissionsPolicy", { value: { allowsFeature }, configurable: true });
            try {
                const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
                const replyPromise = dispatchPasskey({ requestId, op: "create", options: CREATE_OPTIONS() });
                const trigger = await popupPromise;
                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const container = document.querySelector(".parcel-popup.mode-passkey");
                assert.ok(container, "passkey popup should render in a mode-passkey container");
                assert.strictEqual(container.style.position, "fixed", "passkey container should be a fullscreen scrim");
                assert.ok(container.style.backgroundColor, "passkey scrim should dim the page");
                const contextPromise = nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "ready" });
                await contextPromise;
                popup.postMessage({ action: "passkey-cancel" });
                const response = await replyPromise;
                assert.strictEqual(response.name, "NotAllowedError");
            } finally {
                delete document.permissionsPolicy;
                teardown();
                // consented ceremony resets the dismissal streak the cancel grew
                await runSuccessfulAssertion(`${requestId}-cleanse`);
            }
        }

        test("create with unsatisfiable hints still reaches the popup and surfaces them", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            });
            try {
                const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
                const replyPromise = dispatchPasskey({
                    requestId: "pw-hints",
                    op: "create",
                    options: CREATE_OPTIONS({ hints: ["client-device", "security-key", "hybrid"] }),
                });
                const trigger = await popupPromise;
                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const contextPromise = nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "ready" });
                const context = await contextPromise;
                // hints must not defer the ceremony — it reaches the popup
                assert.strictEqual(context.context.op, "create");
                assert.deepStrictEqual(context.context.hintWarning.violated, ["security-key", "hybrid"]);
                popup.postMessage({ action: "passkey-cancel" });
                const response = await replyPromise;
                assert.strictEqual(response.name, "NotAllowedError");
            } finally {
                teardown();
                await runSuccessfulAssertion("pw-hints-cleanse");
            }
        });

        test("non-compliant hint strings are length-capped and classified", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            });
            try {
                const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
                const longHint = "x".repeat(100);
                dispatchPasskey({ requestId: "pw-noncomp", op: "create", options: CREATE_OPTIONS({ hints: [longHint] }) });
                const trigger = await popupPromise;
                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const contextPromise = nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "ready" });
                const context = await contextPromise;
                assert.strictEqual(context.context.hintWarning.violated.length, 0);
                assert.strictEqual(context.context.hintWarning.nonCompliant.length, 1);
                assert.ok(context.context.hintWarning.nonCompliant[0].endsWith("\u2026"), "long hint truncated");
                assert.ok(context.context.hintWarning.nonCompliant[0].length <= 65);
                popup.postMessage({ action: "passkey-cancel" });
            } finally {
                teardown();
                await runSuccessfulAssertion("pw-noncomp-cleanse");
            }
        });

        test("create honours the split publickey-credentials-create permission name", async () => {
            // current engines only know the split names; unknown names evaluate to false
            await assertCreateReachesPopup(
                "pw-policy-split",
                (name) => name === "publickey-credentials-create" || name === "publickey-credentials-get",
            );
        });

        test("create falls back to the legacy publickey-credentials permission name", async () => {
            // pre-split engines only know the combined name
            await assertCreateReachesPopup("pw-policy-legacy", (name) => name === "publickey-credentials");
        });

        test("cross-origin iframe with permissions-policy allow reaches the popup", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            });
            // Simulate a cross-origin iframe: jsdom's window.top is non-configurable,
            // so shadow the global window with a derived object whose top accessor throws.
            const fakeWindow = Object.create(window);
            Object.defineProperty(fakeWindow, "top", {
                get() {
                    return Object.defineProperty({}, "location", {
                        get() {
                            throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
                        },
                    });
                },
            });
            Object.defineProperty(document, "permissionsPolicy", {
                value: { allowsFeature: () => true },
                configurable: true,
            });
            const realWindow = globalThis.window;
            globalThis.window = fakeWindow;
            try {
                const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
                const replyPromise = dispatchPasskey({ requestId: "pw-xorigin-allowed", op: "create", options: CREATE_OPTIONS() });
                const trigger = await popupPromise;
                const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
                await settleAsync();
                const contextPromise = nextMessage(popup, "passkey-context", 3000);
                popup.postMessage({ action: "ready" });
                const context = await contextPromise;
                assert.strictEqual(context.context.op, "create", "ceremony should reach the popup despite cross-origin iframe");
                popup.postMessage({ action: "passkey-cancel" });
                const response = await replyPromise;
                assert.strictEqual(response.name, "NotAllowedError");
            } finally {
                globalThis.window = realWindow;
                delete document.permissionsPolicy;
                teardown();
                await runSuccessfulAssertion("pw-xorigin-allowed-cleanse");
            }
        });

        test("cross-origin iframe without permissions-policy API proceeds to candidates", async () => {
            clearBody();
            const teardown = fakePasskeyAgent((port, msg) => {
                if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            });
            // No permissionsPolicy API — ceremony proceeds via the MAIN-world gate and downstream validation.
            const fakeWindow = Object.create(window);
            Object.defineProperty(fakeWindow, "top", {
                get() {
                    return Object.defineProperty({}, "location", {
                        get() {
                            throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
                        },
                    });
                },
            });
            const realWindow = globalThis.window;
            globalThis.window = fakeWindow;
            try {
                const response = await dispatchPasskey({ requestId: "pw-xorigin-nopolicy", op: "get", options: GET_OPTIONS() });
                // get with no candidates still falls back (no stored passkeys),
                // but the background worker was contacted — that's how it knows
                assert.strictEqual(response.type, "fallback");
            } finally {
                globalThis.window = realWindow;
                teardown();
            }
        });
    });
});

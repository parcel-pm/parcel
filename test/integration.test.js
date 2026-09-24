"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import {
    setupIntegration,
    teardownIntegration,
    flushMicrotasks,
    settleAsync,
    nextMessage,
    makeValidConfig,
    clearBody,
    makeInput,
    click,
} from "./integration-harness.js";

/**
 * Test suite for integration.js content script.
 *
 * Bootstrap lives in integration-harness.js (single once-per-process module
 * import of integration.js); this file binds the harness context into the
 * local names the tests use.
 */

let ctx;
let document, window, mock, portReceivers, portCallers;
let stashReports, initStashReports, trackedTimers;

before(async () => {
    ctx = await setupIntegration();
    ({ window, document, mock, portReceivers, portCallers, stashReports, initStashReports, trackedTimers } = ctx);
});

after(() => teardownIntegration(ctx));
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

    test("document lifecycle reports stash presence (fresh init and bfcache restore)", async () => {
        // fresh init: the snapshot in before() — a fresh top document reports no stash
        assert.ok(
            initStashReports.some((r) => r.stashed === false),
            "a fresh top document must report the absence of a stashed error",
        );

        // bfcache restore: a persisted pageshow must re-report a present stash
        clearBody();
        delete document._parcelError;
        mock.chrome.runtime.sendMessage({ action: "parcel-error-stash", error: "bfcache fill error" });
        await settleAsync();
        stashReports.length = 0;

        const ev = new window.Event("pageshow");
        ev.persisted = true;
        window.dispatchEvent(ev);

        assert.ok(
            stashReports.some((r) => r.stashed === true),
            "a bfcache restore must re-report the stashed error as still present",
        );

        // clean up for the tests that follow — only this test asserts on the leftover stash
        delete document._parcelError;
    });

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

    test("trigger-popup re-resolves the frame ID from the worker (prerender activation, issue #163)", async () => {
        clearBody();
        ctx.liveFrameId = 42; // config-time frameId was 0; simulate a post-activation swap
        try {
            const input = makeInput({ type: "text", name: "username" });
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            await click(input);
            const trigger = await popupPromise;
            assert.strictEqual(trigger.frameId, 42, "must dispatch the live frame ID, not the stale config-time value");

            // untargeted clicks use the same refreshed ID
            const clickPromise = nextMessage(portReceivers["trigger"], "untargeted-click", 3000);
            const div = document.createElement("div");
            document.body.appendChild(div);
            await click(div);
            const untargeted = await clickPromise;
            assert.strictEqual(untargeted.frameId, 42, "untargeted-click must also carry the live frame ID");
        } finally {
            // The content script's stale frameId self-heals on next use; a cleanup click
            // would be buffered by the mock and replayed to the next test.
            ctx.liveFrameId = 0;
        }
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

    test("fill-value is acknowledged on receipt", async () => {
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

        const ackPromise = nextMessage(port, "ack", 3000);
        port.postMessage({ action: "fill-value", value: "annie" });
        const ack = await ackPromise;
        assert.strictEqual(ack.ack, "fill-value");
        await nextMessage(port, "close", 3000);
        assert.strictEqual(input.value, "annie");
    });

    test("fill is acknowledged on receipt", async () => {
        clearBody();
        const input = makeInput({ type: "text", name: "username" });
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

        const ackPromise = nextMessage(port, "ack", 3000);
        port.postMessage({ action: "fill", config: makeValidConfig(), plaintext: "login: alice\nsecret: wonderland" });
        const ack = await ackPromise;
        assert.strictEqual(ack.ack, "fill");
        await nextMessage(port, "close", 3000);
        assert.strictEqual(input.value, "alice");
    });

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

    test("broadcast error on a dead port is stashed on the document", async () => {
        clearBody();
        stashReports.length = 0;
        // connect a broadcast popup and kill the port before the content
        // script processes the connection; the error post must fail
        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        port.disconnect();
        await settleAsync();

        assert.strictEqual(document._parcelError, "Cannot find a suitable autofill target.");
        assert.ok(
            stashReports.some((r) => r.stashed === true),
            "the stash presence must be reported so the worker can badge the tab",
        );

        // clean up for the tests that follow — only this test asserts on the leftover stash
        delete document._parcelError;
    });

    test("undeliverable popup error in a non-top frame is relayed to the worker instead of stashed", async () => {
        clearBody();
        delete document._parcelError;
        stashReports.length = 0;
        const input = makeInput({ type: "email", name: "user" });
        const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
        await click(input);
        await popupPromise;
        const token = input._parcelToken;
        assert.ok(token);

        // pretend this is an iframe: JSDOM cannot represent a non-top frame
        // (its window.top is an immutable self-reference), so swap
        // globalThis.window for a proxy whose top is a different object. The
        // swap must cover the async continuation in which the failed error
        // post relays, so it is restored only after settleAsync().
        const realWindow = globalThis.window;
        const iframeWindow = new Proxy(realWindow, {
            get(t, p) {
                if (p === "top") return {}; // some other object - this "frame" is not the top frame
                const v = Reflect.get(t, p, t);
                return typeof v === "function" ? v.bind(t) : v;
            },
            set(t, p, v) {
                return Reflect.set(t, p, v, t);
            },
            has(t, p) {
                return Reflect.has(t, p);
            },
        });
        try {
            input.style.display = "none"; // make getTargetInfo reject so the error post fires
            globalThis.window = iframeWindow;
            const port = mock.chrome.runtime.connect({ name: token });
            port.disconnect();
            await settleAsync();
        } finally {
            globalThis.window = realWindow;
        }

        assert.strictEqual(document._parcelError, undefined, "a non-top frame must not write the top frame's stash");
        const relays = stashReports.filter((r) => typeof r.error === "string");
        assert.strictEqual(relays.length, 1, "exactly one error must be relayed to the worker");
        assert.ok(
            relays[0].error.includes("The best-match autofill candidate was unsuitable"),
            "the relayed error must be the popup error",
        );
        assert.ok(!("stashed" in relays[0]), "a relayed error must not carry a presence field");
        delete document._parcelError;
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

    test("broadcast origin response reports fillable classes present on the page", async () => {
        clearBody();
        makeInput({ type: "email", name: "user" });
        makeInput({ type: "text", name: "cc-number", autocomplete: "cc-number" });

        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        let msg = await originPromise;

        assert.ok(Array.isArray(msg.targetClasses), "broadcast origin message carries targetClasses");
        assert.ok(msg.targetClasses.includes("card"), "card class reported when card fields are fillable");
        assert.ok(msg.targetClasses.includes("login"), "login class reported when login fields are fillable");

        // Without card fields, the card class is not reported
        clearBody();
        makeInput({ type: "email", name: "user" });
        const port2 = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const originPromise2 = nextMessage(port2, "origin", 3000);
        port2.postMessage({ action: "ready" });
        msg = await originPromise2;

        assert.ok(!msg.targetClasses.includes("card"), "card class not reported without fillable card fields");
        assert.ok(msg.targetClasses.includes("login"), "login class still reported");
    });

    test("element-token origin response does not report targetClasses", async () => {
        // Only the toolbar (broadcast) popup needs class detection; context
        // popups already carry an explicit targetClass from the clicked field.
        clearBody();
        const input = makeInput({ type: "text", name: "username" });
        const triggerReceiver = portReceivers["trigger"];
        const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
        await click(input);
        await popupPromise;

        const port = mock.chrome.runtime.connect({ name: input._parcelToken });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        const msg = await originPromise;

        assert.strictEqual(msg.targetClasses, undefined, "targetClasses is only sent to broadcast connections");
    });

    test("stash instruction stores the error, which the next popup consumes and clears", async () => {
        clearBody();
        makeInput({ type: "email", name: "user" });
        delete document._parcelError;
        stashReports.length = 0;
        mock.chrome.runtime.sendMessage({ action: "parcel-error-stash", error: "the fill failed" });
        await settleAsync();
        assert.strictEqual(document._parcelError, "the fill failed", "the instruction handler must store the stash");
        assert.ok(
            stashReports.some((r) => r.stashed === true),
            "the instruction handler must report stash presence for the badge",
        );

        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const errPromise = nextMessage(port, "error", 3000);
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        assert.strictEqual((await errPromise).error, "An earlier error occurred: the fill failed");
        await originPromise;

        assert.strictEqual(document._parcelError, undefined, "the stash must be deleted after a successful delivery");
        assert.ok(
            stashReports.some((r) => r.stashed === false),
            "the badge clear must be reported after delivery",
        );
    });

    test("broadcast popup ready without a stashed error pushes no error", async () => {
        clearBody();
        makeInput({ type: "email", name: "user" });
        delete document._parcelError;
        stashReports.length = 0;
        const port = mock.chrome.runtime.connect({ name: "broadcast" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        let sawError = false;
        port.onMessage.addListener((msg) => {
            if (msg?.action === "error") sawError = true;
        });
        const originPromise = nextMessage(port, "origin", 3000);
        port.postMessage({ action: "ready" });
        await originPromise;
        await settleAsync();
        assert.strictEqual(sawError, false, "no error may be pushed when no stash exists");
        assert.strictEqual(stashReports.length, 0, "no badge report may be sent when no stash exists");
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
});

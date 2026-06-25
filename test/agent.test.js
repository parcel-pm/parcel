"use strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createChromeMock } from "./chrome-api-mock.js";
import { Agent } from "../src/js/agent.js";

const noopConsole = { log() {}, error() {}, warn() {}, info() {} };
let realConsole;

/**
 * Yield to the event loop until the entire microtask queue is drained.
 *
 * A macrotask (setTimeout) only executes after the event loop has emptied
 * the *entire* microtask queue, including all chained promise resolutions.
 */
function settleAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function once(emitter, event) {
    return new Promise((resolve) => emitter.addEventListener(event, resolve, { once: true }));
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
        targets: [],
    };
}

function stubInitAssets(mock) {
    mock.registerFetchResponse(mock.chrome.runtime.getURL("parcel-host"), "fake-script");
    mock.registerFetchResponse(mock.chrome.runtime.getURL("parcel-host.asc"), "fake-sig");
    mock.registerFetchResponse(mock.chrome.runtime.getURL("/public_suffix_list.dat"), "com\norg\n");
}

function installNativeHandler(mock, handlerFn) {
    const port = mock.getNativePort("com.github.erayd.parcel");
    const listener = (msg) => {
        const reply = handlerFn(msg);
        if (reply !== undefined) port.receiver.postMessage({ token: msg.token, data: reply });
    };
    port.receiver.onMessage.addListener(listener);
    return listener;
}
function uninstallNativeHandler(mock, listener) {
    mock.getNativePort("com.github.erayd.parcel").receiver.onMessage.removeListener(listener);
}

let mock;
let agent;
let handler;

beforeEach(async () => {
    realConsole = globalThis.console;
    globalThis.console = noopConsole;
    mock = createChromeMock();
    mock.installChrome();
    mock.installFetch();
    agent = new Agent();
    await settleAsync();

    handler = installNativeHandler(mock, (msg) => {
        if (msg.action === "install") return { success: true, message: "installed" };
        if (msg.action === "configure") return makeValidConfig();
        if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
        if (msg.action === "changes_since") return { changes: false };
        if (msg.action === "decrypt") return { plaintext: { password: "hunter2" } };
    });

    stubInitAssets(mock);
    agent.dispatchEvent(new CustomEvent("parcel::native::bootstrap"));
    await once(agent, "ready");
});

afterEach(() => {
    globalThis.console = realConsole;
    uninstallNativeHandler(mock, handler);
});

describe("Agent", () => {
    test("unauthorised popup", async () => {
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        const errPromise = nextMessage(popup, "error");
        popup.postMessage({ action: "match", url: "https://example.com" });
        const err = await errPromise;
        assert.ok(err.error?.includes("Unauthorised"), "Unauthorised popup");
    });

    test("single-use token auth", async () => {
        const authPort = mock.chrome.runtime.connect({ name: "auth" });
        await settleAsync();
        authPort.postMessage("single-secret-token");

        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "single-secret-token", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({ action: "match", url: "https://example.com" });
        const match = await matchPromise;
        assert.strictEqual(match.entries.length, 1);

        // Second attempt with same token should fail (single-use deleted)
        const popup2 = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        const errPromise = nextMessage(popup2, "error");
        popup2.postMessage({ action: "match", url: "https://example.com" });
        const err = await errPromise;
        assert.ok(err.error?.includes("Unauthorised"), "token consumed after first use");
    });

    test("broadcast token", async () => {
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({ action: "match", url: "https://example.com" });
        const match = await matchPromise;
        assert.strictEqual(match.entries.length, 1);
        assert.strictEqual(match.entries[0].name, "example.com/admin");
    });

    test("search filters entries", async () => {
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({ action: "match", url: "https://example.com", search: "nomatch" });
        const match = await matchPromise;
        assert.strictEqual(match.entries.length, 0);
    });

    test("not connected to native host", async () => {
        const nativePort = mock.getNativePort("com.github.erayd.parcel");
        nativePort.caller.disconnect();
        await settleAsync();

        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const errPromise = nextMessage(popup, "error");
        popup.postMessage({ action: "match", url: "https://example.com" });
        const err = await errPromise;
        assert.ok(err.error?.includes("Not connected to native host"), "error when native host disconnected");
    });

    test("integration config", async () => {
        const integration = mock.chrome.runtime.connect({ name: "integration", sender: { frameId: 2 } });
        await settleAsync();
        const cfgPromise = nextMessage(integration, "config");
        integration.postMessage({ action: "config" });
        const cfg = await cfgPromise;
        assert.strictEqual(cfg.frameId, 2, "config frameId");
    });

    test("sha256", async () => {
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const digestPromise = nextMessage(popup, "sha256-digest");
        popup.postMessage({ action: "sha256", value: "hello" });
        const digest = await digestPromise;
        assert.strictEqual(digest.hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    test("decrypt from authorised popup", async () => {
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1, url: "https://example.com" } });
        const plaintextPromise = nextMessage(popup, "plaintext");
        popup.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        const pt = await plaintextPromise;
        assert.deepStrictEqual(pt.plaintext, { password: "hunter2" });
    });

    test("decrypt rejected from integration port", async () => {
        const integration = mock.chrome.runtime.connect({ name: "integration" });
        await settleAsync();
        const errPromise = nextMessage(integration, "error");
        integration.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        const err = await errPromise;
        assert.ok(err.error?.includes("not permitted"), "decrypt blocked on integration port");
    });

    test("unknown action rejected", async () => {
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const errPromise = nextMessage(popup, "error");
        popup.postMessage({ action: "exfiltrate" });
        const err = await errPromise;
        assert.ok(err.error?.includes("not permitted"), "unknown action blocked");
    });

    test("trigger relay", async () => {
        const trigger = mock.chrome.runtime.connect({ name: "trigger", sender: { tab: { id: 7, url: "https://example.com" } } });
        await settleAsync();
        const top = mock.findTabPort(7, 0);
        assert.ok(top, "top port");
        const relayPromise = nextMessage(top, "open-popup");
        trigger.postMessage({ action: "open-popup" });
        const relayed = await relayPromise;
        assert.deepStrictEqual(relayed, { action: "open-popup" });
    });

    test("popup bridge tab-context", async () => {
        const bridge = mock.chrome.runtime.connect({ name: "popup-bridge:tok123:0", sender: { tab: { id: 5, url: "https://site.com" } } });
        const ctx = await nextMessage(bridge, "tab-context");
        assert.strictEqual(ctx.tab.id, 5);
        assert.strictEqual(ctx.tab.url, "https://site.com");
    });

    test("bridge without tab disconnects", async () => {
        const bridge = mock.chrome.runtime.connect({ name: "popup-bridge:tok:0", sender: { tab: null } });
        const disconnected = new Promise((resolve) => bridge.onDisconnect.addListener(resolve));
        await settleAsync();
        await disconnected;
        assert.ok(true, "no-tab disconnect");
    });

    test("bridge disconnect tears down both sides", async () => {
        const bridge = mock.chrome.runtime.connect({ name: "popup-bridge:tok:0", sender: { tab: { id: 3, url: "https://x.com" } } });
        await settleAsync();
        const receiver = mock.findTabPort(3, 0);
        let a = false,
            b = false;
        bridge.onDisconnect.addListener(() => {
            a = true;
        });
        receiver.onDisconnect.addListener(() => {
            b = true;
        });
        bridge.disconnect();
        assert.strictEqual(a, true, "bridge disconnect caller");
        assert.strictEqual(b, true, "bridge disconnect receiver");
    });
});

describe("Agent initialisation failures", () => {
    let scopedMock;
    let scopedAgent;
    let scopedHandler;

    beforeEach(async () => {
        realConsole = globalThis.console;
        globalThis.console = noopConsole;
        scopedMock = createChromeMock();
        scopedMock.installChrome();
        scopedMock.installFetch();
        scopedAgent = new Agent();
        await settleAsync();
    });

    afterEach(() => {
        globalThis.console = realConsole;
        if (scopedHandler) uninstallNativeHandler(scopedMock, scopedHandler);
    });

    test("invalid config triggers initFailed", async () => {
        scopedHandler = installNativeHandler(scopedMock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return { modified: 1, passdir: "/home/test/.password-store" };
        });
        stubInitAssets(scopedMock);
        scopedAgent.dispatchEvent(new CustomEvent("parcel::native::bootstrap"));
        const ev = await once(scopedAgent, "initFailed");
        assert.ok(ev.detail?.includes("Invalid configuration"), "initFailed fired with config error");
    });
});

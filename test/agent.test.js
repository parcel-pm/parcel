"use strict";
import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert";
import { createChromeMock } from "./chrome-api-mock.js";
import { Agent } from "../src/js/agent.js";

const noopConsole = { log() {}, error() {}, warn() {}, info() {}, debug() {} };
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
        handleHttpAuth: true,
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
        if (msg.action === "decrypt") {
            if (msg.intent === "http-auth") return { plaintext: "secret: hunter2\nlogin: testuser\n" };
            return { plaintext: { password: "hunter2" } };
        }
    });

    stubInitAssets(mock);
    agent.dispatchEvent(new CustomEvent("parcel::native::bootstrap"));
    await once(agent, "ready");
});

afterEach(() => {
    // Destroy the agent first to cancel the 1s reconnect timer and stop the
    // 60s ping interval, both of which would otherwise keep the process alive.
    agent?.destroy();
    globalThis.console = realConsole;
    uninstallNativeHandler(mock, handler);
});

after(async () => {
    await settleAsync(); // drain pending microtasks after destroy()
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

    test("broadcast fill fallback carries the intended origin", async () => {
        // Simulate a slow decrypt (deferred native reply) with the popup port
        // disconnecting mid-decrypt, forcing the agent's fire-and-forget fallback.
        uninstallNativeHandler(mock, handler);
        let resolveDecrypt;
        let signalStarted;
        const decryptStarted = new Promise((r) => {
            signalStarted = r;
        });
        const decryptDelay = new Promise((r) => {
            resolveDecrypt = r;
        });
        handler = installNativeHandler(mock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return makeValidConfig();
            if (msg.action === "changes_since") return { changes: false };
            if (msg.action === "decrypt") {
                signalStarted();
                return decryptDelay.then(() => ({ plaintext: { password: "hunter2" } }));
            }
        });

        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1, url: "https://example.com" } });
        await settleAsync();
        popup.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        // Wait until the decrypt is in-flight (native decrypt invoked, port still
        // connected) before disconnecting the popup mid-decrypt.
        await decryptStarted;
        popup.disconnect();
        resolveDecrypt();
        // Give the agent's async handler time to run the fallback and its trailing
        // bookkeeping, which must not error now that posting to a disconnected port is
        // skipped.
        await new Promise((r) => setTimeout(r, 20));

        const tabPort = mock.findTabPort(1, 0);
        assert.ok(tabPort, "agent connected a broadcast tab port for the fallback");
        const delivered = await nextMessage(tabPort, "fill");
        assert.strictEqual(delivered.origin, "https://example.com", "fallback carries the intended origin");
        assert.deepStrictEqual(delivered.plaintext, { password: "hunter2" }, "plaintext delivered");
    });

    test("concurrent searches debounce action_list calls", async () => {
        // Replace the default handler with one that delays the list response
        // so multiple match requests can arrive before the first returns.
        uninstallNativeHandler(mock, handler);

        let listCalls = 0;
        let resolveList;
        const listDelay = new Promise((r) => {
            resolveList = r;
        });
        const nativePort = mock.getNativePort("com.github.erayd.parcel");

        handler = installNativeHandler(mock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return makeValidConfig();
            if (msg.action === "changes_since") return { changes: false };
            if (msg.action === "decrypt") return { plaintext: { password: "hunter2" } };
            if (msg.action === "list") {
                listCalls++;
                listDelay.then(() => {
                    nativePort.receiver.postMessage({
                        token: msg.token,
                        data: [{ name: "example.com/admin", path: "example.com/admin" }],
                    });
                });
                return undefined;
            }
        });

        // Fire two concurrent match requests before the first list call returns.
        const popup1 = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup1.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const match1Promise = nextMessage(popup1, "match");
        popup1.postMessage({ action: "match", url: "https://example.com" });
        await settleAsync();

        const popup2 = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup2.postMessage({ action: "auth", token: "broadcast", tab: { id: 2 } });
        const match2Promise = nextMessage(popup2, "match");
        popup2.postMessage({ action: "match", url: "https://example.com" });
        await settleAsync();

        // Before releasing the list response, only one list call should have
        // been dispatched. This is guaranteed by the #callNative semaphore
        // (which serialises native calls), not by the debounce — the debounce
        // is verified by the final assertion below.
        assert.strictEqual(listCalls, 1, "action_list called only once before response");

        resolveList();

        const [match1, match2] = await Promise.all([match1Promise, match2Promise]);
        assert.strictEqual(match1.entries.length, 1, "popup1 received entries");
        assert.strictEqual(match2.entries.length, 1, "popup2 received entries");
        assert.strictEqual(listCalls, 1, "action_list only called once despite concurrent searches");
    });

    test("path hashes are cached across searches on the same entry list", async () => {
        // Verify Helpers.sha256 (via crypto.subtle.digest) is called once per
        // entry path on the first search, then skipped on subsequent searches
        // that reuse the cached entry list (same entry objects within the TTL).
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });

        const subtle = crypto.subtle;
        const realDigest = subtle.digest.bind(subtle);
        let digestCalls = 0;
        // Spy on crypto.subtle.digest, delegating to the real implementation.
        subtle.digest = (algorithm, data) => {
            digestCalls++;
            return realDigest(algorithm, data);
        };
        try {
            // First search loads the entry list and hashes each path once.
            let matchPromise = nextMessage(popup, "match");
            popup.postMessage({ action: "match", url: "https://example.com" });
            const match1 = await matchPromise;
            assert.strictEqual(match1.entries.length, 1, "first match returned entry");
            const callsAfterFirst = digestCalls;
            assert.ok(callsAfterFirst >= 1, "digest called on first search");

            // Second search reuses the cached entry list and the cached path hash.
            matchPromise = nextMessage(popup, "match");
            popup.postMessage({ action: "match", url: "https://example.com" });
            const match2 = await matchPromise;
            assert.strictEqual(match2.entries.length, 1, "second match returned entry");
            assert.strictEqual(digestCalls, callsAfterFirst, "digest not called again on cached search");
        } finally {
            delete subtle.digest;
        }
    });

    test("non-whitelisted actions rejected from integration port", async () => {
        for (const action of ["decrypt", "match", "sha256"]) {
            const integration = mock.chrome.runtime.connect({ name: "integration" });
            await settleAsync();
            const errPromise = nextMessage(integration, "error");
            integration.postMessage({ action });
            const err = await errPromise;
            assert.ok(err.error?.includes("not permitted"), `${action} blocked on integration port`);
            integration.disconnect();
        }
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

    test("onStartup reconnects native host after disconnect", async () => {
        const original = mock.getNativePort("com.github.erayd.parcel");
        original.caller.disconnect();
        await settleAsync();
        if (chrome.runtime.lastError) chrome.runtime.lastError = null;

        mock.fireRuntimeStartup();
        await settleAsync();

        const reconnected = mock.getNativePort("com.github.erayd.parcel");
        assert.notStrictEqual(reconnected, original, "onStartup established a new native connection");
        assert.ok(reconnected, "native port exists after reconnect");
    });

    test("onInstalled reconnects native host after disconnect", async () => {
        const original = mock.getNativePort("com.github.erayd.parcel");
        original.caller.disconnect();
        await settleAsync();
        if (chrome.runtime.lastError) chrome.runtime.lastError = null;

        mock.fireRuntimeInstalled();
        await settleAsync();

        const reconnected = mock.getNativePort("com.github.erayd.parcel");
        assert.notStrictEqual(reconnected, original, "onInstalled established a new native connection");
        assert.ok(reconnected, "native port exists after reconnect");
    });

    test("lifecycle hooks are idempotent when native host is already connected", async () => {
        const before = mock.getNativePort("com.github.erayd.parcel");
        assert.ok(before, "native host connected before event");

        mock.fireRuntimeStartup();
        mock.fireRuntimeInstalled();
        await settleAsync();

        const after = mock.getNativePort("com.github.erayd.parcel");
        assert.strictEqual(after, before, "no spurious reconnect when already connected");
    });

    describe("HTTP auth interception", () => {
        test("returns credentials via popup port decrypt", async () => {
            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            // The background sends a trigger message to the content script.
            // The popup connects via a "popup" port with the per-challenge token.
            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            // Now simulate a match + decrypt with intent "http-auth"
            const matchPromise = nextMessage(popup, "match");
            popup.postMessage({ action: "match", url: "https://example.com/", search: "", limit: true, history: [] });
            const match = await matchPromise;
            assert.ok(match.entries.length > 0, "popup received matching entries");

            const donePromise = nextMessage(popup, "http-auth-done");
            popup.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://example.com/", path: "example.com/admin" });
            await donePromise;

            const result = await resultPromise;
            assert.ok(result.authCredentials, "result has authCredentials");
            assert.strictEqual(result.authCredentials.username, "testuser");
            assert.strictEqual(result.authCredentials.password, "hunter2");

            popup.disconnect();
        });

        test("cancel aborts navigation without native dialog", async () => {
            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            popup.postMessage({ action: "http-auth-cancel" });
            await settleAsync();

            const result = await resultPromise;
            assert.deepStrictEqual(result, { cancel: true }, "cancel resolves with { cancel: true }");

            popup.disconnect();
        });

        test("cancel-then-decrypt doesn't expose plaintext", async () => {
            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            // Simulate the timer expiring before the user selects an entry by
            // sending http-auth-cancel, which calls #resolveAuthCallback and
            // removes the entry from #pendingAuthCallbacks.
            popup.postMessage({ action: "http-auth-cancel" });
            await settleAsync();

            const result = await resultPromise;
            assert.deepStrictEqual(result, { cancel: true }, "cancel resolves callback");

            // Now the user selects an entry and decrypt fires with intent "http-auth".
            // The popup should receive http-auth-done but NOT a plaintext message,
            // because the callback was already resolved (the token is gone from
            // #pendingAuthCallbacks).
            let plaintextReceived = false;
            popup.onMessage.addListener((msg) => {
                if (msg.action === "plaintext") plaintextReceived = true;
            });

            const donePromise = nextMessage(popup, "http-auth-done");
            popup.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://example.com/", path: "example.com/admin" });
            await donePromise;

            assert.ok(!plaintextReceived, "plaintext is not posted to popup after callback already resolved");

            popup.disconnect();
        });

        test("manual fallback shows native dialog", async () => {
            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            popup.postMessage({ action: "http-auth-manual" });
            await settleAsync();
            await settleAsync();

            const result = await resultPromise;
            assert.deepStrictEqual(result, {}, "manual resolves with {} for native dialog");

            // Verify the manual-mode flag was stored in session storage
            assert.ok(mock.sessionStorageMap.has("http-auth-manual:1:https://example.com"), "session storage flag set with origin");

            popup.disconnect();
        });

        test("re-fire after manual mode passes through to native dialog", async () => {
            // First fire: user chooses "Enter manually"
            const firstPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            popup.postMessage({ action: "http-auth-manual" });
            await settleAsync();
            await settleAsync();

            const firstResult = await firstPromise;
            assert.deepStrictEqual(firstResult, {}, "first fire resolves with {}");

            popup.disconnect();
            await settleAsync();

            // Second fire: user cancelled the native dialog, Chrome re-fires
            const secondPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const secondResult = await secondPromise;
            assert.deepStrictEqual(secondResult, {}, "second fire passes through to native dialog");
        });

        test("popup disconnect falls back to native dialog if callback still pending", async () => {
            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            // Popup connects and authenticates, then disconnects without
            // sending a cancel or manual message (e.g. tab closed, popup
            // crashed, or close message arrived before cancel was processed).
            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            popup.disconnect();
            await settleAsync();

            const result = await resultPromise;
            assert.deepStrictEqual(result, {}, "disconnect resolves with {} (native dialog fallback)");
        });

        test("sendMessage failure falls back to popup window", async () => {
            // Content script not present (e.g. extension just installed on an open page)
            mock.setSendMessageFailure("Could not establish connection");

            mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            // Should fall back to opening a popup window
            assert.ok(mock.windowsCreated.length > 0, "popup window created as fallback");
        });

        test("new-tab navigation opens popup window", async () => {
            // Simulate a new tab with no loaded page (about:blank)
            mock.setCurrentTab({ id: 99, status: "loading", url: "about:blank" });

            mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 99,
                url: "https://authenticationtest.com/HTTPAuth/",
            });
            await settleAsync();
            await settleAsync();

            // Should NOT send a message (no content script)
            assert.strictEqual(mock.sentMessages.length, 0, "sendMessage not called for new-tab navigation");

            // Should open a popup window instead
            assert.ok(mock.windowsCreated.length > 0, "popup window created");
            const window = mock.windowsCreated[0];
            assert.ok(window.url.includes("window=1"), "popup URL includes window=1");
            assert.ok(window.url.includes("token="), "popup URL includes per-challenge token");
            assert.ok(!window.url.includes("token=http-auth"), "popup URL does not use fixed token");
            assert.strictEqual(window.type, "popup", "window type is popup");
        });

        test("rejects form-fill intent with http-auth token", async () => {
            mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            const errorPromise = nextMessage(popup, "error");
            popup.postMessage({ action: "decrypt", intent: "fill", origin: "https://example.com/", path: "example.com/admin" });
            const errorMsg = await errorPromise;
            assert.ok(errorMsg.error.includes("not permitted"), "fill intent rejected for http-auth token");

            popup.disconnect();
        });

        test("missing login/secret falls back to native dialog", async () => {
            // Override the native handler to return plaintext without login/secret fields
            uninstallNativeHandler(mock, handler);
            handler = installNativeHandler(mock, (msg) => {
                if (msg.action === "install") return { success: true, message: "installed" };
                if (msg.action === "configure") return makeValidConfig();
                if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
                if (msg.action === "changes_since") return { changes: false };
                if (msg.action === "decrypt") return { plaintext: "totp: JBSWY3DPEHPK3PXP\n" };
            });
            const popup0 = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup0.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
            const cfgPromise = nextMessage(popup0, "config");
            popup0.postMessage({ action: "config" });
            await cfgPromise;
            popup0.disconnect();
            await settleAsync();

            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            const donePromise = nextMessage(popup, "http-auth-done");
            popup.postMessage({ action: "match", url: "https://example.com/", search: "", limit: true, history: [] });
            await nextMessage(popup, "match");
            popup.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://example.com/", path: "example.com/admin" });
            await donePromise;

            const result = await resultPromise;
            assert.deepStrictEqual(result, {}, "missing fields resolves with {} for native dialog");

            popup.disconnect();
        });

        test("malformed decrypt falls back to native dialog", async () => {
            // Override the native handler to return a malformed decrypt result
            uninstallNativeHandler(mock, handler);
            handler = installNativeHandler(mock, (msg) => {
                if (msg.action === "install") return { success: true, message: "installed" };
                if (msg.action === "configure") return makeValidConfig();
                if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
                if (msg.action === "changes_since") return { changes: false };
                if (msg.action === "decrypt") return { plaintext: null };
            });
            const popup0 = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup0.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
            const cfgPromise = nextMessage(popup0, "config");
            popup0.postMessage({ action: "config" });
            await cfgPromise;
            popup0.disconnect();
            await settleAsync();

            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://example.com/",
            });
            await settleAsync();
            await settleAsync();

            const authToken = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token: authToken, tab: { id: 1, url: "https://example.com/" } });
            await settleAsync();

            const donePromise = nextMessage(popup, "http-auth-done");
            popup.postMessage({ action: "match", url: "https://example.com/", search: "", limit: true, history: [] });
            await nextMessage(popup, "match");
            popup.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://example.com/", path: "example.com/admin" });
            await donePromise;

            const result = await resultPromise;
            assert.deepStrictEqual(result, {}, "malformed decrypt resolves with {} for native dialog");

            popup.disconnect();
        });

        test("concurrent 401 challenges don't cross-route credentials", async () => {
            // Override the native handler to return distinct credentials per path,
            // so cross-routing would be detectable.
            uninstallNativeHandler(mock, handler);
            handler = installNativeHandler(mock, (msg) => {
                if (msg.action === "install") return { success: true, message: "installed" };
                if (msg.action === "configure") return makeValidConfig();
                if (msg.action === "list")
                    return [
                        { name: "example.com/bank", path: "example.com/bank" },
                        { name: "example.com/mail", path: "example.com/mail" },
                    ];
                if (msg.action === "changes_since") return { changes: false };
                if (msg.action === "decrypt") {
                    if (msg.path === "example.com/bank") return { plaintext: "secret: bankpass\nlogin: bankuser\n" };
                    if (msg.path === "example.com/mail") return { plaintext: "secret: mailpass\nlogin: mailuser\n" };
                    return { plaintext: "" };
                }
            });
            const popup0 = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup0.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
            const cfgPromise = nextMessage(popup0, "config");
            popup0.postMessage({ action: "config" });
            await cfgPromise;
            popup0.disconnect();
            await settleAsync();

            // Two tabs navigate to 401-protected URLs simultaneously. Each
            // challenge gets its own token; credentials selected in one
            // popup must resolve that challenge, not the other.
            const resultAPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 1,
                url: "https://bank.example/",
            });
            const resultBPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 2,
                url: "https://mail.example/",
            });
            await settleAsync();
            await settleAsync();

            // Both challenges should have sent trigger messages with distinct tokens
            const tokenA = mock.sentMessages[mock.sentMessages.length - 2].msg.token;
            const tokenB = mock.sentMessages[mock.sentMessages.length - 1].msg.token;
            assert.ok(tokenA && tokenB, "both challenges generated tokens");
            assert.notStrictEqual(tokenA, tokenB, "concurrent challenges get distinct tokens");

            // Resolve tab A's challenge with its own token and distinct entry
            const popupA = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popupA.postMessage({ action: "auth", token: tokenA, tab: { id: 1, url: "https://bank.example/" } });
            await settleAsync();
            const doneAPromise = nextMessage(popupA, "http-auth-done");
            popupA.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://bank.example/", path: "example.com/bank" });
            await doneAPromise;

            // Resolve tab B's challenge with its own token and distinct entry
            const popupB = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popupB.postMessage({ action: "auth", token: tokenB, tab: { id: 2, url: "https://mail.example/" } });
            await settleAsync();
            const doneBPromise = nextMessage(popupB, "http-auth-done");
            popupB.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://mail.example/", path: "example.com/mail" });
            await doneBPromise;

            const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
            assert.ok(resultA.authCredentials, "challenge A resolved with credentials");
            assert.ok(resultB.authCredentials, "challenge B resolved with credentials");
            // Each challenge must receive its own distinct credentials — if
            // credentials were cross-routed, these assertions would fail.
            assert.strictEqual(resultA.authCredentials.username, "bankuser");
            assert.strictEqual(resultA.authCredentials.password, "bankpass");
            assert.strictEqual(resultB.authCredentials.username, "mailuser");
            assert.strictEqual(resultB.authCredentials.password, "mailpass");

            popupA.disconnect();
            popupB.disconnect();

            // Restore the default handler for subsequent tests
            uninstallNativeHandler(mock, handler);
            handler = installNativeHandler(mock, (msg) => {
                if (msg.action === "install") return { success: true, message: "installed" };
                if (msg.action === "configure") return makeValidConfig();
                if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
                if (msg.action === "changes_since") return { changes: false };
                if (msg.action === "decrypt") {
                    if (msg.intent === "http-auth") return { plaintext: "secret: hunter2\nlogin: testuser\n" };
                    return { plaintext: { password: "hunter2" } };
                }
            });
            const popup0b = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup0b.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
            const cfgPromise2 = nextMessage(popup0b, "config");
            popup0b.postMessage({ action: "config" });
            await cfgPromise2;
            popup0b.disconnect();
            await settleAsync();
        });

        test("window-mode end-to-end credential resolution", async () => {
            // New tab with no content script → popup opens as a window.
            // Simulate the popup connecting with the token from the window URL.
            mock.setCurrentTab({ id: 77, status: "loading", url: "about:blank" });

            const resultPromise = mock.fireAuthRequired({
                isProxy: false,
                type: "main_frame",
                tabId: 77,
                url: "https://authenticationtest.com/HTTPAuth/",
            });
            await settleAsync();
            await settleAsync();

            // No content-script message should have been sent
            assert.strictEqual(mock.sentMessages.length, 0, "no trigger message for window mode");

            // The popup window was created with the token in the URL
            assert.ok(mock.windowsCreated.length > 0, "popup window created");
            const windowUrl = new URL(mock.windowsCreated[0].url);
            const token = windowUrl.searchParams.get("token");
            assert.ok(token, "window URL includes per-challenge token");
            assert.notStrictEqual(token, "http-auth", "window token is not the fixed string");

            // Simulate the popup connecting with the extracted token
            const popup = mock.chrome.runtime.connect({ name: "popup" });
            await settleAsync();
            popup.postMessage({ action: "auth", token, tab: { url: "https://authenticationtest.com/HTTPAuth/" } });
            await settleAsync();

            // Match + decrypt with intent "http-auth"
            const matchPromise = nextMessage(popup, "match");
            popup.postMessage({ action: "match", url: "https://example.com/", search: "", limit: true, history: [] });
            const match = await matchPromise;
            assert.ok(match.entries.length > 0, "popup received matching entries");

            const donePromise = nextMessage(popup, "http-auth-done");
            popup.postMessage({ action: "decrypt", intent: "http-auth", origin: "https://example.com/", path: "example.com/admin" });
            await donePromise;

            const result = await resultPromise;
            assert.ok(result.authCredentials, "window-mode resolved with credentials");
            assert.strictEqual(result.authCredentials.username, "testuser");
            assert.strictEqual(result.authCredentials.password, "hunter2");

            popup.disconnect();
        });
    }); // describe("HTTP auth interception")

    /**
     * Push a passkey-aware config and entry list into the agent.
     *
     * `shared/fido/` entries are rule-classed as passkeys (outside the default
     * `passkeys/` prefix); `passkeys/example.com/alice` is deliberately left
     * unclassed to exercise class-only candidacy; `test/bob` is a login entry.
     * `github.com` carries class "browser-passkey" to exercise defer-to-browser.
     * @returns {Promise<void>}
     */
    async function configurePasskeyStore() {
        const passkeyConfig = {
            ...makeValidConfig(),
            modified: 2,
            rules: [
                // a browser-passkey site rule overlaid on an entry prefix: it must neither
                // classify nor shadow these entries - the later passkey rule still applies
                { pattern: "^shared/fido/", class: "browser-passkey" },
                { pattern: "^test/", class: "login" },
                { pattern: "^shared/fido/", class: "passkey" },
                // classes carol (matching rpId) and zed (foreign rpId), but not alice
                { pattern: "^passkeys/example\\.com/carol$", class: "passkey" },
                { pattern: "^passkeys/other\\.test/", class: "passkey" },
                // proves passkey entries work from any location that names the rpId
                { pattern: "^misc/", class: "passkey" },
                { pattern: "^github\\.com$", class: "browser-passkey" },
            ],
        };
        uninstallNativeHandler(mock, handler);
        handler = installNativeHandler(mock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return passkeyConfig;
            if (msg.action === "list")
                return [
                    { name: "passkeys/example.com/alice", path: "/home/test/.password-store/passkeys/example.com/alice.gpg" },
                    { name: "passkeys/example.com/carol", path: "/home/test/.password-store/passkeys/example.com/carol.gpg" },
                    { name: "passkeys/other.test/zed", path: "/home/test/.password-store/passkeys/other.test/zed.gpg" },
                    { name: "shared/fido/alice", path: "/home/test/.password-store/shared/fido/alice.gpg" },
                    { name: "shared/fido/carol", path: "/home/test/.password-store/shared/fido/carol.gpg" },
                    { name: "misc/example.com/a", path: "/home/test/.password-store/misc/example.com/a.gpg" },
                    { name: "test/bob", path: "/home/test/.password-store/test/bob.gpg" },
                ];
            if (msg.action === "changes_since") return { changes: false };
            if (msg.action === "passkey") return { op: "get", credentialId: "Y3JlZA" };
        });
        const integration = mock.chrome.runtime.connect({ name: "integration" });
        await settleAsync();
        const configPromise = nextMessage(integration, "config");
        integration.postMessage({ action: "config", config: passkeyConfig });
        await configPromise;
    }

    test("passkey candidates are rule-classed entries whose path names the rpId", async () => {
        await configurePasskeyStore();
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const candidatesPromise = nextMessage(passkey, "passkey-candidates");
        passkey.postMessage({ action: "passkey", phase: "candidates", origin: "https://login.example.com", rpId: "example.com" });
        const msg = await candidatesPromise;
        // included: classed entries whose path names this site's rpId, wherever filed
        // excluded: the unclassed in-dir entry (alice), the foreign-rpId entry (zed),
        //           Passkey entries that never name example.com, and the login entry
        assert.deepStrictEqual(msg.candidates, [
            {
                name: "passkeys/example.com/carol",
                path: "/home/test/.password-store/passkeys/example.com/carol.gpg",
                rule: { pattern: "^passkeys/example\\.com/carol$", class: "passkey", ignore: false, color: "333333" },
            },
            {
                name: "misc/example.com/a",
                path: "/home/test/.password-store/misc/example.com/a.gpg",
                rule: { pattern: "^misc/", class: "passkey", ignore: false, color: "333333" },
            },
        ]);
    });

    test("passkey assertion is allowed for a rule-classed entry outside the passkey dir", async () => {
        await configurePasskeyStore();
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const resultPromise = nextMessage(passkey, "passkey-result");
        passkey.postMessage({
            action: "passkey",
            phase: "assert",
            path: "/home/test/.password-store/shared/fido/alice.gpg",
            origin: "https://login.example.com",
            rpId: "example.com",
            clientDataJSON: "Y2xpZW50",
            allowCredentials: [],
        });
        const msg = await resultPromise;
        assert.strictEqual(msg.result.op, "get");
    });

    test("passkey assertion is rejected for an unclassed entry inside the passkey dir", async () => {
        await configurePasskeyStore();
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const errorPromise = nextMessage(passkey, "error");
        passkey.postMessage({
            action: "passkey",
            phase: "assert",
            path: "/home/test/.password-store/passkeys/example.com/alice.gpg",
            origin: "https://login.example.com",
            rpId: "example.com",
            clientDataJSON: "Y2xpZW50",
            allowCredentials: [],
        });
        const msg = await errorPromise;
        assert.ok(msg.error?.includes("Invalid passkey entry path"), `expected path rejection, got: ${JSON.stringify(msg)}`);
    });

    test("passkey assertion normalises a mixed-case rpId", async () => {
        await configurePasskeyStore();
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const resultPromise = nextMessage(passkey, "passkey-result");
        passkey.postMessage({
            action: "passkey",
            phase: "assert",
            path: "/home/test/.password-store/shared/fido/alice.gpg",
            origin: "https://login.example.com",
            rpId: "Example.com",
            clientDataJSON: "Y2xpZW50",
            allowCredentials: [],
        });
        const msg = await resultPromise;
        assert.strictEqual(msg.result.op, "get");
    });

    test("passkey assertion is rejected for a login-classed entry outside the passkey dir", async () => {
        await configurePasskeyStore();
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const errorPromise = nextMessage(passkey, "error");
        passkey.postMessage({
            action: "passkey",
            phase: "assert",
            path: "/home/test/.password-store/test/bob.gpg",
            origin: "https://login.example.com",
            rpId: "example.com",
            clientDataJSON: "Y2xpZW50",
            allowCredentials: [],
        });
        const msg = await errorPromise;
        assert.ok(msg.error?.includes("Invalid passkey entry path"), `expected path rejection, got: ${JSON.stringify(msg)}`);
    });

    test("a browser-passkey rule defers WebAuthn ceremonies for its site", async () => {
        await configurePasskeyStore();
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const fallbackPromise = nextMessage(passkey, "passkey-fallback");
        passkey.postMessage({
            action: "passkey",
            phase: "candidates",
            origin: "https://github.com",
            rpId: "github.com",
        });
        await fallbackPromise; // no candidates, no popup - straight to the platform handler
    });

    test("a browser-passkey rule set to ignore does not defer", async () => {
        // empty entry store; only the ignored-defer rule matters
        uninstallNativeHandler(mock, handler);
        handler = installNativeHandler(mock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure")
                return {
                    ...makeValidConfig(),
                    modified: 1,
                    rules: [{ pattern: "^ignored\\.com$", ignore: true, class: "browser-passkey" }],
                };
            if (msg.action === "list") return [];
            if (msg.action === "changes_since") return { changes: false };
        });
        const passkey = mock.chrome.runtime.connect({ name: "passkey" });
        await settleAsync();
        const candidatesPromise = nextMessage(passkey, "passkey-candidates");
        passkey.postMessage({ action: "passkey", phase: "candidates", origin: "https://ignored.com", rpId: "ignored.com" });
        const msg = await candidatesPromise; // defer did not fire; candidates posted (empty list)
        assert.deepStrictEqual(msg.candidates, []);
    });

    /**
     * Push a card-aware config and entry list into the agent.
     *
     * `cards/example.com/visa` is rule-classed as a card entry; `example.com/admin`
     * is a login entry. Both name `example.com` so they match the origin.
     * @returns {Promise<void>}
     */
    async function configureCardStore() {
        const cardConfig = {
            ...makeValidConfig(),
            modified: 2,
            rules: [{ pattern: "^cards/", class: "card" }, { pattern: "." }],
        };
        uninstallNativeHandler(mock, handler);
        handler = installNativeHandler(mock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return cardConfig;
            if (msg.action === "list")
                return [
                    { name: "cards/example.com/visa", path: "/home/test/.password-store/cards/example.com/visa.gpg" },
                    { name: "example.com/admin", path: "/home/test/.password-store/example.com/admin.gpg" },
                ];
            if (msg.action === "changes_since") return { changes: false };
            if (msg.action === "decrypt") return { plaintext: "card: 4111111111111111\n" };
        });
        const integration = mock.chrome.runtime.connect({ name: "integration" });
        await settleAsync();
        const configPromise = nextMessage(integration, "config");
        integration.postMessage({ action: "config", config: cardConfig });
        await configPromise;
    }

    test("search with targetClass 'card' returns only card entries", async () => {
        await configureCardStore();
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({
            action: "match",
            url: "https://example.com",
            search: "",
            limit: true,
            history: [],
            targetClass: "card",
        });
        const match = await matchPromise;
        assert.strictEqual(match.entries.length, 1);
        assert.strictEqual(match.entries[0].name, "cards/example.com/visa");
        assert.strictEqual(match.entries[0].rule.class, "card");
    });

    test("search with targetClass 'login' returns only login entries", async () => {
        await configureCardStore();
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({
            action: "match",
            url: "https://example.com",
            search: "",
            limit: true,
            history: [],
            targetClass: "login",
        });
        const match = await matchPromise;
        assert.strictEqual(match.entries.length, 1);
        assert.strictEqual(match.entries[0].name, "example.com/admin");
    });

    test("search without targetClass returns all fillable entries", async () => {
        await configureCardStore();
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({
            action: "match",
            url: "https://example.com",
            search: "",
            limit: true,
            history: [],
        });
        const match = await matchPromise;
        assert.strictEqual(match.entries.length, 2);
    });

    test("card entries are fillable (isFillEntry)", async () => {
        await configureCardStore();
        const popup = mock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const matchPromise = nextMessage(popup, "match");
        popup.postMessage({
            action: "match",
            url: "https://example.com",
            search: "",
            limit: true,
            history: [],
            targetClass: "card",
        });
        const match = await matchPromise;
        // If the card entry appears in results, #isFillEntry returned true for it
        assert.strictEqual(match.entries.length, 1);
        assert.strictEqual(match.entries[0].rule.class, "card");
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
        scopedAgent?.destroy();
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

    test("broadcast init error propagates to popup after disconnect", async () => {
        // Simulate the native host failing during bootstrap (e.g. parcelrc with
        // incorrect permissions): a broadcast error is sent and the host exits
        // before the bootstrap event is dispatched.
        const nativePort = scopedMock.getNativePort("com.github.erayd.parcel");
        const failedPromise = once(scopedAgent, "initFailed");
        nativePort.receiver.postMessage({
            token: "broadcast",
            error: "parcelrc file must have permissions 0600",
        });
        nativePort.receiver.disconnect();
        const ev = await failedPromise;
        assert.ok(ev.detail?.includes("parcelrc"), "initFailed fired with parcelrc error");

        // The popup may be opened only after the failure occurred, so the error
        // must be retained as state and surfaced to a subsequently-connected popup
        // rather than the generic "Not connected to native host" message.
        const popup = scopedMock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1 } });
        const errPromise = nextMessage(popup, "error");
        popup.postMessage({ action: "match", url: "https://example.com" });
        const err = await errPromise;
        assert.ok(
            err.error?.includes("parcelrc file must have permissions 0600"),
            "popup receives the parcelrc error, not a generic disconnect message",
        );
    });

    test("keepalive: onMessage listener registered for content-script pings", async () => {
        // The keepalive listener should be registered and silently handle
        // keepalive messages from integration.js without throwing.
        mock.chrome.runtime.onMessage._fire({ type: "keepalive" });
        assert.ok(
            mock.chrome.runtime.onMessage._count() >= 1,
            "agent should register a runtime.onMessage listener for content-script keepalive pings",
        );
    });
});

describe("Agent native call timeout recovery", () => {
    let scopedMock;
    let scopedAgent;
    let scopedHandler;
    let decryptTokens;

    beforeEach(async () => {
        realConsole = globalThis.console;
        globalThis.console = noopConsole;
        scopedMock = createChromeMock();
        scopedMock.installChrome();
        scopedMock.installFetch();
        stubInitAssets(scopedMock);
        scopedAgent = new Agent();
        await settleAsync();

        decryptTokens = [];
        scopedHandler = installNativeHandler(scopedMock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return { ...makeValidConfig(), decryptTimeout: 1 };
            if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
            if (msg.action === "changes_since") return { changes: false };
            if (msg.action === "decrypt") {
                decryptTokens.push(msg.token);
                return undefined; // don't respond — let the call time out
            }
        });

        scopedAgent.dispatchEvent(new CustomEvent("parcel::native::bootstrap"));
        await once(scopedAgent, "ready");
    });

    afterEach(async () => {
        scopedAgent?.destroy();
        globalThis.console = realConsole;
        if (scopedHandler) uninstallNativeHandler(scopedMock, scopedHandler);
        await settleAsync();
    });

    test("late native response after timeout does not corrupt subsequent call", async () => {
        const nativePort = scopedMock.getNativePort("com.github.erayd.parcel");
        const popup = scopedMock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1, url: "https://example.com" } });
        await settleAsync();

        // First decrypt call — handler doesn't respond, will time out after 1s.
        // The event listener for its token MUST be removed on timeout; otherwise
        // a late response will fire the stale listener and corrupt the next
        // in-flight call's timer, causing a permanent hang.
        const err1Promise = nextMessage(popup, "error", 5000);
        popup.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        const err1 = await err1Promise;
        assert.ok(err1.error?.includes("timed out"), "first call should time out");

        // Second decrypt call — also doesn't respond. After settling, its
        // #pendingCall and timer are in flight.
        const err2Promise = nextMessage(popup, "error", 5000);
        popup.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        await settleAsync();

        // Deliver the late response for the FIRST call's token while the
        // second call is in flight. With the fix, the stale listener was
        // removed on timeout so this dispatch is a no-op. Without the fix,
        // the stale listener fires and clears the second call's timer.
        assert.ok(decryptTokens.length >= 2, "two decrypt calls should have been captured");
        nativePort.receiver.postMessage({
            token: decryptTokens[0],
            data: { plaintext: { password: "late-response" } },
        });

        // The second call must still time out on its own. If the timer was
        // corrupted by the stale listener, this will hang until nextMessage's
        // own 5s timeout fires, failing the test.
        const err2 = await err2Promise;
        assert.ok(err2.error?.includes("timed out"), "second call should time out despite late response for first call");
    });

    test("subsequent call succeeds after a previous call times out", async () => {
        // Replace the handler so the first decrypt doesn't respond (times out)
        // but the second decrypt responds immediately.
        uninstallNativeHandler(scopedMock, scopedHandler);
        let firstDecryptSeen = false;
        scopedHandler = installNativeHandler(scopedMock, (msg) => {
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return { ...makeValidConfig(), decryptTimeout: 1 };
            if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
            if (msg.action === "changes_since") return { changes: false };
            if (msg.action === "decrypt") {
                if (!firstDecryptSeen) {
                    firstDecryptSeen = true;
                    return undefined; // first call: no response, let it time out
                }
                return { plaintext: { password: "hunter2" } }; // second call: respond
            }
        });

        const popup = scopedMock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1, url: "https://example.com" } });
        await settleAsync();

        // First decrypt — times out after 1s.
        const errPromise = nextMessage(popup, "error", 5000);
        popup.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        const err = await errPromise;
        assert.ok(err.error?.includes("timed out"), "first call should time out");

        // Second decrypt — handler responds immediately. This must succeed,
        // proving the semaphore wasn't permanently wedged by the timeout.
        const plaintextPromise = nextMessage(popup, "plaintext", 5000);
        popup.postMessage({ action: "decrypt", path: "test/site", intent: "fill", origin: "https://example.com" });
        const pt = await plaintextPromise;
        assert.deepStrictEqual(pt.plaintext, { password: "hunter2" }, "second call succeeds after timeout recovery");
    });

    test("config is cleared on disconnect so waitUntilReady waits for reinit", async () => {
        // After an unexpected disconnect, #config must be cleared so that
        // #waitUntilReady() waits for the new host's #init() to complete,
        // rather than returning immediately with a stale config.
        const original = scopedMock.getNativePort("com.github.erayd.parcel");
        original.caller.disconnect();
        await settleAsync();
        if (chrome.runtime.lastError) chrome.runtime.lastError = null;

        // Reconnect (simulates onStartup or onInstalled waking the worker).
        scopedMock.fireRuntimeStartup();
        await settleAsync();

        // Install a handler on the new port that tracks actions. Unlike the
        // beforeEach handler, this one responds to all actions (the beforeEach
        // handler intentionally drops decrypt responses for timeout testing).
        const actionsBeforeBootstrap = [];
        const scopedHandler2 = installNativeHandler(scopedMock, (msg) => {
            if (msg.action && msg.action !== "install") {
                actionsBeforeBootstrap.push(msg.action);
            }
            if (msg.action === "install") return { success: true, message: "installed" };
            if (msg.action === "configure") return { ...makeValidConfig(), decryptTimeout: 1 };
            if (msg.action === "list") return [{ name: "example.com/admin", path: "example.com/admin" }];
            if (msg.action === "changes_since") return { changes: false };
        });
        const newPort = scopedMock.getNativePort("com.github.erayd.parcel");

        // Send a popup auth request + search. With stale #config (the bug),
        // #waitUntilReady() returns immediately and the "list" action fires
        // right away. With the fix, it blocks until bootstrap arrives.
        const popup = scopedMock.chrome.runtime.connect({ name: "popup" });
        await settleAsync();
        popup.postMessage({ action: "auth", token: "broadcast", tab: { id: 1, url: "https://example.com" } });
        popup.postMessage({ action: "match", url: "https://example.com", search: "example" });
        await settleAsync();

        // Wait long enough for a synchronous / microtask response to arrive
        // if the handler had bypassed #waitUntilReady().
        await new Promise((r) => setTimeout(r, 200));
        assert.deepStrictEqual(actionsBeforeBootstrap, [], "no actions should reach the native host before bootstrap/init completes");

        // Now send the bootstrap message so #init() runs, which dispatches
        // "ready", unblocking the queued popup request.
        newPort.receiver.postMessage({ token: "broadcast", data: { action: "bootstrap" } });
        await once(scopedAgent, "ready");
        await settleAsync();

        // After init completes, the queued search should have run.
        assert.ok(actionsBeforeBootstrap.includes("list"), "queued list action should execute after bootstrap/init completes");

        uninstallNativeHandler(scopedMock, scopedHandler2);
    });
});

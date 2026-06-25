/**
 * Tests for the Chrome API mock.
 *
 * @since 1.0.0
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import { createChromeMock } from "./chrome-api-mock.js";

describe("chrome-api-mock", () => {
    test("createChromeMock returns frozen object with chrome, helpers", () => {
        const mock = createChromeMock();
        assert.ok(mock.chrome);
        assert.ok(mock.chrome.runtime);
        assert.ok(mock.chrome.storage);
        assert.ok(mock.chrome.tabs);
    });

    test("chrome.runtime.getURL builds correct URL", () => {
        const mock = createChromeMock({ baseUrl: "moz-extension://abc/" });
        assert.strictEqual(mock.chrome.runtime.getURL("/js/helpers.js"), "moz-extension://abc/js/helpers.js");
        assert.strictEqual(mock.chrome.runtime.getURL("public_suffix_list.dat"), "moz-extension://abc/public_suffix_list.dat");
    });

    test("chrome.tabs.getCurrent returns null by default", async () => {
        const mock = createChromeMock();
        const tab = await mock.chrome.tabs.getCurrent();
        assert.strictEqual(tab, null);
    });

    test("chrome.tabs.getCurrent returns set tab", async () => {
        const mock = createChromeMock();
        const fakeTab = { id: 42, url: "https://example.com" };
        mock.setCurrentTab(fakeTab);
        const tab = await mock.chrome.tabs.getCurrent();
        assert.strictEqual(tab, fakeTab);
    });

    test("chrome.tabs.query returns set tab", async () => {
        const mock = createChromeMock();
        const fakeTab = { id: 7, url: "https://test" };
        mock.setCurrentTab(fakeTab);
        const tabs = await mock.chrome.tabs.query({ active: true, currentWindow: true });
        assert.deepStrictEqual(tabs, [fakeTab]);
    });

    test("chrome.storage.local round-trips data", async () => {
        const mock = createChromeMock();
        await mock.chrome.storage.local.set({ key: "value", num: 99 });
        const data = await mock.chrome.storage.local.get(["key", "num"]);
        assert.deepStrictEqual(data, { key: "value", num: 99 });
    });

    test("chrome.storage.local.get(null) returns all", async () => {
        const mock = createChromeMock();
        await mock.chrome.storage.local.set({ a: 1, b: 2 });
        const all = await mock.chrome.storage.local.get(null);
        assert.deepStrictEqual(all, { a: 1, b: 2 });
    });

    test("chrome.storage.local.remove deletes keys", async () => {
        const mock = createChromeMock();
        await mock.chrome.storage.local.set({ x: 1, y: 2 });
        await mock.chrome.storage.local.remove("x");
        const all = await mock.chrome.storage.local.get(null);
        assert.deepStrictEqual(all, { y: 2 });
    });

    test("chrome.runtime.connect creates paired ports", async () => {
        const mock = createChromeMock();
        let receiverPort = null;
        mock.chrome.runtime.onConnect.addListener((port) => {
            receiverPort = port;
        });
        const caller = mock.chrome.runtime.connect({ name: "test" });
        await undefined; // let queueMicrotask fire onConnect

        assert.ok(receiverPort);
        assert.strictEqual(receiverPort.name, "test");
        assert.strictEqual(caller.name, "test");

        const received = [];
        receiverPort.onMessage.addListener((msg) => received.push(msg));
        caller.postMessage({ hello: "world" });
        assert.deepStrictEqual(received, [{ hello: "world" }]);
    });

    test("chrome.runtime.connectNative creates paired ports", () => {
        const mock = createChromeMock();
        const caller = mock.chrome.runtime.connectNative("com.example.host");
        const pair = mock.getNativePort("com.example.host");
        assert.ok(pair);
        assert.strictEqual(pair.caller, caller);
        assert.strictEqual(pair.receiver.name, "native:com.example.host");

        const received = [];
        pair.receiver.onMessage.addListener((msg) => received.push(msg));
        caller.postMessage({ action: "list" });
        assert.deepStrictEqual(received, [{ action: "list" }]);
    });

    test("getNativePort retrieves stored native pair", () => {
        const mock = createChromeMock();
        const caller = mock.chrome.runtime.connectNative("com.example.host");
        const pair = mock.getNativePort("com.example.host");
        assert.strictEqual(pair.caller, caller);
    });

    test("chrome.tabs.connect creates retrievable tab port", () => {
        const mock = createChromeMock();
        const caller = mock.chrome.tabs.connect(42, { name: "trigger", frameId: 3 });
        const receiver = mock.findTabPort(42, 3);
        assert.ok(receiver);

        const received = [];
        receiver.onMessage.addListener((msg) => received.push(msg));
        caller.postMessage({ action: "trigger-popup" });
        assert.deepStrictEqual(received, [{ action: "trigger-popup" }]);
    });

    test("port disconnect fires onDisconnect listeners on both sides", async () => {
        const mock = createChromeMock();
        let receiverPort = null;
        mock.chrome.runtime.onConnect.addListener((port) => {
            receiverPort = port;
        });
        const caller = mock.chrome.runtime.connect({ name: "trigger" });
        await undefined; // let queueMicrotask fire onConnect

        let callerDisconnected = false;
        let receiverDisconnected = false;
        caller.onDisconnect.addListener(() => {
            callerDisconnected = true;
        });
        receiverPort.onDisconnect.addListener(() => {
            receiverDisconnected = true;
        });

        caller.disconnect();
        assert.strictEqual(callerDisconnected, true);
        assert.strictEqual(receiverDisconnected, true);
        assert.strictEqual(caller.disconnected, true);
        assert.strictEqual(receiverPort.disconnected, true);
    });

    test("installChrome sets global chrome", () => {
        const original = globalThis.chrome;
        const mock = createChromeMock();
        mock.installChrome();
        assert.strictEqual(globalThis.chrome, mock.chrome);
        globalThis.chrome = original;
    });

    test("installFetch mocks global fetch", async () => {
        const mock = createChromeMock();
        mock.registerFetchResponse("file:///extension/parcel-host", "#!/bin/bash\necho hello");
        mock.installFetch();
        const resp = await globalThis.fetch("file:///extension/parcel-host");
        assert.strictEqual(await resp.text(), "#!/bin/bash\necho hello");
    });

    test("fetch throws for unregistered URL", async () => {
        const mock = createChromeMock();
        mock.installFetch();
        await assert.rejects(async () => globalThis.fetch("file:///extension/unknown"), /fetch not mocked/);
    });

    test("contextualIdentities.onRemoved can be fired", () => {
        const mock = createChromeMock();
        const events = [];
        mock.chrome.contextualIdentities.onRemoved.addListener((info) => events.push(info));
        mock.fireContextualIdentityRemoved({ contextualIdentity: { cookieStoreId: "abc" } });
        assert.deepStrictEqual(events, [{ contextualIdentity: { cookieStoreId: "abc" } }]);
    });

    test("runtime.onStartup can be fired", () => {
        const mock = createChromeMock();
        const events = [];
        mock.chrome.runtime.onStartup.addListener(() => events.push("startup"));
        mock.fireRuntimeStartup();
        assert.deepStrictEqual(events, ["startup"]);
    });

    test("runtime.onInstalled can be fired", () => {
        const mock = createChromeMock();
        const events = [];
        mock.chrome.runtime.onInstalled.addListener(() => events.push("installed"));
        mock.fireRuntimeInstalled();
        assert.deepStrictEqual(events, ["installed"]);
    });

    test("onMessage listeners can be removed", async () => {
        const mock = createChromeMock();
        let receiverPort = null;
        mock.chrome.runtime.onConnect.addListener((port) => {
            receiverPort = port;
        });
        const caller = mock.chrome.runtime.connect({ name: "msg" });
        await undefined; // let queueMicrotask fire onConnect

        const received = [];
        const handler = (msg) => received.push(msg);
        receiverPort.onMessage.addListener(handler);
        caller.postMessage("first");
        assert.deepStrictEqual(received, ["first"]);

        receiverPort.onMessage.removeListener(handler);
        caller.postMessage("second");
        assert.deepStrictEqual(received, ["first"]);
    });
});

/**
 * Minimal mock for Chrome Extension browser APIs (chrome.runtime, chrome.storage,
 * chrome.tabs, chrome.contextualIdentities, fetch) suitable for testing Parcel's
 * JS files under Node.js with node:test.
 *
 * @since 1.0.0
 */

"use strict";

/**
 * Create a fresh Chrome API mock.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl="file:///extension/"] - Prefix for chrome.runtime.getURL.
 * @returns {object} Mock chrome object plus helpers for test inspection/control.
 */
export function createChromeMock(opts = {}) {
    const baseUrl = opts.baseUrl ?? "file:///extension/";

    // --- internal helpers ----------------------------------------------------

    function _makeEvent() {
        const listeners = new Set();
        const buffer = [];
        return {
            addListener(fn) {
                const wasEmpty = listeners.size === 0;
                listeners.add(fn);
                if (wasEmpty) {
                    for (const args of buffer) fn(...args);
                    buffer.length = 0;
                }
            },
            removeListener(fn) {
                listeners.delete(fn);
            },
            hasListener(fn) {
                return listeners.has(fn);
            },
            _fire(...args) {
                if (listeners.size === 0) {
                    buffer.push(args);
                } else {
                    for (const fn of listeners) fn(...args);
                }
            },
            _count() {
                return listeners.size;
            },
        };
    }

    function _makePortPair(name, sender) {
        const aOnMessage = _makeEvent();
        const aOnDisconnect = _makeEvent();
        const bOnMessage = _makeEvent();
        const bOnDisconnect = _makeEvent();
        let aDisconnected = false;
        let bDisconnected = false;

        function _disconnectBoth() {
            if (!aDisconnected) {
                aDisconnected = true;
                aOnDisconnect._fire();
            }
            if (!bDisconnected) {
                bDisconnected = true;
                bOnDisconnect._fire();
            }
        }

        const caller = Object.freeze({
            name,
            sender,
            get disconnected() {
                return aDisconnected;
            },
            onMessage: aOnMessage,
            onDisconnect: aOnDisconnect,
            postMessage(msg) {
                if (!bDisconnected) bOnMessage._fire(msg);
            },
            disconnect() {
                _disconnectBoth();
            },
        });

        const receiver = Object.freeze({
            name,
            sender,
            get disconnected() {
                return bDisconnected;
            },
            onMessage: bOnMessage,
            onDisconnect: bOnDisconnect,
            postMessage(msg) {
                if (!aDisconnected) aOnMessage._fire(msg);
            },
            disconnect() {
                _disconnectBoth();
            },
        });

        return { caller, receiver };
    }

    // --- storage -------------------------------------------------------------

    const storageMap = new Map();

    const storageLocal = {
        async get(keys) {
            if (keys === null) {
                const out = {};
                for (const [k, v] of storageMap) out[k] = JSON.parse(JSON.stringify(v));
                return out;
            }
            if (typeof keys === "string") keys = [keys];
            const out = {};
            for (const k of keys) {
                if (storageMap.has(k)) out[k] = JSON.parse(JSON.stringify(storageMap.get(k)));
            }
            return out;
        },
        async set(items) {
            for (const [k, v] of Object.entries(items)) storageMap.set(k, JSON.parse(JSON.stringify(v)));
        },
        async remove(keys) {
            if (typeof keys === "string") keys = [keys];
            for (const k of keys) storageMap.delete(k);
        },
    };

    // --- runtime event listeners ---------------------------------------------

    const runtimeOnConnect = _makeEvent();
    const runtimeOnMessage = _makeEvent();
    const contextualIdentitiesOnRemoved = _makeEvent();

    let lastError = null;

    // --- mocked chrome object ------------------------------------------------

    const chrome = {
        runtime: {
            get onConnect() {
                return runtimeOnConnect;
            },
            get onMessage() {
                return runtimeOnMessage;
            },
            get lastError() {
                return lastError;
            },
            set lastError(err) {
                lastError = err;
            },
            getURL(path) {
                return baseUrl + path.replace(/^\//, "");
            },
            connect(info = {}) {
                const name = info.name ?? "";
                const pair = _makePortPair(name, info.sender ?? null);
                queueMicrotask(() => runtimeOnConnect._fire(pair.receiver));
                return pair.caller;
            },
            connectNative(hostName) {
                // Returns a port-like object.  Tests can inspect nativePorts.
                const pair = _makePortPair(`native:${hostName}`, /* sender */ null);
                nativePorts.set(hostName, pair);
                return pair.caller;
            },
        },
        storage: {
            local: storageLocal,
        },
        tabs: {
            async getCurrent() {
                return currentTab;
            },
            async query(_queryInfo) {
                // Minimal stub: always returns currentTab if set, else empty.
                if (currentTab) return [currentTab];
                return [];
            },
            connect(tabId, info = {}) {
                const name = info.name ?? "";
                const frameId = info.frameId ?? 0;
                const pair = _makePortPair(name, { tab: { id: tabId, frameId } });
                // Unlike runtime.connect, tabs.connect does *not* fire runtime.onConnect.
                // The receiving content script gets it via runtime.onConnect instead.
                // For test convenience we store it so tests can wire it manually.
                tabPorts.push({ tabId, frameId, receiver: pair.receiver });
                return pair.caller;
            },
        },
        contextualIdentities: {
            onRemoved: contextualIdentitiesOnRemoved,
        },
    };

    // --- mutable test state / helpers ----------------------------------------

    let currentTab = null;
    const nativePorts = new Map(); // hostName -> {caller, receiver}
    const tabPorts = []; // {tabId, frameId, receiver}

    // fetch mock registry: url -> response body (string)
    const fetchResponses = new Map();

    // clipboard mock: default no-op, tests can override writeText
    const clipboard = {
        async writeText() {},
    };

    return Object.freeze({
        chrome,

        /** Set the tab returned by chrome.tabs.getCurrent / query. */
        setCurrentTab(tab) {
            currentTab = tab;
        },

        /** Direct access to the in-memory storage map for assertions. */
        get storageMap() {
            return storageMap;
        },

        /** Register a fetch response for a given URL. */
        registerFetchResponse(url, body) {
            fetchResponses.set(url, body);
        },

        /** Get the native port pair created by connectNative(hostName). */
        getNativePort(hostName) {
            return nativePorts.get(hostName);
        },

        /** Find a tab port receiver by tabId / frameId for manual wiring. */
        findTabPort(tabId, frameId = 0) {
            return tabPorts.find((p) => p.tabId === tabId && p.frameId === frameId)?.receiver;
        },

        /** Fire a contextual identity removal event. */
        fireContextualIdentityRemoved(changeInfo) {
            contextualIdentitiesOnRemoved._fire(changeInfo);
        },

        /** Install fetch into `globalThis` so imported modules see it. */
        installFetch() {
            globalThis.fetch = async (url) => {
                const resolved = String(url);
                if (fetchResponses.has(resolved)) {
                    const body = fetchResponses.get(resolved);
                    return { text: async () => body };
                }
                throw new Error(`fetch not mocked for URL: ${resolved}`);
            };
        },

        /** Install the chrome object into `globalThis.chrome`. */
        installChrome() {
            globalThis.chrome = chrome;
        },

        /** Install navigator.clipboard and ResizeObserver stubs into `globalThis`. */
        installBrowserPolyfills() {
            if (!globalThis.navigator) globalThis.navigator = {};
            Object.defineProperty(globalThis.navigator, "clipboard", {
                value: clipboard,
                configurable: true,
                writable: true,
            });
            if (!globalThis.ResizeObserver) {
                globalThis.ResizeObserver = class ResizeObserver {
                    observe() {}
                    unobserve() {}
                    disconnect() {}
                };
            }
        },

        /** Direct access to the clipboard mock for test inspection. */
        get clipboard() {
            return clipboard;
        },
    });
}

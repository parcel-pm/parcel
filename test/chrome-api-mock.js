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
                lastError = { message: "The message channel was closed." };
                aOnDisconnect._fire();
            }
            if (!bDisconnected) {
                bDisconnected = true;
                lastError = { message: "The message channel was closed." };
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
                if (aDisconnected) {
                    lastError = { message: "Attempting to use a disconnected port object" };
                    throw new Error("Attempting to use a disconnected port object");
                }
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
                if (bDisconnected) {
                    lastError = { message: "Attempting to use a disconnected port object" };
                    throw new Error("Attempting to use a disconnected port object");
                }
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
    const sessionStorageMap = new Map();

    const makeStorage = (map) => ({
        async get(keys) {
            if (keys === null) {
                const out = {};
                for (const [k, v] of map) out[k] = JSON.parse(JSON.stringify(v));
                return out;
            }
            if (typeof keys === "string") keys = [keys];
            const out = {};
            for (const k of keys) {
                if (map.has(k)) out[k] = JSON.parse(JSON.stringify(map.get(k)));
            }
            return out;
        },
        async set(items) {
            for (const [k, v] of Object.entries(items)) map.set(k, JSON.parse(JSON.stringify(v)));
        },
        async remove(keys) {
            if (typeof keys === "string") keys = [keys];
            for (const k of keys) map.delete(k);
        },
    });

    const storageLocal = makeStorage(storageMap);
    const sessionStorage = makeStorage(sessionStorageMap);

    // --- runtime event listeners ---------------------------------------------

    const runtimeOnConnect = _makeEvent();
    const runtimeOnMessage = _makeEvent();
    const runtimeOnStartup = _makeEvent();
    const runtimeOnInstalled = _makeEvent();
    const contextualIdentitiesOnRemoved = _makeEvent();
    const webRequestOnAuthRequired = _makeEvent();

    let lastError = null;

    // --- tabs.sendMessage mock -----------------------------------------------

    const sentMessages = [];
    let sendMessageFailure = null;

    // --- windows mock --------------------------------------------------------

    const windowsCreated = [];

    // --- mocked chrome object ------------------------------------------------

    const chrome = {
        runtime: {
            get onConnect() {
                return runtimeOnConnect;
            },
            get onMessage() {
                return runtimeOnMessage;
            },
            get onStartup() {
                return runtimeOnStartup;
            },
            get onInstalled() {
                return runtimeOnInstalled;
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
            sendMessage(msg, callback) {
                runtimeOnMessage._fire(msg);
                if (typeof callback === "function") queueMicrotask(() => callback());
            },
        },
        storage: {
            local: storageLocal,
            session: sessionStorage,
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
            async get(tabId) {
                // Return the tab with the given ID, or a default loaded tab
                // (http URL) so that content-script messaging is used by
                // default. Tests that need the new-tab path can use
                // setCurrentTab() with an about:blank or chrome:// URL.
                if (currentTab && currentTab.id === tabId) return currentTab;
                return { id: tabId, status: "complete", url: "https://example.com/" };
            },
            connect(tabId, info = {}) {
                const name = info.name ?? "";
                const frameId = info.frameId ?? 0;
                const pair = _makePortPair(name, { tab: { id: tabId, frameId } });
                tabPorts.push({ tabId, frameId, receiver: pair.receiver });
                return pair.caller;
            },
            async sendMessage(tabId, msg, options) {
                sentMessages.push({ tabId, msg, options });
                if (sendMessageFailure) throw new Error(sendMessageFailure);
                return { ok: true };
            },
        },
        contextualIdentities: {
            onRemoved: contextualIdentitiesOnRemoved,
        },
        webRequest: {
            get onAuthRequired() {
                return webRequestOnAuthRequired;
            },
        },
        windows: {
            async create({ url: _url, type: _type, width: _width, height: _height }) {
                const entry = { url: _url, type: _type };
                windowsCreated.push(entry);
                return { id: windowsCreated.length, ...entry };
            },
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

        /** Direct access to the in-memory storage maps for assertions. */
        get storageMap() {
            return storageMap;
        },

        /** Direct access to the in-memory session storage map for assertions. */
        get sessionStorageMap() {
            return sessionStorageMap;
        },

        /** Direct access to recorded chrome.tabs.sendMessage calls. */
        get sentMessages() {
            return sentMessages;
        },

        /** Direct access to recorded chrome.windows.create calls. */
        get windowsCreated() {
            return windowsCreated;
        },

        /** Set a failure message to make the next tabs.sendMessage call throw. */
        setSendMessageFailure(message) {
            sendMessageFailure = message;
        },

        /** Register a fetch response for a given URL. */
        registerFetchResponse(url, body) {
            fetchResponses.set(url, body);
        },

        /** Get the native port pair created by connectNative(hostName). */
        getNativePort(hostName) {
            return nativePorts.get(hostName);
        },

        /** Find the most recent tab port receiver by tabId / frameId for manual wiring.
         *  Returns the newest match so reconnect scenarios observe the fresh port. */
        findTabPort(tabId, frameId = 0) {
            for (let i = tabPorts.length - 1; i >= 0; i--) {
                if (tabPorts[i].tabId === tabId && tabPorts[i].frameId === frameId) return tabPorts[i].receiver;
            }
            return undefined;
        },

        /** Fire a contextual identity removal event. */
        fireContextualIdentityRemoved(changeInfo) {
            contextualIdentitiesOnRemoved._fire(changeInfo);
        },

        /** Fire the runtime.onStartup event. */
        fireRuntimeStartup() {
            runtimeOnStartup._fire();
        },

        /** Fire the runtime.onInstalled event. */
        fireRuntimeInstalled() {
            runtimeOnInstalled._fire();
        },

        /** Fire the webRequest.onAuthRequired event. Returns a promise that resolves with the callback result. */
        fireAuthRequired(details) {
            return new Promise((resolve) => {
                if (webRequestOnAuthRequired._count() > 0) {
                    webRequestOnAuthRequired._fire(details, resolve);
                } else {
                    resolve({});
                }
            });
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
            if (!globalThis.CSS) {
                globalThis.CSS = {
                    escape: (str) => String(str).replace(/[^\w-]/g, "\\$&"),
                };
            }
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

"use strict";
import { Schema, ConfigSchema } from "./schema.js";
import { Helpers } from "./helpers.js";

/**
 * Main agent class
 * @since 0.1.0
 */
new (class Agent extends EventTarget {
    #connectedNative = false;
    #config;
    #host;
    #entries;
    #entriesUpdated = 0;
    #initError;
    #currentNativeCall = null;
    #authorisedTokens = new Set();
    #publicSuffixList = null;

    /** @since 1.0.0 */
    constructor() {
        super();

        this.addEventListener("parcel::native::bootstrap", (ev) => this.#init());
        chrome.runtime.onConnect.addListener((port) => this.#connect(port));
        if (chrome.contextualIdentities?.onRemoved) {
            chrome.contextualIdentities.onRemoved.addListener((changeInfo) =>
                this.#clearContainerHistory(changeInfo.contextualIdentity?.cookieStoreId),
            );
        }

        // open port to native host
        this.#connectNative();
    }

    /**
     * Initialise the agent & native host.
     * @since 1.0.0
     * @returns {void}
     */
    async #init() {
        try {
            let scriptURL = chrome.runtime.getURL("parcel-host"),
                script = await (await fetch(scriptURL)).text(),
                signatureURL = chrome.runtime.getURL("parcel-host.asc"),
                signature = await (await fetch(signatureURL)).text();
            try {
                let result = await this.#callNative("install", { script, signature });
                if (!result.success) throw new Error(result.message);
                console.log(result.message);
            } catch (err) {
                throw new Error(`Failed to install native host: ${err.message}`);
            }
            this.#setConfig(await this.#callNative("configure"));
            this.dispatchEvent(new CustomEvent("ready"));
        } catch (err) {
            this.#initError = err;
            console.error(`Agent initialisation failed: ${err.message}`);
            this.dispatchEvent(new CustomEvent("initFailed", { detail: err.message }));
        }
    }

    /**
     * Clear saved history for a removed contextual identity.
     * @since 1.0.0
     * @param {string} cookieStoreId - The cookie store ID of the removed contextual identity.
     * @returns {void}
     */
    async #clearContainerHistory(cookieStoreId) {
        if (!cookieStoreId) return;
        try {
            const scope = await Helpers.sha256(cookieStoreId);
            const keys = Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith(`history:${scope}:`));
            if (keys.length) await chrome.storage.local.remove(keys);
        } catch (err) {
            console.error(`Failed to clear history for container ${cookieStoreId}: ${err.message}`);
        }
    }

    /**
     * Connect to the native host.
     * @since 1.0.0
     * @returns {void}
     */
    #connectNative() {
        this.#host = chrome.runtime.connectNative("com.github.erayd.parcel");
        this.#connectedNative = true;
        this.#host.onDisconnect.addListener(this.#onNativeDisconnect.bind(this));
        this.#host.onMessage.addListener(this.#onNativeMessage.bind(this));
    }

    /**
     * Call the native host
     * @since 1.0.0
     * @param {string} action - The action to send to the native host.
     * @param {object} message - The message to send to the native host.
     * @param {number} timeout - The timeout for the call.
     * @returns {mixed} - The native host response payload.
     */
    async #callNative(action, message = {}, timeout = 2000) {
        try {
            // This is necessary to avoid a race condition in Chrome that sometimes drops
            // messages to the native host if they are sent too quickly in succession. By
            // putting a semaphore here, we ensure that the previous call has completed
            // first, thus avoiding any potential in-flight collisions.
            await this.#currentNativeCall;
        } catch (err) {
            // we don't care about previous errors, only that the call has completed.
            // This error has already been handled by this point, and was thrown from
            // the promise rejection callback below.
        }
        const token = crypto.randomUUID();
        this.#currentNativeCall = new Promise((resolve, reject) => {
            if (!this.#connectedNative) {
                reject(new Error("Not connected to native host"));
                return true;
            }
            const timer = setTimeout(() => reject(new Error(`Native host call timed out: ${action}`)), timeout);
            this.addEventListener(
                token,
                (ev) => {
                    clearTimeout(timer);
                    if (ev.detail?.error) reject(new Error(ev.detail.error));
                    else resolve(ev.detail.data);
                },
                { once: true },
            );
        });

        message.token = token;
        message.action = action;
        this.#host.postMessage(message);

        return this.#currentNativeCall;
    }

    /**
     * Handles messages from the native host.
     * @since 1.0.0
     * @param {object} message - The message from the native host.
     * @returns {void}
     */
    async #onNativeMessage(message) {
        if (message.token === "broadcast") {
            if ("error" in message) {
                this.#initError = new Error(message.error);
                console.error(this.#initError);
                this.dispatchEvent(new CustomEvent("initFailed", { detail: message.error }));
            }
            if (message?.data?.action) {
                this.dispatchEvent(new CustomEvent(`parcel::native::${message.data.action}`, { detail: message.data }));
            }
        } else {
            this.dispatchEvent(new CustomEvent(message.token, { detail: message }));
        }
    }

    /**
     * Handles disconnections from the native host.
     * @since 1.0.0
     * @returns {void}
     */
    async #onNativeDisconnect() {
        this.#connectedNative = false;
        if (this.#host.error) {
            console.error(new Error(this.#host.error.message));
        }
        if (chrome.runtime.lastError) {
            console.error(new Error(chrome.runtime.lastError.message));
        }
        if (!this.#initError) {
            console.error("Native host disconnected unexpectedly - reinitialising...");
            setTimeout(this.#connectNative.bind(this), 1000);
        } else {
            console.error("Native host initialisation failed - aborting.");
        }
    }

    /**
     * Wait until the native host has finished initialising.
     * @since 1.0.0
     * @returns {Promise<void>}
     */
    async #waitUntilReady() {
        if (this.#config) return;
        if (this.#initError) throw this.#initError;
        await new Promise((resolve, reject) => {
            this.addEventListener("ready", () => resolve(), { once: true });
            this.addEventListener("initFailed", (ev) => reject(new Error(ev.detail)), { once: true });
        });
    }

    /**
     * Set the configuration for the agent.
     * @since 1.0.0
     * @param {object} config - The configuration object.
     * @returns {void}
     */
    #setConfig(config) {
        // validate the provided configuration
        try {
            Schema.validate(ConfigSchema, config);
        } catch (err) {
            console.error(config);
            throw new Error(`Invalid configuration: ${err.message}`);
        }

        // apply the configuration
        this.#config = config;
    }

    /**
     * Set the list of available pass entries.
     * @since 1.0.0
     * @param {object} list - The list of available pass entries from the native host.
     * @returns {void}
     */
    #setEntries(entries) {
        for (let rule of this.#config.rules) {
            if (rule.ignore) continue;
            if (!rule.color) {
                // auto-generate tag colours for rules that don't have one defined
                let hash = 0;
                for (let i = 0; i < rule.pattern.length; i++) {
                    hash = ((hash << 5) - hash + rule.pattern.charCodeAt(i)) | 0;
                }
                rule.color = Math.abs(hash).toString(16).padStart(6, "0").slice(0, 6);
            }
            let p = new RegExp(rule.pattern, "u");
            for (let entry of entries) {
                if (entry.rule) continue;
                if (p.test(entry.name)) entry.rule = rule;
            }
        }
        this.#entries = entries;
        this.#entriesUpdated = Date.now();
        this.dispatchEvent(new CustomEvent("entriesUpdated", { detail: this.#entries }));
    }

    /**
     * Get the list of available pass entries.
     * @since 1.0.0
     * @returns {object[]} - The list of available pass entries.
     */
    async #getEntries(cacheTTL = this.#config.cacheTTL) {
        let cacheAge = (Date.now() - this.#entriesUpdated) / 1000;
        if (cacheTTL && this.#entries && cacheAge < Math.min(cacheTTL, this.#config.cacheTTL)) return this.#entries;

        let needRefresh = !this.#entriesUpdated;
        if (this.#entriesUpdated) {
            // if the cache is valid, check with the native host if there have been any changes since we last updated it
            const changes = (await this.#callNative("changes_since", { since: Math.floor(this.#entriesUpdated / 1000) }))?.changes;
            if (!changes) {
                this.#entriesUpdated = Date.now();
                needRefresh = false;
            } else needRefresh = true;
        }
        if (needRefresh) this.#setEntries(await this.#callNative("list"));
        return this.#entries;
    }

    /**
     * Handle incoming connections from the extension UI & content scripts.
     * @since 1.0.0
     * @param {Port} port - The connection port from the origin page.
     * @returns {void}
     */
    async #connect(port) {
        var authorised = false;
        var tabId = null;
        var token = null;

        port.onDisconnect.addListener(() => {
            // ignore global disconnect errors (expected from bfcache)
            chrome.runtime.lastError;
        });

        if (port.name?.startsWith("popup-bridge:")) {
            await this.#bridgePopup(port);
            return;
        }

        if (port.name === "auth") {
            port.onMessage.addListener((token) => this.#authorisedTokens.add(token));
            return;
        }

        if (port.name === "trigger") {
            // relay messages between the content script and the top-level frame, so that iframe-triggered popups can
            // be rendered in the top-level context and avoid issues with limited iframe viewport sizes.
            const tab = port.sender.tab;
            const topPort = chrome.tabs.connect(tab.id, { name: "trigger", frameId: 0 });
            port.onMessage.addListener((message) => topPort.postMessage(message));
            topPort.onMessage.addListener((message) => port.postMessage(message));
            port.onDisconnect.addListener(() => topPort.disconnect());
            topPort.onDisconnect.addListener(() => port.disconnect());
            return;
        }

        const updateStatus = (s) => port.postMessage({ action: "status", status: s });
        const clearStatus = () => port.postMessage({ action: "clear-status" });
        const clearErrors = (category = null) => port.postMessage({ action: "clear-errors", category });
        clearStatus();

        // listen for messages
        port.onMessage.addListener(async (message) => {
            try {
                if (port.name === "popup") {
                    if (message?.action === "auth" && (this.#authorisedTokens.has(message.token) || message.token === "broadcast")) {
                        if (message.token !== "broadcast") this.#authorisedTokens.delete(message.token);
                        authorised = true;
                        token = message.token;
                        tabId = message?.tab?.id || null;
                        return;
                    }
                    if (!authorised) throw new Error("Unauthorised port");
                }

                if (!this.#connectedNative) throw new Error("Not connected to native host");
                updateStatus("Waiting for native host startup...");
                await this.#waitUntilReady();
                clearStatus();
                if (message?.action === "match") {
                    updateStatus("Searching for matching entries...");
                    // get matching entries
                    const result = await this.search(message.url, message.search || "", message.limit, message.history);
                    clearStatus();
                    port.postMessage({ action: "match", entries: result });
                } else if (message?.action === "decrypt") {
                    // decrypt the specified entry
                    updateStatus("Decrypting entry...");
                    const result = await this.#callNative("decrypt", { path: message.path }, this.#config.decryptTimeout * 1000);
                    try {
                        clearStatus();
                        port.postMessage({ action: "plaintext", intent: message.intent, plaintext: result.plaintext });
                    } catch (err) {
                        // the port is disconnected, most likely as a result of https://bugzilla.mozilla.org/show_bug.cgi?id=1292701
                        if (message?.intent === "fill" && token === "broadcast" && tabId) {
                            console.warn("Falling back to fire-and-forget fill from agent");
                            const tabPort = chrome.tabs.connect(tabId, { name: "broadcast", frameId: 0 });
                            tabPort.onMessage.addListener(() => {}); // ignore responses, because we aren't an actual popup instance
                            tabPort.postMessage({ action: "fill", config: this.#config, plaintext: result.plaintext });
                        } else throw err;
                    }
                } else if (message?.action === "config") {
                    // provide the current configuration
                    updateStatus("Checking for config changes...");
                    let newConfig = await this.#callNative("configure");
                    if (newConfig?.modified > this.#config.modified) {
                        this.#setConfig(newConfig);
                        updateStatus("Refreshing entry list...");
                        this.#setEntries(await this.#callNative("list"));
                    }
                    clearStatus();
                    let response = { action: "config", config: this.#config };
                    if (port.name === "integration") response.frameId = port.sender?.frameId || 0;
                    port.postMessage(response);
                } else if (message?.action === "sha256") {
                    // provide a SHA-256 hash of the given value
                    const hash = await Helpers.sha256(message.value);
                    port.postMessage({ action: "sha256-digest", value: message.value, hash });
                }
                if (message.hasOwnProperty("action")) clearErrors(message.action);
            } catch (err) {
                if (err.hasOwnProperty("logAs")) console[err.logAs](err);
                else console.error(err);
                port.postMessage({ action: "error", error: err.message, category: err.category || message?.action || "default" });
            }
        });
    }

    /**
     * Relay a popup iframe connection to the matching content script.
     * @since 1.0.0
     * @param {Port} port - The popup runtime port.
     * @returns {void}
     */
    async #bridgePopup(port) {
        const matches = port.name.match(/^popup-bridge:(.+?):(\d+)$/u);
        const token = matches?.[1];
        const frameId = parseInt(matches?.[2], 10) || 0;
        const tabId = port.sender?.tab?.id;
        const tabURL = port.sender?.tab?.url;

        if (!tabId) {
            port.postMessage({ action: "error", error: "Unable to determine the current tab." });
            port.disconnect();
            return;
        }

        const tabPort = chrome.tabs.connect(tabId, { name: token, frameId });
        let disconnected = false;
        const disconnect = () => {
            if (disconnected) return;
            disconnected = true;
            port.disconnect();
            tabPort.disconnect();
        };

        port.postMessage({
            action: "tab-context",
            tab: { id: tabId, url: tabURL, contextualIdentity: port.sender?.tab?.cookieStoreId },
        });

        port.onMessage.addListener((message) => tabPort.postMessage(message));
        port.onDisconnect.addListener(disconnect);
        tabPort.onMessage.addListener((message) => port.postMessage(message));
        tabPort.onDisconnect.addListener(() => {
            chrome.runtime.lastError; // suppress content script connect errors
            disconnect();
        });
    }

    /**
     * Find matching entries for a given origin.
     * @since 1.0.0
     * @param {URL} url - The url to find matching entries for.
     * @param {string} search - The search string to match against.
     * @param {boolean} [limit=true] - Whether to limit the search to the current origin.
     * @param {string[]} [history] - A list of historical paths to include regardless of matches.
     * @returns {object[]} - The matching entries.
     */
    async search(url, search, limit = true, history = []) {
        // consolidate history to most-recent entry per item
        history = history.reduce((acc, entry) => {
            if (!acc.hasOwnProperty(entry.path)) acc[entry.path] = entry;
            else if (acc[entry.path].when < entry.when) acc[entry.path] = entry;
            return acc;
        }, {});

        const origin = new URL(url);
        let matches = [];

        if (origin.host) {
            // find matches for the origin
            const suffix = await this.#getPublicSuffix(origin.hostname);
            const slices = [];
            for (let s = origin.hostname; s.length && s !== suffix; s = s.slice(s.indexOf(".") + 1)) slices.push(s);
            for (let entry of await this.#getEntries()) {
                const hash = await Helpers.sha256(entry.path);
                entry.history = history?.[hash];

                const parts = entry.name.split("/").reverse();
                entry.matchesHost = parts.includes(origin.host);
                entry.matchesHostPart = false;
                if (!entry.matchesHost) {
                    for (let s of slices) {
                        if (parts.includes(s)) {
                            entry.matchesHostPart = true;
                            break;
                        }
                    }
                }
                if (entry.history || entry.matchesHost || entry.matchesHostPart) {
                    matches.push(entry);
                }
            }

            matches = matches.sort((a, b) => {
                if (a.matchesHost && !b.matchesHost) return -1;
                if (!a.matchesHost && b.matchesHost) return 1;
                if (a.matchesHostPart && !b.matchesHostPart) return -1;
                if (!a.matchesHostPart && b.matchesHostPart) return 1;
                return a.name.localeCompare(b.name);
            });
            for (let i = 0; i < matches.length; i++) {
                matches[i].sortOrder = i;
            }
            matches = matches.sort((a, b) => {
                if (a.history && !b.history) return -1;
                if (!a.history && b.history) return 1;
                if (a.history && b.history) return b.history.when - a.history.when;
                return a.sortOrder - b.sortOrder;
            });
        }

        // add all entries for unrestricted search
        if (!limit && search?.length) for (const entry of await this.#getEntries()) if (!matches.includes(entry)) matches.push(entry);

        // filter by space-separated regex search terms
        if (search) {
            for (const term of search.split(/\s+/u)) {
                try {
                    let p = new RegExp(term, "ui");
                    matches = matches.filter((entry) => p.test(entry.name));
                } catch (err) {
                    console.warn(`Invalid search term: ${term}`);
                    err.logAs = "info";
                    throw err;
                }
            }
        }

        for (let i = 0; i < matches.length; i++) {
            if (!matches[i].hasOwnProperty("sortOrder")) {
                matches[i].sortOrder = i;
            }
        }

        return matches;
    }

    /**
     * Get the public suffix for a given hostname.
     * @since 1.0.0
     * @param {string} hostname - The hostname to get the public suffix for.
     * @returns {string} - The public suffix for the given hostname, or the raw hostname if not public.
     */
    async #getPublicSuffix(hostname) {
        if (!this.#publicSuffixList) {
            this.#publicSuffixList = fetch(chrome.runtime.getURL("/public_suffix_list.dat"))
                .then((response) => response.text())
                .then((text) => text.split("\n").filter((line) => !line.startsWith("//") && line.length))
                .catch((err) => {
                    this.#publicSuffixList = null;
                    throw err;
                });
        }

        const list = await this.#publicSuffixList;
        for (let suffix = hostname; suffix.length; suffix = suffix.slice(suffix.indexOf(".") + 1)) {
            if (list.includes(`!${suffix}`)) continue;
            if (list.includes(suffix)) return suffix;
            if (list.includes(`*.${suffix.slice(suffix.indexOf(".") + 1)}`)) return suffix;
            if (suffix.indexOf(".") === -1) break;
        }
        return hostname;
    }
})();

"use strict";
import { Schema, ConfigSchema } from "./schema.js";

/**
 * Main agent class
 * @since 0.1.0
 */
new (class Agent extends EventTarget {
    #config;
    #host;
    #entries;
    #entriesUpdated = 0;
    #initError;
    #currentNativeCall = null;

    /** @since 1.0.0 */
    constructor() {
        super();

        this.addEventListener("parcel::native::bootstrap", (ev) => this.#init());
        chrome.runtime.onConnect.addListener((port) => this.#connect(port));

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
     * Connect to the native host.
     * @since 1.0.0
     * @returns {void}
     */
    #connectNative() {
        this.#host = chrome.runtime.connectNative("com.github.erayd.parcel");
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
        if (Date.now() - this.#entriesUpdated > cacheTTL * 1000) {
            this.#setEntries(await this.#callNative("list"));
        }
        return this.#entries;
    }

    /**
     * Handle incoming connections from the extension UI & content scripts.
     * @since 1.0.0
     * @param {Port} port - The connection port from the origin page.
     * @returns {void}
     */
    async #connect(port) {
        // listen for messages
        port.onMessage.addListener(async (message) => {
            try {
                if (message?.action === "match") {
                    // get matching entries
                    const url = new URL(message.url);
                    const result = await this.search(url.origin, message.search || "", message.limit);
                    port.postMessage({ action: "match", entries: result });
                } else if (message?.action === "decrypt") {
                    // decrypt the specified entry
                    const result = await this.#callNative("decrypt", { path: message.path }, this.#config.decryptTimeout * 1000);
                    port.postMessage({ action: "plaintext", plaintext: result.plaintext });
                } else if (message?.action === "config") {
                    // provide the current configuration
                    let newConfig = await this.#callNative("configure");
                    if (newConfig?.modified > this.#config.modified) {
                        this.#setConfig(newConfig);
                        this.#setEntries(await this.#callNative("list"));
                    }
                    port.postMessage({ action: "config", config: this.#config });
                }
            } catch (err) {
                console.error(err);
                port.postMessage({ action: "error", error: err.message });
            }
        });
    }

    /**
     * Find matching entries for a given origin.
     * @since 1.0.0
     * @param {URL} origin - The origin to find matching entries for.
     * @param {string} search - The search string to match against.
     * @param {boolean} [limit=true] - Whether to limit the search to the current origin.
     * @returns {object[]} - The matching entries.
     */
    async search(origin, search, limit = true) {
        origin = new URL(origin);
        let matches = [];

        // find matches for the origin
        const suffix = await this.#getPublicSuffix(origin.hostname);
        const slices = [];
        for (let s = origin.hostname; s.length && s !== suffix; s = s.slice(s.indexOf(".") + 1)) slices.push(s);
        for (let entry of await this.#getEntries(search.length ? this.#config.cacheTTLInteractive : undefined)) {
            const parts = entry.name.split("/").reverse();
            if (parts.includes(origin.host)) {
                matches.push(entry);
            } else {
                for (let s of slices) {
                    if (parts.includes(s)) {
                        matches.push(entry);
                        break;
                    }
                }
            }
        }

        // origin-matching search
        matches = matches.filter((entry) => {
            if (search) {
                let p = new RegExp(search, "ui");
                return p.test(entry.name);
            }
            return true;
        });

        // unrestricted search
        if (!limit) {
            for (let entry of await this.#getEntries(search.length ? this.#config.cacheTTLInteractive : undefined)) {
                if (!matches.includes(entry)) {
                    if (search) {
                        let p = new RegExp(search, "ui");
                        if (p.test(entry.name)) matches.push(entry);
                    }
                }
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
        let list = (await (await fetch(chrome.runtime.getURL("/public_suffix_list.dat"))).text())
            .split("\n")
            .filter((line) => !line.startsWith("//") && line.length);
        for (let suffix = hostname; suffix.length; suffix = suffix.slice(suffix.indexOf(".") + 1)) {
            if (list.includes(`!${suffix}`)) continue;
            if (list.includes(suffix)) return suffix;
            if (list.includes(`*.${suffix.slice(suffix.indexOf(".") + 1)}`)) return suffix;
        }
        return hostname;
    }
})();

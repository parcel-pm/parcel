"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const Plaintext = (await import(chrome.runtime.getURL("/js/plaintext.js"))).Plaintext;
    const token = new URLSearchParams(window.location.search).get("token") || "broadcast";
    const frameId = parseInt(new URLSearchParams(window.location.search).get("frameId"), 10) || 0;
    const mode = new URLSearchParams(window.location.search).get("mode");
    const targetClass = new URLSearchParams(window.location.search).get("targetClass");
    const isWindowMode = new URLSearchParams(window.location.search).get("window") === "1";
    let frameOrigin; // intended origin for the actual fill operation
    if (token === "broadcast" && window !== window.top) {
        const msg =
            "Parcel may not be independently embedded in a frame. If you are seeing this message, it means that a website " +
            "has attempted to embed Parcel in a way that could allow them to steal your data. Please close this window " +
            "and avoid interacting with the site until they have resolved their security problems.";
        document.body.textContent = msg;
        document.querySelectorAll("style, link[rel=stylesheet]").forEach((el) => el.remove());
        document.body.style.all = "unset";
        throw new Error(msg);
    }

    // Firefox MV3 treats host_permissions as optional — the user must explicitly
    // grant "Access your data for all websites". Without it, webRequest events
    // (including onAuthRequired) silently never fire. Chrome auto-grants on
    // install, so this prompt only appears in Firefox.
    if (mode !== "passkey-conflict" && chrome.permissions) {
        const hasHostPermission = await chrome.permissions.contains({
            origins: ["<all_urls>"],
        });
        if (!hasHostPermission) {
            document.getElementById("search").classList.add("hidden");
            document.getElementById("entries").classList.add("hidden");
            document.getElementById("status").classList.add("hidden");
            document.getElementById("permission-prompt").classList.remove("hidden");
            document.getElementById("permission-grant").addEventListener("click", async () => {
                const granted = await chrome.permissions.request({
                    origins: ["<all_urls>"],
                });
                if (granted) window.location.reload();
            });
            document.getElementById("permission-dismiss").addEventListener("click", () => {
                window.close();
            });
            return;
        }
    }

    /**
     * Post a message, reconnecting once if the post throws. The `post` and
     * `reconnect` closures capture the caller's port variable so the retry
     * targets the freshly opened port.
     * @since 1.0.2
     * @param {() => void} post - Posts the message on the current port.
     * @param {() => void} reconnect - Opens a fresh port; may throw if the extension context is invalidated.
     * @returns {boolean} `true` when delivered, `false` if both the initial and retry attempts failed.
     */
    function postWithRetry(post, reconnect) {
        try {
            post();
            return true;
        } catch (_err) {
            try {
                reconnect();
            } catch (_reconnectErr) {
                return false;
            }
            try {
                post();
                return true;
            } catch (_retryErr) {
                return false;
            }
        }
    }

    /**
     * Wrap the popup's tab port so a transient disconnect — the MV3 service
     * worker terminating (idle timeout, extension reload), severing all
     * existing ports — is recovered transparently, mirroring the content
     * script's own `reconnectingPort`. Without reconnection, the next
     * `postMessage()` throws "Attempting to use a disconnected port object".
     * Unlike the content-script wrapper this port is bidirectional, so every
     * previously-registered `onMessage` listener is re-attached to each fresh
     * port; without that, the security-relevant `origin` mismatch check,
     * `status`/`error` reporting, and `close` handling would silently stop
     * working after a single disconnect.
     * @since 1.0.2
     * @param {() => chrome.runtime.Port} connect - Factory that opens a fresh port to the content script.
     * @param {chrome.runtime.Port} initialPort - The first port (already opened by `connectToTab`).
     * @returns {{ postMessage: (msg: any) => boolean, onMessage: { addListener: (fn: (msg: any) => void) => void } }} A port-like wrapper.
     */
    function reconnectingTabPort(connect, initialPort) {
        let port = initialPort;
        const listeners = new Set();
        /**
         * Bind disconnect + message-dispatch listeners to a raw port.
         * @param {chrome.runtime.Port} p - The port to bind.
         * @returns {void}
         */
        function attach(p) {
            p.onDisconnect.addListener(() => {
                const err = chrome.runtime.lastError;
                if (err) console.debug("[popup] tab port disconnected:", err.message);
                if (port === p) port = null;
            });
            p.onMessage.addListener((msg) => {
                for (const fn of listeners) {
                    try {
                        fn(msg);
                    } catch (_err) {
                        // A single listener error must not block delivery to the others.
                    }
                }
            });
        }
        attach(initialPort);
        return {
            postMessage(msg) {
                if (!port) {
                    try {
                        port = connect();
                        attach(port);
                    } catch (_err) {
                        // Extension context invalidated (popup frame torn down).
                        return false;
                    }
                }
                return postWithRetry(
                    () => port.postMessage(msg),
                    () => {
                        port = connect();
                        attach(port);
                    },
                );
            },
            onMessage: {
                addListener(fn) {
                    listeners.add(fn);
                },
            },
        };
    }

    /**
     * Dummy tab port for window-mode popups (no content script to talk to).
     * Only handles `close` / `close-popup` by calling `window.close()`.
     * @since 1.0.6
     * @returns {{ postMessage: (msg: any) => boolean, onMessage: { addListener: (fn: (msg: any) => void) => void } }}
     */
    function windowTabPort() {
        return {
            postMessage(msg) {
                if (msg?.action === "close" || msg?.action === "close-popup") {
                    window.close();
                }
                return true;
            },
            onMessage: { addListener() {} },
        };
    }

    /**
     * Connect to the active tab content script, falling back to relay via the background service if necessary.
     * @since 1.0.0
     * @returns {Promise<{tab: chrome.tabs.Tab, tabPort: object}>} `tabPort` is a reconnecting wrapper (see {@link reconnectingTabPort}).
     * @throws {Error} If the bridge to the active tab reports an error or disconnects unexpectedly.
     */
    async function connectToTab() {
        if (chrome.tabs?.getCurrent && chrome.tabs?.query && chrome.tabs?.connect) {
            const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
            tab.contextualIdentity = tab?.cookieStoreId;
            const connect = () => chrome.tabs.connect(tab.id, { name: token, frameId });
            return { tab, tabPort: reconnectingTabPort(connect, connect()) };
        }

        const connect = () => chrome.runtime.connect({ name: `popup-bridge:${token}:${frameId}` });
        const initialPort = connect();
        const tab = await new Promise((resolve, reject) => {
            const onMessage = (msg) => {
                if (msg?.action === "tab-context") {
                    initialPort.onMessage.removeListener(onMessage);
                    initialPort.onDisconnect.removeListener(onDisconnect);
                    resolve(msg.tab);
                } else if (msg?.action === "error") {
                    initialPort.onMessage.removeListener(onMessage);
                    initialPort.onDisconnect.removeListener(onDisconnect);
                    reject(new Error(msg.error));
                }
            };
            const onDisconnect = () => {
                initialPort.onMessage.removeListener(onMessage);
                initialPort.onDisconnect.removeListener(onDisconnect);
                reject(new Error(chrome.runtime.lastError?.message || "Disconnected from the active tab."));
            };
            initialPort.onMessage.addListener(onMessage);
            initialPort.onDisconnect.addListener(onDisconnect);
        });

        return { tab, tabPort: reconnectingTabPort(connect, initialPort) };
    }

    // In window mode (new-tab http-auth), there's no content script to connect
    // to. Use a dummy port that handles close via window.close(), and synthesise
    // a tab object; the URL is filled in below from the authoritative background.
    const { tab, tabPort } =
        isWindowMode && mode === "http-auth" ? { tab: { contextualIdentity: undefined }, tabPort: windowTabPort() } : await connectToTab();

    let suppressErrors = false;
    const port = chrome.runtime.connect({ name: "popup" });
    port.postMessage({ action: "auth", token, tab, mode });

    // For http-auth mode the challenge URL comes from the background, bound to the per-challenge token.
    if (mode === "http-auth") {
        const authUrlPromise = new Promise((resolve) => {
            // listen for the http-auth-url response from the background
            const listener = (msg) => {
                if (msg?.action === "http-auth-url") {
                    port.onMessage.removeListener(listener);
                    resolve(msg.url);
                } else if (msg?.action === "http-auth-expired") {
                    port.onMessage.removeListener(listener);
                    resolve(null);
                }
            };
            port.onMessage.addListener(listener);
        });
        port.postMessage({ action: "http-auth-url" });
        const serverAuthUrl = await authUrlPromise;
        if (serverAuthUrl) {
            tab.url = serverAuthUrl;
        } else {
            // The auth session has expired (e.g. service worker was terminated
            // and restarted). Show an informative message and close the popup.
            suppressErrors = true;
            document.querySelector("#status").textContent = "Session expired";
            const expiredMsg = document.createElement("p");
            expiredMsg.classList.add("error");
            expiredMsg.textContent = "This authentication session has expired. Please close this window and retry.";
            document.body.insertAdjacentElement("afterbegin", expiredMsg);
            document.getElementById("modal-shade").classList.add("hidden");
            setTimeout(() => tabPort.postMessage({ action: "close-popup" }), 5000);
            return;
        }
    }
    const ul = document.querySelector("ul");
    let limit = true;
    let history = [];

    /**
     * Focus the currently-selected element in the popup, defaulting to the search input
     * or the first list item if no selection exists. Also calls `window.focus()` to bring
     * the popup iframe to the foreground.
     * @since 1.0.2
     */
    function focusSelected() {
        let selected = document.querySelector(".selected");
        if (!selected) {
            selected = document.getElementById("searchPattern") || document.querySelector("li");
            selected?.classList.add("selected");
        }
        window.focus();
        selected?.focus();
    }

    /**
     * Hash a string with SHA-256, delegating to the background service worker if the
     * Web Crypto API is unavailable in this context.
     * @since 1.0.0
     * @param {string} s - The string to hash.
     * @returns {Promise<string>} The hex digest.
     */
    const sha256 = async (s) => {
        try {
            return await Helpers.sha256(s);
        } catch (_err) {
            console.warn("Crypto API not available in this context, delegating hash to background worker.");
            // If the crypto API isn't available in this context, hash via the background service
            const digest = new Promise((resolve) => {
                function shaListener(msg) {
                    if (msg?.action === "sha256-digest" && msg.value === s) {
                        port.onMessage.removeListener(shaListener);
                        resolve(msg.hash);
                    }
                }
                port.onMessage.addListener(shaListener);
            });
            port.postMessage({ action: "sha256", value: s });
            return await digest;
        }
    };

    /**
     * Custom element for displaying a line of the plaintext in detail view
     * @since 1.0.0
     */
    class ParcelPlaintextLine extends HTMLElement {
        static observedAttributes = ["data-value"];
        #root;
        #marqueeId = null;
        #scrollTimeout = null;
        #originalText = null;

        constructor() {
            super();
            this.#root = this.attachShadow({ mode: "open" });
            this.#root.appendChild(document.getElementById("parcel-plaintext-line-template").content.cloneNode(true));

            const line = this.#root.querySelector(".line");
            line.addEventListener("mouseenter", () => this.#startHover(line));
            line.addEventListener("mouseleave", () => this.#endHover(line));

            this.#root.querySelector(".copy").addEventListener("click", async (ev) => {
                ev.stopPropagation();
                await navigator.clipboard.writeText(this.getValue());
                window.close();
            });
            if (document.querySelector(".context-popup")) {
                this.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    tabPort.postMessage({ action: "fill-value", value: this.getValue() });
                });
            }
        }

        disconnectedCallback() {
            this.#endHover();
        }

        #startHover(line) {
            if (line.scrollWidth <= line.clientWidth) return;

            this.#originalText = line.textContent;
            const displayText = this.#originalText.replace(/^[^:]+:\s*/, "");
            line.textContent = displayText;

            if (line.scrollWidth <= line.clientWidth) return;

            line.classList.add("scrolling");
            if (line.scrollWidth <= line.clientWidth) return;

            this.#scrollTimeout = setTimeout(() => {
                line.textContent = "";
                const track = document.createElement("span");
                track.style.display = "inline-flex";
                track.style.whiteSpace = "pre";
                track.style.flexShrink = "0";

                const s1 = document.createElement("span");
                s1.textContent = displayText;
                s1.style.flexShrink = "0";
                const s2 = document.createElement("span");
                s2.textContent = displayText;
                s2.style.flexShrink = "0";
                s2.style.marginLeft = "2ch";

                track.appendChild(s1);
                track.appendChild(s2);
                line.appendChild(track);

                const gap = parseFloat(getComputedStyle(s2).marginLeft) || 0;
                const width = s1.scrollWidth + gap;
                const start = performance.now();
                const speed = 60;

                const step = (now) => {
                    const elapsed = now - start;
                    const pos = -(((elapsed * speed) / 1000) % width);
                    track.style.transform = `translateX(${pos}px)`;
                    this.#marqueeId = requestAnimationFrame(step);
                };
                this.#marqueeId = requestAnimationFrame(step);
            }, 500);
        }

        #endHover() {
            const line = this.#root.querySelector(".line");
            if (this.#scrollTimeout) {
                clearTimeout(this.#scrollTimeout);
                this.#scrollTimeout = null;
            }
            if (this.#marqueeId) {
                cancelAnimationFrame(this.#marqueeId);
                this.#marqueeId = null;
            }
            if (this.#originalText !== null) {
                line.textContent = this.#originalText;
                this.#originalText = null;
            }
            line.classList.remove("scrolling");
        }

        attributeChangedCallback(name, oldValue, newValue) {
            switch (name) {
                case "data-value":
                    this.setValue(newValue);
                    break;
            }
        }

        /**
         * Get the value of the line
         * @since 1.0.0
         * @returns {string}
         */
        getValue() {
            const line = this.#originalText !== null ? this.#originalText : this.#root.querySelector(".line").textContent,
                matches = line.match(/^[a-z0-9_]+:(?!\/\/)\s*(.+)$/iu);
            if (matches) return matches[1];
            return line.trim();
        }

        /**
         * Set the displayed value of the line
         * @since 1.0.0
         * @param {string} value - The value to display
         */
        setValue(value) {
            this.#endHover();
            this.#root.querySelector(".line").textContent = value;
        }
    }
    customElements.define("parcel-plaintext-line", ParcelPlaintextLine);

    /**
     * Custom element for displaying extracted values in the detail view.
     * @since 1.0.0
     */
    class ParcelValue extends HTMLElement {
        static observedAttributes = ["data-label", "data-value", "data-name"];
        #root;

        constructor() {
            super();
            this.#root = this.attachShadow({ mode: "open" });
            this.#root.appendChild(document.getElementById("parcel-value-template").content.cloneNode(true));

            this.#root.querySelector(".copy").addEventListener("click", async (ev) => {
                ev.stopPropagation();
                await navigator.clipboard.writeText(this.#root.querySelector(".value").textContent);
                window.close();
            });
            if (document.querySelector(".context-popup")) {
                this.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    tabPort.postMessage({ action: "fill-value", value: this.#root.querySelector(".value").textContent });
                });
            }
        }

        attributeChangedCallback(name, oldValue, newValue) {
            switch (name) {
                case "data-label":
                    this.#root.querySelector(".label").textContent = newValue;
                    break;
                case "data-value":
                    this.setValue(newValue);
                    break;
            }
        }

        /**
         * Set the displayed value, supporting dynamic values if a function is provided.
         * @since 1.0.0
         * @param {string|function} value - The value to display, or a function returning a value spec with `value`, `again`, `epoch`, `interval`, `generatedAt`, and `refreshAt` properties.
         * @param {boolean} [asChars=false] - Whether to split the value into individual character elements for styling.
         * @returns {Promise<void>}
         */
        async setValue(value, asChars = false) {
            if (typeof value === "function") {
                const valueFn = value,
                    spec = await valueFn(),
                    container = this.#root.querySelector(".value-container");
                let interval = null;

                function refresh() {
                    const remaining = spec.interval - (Date.now() - spec.generatedAt);
                    container.style.borderImage = `linear-gradient(to right, var(--color-progress) ${(remaining / spec.interval) * 100}%, transparent 0) 1`;
                    if (remaining < 0) {
                        clearInterval(interval);
                        this.setValue(valueFn);
                    }
                }

                if (spec.refreshAt) {
                    container.style.borderBottom = "1px solid transparent";
                    container.style.paddingBottom = "-1px";
                    refresh.call(this);
                    interval = setInterval(refresh.bind(this), 50);
                    value = spec.value;
                }
            }
            const elValue = this.#root.querySelector(".value");
            if (asChars) {
                for (const c of [...value]) {
                    const el = document.createElement("span");
                    el.classList.add("char");
                    if (c.match(/[\d]/)) el.classList.add("digit");
                    else if (c.match(/\p{P}/u)) el.classList.add("punct");
                    el.textContent = c;
                    elValue.appendChild(el);
                }
            } else this.#root.querySelector(".value").textContent = value;
        }
    }
    customElements.define("parcel-value", ParcelValue);

    /**
     * Custom element for displaying the detail view.
     * @since 1.0.0
     */
    class ParcelDetail extends HTMLElement {
        static observedAttributes = ["data-path", "data-plaintext"];
        #plaintext;
        #root;

        constructor() {
            super();
            this.#root = this.attachShadow({ mode: "open" });
            this.#root.appendChild(document.getElementById("parcel-detail-template").content.cloneNode(true));
        }

        /**
         * Populate the detail view by hoisting high-priority values and rendering all plaintext lines.
         * @since 1.0.0
         * @param {Plaintext} plaintext - The plaintext instance to render.
         * @returns {Promise<void>}
         */
        async setPlaintext(plaintext) {
            this.#plaintext = plaintext;
            const config = await this.#plaintext.getConfig();

            for (const target of config.targets.concat(config.additionalTargets || [])) {
                if (!target.hoist) continue;
                const value = await this.#plaintext.getValue(target.name);
                if (value === null) continue;
                const el = document.createElement("parcel-value");
                el.setAttribute("data-label", target.label || target.name);
                el.setValue(target.dynamic ? () => this.#plaintext.getValue(target.name) : value, target.highlightSpecial);
                this.#root.appendChild(el);
            }

            const elPlaintext = document.createElement("div");
            elPlaintext.classList.add("plaintext");
            for (const line of this.#plaintext.getPlaintext().split(/\r\n|\n|\r/iu)) {
                const el = document.createElement("parcel-plaintext-line");
                el.setValue(line);
                elPlaintext.appendChild(el);
            }
            this.#root.appendChild(elPlaintext);

            await new Promise((resolve) => requestAnimationFrame(resolve));
            document.body.style.minHeight = this.scrollHeight + "px";
            document.body.style.minWidth = `min(500px, ${this.scrollWidth}px)`;
            if (!isWindowMode) reportPopupSize();
        }
    }
    customElements.define("parcel-detail", ParcelDetail);

    /**
     * Report the popup's rendered size to the host page, which uses it to size the
     * popup iframe. The body's visible border-box is measured instead of scrollWidth/
     * scrollHeight: on a height-clamped body the scroll dimensions describe
     * the overflowing content, so the frame would grow past the body - leaving dead
     * space at the bottom while the overflow clips the content off the top.
     * @since 1.0.4
     * @returns {void}
     */
    function reportPopupSize() {
        const rect = document.body.getBoundingClientRect();
        tabPort.postMessage({ action: "resize", width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
    }

    // init specific to the popup invocation type
    if (token === "broadcast") {
        document.body.classList.add("action-popup");
        window.addEventListener("keydown", (ev) => {
            if (["Escape", "ArrowLeft"].includes(ev.key)) {
                ev.preventDefault();
                const detail = document.getElementsByTagName("parcel-detail").item(0);
                if (detail) detail.remove();
                else if (ev.key === "Escape") window.close();
                document.getElementById("modal-shade").classList.add("hidden");
                document.querySelector(".selected").scrollIntoView({ behavior: "smooth", block: "nearest" });
                focusSelected();
            }
        });
        tabPort.onMessage.addListener((msg) => {
            if (msg?.action === "close") {
                window.close();
            }
        });
    } else {
        document.body.classList.add("context-popup");
        if (isWindowMode) document.body.classList.add("window-popup");
        // In window mode the tab port is a no-op dummy — size reporting is
        // handled by CSS (fixed window size, internal vertical scroll).
        if (!isWindowMode) {
            new ResizeObserver(reportPopupSize).observe(document.body);
            reportPopupSize();
        }
        window.addEventListener("keydown", (ev) => {
            if (ev.key !== "Escape") return;
            if (mode === "http-auth") {
                if (isWindowMode) return;
                port.postMessage({ action: "http-auth-cancel" });
                tabPort.postMessage({ action: "close", cancelNavigation: true });
            } else {
                tabPort.postMessage({ action: "close" });
            }
        });

        // When the detail view is open, allow typing a 1-based plaintext line
        // number to fill that line's value into the target element, just as
        // clicking the line would. Digit input is accumulated and the value is
        // filled automatically once input pauses for the timeout duration.
        // When there are fewer than ten lines, a second digit could never form
        // a valid index, so the value is filled immediately on the first digit
        // instead of waiting. Escape cancels any pending input. The detail view
        // is modal, so it captures keystrokes regardless of where focus sits.
        let lineNumberBuffer = "";
        let lineNumberTimer = null;
        const LINE_NUMBER_TIMEOUT = 850;
        window.addEventListener("keydown", (ev) => {
            const detail = document.getElementsByTagName("parcel-detail").item(0);
            if (!detail) return;
            if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

            if (/^\d$/.test(ev.key)) {
                ev.preventDefault();
                lineNumberBuffer += ev.key;
                if (lineNumberTimer) {
                    clearTimeout(lineNumberTimer);
                    lineNumberTimer = null;
                }
                const lineCount = detail.shadowRoot.querySelectorAll("parcel-plaintext-line").length;
                if (lineCount < 10) {
                    fillPlaintextLine(detail, lineNumberBuffer);
                    lineNumberBuffer = "";
                } else {
                    lineNumberTimer = setTimeout(() => {
                        fillPlaintextLine(detail, lineNumberBuffer);
                        lineNumberBuffer = "";
                        lineNumberTimer = null;
                    }, LINE_NUMBER_TIMEOUT);
                }
                return;
            }
            if (ev.key === "Escape") {
                lineNumberBuffer = "";
                if (lineNumberTimer) {
                    clearTimeout(lineNumberTimer);
                    lineNumberTimer = null;
                }
            }
        });

        /**
         * Fill the value of a plaintext line (1-based index) from a detail view
         * into the active target element, matching the behaviour of clicking
         * the line. Out-of-range indices are ignored.
         * @since 1.0.2
         * @param {ParcelDetail} detail - The detail element containing the lines.
         * @param {string|number} index - The 1-based line number to fill.
         * @returns {void}
         */
        function fillPlaintextLine(detail, index) {
            const lines = detail.shadowRoot.querySelectorAll("parcel-plaintext-line");
            const i = parseInt(index, 10);
            if (!Number.isNaN(i) && i >= 1 && i <= lines.length) {
                const line = lines[i - 1];
                tabPort.postMessage({ action: "fill-value", value: line.getValue() });
            }
        }
    }

    if (tab.url) {
        const url = new URL(tab.url);
        const hash = await sha256(url.origin);
        const scope = await sha256(tab.contextualIdentity ? tab.contextualIdentity : "default");
        document.getElementById("origin").textContent = url.hostname;
        history = (await chrome.storage.local.get(`history:${scope}:${hash}`))?.[`history:${scope}:${hash}`] || [];
    } else {
        limit = false;
        document.getElementById("origin").classList.add("hidden");
    }

    // Card fields are not origin-specific — a card is used across many sites —
    // so the popup defaults to global search instead of origin-limited results.
    if (targetClass === "card") {
        limit = false;
        document.getElementById("origin").classList.add("hidden");
    }

    document.getElementById("modal-shade").addEventListener("click", () => {
        document.querySelectorAll("parcel-detail").forEach((el) => el.remove());
        document.getElementById("modal-shade").classList.add("hidden");
        focusSelected();
    });

    window.addEventListener("keydown", (ev) => {
        if (mode === "passkey" || mode === "passkey-conflict") return; // these views use native button/tab navigation
        let selected = document.querySelector(".selected");
        if (ev.key === "ArrowDown" || (ev.key === "Tab" && !ev.shiftKey)) {
            ev.preventDefault();
            selected.classList.remove("selected");
            if (selected.tagName === "LI" && selected.nextElementSibling) {
                selected = selected.nextElementSibling;
            } else if (selected.tagName === "INPUT") {
                selected = document.querySelector("li") || selected;
            }
            selected.classList.add("selected");
            selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
            selected.focus();
        } else if (ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey)) {
            if (ev.key === "Tab" && ev.shiftKey && token !== "broadcast" && selected.id === "searchPattern") {
                ev.preventDefault();
                if (!tabPort.postMessage({ action: "focus-target" })) window.close();
                return;
            }
            ev.preventDefault();
            selected.classList.remove("selected");
            if (selected.tagName === "LI") {
                if (selected.previousElementSibling) selected = selected.previousElementSibling;
                else selected = document.getElementById("searchPattern");
            }
            selected.classList.add("selected");
            selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
            selected.focus();
        } else if (ev.key === "ArrowRight" && selected.tagName === "LI") {
            ev.preventDefault();
            document.querySelector("li.selected button.detail").click();
        } else if (ev.key === "ArrowLeft" && selected.tagName === "LI") {
            ev.preventDefault();
            const detail = document.getElementsByTagName("parcel-detail").item(0);
            if (detail) detail.remove();
            document.getElementById("modal-shade").classList.add("hidden");
            selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
            selected.focus();
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            (document.querySelector("li.selected") || document.querySelector("li"))?.click();
        }
    });

    // listen for status & error messages returned from the content script
    tabPort.onMessage.addListener((msg) => {
        if (msg?.action === "focus-popup") {
            focusSelected();
        } else if (msg?.action === "status") {
            document.querySelector("#status").textContent = msg.status;
        } else if (msg?.action === "clear-status") {
            document.querySelector("#status").textContent = "Idle";
        } else if (msg?.action === "error") {
            document.querySelector("#status").textContent = "Error";
            const p = document.createElement("p");
            p.classList.add("error");
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => {
                if (el._errorTimer) clearTimeout(el._errorTimer);
                el.remove();
            });
            document.body.insertAdjacentElement("afterbegin", p);
            p._errorTimer = setTimeout(() => {
                delete p._errorTimer;
                p.remove();
            }, 5000);
        } else if (msg?.action === "origin") {
            if (tab.url) {
                frameOrigin = msg.origin;
                const tabURL = new URL(tab.url);
                if (msg.origin !== tabURL.origin) {
                    tabPort.postMessage({ action: "focus-suspend" });
                    alert(
                        `The field you are trying to fill is from a different origin (${msg.origin}) than the page you ` +
                            `are browsing (${tabURL.origin}). This may be a sign of a security issue. Do not ` +
                            `enter any sensitive information into this field unless you are sure it is safe to do so.`,
                    );
                    tabPort.postMessage({ action: "focus-resume" });
                }
            }
        }
    });

    // parcel config from the native host
    const config = new Promise((resolve) => {
        function configListener(msg) {
            if (msg?.action === "config") {
                port.onMessage.removeListener(configListener);
                resolve(msg?.config);
            }
        }
        port.onMessage.addListener(configListener);
        port.postMessage({ action: "config" });
    });

    /**
     * Copy text to the clipboard, falling back to a hidden textarea and
     * `execCommand("copy")` when the async Clipboard API is unavailable or policy-denied
     * (e.g. browsers without clipboard-write iframe delegation).
     *
     * @since 1.0.4
     * @param {string} text - The text to copy.
     * @returns {Promise<boolean>} `true` when the copy succeeded.
     */
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_err) {
            // clipboard API unavailable or denied - use the legacy path
        }
        const scratch = document.createElement("textarea");
        scratch.value = text;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.left = "-9999px";
        document.body.appendChild(scratch);
        scratch.select();
        try {
            return document.execCommand("copy");
        } catch (_err) {
            return false;
        } finally {
            scratch.remove();
        }
    }

    /**
     * Build the self-contained shell snippet that saves an armored passkey entry to disk.
     * Paths are single-quote-escaped and the heredoc delimiter is quoted so the blob
     * cannot be mangled by shell expansion. The delimiter is deliberately distinctive
     * so the command cannot terminate early should the content ever contain the line.
     *
     * @since 1.0.4
     * @param {string} file - Absolute path of the entry file to write.
     * @param {string} content - Armored, already-encrypted entry content.
     * @param {string} [rpId] - Relying party ID, used for the git commit message when included.
     * @param {string} [passdir] - Absolute path of the password store root, used as git -C target.
     * @returns {string} The shell command.
     */
    function buildPasskeySaveCommand(file, content, rpId, passdir) {
        const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
        const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
        let cmd = `mkdir -p ${q(dir)} && cat > ${q(file)} <<'PARCEL_PASSKEY_EOF'\n${content}\nPARCEL_PASSKEY_EOF\n`;
        if (rpId) {
            const gitDir = passdir && file.startsWith(passdir) ? passdir : dir;
            cmd += `git -C ${q(gitDir)} add ${q(file)} && git -C ${q(gitDir)} commit -m "Add passkey for ${rpId} to store."\n`;
        }
        return cmd;
    }

    /**
     * Initialise the passkey consent ceremony interface: replace the fill view with the
     * ceremony view, render the ceremony context when it arrives from the content script,
     * and wire the consent/cancel/fallback actions back over the tab port. Creation is
     * only offered for "create" operations — answering a "get" call with an
     * attestation-shaped credential would break the relying party, so new credentials
     * cannot be registered from an assertion ceremony.
     * @since 1.0.4
     * @returns {void}
     */
    function initPasskeyPopup() {
        const elRoot = document.getElementById("passkey");
        const elTitle = document.getElementById("passkey-title");
        const elOrigin = document.getElementById("passkey-origin");
        const elUser = document.getElementById("passkey-user");
        const elHints = document.getElementById("passkey-hints");
        const elExisting = document.getElementById("passkey-existing");
        const elExistingList = document.getElementById("passkey-existing-list");
        const elEntries = document.getElementById("passkey-entries");

        /**
         * The display name for a passkey candidate, with its rule's strip pattern
         * applied (falls back to the raw entry name when the rule sets no strip).
         *
         * @param {Object} candidate - candidate entry ({name, rule})
         * @returns {string} display name
         * @since 1.0.4
         */
        function stripName(candidate) {
            return candidate.rule?.strip ? candidate.name.replace(new RegExp(candidate.rule.strip, "ui"), "") : candidate.name;
        }
        const elSave = document.getElementById("passkey-save");
        const elActions = document.getElementById("passkey-actions");
        const elCreate = document.getElementById("passkey-create");
        const elFallback = document.getElementById("passkey-fallback");
        const elCopy = document.getElementById("passkey-copy");
        // the raw armored entry, its target path, and the ceremony rpId, kept
        // separately from the textarea (which shows the full shell command) so
        // downloads stay pristine
        let passkeySaveFile = "";
        let passkeySaveContent = "";
        let passkeyRpId = "";
        let passkeyPassdir = "";

        const elCommitToggle = document.getElementById("passkey-commit");
        const elBlob = document.getElementById("passkey-blob");

        /**
         * Rebuild the textarea command from the cached save data and checkbox state.
         * @since 1.0.4
         * @returns {void}
         */
        function refreshSaveCommand() {
            elBlob.value = buildPasskeySaveCommand(
                passkeySaveFile,
                passkeySaveContent,
                elCommitToggle.checked ? passkeyRpId : undefined,
                passkeyPassdir,
            );
        }

        elCommitToggle.addEventListener("change", refreshSaveCommand);

        document.body.classList.add("passkey-popup");
        elRoot.classList.remove("hidden");

        // prevent further input while the content script settles the ceremony; the
        // iframe is closed once it has
        const disableActions = () => elRoot.querySelectorAll("button").forEach((button) => (button.disabled = true));

        elRoot.querySelectorAll(".passkey-cancel").forEach((button) =>
            button.addEventListener("click", () => {
                disableActions();
                tabPort.postMessage({ action: "passkey-cancel" });
            }),
        );
        elFallback.addEventListener("click", () => {
            disableActions();
            tabPort.postMessage({ action: "passkey-fallback" });
        });
        elCreate.addEventListener("click", () => {
            // the ceremony continues with the save view, so only the decision buttons are retired
            elCreate.disabled = true;
            elFallback.disabled = true;
            tabPort.postMessage({ action: "passkey-create" });
        });
        elCopy.addEventListener("click", async () => {
            const elBlob = document.getElementById("passkey-blob");
            if (await copyText(elBlob.value)) {
                elCopy.textContent = "Copied!";
            } else {
                // copy failed - select the text for manual copying
                elBlob.select();
            }
        });
        document.getElementById("passkey-download").addEventListener("click", () => {
            if (!passkeySaveContent) return;
            // the blob is already encrypted ciphertext; an anchor download needs no extra permission
            const filename = passkeySaveFile.split("/").pop() || "passkey.gpg";
            const url = URL.createObjectURL(new Blob([passkeySaveContent + "\n"], { type: "application/pgp-encrypted" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        });
        document.getElementById("passkey-ack").addEventListener("click", () => {
            disableActions();
            tabPort.postMessage({ action: "passkey-create-ack" });
        });

        /**
         * Render the ceremony context received from the content script: heading, requesting
         * origin, the candidate account list (assertion) or account details (creation), and
         * the actions appropriate to the operation.
         * @since 1.0.4
         * @param {object} context - Ceremony context `{op, rpId, origin, candidates, user}`.
         * @returns {void}
         */
        async function renderPasskeyContext(context) {
            elActions.classList.remove("hidden");
            elOrigin.textContent = `Requested by ${context.origin}`;
            // Surface WebAuthn hints Parcel cannot satisfy (e.g. security-key, hybrid)
            // and any non-compliant hint tokens, so the user can make an informed choice.
            const { violated = [], nonCompliant = [] } = context.hintWarning || {};
            if (violated.length || nonCompliant.length) {
                const parts = [];
                if (violated.length) {
                    parts.push(
                        `This site requested authenticator hints Parcel cannot satisfy (${violated.join(", ")}). ` +
                            "Proceed only if you understand the site may reject the credential.",
                    );
                }
                if (nonCompliant.length) {
                    parts.push(`Non-compliant WebAuthn hint received: ${nonCompliant.join(", ")}.`);
                }
                elHints.textContent = parts.join(" ");
                elHints.classList.remove("hidden");
            } else {
                elHints.classList.add("hidden");
            }
            if (context.op === "create") {
                elTitle.textContent = `Create a passkey for ${context.rpId}?`;
                elUser.textContent = context.user?.displayName
                    ? `Account: ${context.user.displayName} (${context.user.name})`
                    : `Account: ${context.user?.name || "unnamed account"}`;
                elUser.classList.remove("hidden");
                // Parcel cannot honour excludeCredentials (credential IDs live inside
                // encrypted entries, so they can't be checked without decryption), so
                // existing passkeys for this site are surfaced here instead - letting
                // the user spot a duplicate registration before creating another one
                if (context.candidates?.length) {
                    elExisting.textContent = `You already have ${context.candidates.length === 1 ? "a passkey" : `${context.candidates.length} passkeys`} for this site:`;
                    elExistingList.replaceChildren(
                        ...context.candidates.map((candidate) => {
                            const li = document.createElement("li");
                            if (candidate.rule?.tag) {
                                const tag = document.createElement("span");
                                tag.classList.add("tag");
                                tag.textContent = candidate.rule.tag;
                                tag.style.backgroundColor = `#${candidate.rule.color}`;
                                const luma = Helpers.getLuma(candidate.rule.color);
                                tag.style.color = luma < 0.35 ? "var(--color-text-tag-inverted)" : "var(--color-text-tag)";
                                li.appendChild(tag);
                            }
                            li.appendChild(document.createTextNode(stripName(candidate)));
                            return li;
                        }),
                    );
                    elExisting.classList.remove("hidden");
                    elExistingList.classList.remove("hidden");
                } else {
                    elExisting.classList.add("hidden");
                    elExistingList.classList.add("hidden");
                }
                elCreate.focus({ preventScroll: true });
            } else {
                elExisting.classList.add("hidden");
                elExistingList.classList.add("hidden");
                elTitle.textContent = `Sign in to ${context.rpId} with a passkey?`;
                elCreate.classList.add("hidden");
                for (const candidate of context.candidates) {
                    const button = document.createElement("button");
                    button.type = "button";

                    if (candidate.rule?.tag) {
                        const tag = document.createElement("span");
                        tag.classList.add("tag");
                        tag.textContent = candidate.rule.tag;
                        tag.style.backgroundColor = `#${candidate.rule.color}`;
                        const luma = Helpers.getLuma(candidate.rule.color);
                        tag.style.color = luma < 0.35 ? "var(--color-text-tag-inverted)" : "var(--color-text-tag)";
                        button.appendChild(tag);
                    }

                    const nameContainer = document.createElement("span");
                    nameContainer.classList.add("name-container");

                    const displayName = stripName(candidate);

                    const name = document.createElement("span");
                    name.classList.add("name");
                    name.textContent = displayName;
                    nameContainer.appendChild(name);

                    // store-relative path, shown only when it differs from the name
                    const passdir = (await config).passdir;
                    const pathSpan = document.createElement("span");
                    pathSpan.classList.add("path");
                    if (passdir && candidate.path.startsWith(passdir)) {
                        pathSpan.textContent = candidate.path.slice(
                            passdir.length + (candidate.path.charAt(passdir.length) === "/" ? 1 : 0),
                        );
                    } else {
                        pathSpan.textContent = candidate.path;
                    }
                    if (pathSpan.textContent.replace(/.gpg$/, "") !== name.textContent) nameContainer.appendChild(pathSpan);

                    button.appendChild(nameContainer);

                    // candidate consent signs an assertion for this entry
                    button.addEventListener("click", () => {
                        disableActions();
                        tabPort.postMessage({ action: "passkey-assert", path: candidate.path });
                    });
                    elEntries.appendChild(document.createElement("li")).appendChild(button);
                }
                elEntries.querySelector("button")?.focus({ preventScroll: true });
            }
        }

        tabPort.onMessage.addListener((msg) => {
            if (msg?.action === "passkey-context") {
                renderPasskeyContext(msg.context);
            } else if (msg?.action === "passkey-created") {
                // the credential has been minted but is not yet stored; the user must save
                // the entry out-of-band and confirm before the ceremony completes
                elActions.classList.add("hidden");
                passkeySaveFile = msg.file || msg.path;
                passkeySaveContent = msg.armored || "";
                passkeyRpId = msg.rpId || "";
                config.then((c) => {
                    passkeyPassdir = c.passdir;
                    elCommitToggle.checked = !!c.gitInPasskeyCommand;
                    refreshSaveCommand();
                });
                document.querySelector("#status").textContent = "Save the new passkey entry to continue";
                elSave.classList.remove("hidden");
                // preventScroll: the enlarged body may not have been re-measured yet, and
                // scrolling the overflow-hidden body to the new button would clip the title
                elCopy.focus({ preventScroll: true });
            }
        });
    }

    /**
     * Initialise the passkey conflict notice: shown instead of the fill view when another
     * extension controls the page's WebAuthn API while the user holds Parcel passkeys for
     * the site. Offers a per-origin dismissal (persisted by the content script), a link to
     * the documentation, and a plain close.
     * @since 1.0.4
     * @returns {void}
     */
    function initPasskeyConflict() {
        const elRoot = document.getElementById("passkey-conflict");
        const disableActions = () => elRoot.querySelectorAll("button").forEach((button) => (button.disabled = true));

        document.body.classList.add("passkey-popup");
        elRoot.classList.remove("hidden");

        tabPort.onMessage.addListener((msg) => {
            if (msg?.action === "passkey-conflict-context" && msg.context?.origin) {
                document.getElementById("passkey-conflict-origin").textContent = msg.context.origin;
            }
        });
        document.getElementById("passkey-conflict-dismiss").addEventListener("click", () => {
            disableActions();
            tabPort.postMessage({ action: "passkey-conflict-dismiss" });
        });
        document.getElementById("passkey-conflict-docs").addEventListener("click", () => {
            window.open(
                "https://github.com/parcel-pm/parcel#passkey-conflicts-with-other-password-managers",
                "_blank",
                "noopener,noreferrer",
            );
        });
        elRoot.querySelectorAll(".passkey-conflict-close").forEach((button) =>
            button.addEventListener("click", () => {
                disableActions();
                tabPort.postMessage({ action: "close" });
            }),
        );
        document.getElementById("passkey-conflict-dismiss").focus();
    }

    // listen for messages from the native host
    port.onMessage.addListener(async (msg) => {
        if (msg.action === "status") {
            document.querySelector("#status").textContent = msg.status;
        } else if (msg.action === "clear-status") {
            document.querySelector("#status").textContent = "Idle";
        } else if (msg.action === "match") {
            if (!msg.entries.length && !document.querySelector(".no-matches")) {
                const p = document.createElement("p");
                p.classList.add("list-notice", "no-matches");
                p.textContent = "No matching entries";
                ul.insertAdjacentElement("afterend", p);
            } else if (msg.entries.length) {
                document.querySelector(".no-matches")?.remove();
            }
            ul.querySelectorAll(":scope > li").forEach((el) => (el._keep = false));
            for (const entry of msg.entries) {
                let li = ul.querySelector(`li[data-path="${CSS.escape(entry.path)}"]`);
                if (li) {
                    // reuse existing li elements
                    li._keep = true;
                    ul.appendChild(li);
                    continue;
                }
                li = document.createElement("li");
                li._keep = true;
                li.tabIndex = -1;
                li.setAttribute("data-path", entry.path);
                if (entry.isInHistory) li.classList.add("history");
                if (entry.rule?.class === "card") li.classList.add("entry-card");
                else if (entry.rule?.class === "passkey") li.classList.add("entry-passkey");
                else li.classList.add("entry-login");
                li.setAttribute("data-sort-order", entry.sortOrder);

                if (entry.rule.tag) {
                    const tag = document.createElement("span");
                    tag.classList.add("tag");
                    tag.textContent = entry.rule.tag;
                    tag.style.backgroundColor = `#${entry.rule.color}`;
                    const luma = Helpers.getLuma(entry.rule.color);
                    if (luma < 0.35) tag.style.color = "var(--color-text-tag-inverted)";
                    else tag.style.color = "var(--color-text-tag)";
                    li.appendChild(tag);
                }

                const nameContainer = document.createElement("div");
                nameContainer.classList.add("name-container");

                const name = document.createElement("span");
                name.classList.add("name");
                name.textContent = entry.rule.strip ? entry.name.replace(new RegExp(entry.rule.strip, "ui"), "") : entry.name;
                nameContainer.appendChild(name);

                const pathSpan = document.createElement("span");
                pathSpan.classList.add("path");
                const passdir = (await config).passdir;
                if (passdir && entry.path.startsWith(passdir)) {
                    pathSpan.textContent = entry.path.slice(passdir.length + (entry.path.charAt(passdir.length) === "/" ? 1 : 0));
                } else {
                    pathSpan.textContent = entry.path;
                }
                if (pathSpan.textContent.replace(/.gpg$/, "") !== name.textContent) nameContainer.appendChild(pathSpan);

                li.appendChild(nameContainer);

                const url = new URL(tab.url || "undefined-url://");
                const hash = await sha256(url.origin);
                const scope = await sha256(tab.contextualIdentity ? tab.contextualIdentity : "default");
                for (const he of history) {
                    if (he.path === (await sha256(entry.path))) {
                        const historyButton = document.createElement("button");
                        historyButton.classList.add("historyNuke");
                        historyButton.setAttribute("title", "Forget this entry");
                        historyButton.addEventListener("click", (ev) => {
                            ev.stopPropagation();
                            history = history.filter((h) => h.path !== he.path);
                            chrome.storage.local.set({ [`history:${scope}:${hash}`]: history });
                            historyButton.remove();
                            li.remove();
                            for (let el = ul.lastElementChild; el; el = el.previousElementSibling) {
                                if (parseInt(el.getAttribute("data-sort-order")) < entry.sortOrder || el.classList.contains("history")) {
                                    el.insertAdjacentElement("afterend", li);
                                    break;
                                }
                            }
                            if (!li.parentElement) {
                                ul.insertAdjacentElement("afterbegin", li);
                            }
                        });
                        li.appendChild(historyButton);
                        break;
                    }
                }

                const button = document.createElement("button");
                button.classList.add("detail");
                button.setAttribute("title", "Show detailed content");
                if (mode === "http-auth") button.classList.add("hidden");
                else {
                    button.addEventListener("click", (ev) => {
                        ev.stopPropagation();
                        document.querySelector(".selected")?.classList.remove("selected");
                        button.closest("li").classList.add("selected");
                        document.getElementById("modal-shade").classList.remove("hidden");
                        port.postMessage({ action: "decrypt", intent: "detail", origin: url.origin, path: entry.path });
                    });
                }
                li.appendChild(button);

                li.addEventListener("click", async () => {
                    const intent = mode === "http-auth" ? "http-auth" : "fill";
                    port.postMessage({ action: "decrypt", intent, origin: url.origin, path: entry.path });
                    // Card entries are never added to fill history — card fills are not
                    // origin-specific and tracking them would clutter login history.
                    if ((entry.rule?.class || "login") === "card") return;
                    const hash = await sha256(entry.path);
                    if (history?.[0]?.path === hash) history[0].when = Date.now();
                    else history.unshift({ path: hash, when: Date.now() });
                });

                ul.appendChild(li);
            }
            ul.querySelectorAll(":scope > li").forEach((el) => {
                if (!el._keep) el.remove();
            });
        } else if (msg.action === "plaintext") {
            if (msg.intent === "fill") {
                const delivered = tabPort.postMessage({
                    action: "fill",
                    token,
                    plaintext: msg.plaintext,
                    config: await config,
                    origin: frameOrigin,
                });
                // Only record history when the fill was actually delivered to the content
                // script; otherwise we would log a fill against a stale tab that never happened.
                if (delivered && tab.url && (await config).saveHistory) {
                    const url = new URL(tab.url);
                    const hash = await sha256(url.origin);
                    const scope = await sha256(tab.contextualIdentity ? tab.contextualIdentity : "default");
                    chrome.storage.local.set({ [`history:${scope}:${hash}`]: history.slice(0, (await config).historyLength) });
                }
            } else if (msg.intent === "detail") {
                const plaintext = new Plaintext(msg.plaintext, config);
                document.querySelectorAll("parcel-detail").forEach((el) => el.remove());
                const elDetail = document.createElement("parcel-detail");
                elDetail.setPlaintext(plaintext);
                document.body.appendChild(elDetail);
            }
        } else if (msg.action === "http-auth-done") {
            tabPort.postMessage({ action: "close-popup" });
        } else if (msg.action === "error") {
            if (suppressErrors) return;
            document.querySelector("#status").textContent = "Error";
            const p = document.createElement("p");
            p.classList.add("error");
            if (Object.prototype.hasOwnProperty.call(msg, "category")) p.classList.add(`error-category-${msg.category}`);
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => {
                if (el._errorTimer) clearTimeout(el._errorTimer);
                el.remove();
            });
            document.body.insertAdjacentElement("afterbegin", p);
            document.getElementById("modal-shade").classList.add("hidden");
            p.scrollIntoView({ behavior: "instant", block: "nearest" });
            p._errorTimer = setTimeout(() => {
                delete p._errorTimer;
                p.remove();
            }, 10000);
        } else if (msg.action === "clear-errors") {
            const selector = Object.prototype.hasOwnProperty.call(msg, "category") ? `p.error.error-category-${msg.category}` : "p.error";
            document.querySelectorAll(selector).forEach((el) => {
                if (el._errorTimer) clearTimeout(el._errorTimer);
                el.remove();
            });
        }
    });

    if (mode === "passkey") {
        initPasskeyPopup();
    } else if (mode === "passkey-conflict") {
        initPasskeyConflict();
    } else {
        const search = document.getElementById("searchPattern");

        // For http-auth mode, show the action buttons
        if (mode === "http-auth") {
            document.getElementById("http-auth-actions").classList.remove("hidden");
            if (isWindowMode) {
                // In window mode (new-tab navigation), there's no previous
                // page to go back to, so "Cancel" is not offered.
                document.getElementById("http-auth-cancel").classList.add("hidden");
            } else {
                document.getElementById("http-auth-cancel").addEventListener("click", () => {
                    port.postMessage({ action: "http-auth-cancel" });
                    tabPort.postMessage({ action: "close", cancelNavigation: true });
                });
            }
            document.getElementById("http-auth-manual").addEventListener("click", () => {
                port.postMessage({ action: "http-auth-manual" });
                tabPort.postMessage({ action: "close" });
            });
        }

        // re-run the search when the search input changes
        search.addEventListener("input", () => {
            update();
            document.querySelector(".selected")?.classList.remove("selected");
            search.classList.add("selected");
        });

        // re-run the search
        function update() {
            port.postMessage({ action: "match", url: tab.url || "unknown-url://", search: search.value, limit, history, targetClass });
        }

        // initial search
        update();

        // For http-auth mode, always focus the search input
        if (mode === "http-auth") {
            search.focus();
        }

        document.getElementById("searchPattern").addEventListener("keydown", (ev) => {
            if (ev.key === "Backspace" && search.value.length === 0) {
                limit = false;
                document.getElementById("origin").classList.add("hidden");
            }
        });
    }

    // UI updates when the anti-phishing mode is toggled
    if (token === "broadcast") focusSelected();
    document.getElementById("live-region").textContent =
        mode === "passkey"
            ? "Parcel passkey consent opened. Press Tab to interact."
            : mode === "passkey-conflict"
              ? "Parcel passkey conflict notice opened. Press Tab to interact."
              : mode === "http-auth"
                ? "Parcel authentication required. Press Tab to interact."
                : "Parcel popup opened. Press Tab to interact.";

    // show the default-rules warning
    config.then((config) => {
        if (!config.defaultRules) return;
        const p = document.createElement("p");
        p.classList.add("warning");
        p.textContent = "No whitelist rules are configured - your entire password store is accessible!";
        document.body.insertAdjacentElement("afterbegin", p);
    });

    // tell the tab we're ready
    await new Promise((resolve) => requestAnimationFrame(resolve));
    tabPort.postMessage({ action: "ready" });
})();

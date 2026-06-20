"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const Plaintext = (await import(chrome.runtime.getURL("/js/plaintext.js"))).Plaintext;
    const token = new URLSearchParams(window.location.search).get("token") || "broadcast";
    const frameId = parseInt(new URLSearchParams(window.location.search).get("frameId"), 10) || 0;
    if (token === "broadcast" && window !== window.top) {
        const msg =
            "Parcel may not be independently embedded in a frame. If you are seeing this message, it means that a website " +
            "has attempted to embed Parcel in a way that could allow them to steal your data. Please close this window " +
            "and avoid interacting with the site until they have resolved their security problems.";
        document.body.textContent = msg;
        document.querySelectorAll("style, link[rel=stylesheet]").forEach((el) => el.remove());
        document.body.style.all = "unset";
        throw new Error(msg);
        return;
    }

    /**
     * Connect to the active tab content script, falling back to relay via the background service if necessary.
     * @since 1.0.0
     * @returns {Promise<{tab: chrome.tabs.Tab, tabPort: chrome.runtime.Port}>}
     * @throws {Error} If the bridge to the active tab reports an error or disconnects unexpectedly.
     */
    async function connectToTab() {
        if (chrome.tabs?.getCurrent && chrome.tabs?.query && chrome.tabs?.connect) {
            const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
            tab.contextualIdentity = tab?.cookieStoreId;
            return { tab, tabPort: chrome.tabs.connect(tab.id, { name: token, frameId }) };
        }

        const tabPort = chrome.runtime.connect({ name: `popup-bridge:${token}:${frameId}` });
        const tab = await new Promise((resolve, reject) => {
            const onMessage = (msg) => {
                if (msg?.action === "tab-context") {
                    tabPort.onMessage.removeListener(onMessage);
                    tabPort.onDisconnect.removeListener(onDisconnect);
                    resolve(msg.tab);
                } else if (msg?.action === "error") {
                    tabPort.onMessage.removeListener(onMessage);
                    tabPort.onDisconnect.removeListener(onDisconnect);
                    reject(new Error(msg.error));
                }
            };
            const onDisconnect = () => {
                tabPort.onMessage.removeListener(onMessage);
                tabPort.onDisconnect.removeListener(onDisconnect);
                reject(new Error(chrome.runtime.lastError?.message || "Disconnected from the active tab."));
            };

            tabPort.onMessage.addListener(onMessage);
            tabPort.onDisconnect.addListener(onDisconnect);
        });

        return { tab, tabPort };
    }

    const { tab, tabPort } = await connectToTab();
    tabPort.onDisconnect.addListener(() => {
        chrome.runtime.lastError; // suppress errors on pages where the content script is not injected
        tabPort.disconnected = true;
    });
    const port = chrome.runtime.connect({ name: "popup" });
    port.postMessage({ action: "auth", token, tab });
    const ul = document.querySelector("ul");
    let limit = true;
    let history = [];

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
        } catch (err) {
            console.warn("Crypto API not available in this context, delegating hash to background worker.");
            // If the crypto API isn't available in this context, hash via the background service
            let digest = new Promise((resolve) => {
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

            let line = this.#root.querySelector(".line");
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
            let displayText = this.#originalText.replace(/^[^:]+:\s*/, "");
            line.textContent = displayText;

            if (line.scrollWidth <= line.clientWidth) return;

            line.classList.add("scrolling");
            if (line.scrollWidth <= line.clientWidth) return;

            this.#scrollTimeout = setTimeout(() => {
                line.textContent = "";
                let track = document.createElement("span");
                track.style.display = "inline-flex";
                track.style.whiteSpace = "pre";
                track.style.flexShrink = "0";

                let s1 = document.createElement("span");
                s1.textContent = displayText;
                s1.style.flexShrink = "0";
                let s2 = document.createElement("span");
                s2.textContent = displayText;
                s2.style.flexShrink = "0";
                s2.style.marginLeft = "2ch";

                track.appendChild(s1);
                track.appendChild(s2);
                line.appendChild(track);

                let gap = parseFloat(getComputedStyle(s2).marginLeft) || 0;
                let width = s1.scrollWidth + gap;
                let start = performance.now();
                let speed = 60;

                let step = (now) => {
                    let elapsed = now - start;
                    let pos = -(((elapsed * speed) / 1000) % width);
                    track.style.transform = `translateX(${pos}px)`;
                    this.#marqueeId = requestAnimationFrame(step);
                };
                this.#marqueeId = requestAnimationFrame(step);
            }, 500);
        }

        #endHover() {
            let line = this.#root.querySelector(".line");
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
            let line = this.#originalText !== null ? this.#originalText : this.#root.querySelector(".line").textContent,
                matches = line.match(/^[a-z0-9_\-]+:(?!\/\/)\s*(.+)$/iu);
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
                let valueFn = value,
                    spec = await valueFn(),
                    now = Date.now(),
                    cycle = Math.floor((spec.again - spec.epoch) / 1000),
                    interval = null,
                    container = this.#root.querySelector(".value-container");

                function refresh() {
                    let remaining = spec.interval - (Date.now() - spec.generatedAt);
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
            let elValue = this.#root.querySelector(".value");
            if (asChars) {
                for (let c of [...value]) {
                    let el = document.createElement("span");
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
        #path;

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
            let config = await this.#plaintext.getConfig();

            for (let target of config.targets.concat(config.additionalTargets || [])) {
                if (!target.hoist) continue;
                let value = await this.#plaintext.getValue(target.name);
                if (value === null) continue;
                let el = document.createElement("parcel-value");
                el.setAttribute("data-label", target.label || target.name);
                el.setValue(target.dynamic ? () => this.#plaintext.getValue(target.name) : value, target.highlightSpecial);
                this.#root.appendChild(el);
            }

            let elPlaintext = document.createElement("div");
            elPlaintext.classList.add("plaintext");
            for (let line of this.#plaintext.getPlaintext().split(/\r\n|\n|\r/iu)) {
                let el = document.createElement("parcel-plaintext-line");
                el.setValue(line);
                elPlaintext.appendChild(el);
            }
            this.#root.appendChild(elPlaintext);

            await new Promise((resolve) => requestAnimationFrame(resolve));
            document.body.style.minHeight = this.scrollHeight + "px";
            document.body.style.minWidth = `min(500px, ${this.scrollWidth}px)`;
            tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });
        }
    }
    customElements.define("parcel-detail", ParcelDetail);

    // init specific to the popup invocation type
    if (token === "broadcast") {
        document.body.classList.add("action-popup");
        window.addEventListener("keydown", (ev) => {
            if (["Escape", "ArrowLeft"].includes(ev.key)) {
                ev.preventDefault();
                let detail = document.getElementsByTagName("parcel-detail").item(0);
                if (detail) detail.remove();
                else if (ev.key === "Escape") window.close();
                document.getElementById("modal-shade").classList.add("hidden");
                document.querySelector(".selected").scrollIntoView({ behavior: "smooth", block: "nearest" });
                document.querySelector(".selected").focus();
            }
        });
        tabPort.onMessage.addListener((msg) => {
            if (msg?.action === "close") {
                window.close();
            }
        });
    } else {
        document.body.classList.add("context-popup");
        // the iframe is off-limits to the page origin, so need to tell it when we change size
        new ResizeObserver((entries) => {
            tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });
        }).observe(document.body);
        tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });
        window.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
                tabPort.postMessage({ action: "close" });
            }
        });
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

    document.getElementById("modal-shade").addEventListener("click", () => {
        document.querySelectorAll("parcel-detail").forEach((el) => el.remove());
        document.getElementById("modal-shade").classList.add("hidden");
        document.querySelector(".selected").focus();
    });

    window.addEventListener("keydown", (ev) => {
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
            let detail = document.getElementsByTagName("parcel-detail").item(0);
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
        if (msg?.action === "status") {
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
        } else if (msg?.action == "origin") {
            if (tab.url) {
                const tabURL = new URL(tab.url);
                if (msg.origin !== tabURL.origin) {
                    alert(
                        `The field you are trying to fill is from a different origin (${msg.origin}) than the page you ` +
                            `are browsing (${tabURL.origin}). This may be a sign of a security issue. Do not ` +
                            `enter any sensitive information into this field unless you are sure it is safe to do so.`,
                    );
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
                let li = ul.querySelector(`li[data-path="${entry.path}"]`);
                if (li) {
                    // reuse existing li elements
                    li._keep = true;
                    ul.appendChild(li);
                    continue;
                }
                li = document.createElement("li");
                li._keep = true;
                li.setAttribute("data-path", entry.path);
                if (entry.isInHistory) li.classList.add("history");
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
                for (let he of history) {
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
                button.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    document.querySelector(".selected")?.classList.remove("selected");
                    button.closest("li").classList.add("selected");
                    document.getElementById("modal-shade").classList.remove("hidden");
                    port.postMessage({ action: "decrypt", intent: "detail", origin: url.origin, path: entry.path });
                });
                li.appendChild(button);

                li.addEventListener("click", async (ev) => {
                    port.postMessage({ action: "decrypt", intent: "fill", origin: url.origin, path: entry.path });
                    if (history?.[0]?.path === (await sha256(entry.path))) {
                        history[0].when = Date.now();
                    } else {
                        history.unshift({ path: await sha256(entry.path), when: Date.now() });
                    }
                });

                ul.appendChild(li);
            }
            ul.querySelectorAll(":scope > li").forEach((el) => {
                if (!el._keep) el.remove();
            });
        } else if (msg.action === "plaintext") {
            if (msg.intent === "fill" && !tabPort.disconnected) {
                tabPort.postMessage({ action: "fill", token, plaintext: msg.plaintext, config: await config });
                if (tab.url && (await config).saveHistory) {
                    const url = new URL(tab.url);
                    const hash = await sha256(url.origin);
                    const scope = await sha256(tab.contextualIdentity ? tab.contextualIdentity : "default");
                    chrome.storage.local.set({ [`history:${scope}:${hash}`]: history.slice(0, (await config).historyLength) });
                }
            } else if (msg.intent === "detail") {
                let plaintext = new Plaintext(msg.plaintext, config);
                document.querySelectorAll("parcel-detail").forEach((el) => el.remove());
                let elDetail = document.createElement("parcel-detail");
                elDetail.setPlaintext(plaintext);
                document.body.appendChild(elDetail);
            }
        } else if (msg.action === "error") {
            document.querySelector("#status").textContent = "Error";
            const p = document.createElement("p");
            p.classList.add("error");
            if (msg.hasOwnProperty("category")) p.classList.add(`error-category-${msg.category}`);
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
            const selector = msg.hasOwnProperty("category") ? `p.error.error-category-${msg.category}` : "p.error";
            document.querySelectorAll(selector).forEach((el) => {
                if (el._errorTimer) clearTimeout(el._errorTimer);
                el.remove();
            });
        }
    });

    const search = document.getElementById("searchPattern");

    // re-run the search when the search input changes
    search.addEventListener("input", (ev) => {
        update();
        document.querySelector(".selected").classList.remove("selected");
        search.classList.add("selected");
    });

    // re-run the search
    function update() {
        port.postMessage({ action: "match", url: tab.url || "unknown-url://", search: search.value, limit, history });
    }

    // initial search
    update();

    // UI updates when the anti-phishing mode is toggled
    document.getElementById("searchPattern").focus();
    document.getElementById("searchPattern").addEventListener("keydown", (ev) => {
        if (ev.key === "Backspace" && search.value.length === 0) {
            limit = false;
            document.getElementById("origin").classList.add("hidden");
        }
    });

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

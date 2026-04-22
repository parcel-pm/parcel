"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const Plaintext = (await import(chrome.runtime.getURL("/js/plaintext.js"))).Plaintext;
    const token = new URLSearchParams(window.location.search).get("token") || "broadcast";
    const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const tabPort = chrome.tabs.connect(tab.id, { name: token });
    tabPort.onDisconnect.addListener(() => {
        chrome.runtime.lastError; // suppress errors on pages where the content script is not injected
        tabPort.disconnected = true;
    });
    const port = chrome.runtime.connect({ name: "popup" });
    const ul = document.querySelector("ul");
    let limit = true;
    let history = [];

    /**
     * Custom element for displaying a line of the plaintext in detail view
     * @since 1.0.0
     */
    class ParcelPlaintextLine extends HTMLElement {
        static observedAttributes = ["data-value"];
        #root;

        constructor() {
            super();
            this.#root = this.attachShadow({ mode: "open" });
            this.#root.appendChild(document.getElementById("parcel-plaintext-line-template").content.cloneNode(true));

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
            let line = this.#root.querySelector(".line").textContent,
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
            this.#root.querySelector(".line").textContent = value;
        }
    }
    customElements.define("parcel-plaintext-line", ParcelPlaintextLine);

    /**
     * Custom element for displaying extracted values in the detail view
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
         * Set the displayed value, supporting dynamic values if a function is provided
         * @since 1.0.0
         * @param {string|function} value - The value to display, or a function that returns the value (or an object with value and again properties for dynamic values)
         * @param {boolean} [asChars=false] - Whether to split the value into individual character elements for styling
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
     * Custom element for displaying the detail view
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

        async setPlaintext(plaintext) {
            this.#plaintext = plaintext;

            let secret = await this.#plaintext.getValue("secret");
            if (secret !== null) {
                let el = document.createElement("parcel-value");
                el.setAttribute("data-label", "Secret");
                el.setValue(secret, true);
                this.#root.appendChild(el);
            }
            let login = await this.#plaintext.getValue("login");
            if (login !== null) {
                let el = document.createElement("parcel-value");
                el.setAttribute("data-label", "Login");
                el.setValue(login);
                this.#root.appendChild(el);
            }
            let totp = () => this.#plaintext.getValue("totp");
            if ((await totp()) !== null) {
                let el = document.createElement("parcel-value");
                el.setAttribute("data-label", "TOTP");
                el.setValue(totp);
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
        const hash = await Helpers.sha256(url.origin);
        document.getElementById("origin").textContent = url.hostname;
        history = (await chrome.storage.local.get(`history:${hash}`))?.[`history:${hash}`] || [];
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
        if (ev.key === "ArrowDown") {
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
        } else if (ev.key === "ArrowUp") {
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

    // listen for error messages returned from the content script
    tabPort.onMessage.addListener((msg) => {
        if (msg?.action === "error") {
            const p = document.createElement("p");
            p.classList.add("error");
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => el.remove());
            document.body.insertAdjacentElement("afterbegin", p);
            setTimeout(() => p.remove(), 5000);
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
        if (msg.action === "match") {
            while (ul.firstChild) {
                ul.removeChild(ul.firstChild);
            }
            if (!msg.entries.length && !document.querySelector(".no-matches")) {
                const p = document.createElement("p");
                p.classList.add("list-notice", "no-matches");
                p.textContent = "No matching entries";
                ul.parentElement.appendChild(p);
            } else if (msg.entries.length) {
                document.querySelector(".no-matches")?.remove();
            }
            for (const entry of msg.entries) {
                const li = document.createElement("li");
                if (entry.isInHistory) li.classList.add("history");
                li.setAttribute("data-sort-order", entry.sortOrder);

                if (entry.rule.tag) {
                    const tag = document.createElement("span");
                    tag.classList.add("tag");
                    tag.textContent = entry.rule.tag;
                    tag.style.backgroundColor = `#${entry.rule.color}`;
                    let rgb = parseInt(entry.rule.color, 16);
                    rgb = [rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff];
                    const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
                    if (luma < 75) tag.style.color = "#eee";
                    li.appendChild(tag);
                }

                const name = document.createElement("span");
                name.setAttribute("title", entry.path);
                name.classList.add("name");
                name.textContent = entry.rule.strip ? entry.name.replace(new RegExp(entry.rule.strip, "ui"), "") : entry.name;
                li.appendChild(name);

                const url = new URL(tab.url || "undefined-url://");
                const hash = await Helpers.sha256(url.origin);
                for (let he of history) {
                    if (he.path === (await Helpers.sha256(entry.path))) {
                        const historyButton = document.createElement("button");
                        historyButton.classList.add("historyNuke");
                        historyButton.textContent = "X";
                        historyButton.setAttribute("title", "Forget this entry");
                        historyButton.addEventListener("click", (ev) => {
                            ev.stopPropagation();
                            history = history.filter((h) => h.path !== he.path);
                            chrome.storage.local.set({ [`history:${hash}`]: history });
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
                button.textContent = ">";
                button.setAttribute("title", "Show detailed content");
                button.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    document.querySelector(".selected")?.classList.remove("selected");
                    button.closest("li").classList.add("selected");
                    document.getElementById("modal-shade").classList.remove("hidden");
                    port.postMessage({ action: "decrypt", intent: "detail", path: entry.path });
                });
                li.appendChild(button);

                li.addEventListener("click", async (ev) => {
                    port.postMessage({ action: "decrypt", intent: "fill", path: entry.path }); // MARK
                    if (history?.[0]?.path === (await Helpers.sha256(entry.path))) {
                        history[0].when = Date.now();
                    } else {
                        history.unshift({ path: await Helpers.sha256(entry.path), when: Date.now() });
                    }
                });

                ul.appendChild(li);
            }
        } else if (msg.action === "plaintext") {
            if (msg.intent === "fill" && !tabPort.disconnected) {
                tabPort.postMessage({ action: "fill", token, plaintext: msg.plaintext, config: await config });
                if (tab.url) {
                    const url = new URL(tab.url);
                    const hash = await Helpers.sha256(url.origin);
                    chrome.storage.local.set({ [`history:${hash}`]: history.slice(0, (await config).historyLength) });
                }
            } else if (msg.intent === "detail") {
                let plaintext = new Plaintext(msg.plaintext, config);
                document.querySelectorAll("parcel-detail").forEach((el) => el.remove());
                let elDetail = document.createElement("parcel-detail");
                elDetail.setPlaintext(plaintext);
                document.body.appendChild(elDetail);
            }
        } else if (msg.action === "error") {
            const p = document.createElement("p");
            p.classList.add("error");
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => el.remove());
            document.body.insertAdjacentElement("afterbegin", p);
            document.getElementById("modal-shade").classList.add("hidden");
            p.scrollIntoView({ behavior: "instant", block: "nearest" });
            setTimeout(() => p.remove(), 5000);
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
})();

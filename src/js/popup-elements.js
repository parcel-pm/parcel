"use strict";

let deps = null;
let Helpers = null;

/**
 * Define and register the popup's custom elements (`parcel-plaintext-line`,
 * `parcel-value`, `parcel-detail`). All DOM templates must be present in the
 * document before any element is instantiated; registration itself only needs
 * the `deps` wiring.
 * @since 1.0.8
 * @param {object} deps - Wiring provided by the popup script.
 * @param {Function} deps.copyValue - Copy a secret to the clipboard; resolves `true` when the popup should close.
 * @param {Function} deps.fillValue - Fill a value into the page, handling scope checks and delivery errors.
 * @param {Function} deps.notifyResized - Notify the host page after the detail view has resized the popup.
 * @returns {Promise<void>}
 */
export async function definePopupElements(newDeps) {
    deps = newDeps;
    Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;

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
                if (await deps.copyValue(this.getValue())) window.close();
            });
            if (document.querySelector(".context-popup")) {
                this.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    deps.fillValue(this.getValue());
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
                if (await deps.copyValue(this.#root.querySelector(".value").textContent)) window.close();
            });
            if (document.querySelector(".context-popup")) {
                this.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    deps.fillValue(this.#root.querySelector(".value").textContent);
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
            const targets = config.targets.concat(config.additionalTargets || []);

            const hoisted = [];
            for (const target of targets) {
                if (!target.hoist) continue;
                const value = await this.#plaintext.getValue(target.name);
                if (value === null) continue;
                hoisted.push({ target, value, chain: Helpers.fallbackChain(targets, target.name) });
            }

            for (const item of hoisted) {
                // suppress a hoisted value that another hoisted target also derives via its
                // fallback chain, so it renders once under the more specific target
                if (hoisted.some((h) => h !== item && h.chain.has(item.target.name) && h.value === item.value)) continue;
                const target = item.target;
                const el = document.createElement("parcel-value");
                el.setAttribute("data-label", target.label || target.name);
                el.setValue(target.dynamic ? () => this.#plaintext.getValue(target.name) : item.value, target.highlightSpecial);
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
            deps.notifyResized();
        }
    }
    customElements.define("parcel-detail", ParcelDetail);
}

"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const targetSelectors = import(chrome.runtime.getURL("/js/selectors.js"));

    /**
     * Configuration object
     * @since 1.0.0
     */
    const config = new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "config" });
        port.onMessage.addListener(async (msg) => {
            if (msg.action === "config") {
                port.disconnect();
                resolve(msg.config);
            }
        });
        port.postMessage({ action: "config" });
    });

    /**
     * List of valid focus targets.
     * @since 1.0.0
     */
    const validTargets = targetSelectors.then(async (targetSelectors) => {
        let selectors = targetSelectors.targetSelectors.concat((await config).additionalSelectors || []);
        return selectors.filter((t) => t.type !== "blacklist" && (!t.host || t.host.includes(window.location.hostname)));
    });

    /**
     * List of invalid focus targets.
     * @since 1.0.0
     */
    const invalidTargets = targetSelectors.then((targetSelectors) =>
        targetSelectors.targetSelectors.filter((t) => t.type === "blacklist" && (!t.host || t.host.includes(window.location.hostname))),
    );

    /**
     * Get the target info for an element
     * @since 1.0.0
     * @param {HTMLElement} el - The element to check.
     * @returns {string|null} - The target type or null if not found.
     */
    async function getTargetInfo(el) {
        try {
            if (el.hasAttribute("type") && !["text", "email", "tel", "password"].includes(el.type)) return null;
        } catch (err) {
            console.log(el);
            throw err;
        }
        let finalTarget = null;
        for (let target of await validTargets) {
            if (el.matches(target.selector) && !el.readOnly && !el.disabled) {
                finalTarget = target;
                break;
            }
        }
        if (finalTarget) {
            for (let target of await invalidTargets) {
                if (el.matches(target.selector)) {
                    finalTarget = null;
                    break;
                }
            }
        }
        return finalTarget;
    }

    /**
     * Get fillable fields that are related to the given element.
     * @since 1.0.0
     * @param {HTMLElement} el - The element to start from.
     * @returns {HTMLElement[]} - The related fillable fields.
     */
    async function getRelatedFields(el) {
        const form = el.closest("form");
        if (!form) return [];
        const relatedFields = [];
        for (let target of await validTargets) {
            form.querySelectorAll(target.selector).forEach(async (field) => {
                for (let target of await invalidTargets) {
                    if (field.matches(target.selector)) return;
                }
                relatedFields.push(field);
            });
        }
        return relatedFields;
    }

    /**
     * Fill the appropriate value for the target element.
     * @since 1.0.0
     * @param {HTMLElement} el - The element to target
     * @param {string} plaintext - The plaintext to fill from
     * @param {object} config - The current parcel config
     * @param {string|null} type - The target type to use, or null to infer from the element
     * @param {string|null} fillValue - The value to fill, or null to derive from the plaintext and config
     */
    async function fillField(el, plaintext, config, type = null, fillValue = null) {
        const targetInfo = await getTargetInfo(el);
        if (!type) type = targetInfo.type;
        if (fillValue === null) fillValue = await Helpers.getValue(plaintext, config, type);
        if (typeof fillValue === "object" && fillValue.hasOwnProperty("value")) fillValue = fillValue.value;

        /** Robust value-setting logic below is largely copied from Browserpass - thanks to all who helped develop it! */
        {
            // Send some keyboard events indicating that value modification has started (no associated keycode)
            for (let eventName of ["keydown", "keypress", "keyup", "input", "change"]) {
                el.dispatchEvent(new Event(eventName, { bubbles: true }));
            }

            // truncate the value if required by the field
            if (el.maxLength > 0) {
                fillValue = fillValue.substr(0, el.maxLength);
            }

            // Set the field value
            let initialValue = el.value || el.getAttribute("value");
            el.setAttribute("value", fillValue);
            el.value = fillValue;

            // Send the keyboard events again indicating that value modification has finished (no associated keycode)
            for (let eventName of ["keydown", "keypress", "keyup", "input", "change"]) {
                el.dispatchEvent(new Event(eventName, { bubbles: true }));
            }

            // re-set value if unchanged after firing post-fill events
            // (in case of sabotage by the site's own event handlers)
            if ((el.value || el.getAttribute("value")) === initialValue) {
                await new Promise((resolve) => setTimeout(resolve, 10)); // brief wait to yield execution to the page
                el.setAttribute("value", fillValue);
                el.value = fillValue;
            }

            // Finally unfocus the element
            el.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        el.style.outline = "2px solid green";
    }

    /**
     * Triggers a popup for the given element.
     * @since 1.0.0
     * @param {HTMLElement} element - The element to trigger the popup for.
     * @param {string} targetClass - The fill class of the target.
     * @param {string} token - The token for the element.
     * @returns {void}
     */
    function triggerPopup(el, targetClass, token) {
        Helpers.shadowSelectorAll(".parcel-popup").forEach((popup) => {
            if (popup._parcelToken !== token) {
                popup.remove();
            }
        });
        const popup = (el._parcelPopup = document.createElement("div"));
        popup._parcelCreated = Date.now();
        popup.setAttribute(
            "style",
            "color-scheme: initial; forced-color-adjust: initial; mask: initial; math-depth: initial; position: fixed; position-anchor: initial; text-size-adjust: initial; appearance: initial; color: initial; font: initial; font-palette: initial; font-synthesis: initial; position-area: initial; text-orientation: initial; text-rendering: initial; text-spacing-trim: initial; -webkit-font-smoothing: initial; -webkit-locale: initial; -webkit-text-orientation: initial; -webkit-writing-mode: initial; writing-mode: initial; zoom: initial; accent-color: initial; place-content: initial; place-items: initial; place-self: initial; alignment-baseline: initial; anchor-name: initial; anchor-scope: initial; animation-composition: initial; animation: initial; app-region: initial; aspect-ratio: initial; backdrop-filter: initial; backface-visibility: initial; background: initial; background-blend-mode: initial; baseline-shift: initial; baseline-source: initial; block-size: initial; border-block: initial; border: none; border-radius: initial; border-collapse: initial; border-end-end-radius: initial; border-end-start-radius: initial; border-inline: initial; border-start-end-radius: initial; border-start-start-radius: initial; bottom: initial; box-decoration-break: initial; box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 4px 20px; box-sizing: initial; break-after: initial; break-before: initial; break-inside: initial; buffered-rendering: initial; caption-side: initial; caret-color: initial; clear: initial; clip: initial; clip-path: initial; clip-rule: initial; color-interpolation: initial; color-interpolation-filters: initial; color-rendering: initial; columns: initial; column-fill: initial; gap: initial; column-rule: initial; column-span: initial; contain: initial; contain-intrinsic-block-size: initial; contain-intrinsic-size: initial; contain-intrinsic-inline-size: initial; container: initial; content: initial; content-visibility: initial; counter-increment: initial; counter-reset: initial; counter-set: initial; cursor: initial; cx: initial; cy: initial; d: initial; display: initial; dominant-baseline: initial; empty-cells: initial; field-sizing: initial; fill: initial; fill-opacity: initial; fill-rule: initial; filter: initial; flex: initial; flex-flow: initial; float: initial; flood-color: initial; flood-opacity: initial; grid: initial; grid-area: initial; height: initial; hyphenate-character: initial; hyphenate-limit-chars: initial; hyphens: initial; image-orientation: initial; image-rendering: initial; initial-letter: initial; inline-size: initial; inset-block: initial; inset-inline: initial; interpolate-size: initial; isolation: initial; left: initial; letter-spacing: initial; lighting-color: initial; line-break: initial; list-style: initial; margin-block: initial; margin: initial; margin-inline: initial; marker: initial; mask-type: initial; math-shift: initial; math-style: initial; max-block-size: initial; max-height: initial; max-inline-size: initial; max-width: initial; min-block-size: initial; min-height: initial; min-inline-size: initial; min-width: initial; mix-blend-mode: initial; object-fit: initial; object-position: initial; object-view-box: initial; offset: initial; opacity: initial; order: initial; orphans: initial; outline: 0px; outline-offset: initial; overflow-anchor: initial; overflow-block: initial; overflow-clip-margin: initial; overflow-inline: initial; overflow-wrap: initial; overflow: initial; overlay: initial; overscroll-behavior-block: initial; overscroll-behavior-inline: initial; overscroll-behavior: initial; padding-block: initial; padding: initial; padding-inline: initial; page: initial; page-orientation: initial; paint-order: initial; perspective: initial; perspective-origin: initial; pointer-events: initial; position-try: initial; position-visibility: initial; quotes: initial; r: initial; resize: initial; right: initial; rotate: initial; ruby-align: initial; ruby-position: initial; rx: initial; ry: initial; scale: initial; scroll-behavior: initial; scroll-initial-target: initial; scroll-margin-block: initial; scroll-margin: initial; scroll-margin-inline: initial; scroll-marker-group: initial; scroll-padding-block: initial; scroll-padding: initial; scroll-padding-inline: initial; scroll-snap-align: initial; scroll-snap-stop: initial; scroll-snap-type: initial; scroll-timeline: initial; scrollbar-color: initial; scrollbar-gutter: initial; scrollbar-width: initial; shape-image-threshold: initial; shape-margin: initial; shape-outside: initial; shape-rendering: initial; size: initial; speak: initial; stop-color: initial; stop-opacity: initial; stroke: initial; stroke-dasharray: initial; stroke-dashoffset: initial; stroke-linecap: initial; stroke-linejoin: initial; stroke-miterlimit: initial; stroke-opacity: initial; stroke-width: initial; tab-size: initial; table-layout: initial; text-align: initial; text-align-last: initial; text-anchor: initial; text-box: initial; text-combine-upright: initial; text-decoration: initial; text-decoration-skip-ink: initial; text-emphasis: initial; text-emphasis-position: initial; text-indent: initial; text-overflow: initial; text-shadow: initial; text-transform: initial; text-underline-offset: initial; text-underline-position: initial; text-wrap: initial; timeline-scope: initial; top: initial; touch-action: initial; transform: initial; transform-box: initial; transform-origin: initial; transform-style: initial; transition: initial; translate: initial; user-select: initial; vector-effect: initial; vertical-align: initial; view-timeline: initial; view-transition-class: initial; view-transition-name: initial; visibility: visible; border-spacing: initial; -webkit-box-align: initial; -webkit-box-decoration-break: initial; -webkit-box-direction: initial; -webkit-box-flex: initial; -webkit-box-ordinal-group: initial; -webkit-box-orient: initial; -webkit-box-pack: initial; -webkit-box-reflect: initial; -webkit-line-break: initial; -webkit-line-clamp: initial; -webkit-mask-box-image: initial; -webkit-print-color-adjust: initial; -webkit-rtl-ordering: initial; -webkit-ruby-position: initial; -webkit-tap-highlight-color: initial; -webkit-text-combine: initial; -webkit-text-decorations-in-effect: initial; -webkit-text-fill-color: initial; -webkit-text-security: initial; -webkit-text-stroke: initial; -webkit-user-drag: initial; white-space-collapse: initial; widows: initial; width: initial; will-change: initial; word-break: initial; word-spacing: initial; x: initial; y: initial; z-index: 2147483647;",
        );
        popup.classList.add("parcel-popup");
        popup.classList.add(`parcel-popup-${token}`);
        const root = popup.attachShadow({ mode: "closed" });
        popup.style.position = "absolute";
        popup.style.top = `${el.getBoundingClientRect().bottom}px`;
        popup.style.left = `${el.getBoundingClientRect().left}px`;
        popup.style.color = "black";
        popup.style.backgroundColor = "white";
        popup.style.border = "1px solid black";
        popup.style.overflow = "hidden";
        popup.style.maxHeight = "400px";
        popup.style.minWidth = "200px";
        popup.style.minHeight = "100px";
        popup.style.boxSizing = "content-box";

        const style = document.createElement("style");
        style.textContent = `
        :host {
            all: initial;
            min-height: 100px;
            h1 { color: blue; }

            iframe {
                width: 100%;
                height: 100%;
                border: none;
                overflow: hidden;
            }
        }`;
        root.appendChild(style);

        // attach iframe
        const frame = document.createElement("iframe");
        frame.src = chrome.runtime.getURL(`/html/popup.html?token=${el._parcelToken}`);
        root.appendChild(frame);

        document.body.appendChild(popup);
    }

    /**
     * Trigger the popup when the element is clicked.
     * @since 1.0.0
     * @param {HTMLElement} target - The clicked element.
     * @param {boolean} shadow - Whether the click originated from a shadow DOM.
     * @returns {void}
     */
    async function handleTriggerClick(target) {
        let popup = document.querySelector(".parcel-popup");
        let targetInfo = await getTargetInfo(target);
        if (targetInfo) {
            if (popup) popup.remove();
            if (!target._parcelToken) {
                target._parcelToken = crypto.randomUUID();
            }
            target.classList.add(`parcel-target-${target._parcelToken}`);
            target.setAttribute("parcel-selector", targetInfo.selector);
            target.setAttribute("parcel-type", targetInfo.type);
            triggerPopup(target, targetInfo.class, target._parcelToken);
        } else if (popup && popup._parcelCreated < Date.now() - 350) popup.remove();
    }

    document.addEventListener("click", (ev) => handleTriggerClick(ev.target), { capture: true, passive: true });
    document.addEventListener(
        "parcel-shadow-click",
        async (ev) => {
            const target = Helpers.shadowSelector(`[parcel-shadow-event="${ev.detail.target}"]`, document);
            if (target) handleTriggerClick(target);
        },
        { capture: true, passive: true },
    );

    /**
     * Handle messages from the popup.
     * @since 1.0.0
     */
    chrome.runtime.onConnect.addListener(async (port) => {
        if (!port.name) return;
        let el = Helpers.shadowSelector(`.parcel-target-${port.name}`);
        if (!el) {
            if (window === window.top && port.name === "broadcast") {
                // Handle broadcast connections in the root frame only
                // Look for a suitable target element in the root frame
                const selectors = (await validTargets).toSorted((a, b) => {
                    const priority = ["totp", "login", "secret"]; // target type search order, highest priority last
                    if (priority.indexOf(a.type) > priority.indexOf(b.type)) return -1;
                    if (priority.indexOf(a.type) < priority.indexOf(b.type)) return 1;
                    return 0;
                });
                for (let selector of selectors) {
                    //el = document.querySelector(selector.selector);
                    el = Helpers.shadowSelector(selector.selector);
                    if (el) {
                        el._parcelToken = port.name;
                        el.classList.add(`parcel-target-${port.name}`);
                        break;
                    }
                }
                if (!el) {
                    port.postMessage({ action: "error", error: "Cannot find a suitable autofill target." });
                    port.disconnect();
                    return;
                }
            } else {
                return;
            }
        }
        if (el._parcelToken !== port.name) {
            port.postMessage({ action: "error", error: "Invalid token." });
            port.disconnect();
            return;
        }
        const targetInfo = await getTargetInfo(el);
        if (!targetInfo) {
            port.postMessage({ action: "error", error: "Invalid fill target." });
            port.disconnect();
            return;
        }
        port.onMessage.addListener(async (msg) => {
            console.log(msg?.action);
            if (msg?.action === "fill-value") {
                console.log(el, msg);
                await fillField(el, null, null, null, msg.value);
                port.postMessage({ action: "close" });
                document.querySelector(`.parcel-popup-${port.name}`)?.remove();
            } else if (msg?.action === "fill") {
                // fill the target field, and related fields if configured
                try {
                    if (!msg.hasOwnProperty("config")) throw new Error("Config is missing.");
                    if (!msg.hasOwnProperty("plaintext")) throw new Error("Plaintext is missing.");
                    await fillField(el, msg.plaintext, msg.config);
                    if (msg.config.fillRelated) {
                        for (const rel of await getRelatedFields(el)) {
                            try {
                                await fillField(rel, msg.plaintext, msg.config);
                            } catch (err) {
                                // ignore errors when filling related form fields
                            }
                        }
                    }
                    port.postMessage({ action: "close" });
                    document.querySelector(`.parcel-popup-${port.name}`)?.remove();

                    // submit the form if configured, else try to focus the submit button
                    const submitTargets = (await validTargets).filter((t) => t.type === "submit");
                    const form = el.closest("form");
                    if (form) {
                        for (let target of submitTargets) {
                            let submitButton = form.querySelector(target.selector);
                            if (submitButton) {
                                if ((await config)?.autoSubmit) {
                                    submitButton.click();
                                } else {
                                    submitButton.focus();
                                }
                                break;
                            }
                        }
                    } else if ((await config)?.autoSubmit) {
                        el.focus();
                        for (ev in ["keydown", "keypress", "keyup"]) {
                            el.dispatchEvent(new KeyboardEvent(ev, { bubbles: true, key: "Enter", code: "Enter", keyCode: 13 }));
                        }
                    } else {
                        el.focus();
                    }
                } catch (err) {
                    port.postMessage({ action: "error", error: err.message });
                }
            } else if (msg?.action === "resize") {
                console.log(msg);
                const popup = document.querySelector(`.parcel-popup-${port.name}`);
                if (popup) {
                    popup.style.height = `${msg.height}px`;
                    popup.style.width = `${msg.width}px`;
                }
            } else if (msg?.action === "close") {
                Helpers.shadowSelector(`.parcel-popup-${port.name}`)?.remove();
            }
        });
    });
})();

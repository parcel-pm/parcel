"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const { Schema, SelectorSchema } = await import(chrome.runtime.getURL("/js/schema.js"));
    const targetSelectors = import(chrome.runtime.getURL("/js/selectors.js"));
    const targetBindings = {};
    const authPort = chrome.runtime.connect({ name: "auth" });
    var frameId = 0;

    /**
     * Configuration object
     * @since 1.0.0
     */
    const config = new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "integration" });
        port.onMessage.addListener(async (msg) => {
            if (msg.action === "config") {
                port.disconnect();
                frameId = msg?.frameId || 0;
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
        Schema.validate(SelectorSchema, selectors);
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
     * @param {boolean} related - Whether to use selectors that are marked only for use with related fields
     * @returns {string|null} - The target type or null if not found.
     */
    async function getTargetInfo(el, related = false) {
        try {
            if (el.hasAttribute("type") && !["text", "email", "tel", "password"].includes(el.type)) return null;
        } catch (err) {
            console.log(el);
            throw err;
        }
        let finalTarget = null;
        for (let target of (await validTargets).filter((t) => (related ? true : !t.relatedOnly))) {
            if (el.matches(target.selector) && !el.readOnly && !el.disabled) {
                finalTarget = target;
                break;
            }
        }
        if (finalTarget) {
            for (let target of (await invalidTargets).filter((t) => (related ? true : !t.relatedOnly))) {
                if (el.matches(target.selector)) {
                    finalTarget = null;
                    el.setAttribute("parcel-blacklist", target.selector);
                    break;
                }
            }
            if (finalTarget) {
                finalTarget.related =
                    (await config).targets.concat((await config).additionalTargets || []).find((t) => t.name === finalTarget.type)
                        ?.related || [];
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
        const targetInfo = await getTargetInfo(el);
        const form = el.closest("form");
        if (!form) return [];
        const relatedFields = [];
        for (let target of (await validTargets).filter((t) => targetInfo.related.includes(t.type))) {
            for (const field of form.querySelectorAll(target.selector)) {
                if (relatedFields.includes(field) || field === el) continue;
                let isInvalid = false;
                for (let target of await invalidTargets) {
                    if (field.matches(target.selector)) {
                        isInvalid = true;
                        break;
                    }
                }
                if (isInvalid) continue;
                if (!field.targetInfo) field.targetInfo = await getTargetInfo(field, true);
                if (field.targetInfo && targetInfo.related.includes(field.targetInfo?.type)) relatedFields.push(field);
            }
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
     * @param {boolean} isRelated - Whether the field being filled is a related field (as opposed to the originally clicked field)
     */
    async function fillField(el, plaintext, config, type = null, fillValue = null, isRelated = false) {
        if (!el.parentNode) throw new Error("Target element has been removed from the DOM.");
        const targetInfo = await getTargetInfo(el, isRelated);
        if (!type) type = targetInfo.type;
        if (fillValue === null) fillValue = await Helpers.getValue(plaintext, config, type);
        if (typeof fillValue === "object" && fillValue.hasOwnProperty("value")) fillValue = fillValue.value;

        // Send some keyboard events indicating that value modification has started (no associated keycode)
        for (let eventName of ["keydown", "keypress", "keyup", "input", "change"]) {
            el.dispatchEvent(new Event(eventName, { bubbles: true }));
        }

        // truncate the value if required by the field
        if (el.maxLength > 0) {
            fillValue = fillValue.substr(0, el.maxLength);
        }

        // Handle select fields for which the direct value set failed
        if (el.tagName === "SELECT") {
            let optionToSelect = Array.from(el.options).find((o) => o.value === fillValue || o.text === fillValue);
            if (!optionToSelect && type === "cardexp-year") {
                let fullYear = (2000 + parseInt(fillValue)).toString();
                optionToSelect = Array.from(el.options).find((o) => o.value === fullYear || o.text === fullYear);
            }
            if (!optionToSelect && type === "cardexp-month") {
                let monthShortNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
                let monthLongNames = [
                    "january",
                    "february",
                    "march",
                    "april",
                    "may",
                    "june",
                    "july",
                    "august",
                    "september",
                    "october",
                    "november",
                    "december",
                ];
                let monthIndex = parseInt(fillValue) - 1;
                optionToSelect = Array.from(el.options).find(
                    (o) =>
                        o.value === fillValue.padStart(2, "0") ||
                        o.text === fillValue.padStart(2, "0") ||
                        o.value === parseInt(fillValue).toString() ||
                        o.text === parseInt(fillValue).toString() ||
                        o.value === monthShortNames[monthIndex] ||
                        o.text.toLowerCase() === monthShortNames[monthIndex] ||
                        o.value === monthLongNames[monthIndex] ||
                        o.text.toLowerCase() === monthLongNames[monthIndex],
                );
            }
            if (optionToSelect) optionToSelect.selected = true;
        } else {
            // Set the field value directly
            var initialValue = el.value || el.getAttribute("value");
            el.setAttribute("value", fillValue);
            el.value = fillValue;
        }

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

        el.style.outline = "2px solid green";
    }

    /**
     * Triggers a popup for the given element.
     * @since 1.0.0
     * @param {HTMLElement} element - The element to trigger the popup for.
     * @param {string} token - The token for the element.
     * @returns {void}
     */
    function triggerPopup(el, token) {
        Helpers.shadowSelectorAll(".parcel-popup").forEach((popup) => {
            if (popup._parcelToken !== token) {
                popup.remove();
            }
        });
        const popup = (el._parcelPopup = document.createElement("div"));
        popup._parcelTarget = el;
        popup._parcelCreated = Date.now();
        popup.setAttribute(
            "style",
            "color-scheme: initial; forced-color-adjust: initial; mask: initial; math-depth: initial; position: fixed; position-anchor: initial; text-size-adjust: initial; appearance: initial; color: initial; font: initial; font-palette: initial; font-synthesis: initial; position-area: initial; text-orientation: initial; text-rendering: initial; text-spacing-trim: initial; -webkit-font-smoothing: initial; -webkit-locale: initial; -webkit-text-orientation: initial; -webkit-writing-mode: initial; writing-mode: initial; zoom: initial; accent-color: initial; place-content: initial; place-items: initial; place-self: initial; alignment-baseline: initial; anchor-name: initial; anchor-scope: initial; animation-composition: initial; animation: initial; app-region: initial; aspect-ratio: initial; backdrop-filter: initial; backface-visibility: initial; background: initial; background-blend-mode: initial; baseline-shift: initial; baseline-source: initial; block-size: initial; border-block: initial; border: none; border-radius: initial; border-collapse: initial; border-end-end-radius: initial; border-end-start-radius: initial; border-inline: initial; border-start-end-radius: initial; border-start-start-radius: initial; bottom: initial; box-decoration-break: initial; box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 4px 20px; box-sizing: initial; break-after: initial; break-before: initial; break-inside: initial; buffered-rendering: initial; caption-side: initial; caret-color: initial; clear: initial; clip: initial; clip-path: initial; clip-rule: initial; color-interpolation: initial; color-interpolation-filters: initial; color-rendering: initial; columns: initial; column-fill: initial; gap: initial; column-rule: initial; column-span: initial; contain: initial; contain-intrinsic-block-size: initial; contain-intrinsic-size: initial; contain-intrinsic-inline-size: initial; container: initial; content: initial; content-visibility: initial; counter-increment: initial; counter-reset: initial; counter-set: initial; cursor: initial; cx: initial; cy: initial; d: initial; display: initial; dominant-baseline: initial; empty-cells: initial; field-sizing: initial; fill: initial; fill-opacity: initial; fill-rule: initial; filter: initial; flex: initial; flex-flow: initial; float: initial; flood-color: initial; flood-opacity: initial; grid: initial; grid-area: initial; height: initial; hyphenate-character: initial; hyphenate-limit-chars: initial; hyphens: initial; image-orientation: initial; image-rendering: initial; initial-letter: initial; inline-size: initial; inset-block: initial; inset-inline: initial; interpolate-size: initial; isolation: initial; left: initial; letter-spacing: initial; lighting-color: initial; line-break: initial; list-style: initial; margin-block: initial; margin: initial; margin-inline: initial; marker: initial; mask-type: initial; math-shift: initial; math-style: initial; max-block-size: initial; max-height: initial; max-inline-size: initial; max-width: initial; min-block-size: initial; min-height: initial; min-inline-size: initial; min-width: initial; mix-blend-mode: initial; object-fit: initial; object-position: initial; object-view-box: initial; offset: initial; opacity: initial; order: initial; orphans: initial; outline: 0px; outline-offset: initial; overflow-anchor: initial; overflow-block: initial; overflow-clip-margin: initial; overflow-inline: initial; overflow-wrap: initial; overflow: initial; overlay: initial; overscroll-behavior-block: initial; overscroll-behavior-inline: initial; overscroll-behavior: initial; padding-block: initial; padding: initial; padding-inline: initial; page: initial; page-orientation: initial; paint-order: initial; perspective: initial; perspective-origin: initial; pointer-events: initial; position-try: initial; position-visibility: initial; quotes: initial; r: initial; resize: initial; right: initial; rotate: initial; ruby-align: initial; ruby-position: initial; rx: initial; ry: initial; scale: initial; scroll-behavior: initial; scroll-initial-target: initial; scroll-margin-block: initial; scroll-margin: initial; scroll-margin-inline: initial; scroll-marker-group: initial; scroll-padding-block: initial; scroll-padding: initial; scroll-padding-inline: initial; scroll-snap-align: initial; scroll-snap-stop: initial; scroll-snap-type: initial; scroll-timeline: initial; scrollbar-color: initial; scrollbar-gutter: initial; scrollbar-width: initial; shape-image-threshold: initial; shape-margin: initial; shape-outside: initial; shape-rendering: initial; size: initial; speak: initial; stop-color: initial; stop-opacity: initial; stroke: initial; stroke-dasharray: initial; stroke-dashoffset: initial; stroke-linecap: initial; stroke-linejoin: initial; stroke-miterlimit: initial; stroke-opacity: initial; stroke-width: initial; tab-size: initial; table-layout: initial; text-align: initial; text-align-last: initial; text-anchor: initial; text-box: initial; text-combine-upright: initial; text-decoration: initial; text-decoration-skip-ink: initial; text-emphasis: initial; text-emphasis-position: initial; text-indent: initial; text-overflow: initial; text-shadow: initial; text-transform: initial; text-underline-offset: initial; text-underline-position: initial; text-wrap: initial; timeline-scope: initial; top: initial; touch-action: initial; transform: initial; transform-box: initial; transform-origin: initial; transform-style: initial; transition: initial; translate: initial; user-select: initial; vector-effect: initial; vertical-align: initial; view-timeline: initial; view-transition-class: initial; view-transition-name: initial; visibility: visible; border-spacing: initial; -webkit-box-align: initial; -webkit-box-decoration-break: initial; -webkit-box-direction: initial; -webkit-box-flex: initial; -webkit-box-ordinal-group: initial; -webkit-box-orient: initial; -webkit-box-pack: initial; -webkit-box-reflect: initial; -webkit-line-break: initial; -webkit-line-clamp: initial; -webkit-mask-box-image: initial; -webkit-print-color-adjust: initial; -webkit-rtl-ordering: initial; -webkit-ruby-position: initial; -webkit-tap-highlight-color: initial; -webkit-text-combine: initial; -webkit-text-decorations-in-effect: initial; -webkit-text-fill-color: initial; -webkit-text-security: initial; -webkit-text-stroke: initial; -webkit-user-drag: initial; white-space-collapse: initial; widows: initial; width: initial; will-change: initial; word-break: initial; word-spacing: initial; x: initial; y: initial; z-index: 2147483647;",
        );
        popup.classList.add("parcel-popup");
        const root = popup.attachShadow({ mode: "closed" });
        popup.style.position = "absolute";
        popup.style.top = `${el.getBoundingClientRect().bottom + 5}px`;
        popup.style.left = `${el.getBoundingClientRect().left + 5}px`;
        popup.style.color = "black";
        popup.style.backgroundColor = "white";
        popup.style.border = "1px solid black";
        popup.style.overflow = "hidden";
        popup.style.maxHeight = "400px";
        popup.style.minWidth = "200px";
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
        frame.src = chrome.runtime.getURL(`/html/popup.html?token=${token}&frameId=${frameId}`);
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
            try {
                target._parcelToken = crypto.randomUUID();
            } catch (err) {
                // fallback for browsers without crypto.randomUUID(), typically insecure pages lacking the crypto API
                target._parcelToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
            }
            targetBindings[target._parcelToken] = target;
            authPort.postMessage(target._parcelToken);
            if (popup) {
                popup.remove();
                if (target === popup._parcelTarget) return; // Don't reopen the popup if we just clicked its target field to close it
            }
            target.setAttribute("parcel-selector", targetInfo.selector);
            target.setAttribute("parcel-type", targetInfo.type);
            triggerPopup(target, target._parcelToken);
        } else if (popup && popup._parcelCreated < Date.now() - 350) popup.remove();
    }

    if (!(await config).disableContextPopup) {
        document.addEventListener("click", (ev) => handleTriggerClick(ev.target), { capture: true, passive: true });
        document.addEventListener(
            "parcel-shadow-click",
            async (ev) => {
                const target = Helpers.shadowSelector(`[parcel-shadow-event="${ev.detail.target}"]`, document);
                if (target) handleTriggerClick(target);
            },
            { capture: true, passive: true },
        );
    }

    /**
     * Handle messages from the popup.
     * @since 1.0.0
     */
    chrome.runtime.onConnect.addListener(async (port) => {
        if (!port.name) return;
        if (!targetBindings.hasOwnProperty(port.name) && port.name !== "broadcast") {
            port.postMessage({ action: "close" });
            port.disconnect();
            return;
        }
        port.onDisconnect.addListener(() => delete targetBindings[port.name]);
        const updateStatus = (status) => port.postMessage({ action: "status", status });
        const clearStatus = () => port.postMessage({ action: "clear-status" });
        let el = targetBindings[port.name];
        if (!el) {
            if (window === window.top && port.name === "broadcast") {
                // Handle broadcast connections in the root frame only
                // Look for a suitable target element in the root frame
                const selectors = (await validTargets)
                    .toSorted((a, b) => {
                        const priority = ["totp", "login", "secret", "cardholder"]; // target type search order, highest priority last
                        if (priority.indexOf(a.type) > priority.indexOf(b.type)) return -1;
                        if (priority.indexOf(a.type) < priority.indexOf(b.type)) return 1;
                        return 0;
                    })
                    .filter((t) => !t.relatedOnly);
                for (let selector of selectors) {
                    el = Helpers.shadowSelector(selector.selector);
                    if (el) {
                        el._parcelToken = port.name;
                        break;
                    }
                }
                if (!el) {
                    port.postMessage({ action: "error", error: "Cannot find a suitable autofill target." });
                    port.disconnect();
                    return;
                }
            } else {
                throw new Error("Element binding is missing.");
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
            port.postMessage({ action: "error", error: "Cannot find a suitable autofill target." });
            port.disconnect();
            return;
        }
        port.onMessage.addListener(async (msg) => {
            if (msg?.action === "fill-value") {
                // Fill the target field with the selected value
                updateStatus("Filling value...");
                await fillField(el, null, null, null, msg.value);
                port.postMessage({ action: "close" });
                el._parcelPopup?.remove();
            } else if (msg?.action === "fill") {
                // fill the target field, and related fields if configured
                try {
                    updateStatus("Filling values...");
                    if (!msg.hasOwnProperty("config")) throw new Error("Config is missing.");
                    if (!msg.hasOwnProperty("plaintext")) throw new Error("Plaintext is missing.");
                    await fillField(el, msg.plaintext, msg.config);
                    if (msg.config.fillRelated) {
                        for (const rel of await getRelatedFields(el)) {
                            try {
                                await fillField(rel, msg.plaintext, msg.config, null, null, true);
                            } catch (err) {
                                // ignore errors when filling related form fields
                            }
                        }
                    }
                    port.postMessage({ action: "close" });
                    el._parcelPopup?.remove();

                    // submit the form if configured, else try to focus the submit button
                    const submitTargets = (await validTargets).filter((t) => t.type === "submit");
                    const form = el.closest("form");
                    if (form) {
                        for (let target of submitTargets) {
                            let submitButton = form.querySelector(target.selector);
                            if (submitButton) submitButton.focus();
                        }
                    } else {
                        el.focus();
                    }
                } catch (err) {
                    console.warn(err);
                    port.postMessage({ action: "error", error: err.message });
                }
            } else if (msg?.action === "resize") {
                const popup = el._parcelPopup;
                if (popup) {
                    popup.style.height = `${msg.height}px`;
                    popup.style.width = `${msg.width}px`;
                }
            } else if (msg?.action === "close") {
                let popup = el._parcelPopup;
                if (popup) {
                    popup.remove();
                    popup._parcelTarget?.focus();
                }
            }
        });
    });
})();

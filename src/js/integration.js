"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const { Schema, SelectorSchema } = await import(chrome.runtime.getURL("/js/schema.js"));
    const targetSelectors = import(chrome.runtime.getURL("/js/selectors.js"));
    const targetBindings = {};
    let authPort = chrome.runtime.connect({ name: "auth" });
    window.addEventListener("pageshow", (ev) => {
        // re-establish connection to the auth port on bfcache restore
        if (ev.persisted) authPort = chrome.runtime.connect({ name: "auth" });
    });
    let frameId = 0;

    /**
     * Handle incoming "trigger" port connections (popup open/close, resize, and untargeted-click routing).
     * @since 1.0.0
     * @param {chrome.runtime.Port} port - The incoming "trigger" connection.
     * @returns {void}
     */
    chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== "trigger") return;
        port.onMessage.addListener(async (msg) => {
            if (msg?.action === "trigger-popup") {
                triggerPopup(msg.token, msg.frameId, msg.position, msg.origin);
            } else if (msg?.action === "close-popup") {
                document.querySelectorAll(".parcel-popup").forEach((popup) => popup.remove());
            } else if (msg?.action === "resize-popup") {
                const popup = document.querySelector(".parcel-popup");
                if (popup) popup._resizeFn(msg.width, msg.height);
            } else if (msg?.action === "untargeted-click") {
                // if a popup exists, close it if the click was outside the popup
                const popup = [...document.querySelectorAll(".parcel-popup")].sort((a, b) => b._parcelCreated - a._parcelCreated)?.[0];
                if (popup) {
                    const frameEl = [...document.querySelectorAll("iframe")].find((f) => f._parcelFrameId === msg.frameId);
                    if (frameEl) {
                        const frameRect = frameEl.getBoundingClientRect();
                        msg.x += frameRect.left;
                        msg.y += frameRect.top;
                    }

                    const popupRect = popup.getBoundingClientRect();
                    if (!(msg.x >= popupRect.left && msg.x <= popupRect.right && msg.y >= popupRect.top && msg.y <= popupRect.bottom))
                        popup.remove();
                }
            }
        });
    });
    let triggerPort = chrome.runtime.connect({ name: "trigger" });
    window.addEventListener("pageshow", (ev) => {
        // re-establish connection to the trigger port on bfcache restore
        if (ev.persisted) triggerPort = chrome.runtime.connect({ name: "trigger" });
    });
    window.addEventListener("message", (ev) => {
        if (ev.data?.action === "parcel-frame-id") {
            const frameEl = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === ev.source);
            if (frameEl) frameEl._parcelFrameId = ev.data.frameId;
        }
    });

    /**
     * Configuration object retrieved from the background worker.
     * @since 1.0.0
     * @type {Promise<object>}
     */
    const config = new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "integration" });
        port.onMessage.addListener(async (msg) => {
            if (msg.action === "config") {
                port.disconnect();
                frameId = msg?.frameId || 0;
                if (window !== window.top) window.top.postMessage({ action: "parcel-frame-id", frameId }, "*");
                resolve(msg.config);
            }
        });
        port.postMessage({ action: "config" });
    });

    /**
     * List of valid focus targets, filtered to the current host.
     * @since 1.0.0
     * @type {Promise<object[]>}
     */
    const validTargets = targetSelectors.then(async (targetSelectors) => {
        const selectors = targetSelectors.targetSelectors.concat((await config).additionalSelectors || []);
        Schema.validate(SelectorSchema, selectors);
        return selectors.filter(
            (t) => !["blacklist", "aggregate"].includes(t.type) && (!t.host || t.host.includes(window.location.hostname)),
        );
    });

    /**
     * List of blacklist-type selectors applicable to the current host.
     * @since 1.0.0
     * @type {Promise<object[]>}
     */
    const invalidTargets = targetSelectors.then((targetSelectors) =>
        targetSelectors.targetSelectors.filter((t) => t.type === "blacklist" && (!t.host || t.host.includes(window.location.hostname))),
    );

    /**
     * Get the target info for an element.
     * @since 1.0.0
     * @param {HTMLElement} el - The element to check.
     * @param {boolean} [related=false] - Whether to include selectors flagged `relatedOnly` in the candidate pool.
     * @returns {Promise<?object>} The matching target descriptor (`{type, selector, related, ...}`), or null if not found.
     * @throws {Error} If the element is not visible, has an unsupported input type, or matches a blacklist selector.
     */
    async function getTargetInfo(el, related = false) {
        try {
            if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
                throw new Error("Target element is not visible.");
            }
            if (el.hasAttribute("type") && !["text", "email", "tel", "password"].includes(el.type))
                throw new Error(`Invalid input type: ${el.type}`);
            let finalTarget = null;
            for (const target of (await validTargets).filter((t) => (related ? true : !t.relatedOnly))) {
                if (el.matches(target.selector) && !el.readOnly && !el.disabled) {
                    finalTarget = target;
                    break;
                }
            }
            if (finalTarget) {
                for (const target of (await invalidTargets).filter((t) => (related ? true : !t.relatedOnly))) {
                    if (el.matches(target.selector)) {
                        el.setAttribute("parcel-blacklist", target.selector);
                        throw new Error(`Target element matches a blacklist selector: ${target.selector}`);
                    }
                }
                finalTarget.related =
                    (await config).targets.concat((await config).additionalTargets || []).find((t) => t.name === finalTarget.type)
                        ?.related || [];
            }
            return finalTarget;
        } catch (err) {
            console.info(el); // log the target element to assist with troubleshooting selector issues
            throw err;
        }
    }

    /**
     * Get fillable fields that are related to the given element.
     * @since 1.0.0
     * @param {HTMLElement} el - The element to start from.
     * @returns {Promise<HTMLElement[]>} The related fillable fields within the closest aggregate group.
     * @throws {Error} If `getTargetInfo(el)` rejects (e.g. the element is not a valid target).
     */
    async function getRelatedFields(el) {
        const targetInfo = await getTargetInfo(el);
        const aggregationSelectors = (await targetSelectors).targetSelectors.filter((s) => s.type === "aggregate");
        let group;
        for (const s of aggregationSelectors) {
            group = el.closest(s.selector);
            if (group) break;
        }
        if (!group) return [];
        const relatedFields = [];
        for (const target of (await validTargets).filter((t) => targetInfo.related.includes(t.type))) {
            for (const field of group.querySelectorAll(target.selector)) {
                if (relatedFields.includes(field) || field === el) continue;
                let isInvalid = false;
                for (const target of await invalidTargets) {
                    if (field.matches(target.selector)) {
                        isInvalid = true;
                        break;
                    }
                }
                if (isInvalid) continue;
                try {
                    if (!field.targetInfo) field.targetInfo = await getTargetInfo(field, true);
                    if (targetInfo.related.includes(field.targetInfo?.type)) relatedFields.push(field);
                } catch (_err) {
                    // if getTargetInfo throws, it means the field is not fillable, but we can ignore
                    // the error because we're only using it as an eligibility test for related fields
                }
            }
        }
        return relatedFields;
    }

    /**
     * Fill the appropriate value for the target element.
     * @since 1.0.0
     * @param {HTMLElement} el - The element to target.
     * @param {string|null} plaintext - The plaintext to derive the value from, or null when filling a direct value.
     * @param {object|null} config - The current parcel config, or null when filling a direct value.
     * @param {string|null} [type=null] - The target type to use, or null to infer from the element.
     * @param {string|null} [fillValue=null] - The value to fill, or null to derive from the plaintext and config.
     * @param {boolean} [isRelated=false] - Whether the field being filled is a related field (as opposed to the originally clicked field).
     * @returns {Promise<void>}
     * @throws {Error} If the target element has been removed from the DOM or is not eligible for autofill.
     */
    async function fillField(el, plaintext, config, type = null, fillValue = null, isRelated = false) {
        if (!el.parentNode) throw new Error("Target element has been removed from the DOM.");
        let targetInfo;
        let initialValue;
        try {
            targetInfo = await getTargetInfo(el, isRelated);
        } catch (err) {
            throw new Error(`Target element is not eligible for autofill: ${err.message}`);
        }
        if (!type) type = targetInfo.type;
        if (fillValue === null) fillValue = await Helpers.getValue(plaintext, config, type);
        if (typeof fillValue === "object" && Object.prototype.hasOwnProperty.call(fillValue, "value")) fillValue = fillValue.value;

        // Send some keyboard events indicating that value modification has started (no associated keycode)
        for (const eventName of ["keydown", "keypress", "keyup", "input", "change"]) {
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
                const fullYear = (2000 + parseInt(fillValue)).toString();
                optionToSelect = Array.from(el.options).find((o) => o.value === fullYear || o.text === fullYear);
            }
            if (!optionToSelect && type === "cardexp-month") {
                const monthShortNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
                const monthLongNames = [
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
                const monthIndex = parseInt(fillValue) - 1;
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
            initialValue = el.value || el.getAttribute("value");
            el.setAttribute("value", fillValue);
            el.value = fillValue;
        }

        // Send the keyboard events again indicating that value modification has finished (no associated keycode)
        for (const eventName of ["keydown", "keypress", "keyup", "input", "change"]) {
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
     * Trigger a popup for the given element, anchoring it to the element's position.
     * @since 1.0.0
     * @param {string} token - The token for the element.
     * @param {number} frameId - The ID of the frame in which the target element resides.
     * @param {DOMRect} position - The position of the target element.
     * @returns {Promise<void>}
     */
    async function triggerPopup(token, frameId, position) {
        // remove old popups
        for (const popup of [...Helpers.shadowSelectorAll(".parcel-popup")]) {
            popup.remove();
            if (popup._parcelToken === token) return; // Don't reopen the popup if we just clicked its target field to close it
        }

        // adjust coordinates if the target element is inside an iframe
        const frameEl = [...document.querySelectorAll("iframe")].find((f) => f._parcelFrameId === frameId);
        if (frameEl) {
            const frameRect = frameEl.getBoundingClientRect();
            position = {
                top: position.top + frameRect.top,
                bottom: position.bottom + frameRect.top,
                left: position.left + frameRect.left,
                right: position.right + frameRect.left,
                x: position.x + frameRect.left,
                y: position.y + frameRect.top,
            };
        }

        // adjust coordinates for scroll position
        position = {
            ...position,
            top: position.top + window.scrollY,
            bottom: position.bottom + window.scrollY,
            left: position.left + window.scrollX,
            right: position.right + window.scrollX,
        };

        const popup = document.createElement("div");
        popup._parcelCreated = Date.now();
        popup._parcelToken = token;
        popup.setAttribute(
            "style",
            "color-scheme: initial; forced-color-adjust: initial; mask: initial; math-depth: initial; position: fixed; position-anchor: initial; text-size-adjust: initial; appearance: initial; color: initial; font: initial; font-palette: initial; font-synthesis: initial; position-area: initial; text-orientation: initial; text-rendering: initial; text-spacing-trim: initial; -webkit-font-smoothing: initial; -webkit-locale: initial; -webkit-text-orientation: initial; -webkit-writing-mode: initial; writing-mode: initial; zoom: initial; accent-color: initial; place-content: initial; place-items: initial; place-self: initial; alignment-baseline: initial; anchor-name: initial; anchor-scope: initial; animation-composition: initial; animation: initial; app-region: initial; aspect-ratio: initial; backdrop-filter: initial; backface-visibility: initial; background: initial; background-blend-mode: initial; baseline-shift: initial; baseline-source: initial; block-size: initial; border-block: initial; border: none; border-radius: initial; border-collapse: initial; border-end-end-radius: initial; border-end-start-radius: initial; border-inline: initial; border-start-end-radius: initial; border-start-start-radius: initial; bottom: initial; box-decoration-break: initial; box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 4px 20px; box-sizing: initial; break-after: initial; break-before: initial; break-inside: initial; buffered-rendering: initial; caption-side: initial; caret-color: initial; clear: initial; clip: initial; clip-path: initial; clip-rule: initial; color-interpolation: initial; color-interpolation-filters: initial; color-rendering: initial; columns: initial; column-fill: initial; gap: initial; column-rule: initial; column-span: initial; contain: initial; contain-intrinsic-block-size: initial; contain-intrinsic-size: initial; contain-intrinsic-inline-size: initial; container: initial; content: initial; content-visibility: initial; counter-increment: initial; counter-reset: initial; counter-set: initial; cursor: initial; cx: initial; cy: initial; d: initial; display: initial; dominant-baseline: initial; empty-cells: initial; field-sizing: initial; fill: initial; fill-opacity: initial; fill-rule: initial; filter: initial; flex: initial; flex-flow: initial; float: initial; flood-color: initial; flood-opacity: initial; grid: initial; grid-area: initial; height: initial; hyphenate-character: initial; hyphenate-limit-chars: initial; hyphens: initial; image-orientation: initial; image-rendering: initial; initial-letter: initial; inline-size: initial; inset-block: initial; inset-inline: initial; interpolate-size: initial; isolation: initial; left: initial; letter-spacing: initial; lighting-color: initial; line-break: initial; list-style: initial; margin-block: initial; margin: initial; margin-inline: initial; marker: initial; mask-type: initial; math-shift: initial; math-style: initial; max-block-size: initial; max-height: initial; max-inline-size: initial; max-width: initial; min-block-size: initial; min-height: initial; min-inline-size: initial; min-width: initial; mix-blend-mode: initial; object-fit: initial; object-position: initial; object-view-box: initial; offset: initial; opacity: initial; order: initial; orphans: initial; outline: 0px; outline-offset: initial; overflow-anchor: initial; overflow-block: initial; overflow-clip-margin: initial; overflow-inline: initial; overflow-wrap: initial; overflow: initial; overlay: initial; overscroll-behavior-block: initial; overscroll-behavior-inline: initial; overscroll-behavior: initial; padding-block: initial; padding: initial; padding-inline: initial; page: initial; page-orientation: initial; paint-order: initial; perspective: initial; perspective-origin: initial; pointer-events: initial; position-try: initial; position-visibility: initial; quotes: initial; r: initial; resize: initial; right: initial; rotate: initial; ruby-align: initial; ruby-position: initial; rx: initial; ry: initial; scale: initial; scroll-behavior: initial; scroll-initial-target: initial; scroll-margin-block: initial; scroll-margin: initial; scroll-margin-inline: initial; scroll-marker-group: initial; scroll-padding-block: initial; scroll-padding: initial; scroll-padding-inline: initial; scroll-snap-align: initial; scroll-snap-stop: initial; scroll-snap-type: initial; scroll-timeline: initial; scrollbar-color: initial; scrollbar-gutter: initial; scrollbar-width: initial; shape-image-threshold: initial; shape-margin: initial; shape-outside: initial; shape-rendering: initial; size: initial; speak: initial; stop-color: initial; stop-opacity: initial; stroke: initial; stroke-dasharray: initial; stroke-dashoffset: initial; stroke-linecap: initial; stroke-linejoin: initial; stroke-miterlimit: initial; stroke-opacity: initial; stroke-width: initial; tab-size: initial; table-layout: initial; text-align: initial; text-align-last: initial; text-anchor: initial; text-box: initial; text-combine-upright: initial; text-decoration: initial; text-decoration-skip-ink: initial; text-emphasis: initial; text-emphasis-position: initial; text-indent: initial; text-overflow: initial; text-shadow: initial; text-transform: initial; text-underline-offset: initial; text-underline-position: initial; text-wrap: initial; timeline-scope: initial; top: initial; touch-action: initial; transform: initial; transform-box: initial; transform-origin: initial; transform-style: initial; transition: initial; translate: initial; user-select: initial; vector-effect: initial; vertical-align: initial; view-timeline: initial; view-transition-class: initial; view-transition-name: initial; visibility: visible; border-spacing: initial; -webkit-box-align: initial; -webkit-box-decoration-break: initial; -webkit-box-direction: initial; -webkit-box-flex: initial; -webkit-box-ordinal-group: initial; -webkit-box-orient: initial; -webkit-box-pack: initial; -webkit-box-reflect: initial; -webkit-line-break: initial; -webkit-line-clamp: initial; -webkit-mask-box-image: initial; -webkit-print-color-adjust: initial; -webkit-rtl-ordering: initial; -webkit-ruby-position: initial; -webkit-tap-highlight-color: initial; -webkit-text-combine: initial; -webkit-text-decorations-in-effect: initial; -webkit-text-fill-color: initial; -webkit-text-security: initial; -webkit-text-stroke: initial; -webkit-user-drag: initial; white-space-collapse: initial; widows: initial; width: initial; will-change: initial; word-break: initial; word-spacing: initial; x: initial; y: initial; z-index: 2147483647;",
        );
        popup.classList.add("parcel-popup");
        const root = popup.attachShadow({ mode: "closed" });
        popup.style.position = "absolute";
        popup.style.top = `${position.bottom + 5}px`;
        popup.style.left = `${position.left + 5}px`;
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

        // add hook to adjust size & position
        popup._resizeFn = async (width = 0, height = 0) => {
            if (width) popup.style.width = `${width}px`;
            if (height) popup.style.height = `${height}px`;
            await new Promise((resolve) => requestAnimationFrame(resolve)); // wait for the resize to take effect before adjusting position
            const rect = popup.getBoundingClientRect();
            if (position.y + rect.height + 5 > window.innerHeight) popup.style.top = `${position.top - rect.height - 5}px`;
            else popup.style.top = `${position.bottom + 5}px`;
            if (position.x + rect.width + 5 > window.innerWidth) popup.style.left = `${window.innerWidth - rect.width - 5}px`;
            else popup.style.left = `${position.left + 5}px`;
        };

        document.body.appendChild(popup);
        popup._resizeFn();
    }

    /**
     * Handle a click on a potential autofill target, dispatching a trigger to the root frame.
     * @since 1.0.0
     * @param {HTMLElement} target - The clicked element (may be a shadow host or label-associated element).
     * @param {number} x - The x coordinate of the click.
     * @param {number} y - The y coordinate of the click.
     * @param {boolean} [isShadowClick=false] - Whether the click was re-dispatched from the shadow-DOM click intercept.
     * @returns {Promise<void>}
     */
    async function handleTriggerClick(target, x, y, isShadowClick = false) {
        if (!isShadowClick && target.hasAttribute("is-shadow")) return; // ignore duplicate clicks from shadow hosts
        if (target?.control) return; // ignore clicks on labels, we'll handle them via the cascaded click on its associated element
        if (target._lastClicked && target._lastClicked > Date.now() - 350) return; // debounce multiple quick clicks
        target._lastClicked = Date.now();

        //let popup = document.querySelector(".parcel-popup");
        try {
            const targetInfo = await getTargetInfo(target);
            if (!Object.prototype.hasOwnProperty.call(target, "_parcelToken")) {
                try {
                    target._parcelToken = crypto.randomUUID();
                } catch (_err) {
                    // fallback for browsers without crypto.randomUUID(), typically insecure pages lacking the crypto API
                    target._parcelToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
                }
            }
            targetBindings[target._parcelToken] = target;
            addTargetInputClose(target);
            authPort.postMessage(target._parcelToken);
            target.setAttribute("parcel-selector", targetInfo.selector);
            target.setAttribute("parcel-type", targetInfo.type);

            // dispatch clicks to the handler in the root frame so that the popup can be rendered there
            triggerPort.postMessage({
                action: "trigger-popup",
                frameId,
                token: target._parcelToken,
                position: target.getBoundingClientRect(),
                origin: window.location.origin,
            });
        } catch (_err) {
            // dispatch other clicks to the root frame too, so that they can be used to close the popup
            triggerPort.postMessage({ action: "untargeted-click", frameId, x, y });
        }
    }

    /**
     * Remove the input-close listener from a target element, if one is bound.
     * @since 1.0.2
     * @param {HTMLElement} target - The element to remove the listener from.
     */
    function removeTargetInputClose(target) {
        if (!target?._parcelCloseOnInput) return;
        target.removeEventListener("input", target._parcelCloseOnInput);
        delete target._parcelCloseOnInput;
    }

    /**
     * Clean up all Parcel bindings on a target element: removes the input-close listener,
     * deletes the popup port reference, clears the focus-suspended flag, and removes the
     * element from the target bindings map.
     * @since 1.0.2
     * @param {HTMLElement} target - The element to clean up.
     * @param {chrome.runtime.Port|null} [port=null] - If provided, only cleans up if the target's bound port matches.
     */
    function cleanupInlineTarget(target, port = null) {
        if (!target) return;
        if (port && target._parcelPopupPort && target._parcelPopupPort !== port) return;
        removeTargetInputClose(target);
        if (!port || target._parcelPopupPort === port) delete target._parcelPopupPort;
        delete target._parcelFocusSuspended;
        if (target._parcelToken && target._parcelToken !== "broadcast") delete targetBindings[target._parcelToken];
    }

    /**
     * Bind an input event listener to the target element that closes the popup and cleans
     * up the target binding when the user starts typing.
     * @since 1.0.2
     * @param {HTMLElement} target - The element to bind the input-close listener to.
     */
    function addTargetInputClose(target) {
        removeTargetInputClose(target);
        target._parcelCloseOnInput = () => {
            if (target._parcelFilling) return;
            const popupPort = target._parcelPopupPort;
            cleanupInlineTarget(target, popupPort);
            triggerPort.postMessage({ action: "close-popup" });
            popupPort?.disconnect();
        };
        target.addEventListener("input", target._parcelCloseOnInput);
    }

    /**
     * Capture-phase keydown handler that intercepts Tab on popup-bound elements and
     * redirects focus to the popup iframe. Uses `composedPath()` to find the bound element
     * through shadow DOM boundaries. Skips interception when focus is suspended (e.g.
     * during a blocking alert) or when the popup port is stale.
     * @since 1.0.2
     * @param {KeyboardEvent} ev - The keydown event.
     */
    function handleTargetKeydown(ev) {
        if (ev.defaultPrevented || ev.key !== "Tab" || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
        const target = ev.composedPath().find((el) => el?._parcelPopupPort);
        if (!target) return;
        if (target._parcelFocusSuspended) return;
        ev.preventDefault();
        try {
            target._parcelPopupPort.postMessage({ action: "focus-popup" });
        } catch (_err) {
            cleanupInlineTarget(target, target._parcelPopupPort);
        }
    }

    if (!(await config).disableContextPopup) {
        document.addEventListener("click", (ev) => handleTriggerClick(ev.target, ev.clientX, ev.clientY), { capture: true, passive: true });
        document.addEventListener("keydown", handleTargetKeydown, { capture: true });
        document.addEventListener(
            "parcel-shadow-click",
            async (ev) => {
                const target = Helpers.shadowSelector(`[parcel-shadow-event="${ev.detail.target}"]`, document);
                target.removeAttribute("parcel-shadow-event");
                if (target) handleTriggerClick(target, ev.detail.x, ev.detail.y, true);
            },
            { capture: true, passive: true },
        );
    }

    /**
     * Handle incoming connections from the popup, binding each connection to its target element
     * and routing subsequent messages (ready / fill-value / fill / resize / close).
     * @since 1.0.0
     * @param {chrome.runtime.Port} port - The incoming popup connection.
     * @returns {Promise<void>}
     * @throws {Error} If a non-broadcast connection arrives without a matching element binding.
     */
    chrome.runtime.onConnect.addListener(async (port) => {
        if (!port.name) return;
        if (port.name === "trigger") return; // handled in another listener

        if (!Object.prototype.hasOwnProperty.call(targetBindings, port.name) && port.name !== "broadcast") {
            port.postMessage({ action: "close" });
            port.disconnect();
            return;
        }
        const updateStatus = (status) => port.postMessage({ action: "status", status });
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
                for (const selector of selectors) {
                    el = Helpers.shadowSelector(selector.selector);
                    if (el) {
                        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
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
            }
        }
        if (el._parcelToken !== port.name) {
            port.postMessage({ action: "error", error: "Invalid token." });
            port.disconnect();
            return;
        }
        port.onDisconnect.addListener(() => {
            if (port.name !== "broadcast") cleanupInlineTarget(el, port);
            delete targetBindings[port.name];
        });
        try {
            await getTargetInfo(el);
        } catch (_err) {
            port.postMessage({ action: "error", error: "The selected autofill candidate was unsuitable." });
            port.disconnect();
            return;
        }
        if (port.name !== "broadcast") el._parcelPopupPort = port;
        // Sets _parcelFilling during fill so the input-close listener doesn't fire
        const fillBoundField = async (...args) => {
            el._parcelFilling = true;
            try {
                return await fillField(el, ...args);
            } finally {
                delete el._parcelFilling;
            }
        };
        port.onMessage.addListener(async (msg) => {
            if (msg?.action === "ready") {
                port.postMessage({ action: "origin", origin: window.location.origin });
            } else if (msg?.action === "focus-target") {
                el.focus();
            } else if (msg?.action === "focus-suspend") {
                el._parcelFocusSuspended = true;
            } else if (msg?.action === "focus-resume") {
                delete el._parcelFocusSuspended;
            } else if (msg?.action === "fill-value") {
                // Fill the target field with the selected value
                updateStatus("Filling value...");
                await fillBoundField(null, null, null, msg.value);
                cleanupInlineTarget(el, port);
                port.postMessage({ action: "close" });
                triggerPort.postMessage({ action: "close-popup" });
            } else if (msg?.action === "fill") {
                // fill the target field, and related fields if configured
                try {
                    updateStatus("Filling values...");
                    if (!Object.prototype.hasOwnProperty.call(msg, "config")) throw new Error("Config is missing.");
                    if (!Object.prototype.hasOwnProperty.call(msg, "plaintext")) throw new Error("Plaintext is missing.");
                    await fillBoundField(msg.plaintext, msg.config);
                    if (msg.config.fillRelated) {
                        for (const rel of await getRelatedFields(el)) {
                            try {
                                await fillField(rel, msg.plaintext, msg.config, null, null, true);
                            } catch (_err) {
                                // ignore errors when filling related form fields
                            }
                        }
                    }
                    cleanupInlineTarget(el, port);
                    port.postMessage({ action: "close" });
                    triggerPort.postMessage({ action: "close-popup" });

                    // try to focus the submit button
                    const submitTargets = (await validTargets).filter((t) => t.type === "submit");
                    let group;
                    const aggregationSelectors = (await targetSelectors).targetSelectors.filter((s) => s.type === "aggregate");
                    for (const s of aggregationSelectors) {
                        group = el.closest(s.selector);
                        if (group) break;
                    }
                    if (group) {
                        for (const target of submitTargets) {
                            const submitButton = group.querySelector(target.selector);
                            if (submitButton) {
                                await new Promise((resolve) => requestAnimationFrame(resolve));
                                submitButton.focus();
                                break;
                            }
                        }
                    } else {
                        el.focus();
                    }
                } catch (err) {
                    console.warn(err);
                    port.postMessage({ action: "error", error: err.message });
                } finally {
                    delete el._parcelToken; // remove the token to prevent stale bindings in case of subsequent context-popup invocations
                }
            } else if (msg?.action === "resize") {
                triggerPort.postMessage({ action: "resize-popup", height: msg.height, width: msg.width });
            } else if (msg?.action === "close") {
                cleanupInlineTarget(el, port);
                triggerPort.postMessage({ action: "close-popup" });
            }
        });
    });
})();

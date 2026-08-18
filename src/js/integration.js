"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const { Schema, SelectorSchema, PasskeyRequestSchema, PasskeyAbortSchema, PasskeyConflictSchema } = await import(
        chrome.runtime.getURL("/js/schema.js")
    );
    const webauthn = await import(chrome.runtime.getURL("/js/webauthn.js"));
    const targetSelectors = import(chrome.runtime.getURL("/js/selectors.js"));
    const targetBindings = {};
    const passkeyBindings = {};
    // state for the popup-spam guard (see PASSKEY_DISMISS_THRESHOLD)
    let passkeyDismissStreak = 0;
    let passkeyLastDismissAt = 0;

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
     * Create a runtime port that transparently reconnects after disconnection.
     *
     * The MV3 service worker can terminate at any time (idle timeout, extension
     * reload), severing all existing ports. Without reconnection, the next
     * `postMessage()` throws "Attempting to use a disconnected port object".
     * This wrapper lazily re-establishes the connection before each post so
     * callers always operate on a live port.
     * @since 1.0.2
     * @param {string} name - The port name passed to `chrome.runtime.connect()`.
     * @returns {{ postMessage: (msg: any) => boolean, reconnect: () => void }} A port-like wrapper whose `postMessage` returns `true` when the message was delivered.
     */
    function reconnectingPort(name) {
        let port = null;
        function open() {
            try {
                const p = chrome.runtime.connect({ name });
                p.onDisconnect.addListener(() => {
                    chrome.runtime.lastError; // consume the disconnect error
                    if (port === p) port = null;
                });
                return p;
            } catch (_err) {
                // Extension context invalidated — the content script is stale
                // and must be reloaded by the user. We return null so callers
                // don't attempt further posts on a dead port.
                return null;
            }
        }
        port = open();
        return {
            postMessage(msg) {
                if (!port) port = open();
                if (!port) return false;
                return postWithRetry(
                    () => port.postMessage(msg),
                    () => {
                        port = open();
                    },
                );
            },
            reconnect() {
                port = open();
            },
        };
    }

    const authPort = reconnectingPort("auth");
    window.addEventListener("pageshow", (ev) => {
        // re-establish connection to the auth port on bfcache restore
        if (ev.persisted) authPort.reconnect();
    });
    let frameId = 0;

    // Send a periodic keepalive message to the service worker so that MV3
    // doesn't suspend it during idle periods. Content scripts run in the tab's
    // process and are not subject to service worker suspension, so this timer
    // keeps firing as long as the tab is open. Each message resets the worker's
    // inactivity timer, which in turn keeps the native host ping interval alive.
    //
    // Only the top frame needs to send keepalives — integration.js runs with
    // all_frames: true, but a single timer per tab is sufficient since any
    // keepalive resets the shared service worker inactivity timer.
    //
    // Note that Chrome intensively throttles timers in tabs hidden for more
    // than a few minutes (to ~1/minute), so a fully-backgrounded tab may stop
    // keeping the worker alive. That failure mode is deliberately benign and
    // self-healing: the native host exits via its own idle watchdog, and the
    // next keepalive sendMessage wakes the worker, which reconnects on
    // construction. We degrade to a dormant host, never a zombie one.
    //
    // After extension reload, this stale script's context is invalidated and
    // sendMessage throws; catch it once and stop the timer (a fresh content
    // script only arrives on page reload).
    if (window === window.top) {
        const keepalive = setInterval(() => {
            try {
                chrome.runtime.sendMessage({ type: "keepalive" }, () => void chrome.runtime.lastError);
            } catch (_err) {
                clearInterval(keepalive);
            }
        }, 25_000);
    }

    // Trigger the http-auth scrim popup from the background worker.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.action === "trigger-http-auth") {
            if (window !== window.top) return;
            httpAuthTokens.add(msg.token);
            triggerPopup(msg.token, 0, { centered: true }, "http-auth");
            sendResponse({ ok: true });
        }
    });

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
                triggerPopup(msg.token, msg.frameId, msg.position, msg.mode, msg.targetClass);
            } else if (msg?.action === "close-popup") {
                document.querySelectorAll(".parcel-popup").forEach((popup) => removePopup(popup));
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
                        removePopup(popup);
                }
            }
        });
    });
    const triggerPort = reconnectingPort("trigger");
    window.addEventListener("pageshow", (ev) => {
        // re-establish connection to the trigger port on bfcache restore
        if (ev.persisted) triggerPort.reconnect();
    });
    window.addEventListener("message", (ev) => {
        if (ev.data?.action === "parcel-frame-id" && typeof ev.source?.postMessage === "function") {
            const frameEl = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === ev.source);
            if (frameEl) frameEl._parcelFrameId = ev.data.frameId;
        }
    });

    /**
     * Configuration object retrieved from the background worker.
     * @since 1.0.0
     * @type {Promise<object>}
     */
    const config = new Promise((resolve, reject) => {
        const MAX_ATTEMPTS = 5;
        let attempts = 0;
        let settled = false;

        // settle-once rejection: the error is logged here, so consumers only
        // receive it (and gate on configOK) without re-logging
        const rejectConfig = (err) => {
            if (settled) return;
            settled = true;
            console.error(err);
            reject(err);
        };

        /**
         * Request the config on a fresh "integration" port, retrying on error,
         * disconnect or timeout. Rejects after MAX_ATTEMPTS failures.
         * @since 1.0.6
         * @returns {void}
         */
        function requestConfig() {
            let port;
            try {
                port = chrome.runtime.connect({ name: "integration" });
            } catch (_err) {
                // Extension context invalidated — the content script is stale and
                // the page must be reloaded to get a fresh injection.
                rejectConfig(new Error("Extension context invalidated — please reload the page."));
                return;
            }
            const timer = setTimeout(() => fail("timed out"), 10_000);
            // retry the request, or give up once attempts are exhausted
            const fail = (reason) => {
                if (settled) return;
                clearTimeout(timer);
                if (++attempts >= MAX_ATTEMPTS) {
                    rejectConfig(new Error(`Failed to load configuration after ${MAX_ATTEMPTS} attempts (${reason})`));
                    return;
                }
                setTimeout(requestConfig, 1000);
            };
            port.onMessage.addListener((msg) => {
                if (msg.action === "error") return fail(msg.error);
                if (msg.action !== "config" || settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    port.disconnect();
                } catch (_err) {
                    // already disconnected; nothing to clean up
                }
                frameId = msg?.frameId || 0;
                if (window !== window.top) {
                    // Restrict the broadcast to the top-level origin so a
                    // cross-origin embedding page can't observe it. ancestorOrigins
                    // exposes ancestor origins even cross-origin; fall back to "*"
                    // in browsers that don't implement it.
                    const ancestors = location.ancestorOrigins;
                    const topOrigin = ancestors?.length ? ancestors.item(ancestors.length - 1) : "*";
                    window.top.postMessage({ action: "parcel-frame-id", frameId }, topOrigin);
                }
                resolve(msg.config);
            });
            port.onDisconnect.addListener(() => {
                chrome.runtime.lastError; // consume the disconnect error
                fail("disconnected");
            });
            port.postMessage({ action: "config" });
        }
        requestConfig();
    });

    /**
     * True when the config loaded, false when it failed. Also marks `config` as
     * handled so its rejection can't surface as "Uncaught (in promise)".
     * @since 1.0.6
     * @type {Promise<boolean>}
     */
    const configOK = config.then(
        () => true,
        () => false,
    );

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
     * @param {boolean} [related=false] - Whether to include selectors flagged `relatedOnly` (and exclude those flagged `relatedNever`) in the candidate pool.
     * @returns {Promise<?object>} The matching target descriptor (`{type, selector, related, ...}`).
     * @throws {Error} If the element is not visible, has an unsupported input type, doesn't match a selector, matches a blacklist selector, or (for shadow-scoped descriptors) is not enclosed by a shadow host that satisfies the descriptor's `shadow` field.
     */
    async function getTargetInfo(el, related = false) {
        try {
            if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
                throw new Error("Target element is not visible.");
            }
            if (el.tagName === "BUTTON" || (el.hasAttribute("type") && !["text", "email", "tel", "password"].includes(el.type)))
                throw new Error(`Invalid input type: ${el.type}`);
            let finalTarget = null;
            for (const target of (await validTargets).filter((t) => (related ? !t.relatedNever : !t.relatedOnly))) {
                if (el.matches(target.selector) && !el.readOnly && !el.disabled) {
                    if (target.shadow) {
                        const host = el.getRootNode()?.host;
                        if (!host || !host.matches(target.shadow)) continue;
                    }
                    finalTarget = target;

                    finalTarget.related =
                        (await config).targets.concat((await config).additionalTargets || []).find((t) => t.name === finalTarget.type)
                            ?.related || [];
                    finalTarget.isShadowSingle = false;

                    // if the element is in a shadow DOM which contains no other related targets, mark is as a single-field shadow target
                    const root = el.getRootNode();
                    if (root?.host) {
                        finalTarget.isShadowSingle = true;
                        for (const target of (await validTargets).filter((t) => finalTarget?.related.includes(t.type))) {
                            if (Helpers.shadowSelector(target.selector, root, target.shadow || null)) {
                                finalTarget.isShadowSingle = false;
                                break;
                            }
                        }
                    }

                    // if the selector requires isShadowSingle, but the element is not in a single-field shadow DOM, skip it
                    if (target.single && !finalTarget.isShadowSingle) continue;

                    for (const target of (await invalidTargets).filter((t) => (related ? !t.relatedNever : !t.relatedOnly))) {
                        if (el.matches(target.selector)) {
                            el.setAttribute("parcel-blacklist", target.selector);
                            finalTarget = null;
                            break;
                        }
                    }

                    if (finalTarget) return finalTarget;
                }
            }
            throw new Error("No matching selector");
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
        if (targetInfo.isShadowSingle) group = el.getRootNode()?.host?.getRootNode(); // group singles by containing shadow host
        if (group === document) group = null; // the document root is not a valid group
        if (!group) {
            for (const s of aggregationSelectors) {
                group = Helpers.shadowClosest(el, s.selector);
                if (group) break;
            }
        }
        if (!group) return [];
        const relatedFields = [];
        for (const target of (await validTargets).filter((t) => targetInfo.related.includes(t.type) && !t.relatedNever)) {
            for (const field of Helpers.shadowSelectorAll(target.selector, group, target.shadow || null)) {
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

    /** Duration of the passkey ceremony scrim fade, in milliseconds. */
    const CEREMONY_FADE_MS = 350;

    /**
     * Popup-spam guard: a page can re-raise the consent modal in a tight loop by
     * calling navigator.credentials again after each dismissal. After this many
     * consecutive dismissed ceremonies, further requests are refused (popup-free) for
     * PASSKEY_POPUP_COOLDOWN_MS; a ceremony the user actually completes resets it.
     */
    const PASSKEY_DISMISS_THRESHOLD = 2;
    const PASSKEY_POPUP_COOLDOWN_MS = 1000;

    /**
     * Cap on the persistent passkeyConflictDismissed map (origins where the conflict
     * notice was permanently dismissed): bounds storage growth and the recorded trail
     * of conflicting sites; oldest-dismissed origins are evicted first.
     */
    const PASSKEY_CONFLICT_DISMISSED_LIMIT = 1000;

    /** Popup modes rendered as a centred card over a fullscreen scrim that fades in and out. */
    const SCRIM_MODES = new Set(["passkey", "passkey-conflict", "http-auth"]);

    /** Per-challenge tokens for http-auth scrim popups, so the onConnect handler can identify them. */
    const httpAuthTokens = new Set();

    /**
     * Remove a popup element from the page. Scrim popups (passkey ceremonies and conflict
     * notices) fade out first (via the Web Animations API, as stylesheet keyframe animations
     * on the shadow host do not run reliably); all other popups are removed immediately.
     *
     * @since 1.0.4
     * @param {HTMLElement} popup - The `.parcel-popup` element to remove.
     * @returns {void}
     */
    function removePopup(popup) {
        if (!popup._scrimMode || popup._closing) {
            popup.remove();
            return;
        }
        popup._closing = true;
        if (typeof popup.animate !== "function") {
            popup.remove();
            return;
        }
        const cleanup = () => popup.remove();
        popup
            .animate([{ opacity: 1 }, { opacity: 0 }], {
                duration: CEREMONY_FADE_MS,
                easing: "ease-in",
                fill: "forwards",
            })
            .finished.then(cleanup, cleanup);
        setTimeout(cleanup, CEREMONY_FADE_MS + 100); // fail-safe if the animation never completes
    }

    /**
     * Trigger a popup for the given element, anchoring it to the element's position.
     * When `position.centered` is true (passkey ceremonies), the popup is centred in the
     * viewport instead of being anchored to an element.
     * @since 1.0.0
     * @param {string} token - The token for the element.
     * @param {number} frameId - The ID of the frame in which the target element resides.
     * @param {DOMRect} position - The position of the target element.
     * @param {string} [mode] - Optional popup mode (e.g. "passkey"), passed through to the popup iframe URL.
     * @param {string|null} [targetClass=null] - The class of the target field (e.g. "card"), used to filter popup entries.
     * @returns {Promise<void>}
     */
    async function triggerPopup(token, frameId, position, mode = null, targetClass = null) {
        // remove old popups
        for (const popup of [...Helpers.shadowSelectorAll(".parcel-popup")]) {
            removePopup(popup);
            if (popup._parcelToken === token) return; // Don't reopen the popup if we just clicked its target field to close it
        }

        // centred popups are not anchored to an element, so no coordinate adjustment applies
        if (!position?.centered) {
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
        }

        const popup = document.createElement("div");
        popup._parcelCreated = Date.now();
        popup._parcelToken = token;
        popup.setAttribute(
            "style",
            "color-scheme: initial; forced-color-adjust: initial; mask: initial; math-depth: initial; position: fixed; position-anchor: initial; text-size-adjust: initial; appearance: initial; color: initial; font: initial; font-palette: initial; font-synthesis: initial; position-area: initial; text-orientation: initial; text-rendering: initial; text-spacing-trim: initial; -webkit-font-smoothing: initial; -webkit-locale: initial; -webkit-text-orientation: initial; -webkit-writing-mode: initial; writing-mode: initial; zoom: initial; accent-color: initial; place-content: initial; place-items: initial; place-self: initial; alignment-baseline: initial; anchor-name: initial; anchor-scope: initial; animation-composition: initial; animation: initial; app-region: initial; aspect-ratio: initial; backdrop-filter: initial; backface-visibility: initial; background: initial; background-blend-mode: initial; baseline-shift: initial; baseline-source: initial; block-size: initial; border-block: initial; border: none; border-radius: initial; border-collapse: initial; border-end-end-radius: initial; border-end-start-radius: initial; border-inline: initial; border-start-end-radius: initial; border-start-start-radius: initial; bottom: initial; box-decoration-break: initial; box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 4px 20px; box-sizing: initial; break-after: initial; break-before: initial; break-inside: initial; buffered-rendering: initial; caption-side: initial; caret-color: initial; clear: initial; clip: initial; clip-path: initial; clip-rule: initial; color-interpolation: initial; color-interpolation-filters: initial; color-rendering: initial; columns: initial; column-fill: initial; gap: initial; column-rule: initial; column-span: initial; contain: initial; contain-intrinsic-block-size: initial; contain-intrinsic-size: initial; contain-intrinsic-inline-size: initial; container: initial; content: initial; content-visibility: initial; counter-increment: initial; counter-reset: initial; counter-set: initial; cursor: initial; cx: initial; cy: initial; d: initial; display: initial; dominant-baseline: initial; empty-cells: initial; field-sizing: initial; fill: initial; fill-opacity: initial; fill-rule: initial; filter: initial; flex: initial; flex-flow: initial; float: initial; flood-color: initial; flood-opacity: initial; grid: initial; grid-area: initial; height: initial; hyphenate-character: initial; hyphenate-limit-chars: initial; hyphens: initial; image-orientation: initial; image-rendering: initial; initial-letter: initial; inline-size: initial; inset-block: initial; inset-inline: initial; interpolate-size: initial; isolation: initial; left: initial; letter-spacing: initial; lighting-color: initial; line-break: initial; list-style: initial; margin-block: initial; margin: initial; margin-inline: initial; marker: initial; mask-type: initial; math-shift: initial; math-style: initial; max-block-size: initial; max-height: initial; max-inline-size: initial; max-width: initial; min-block-size: initial; min-height: initial; min-inline-size: initial; min-width: initial; mix-blend-mode: initial; object-fit: initial; object-position: initial; object-view-box: initial; offset: initial; opacity: initial; order: initial; orphans: initial; outline: 0px; outline-offset: initial; overflow-anchor: initial; overflow-block: initial; overflow-clip-margin: initial; overflow-inline: initial; overflow-wrap: initial; overflow: initial; overlay: initial; overscroll-behavior-block: initial; overscroll-behavior-inline: initial; overscroll-behavior: initial; padding-block: initial; padding: initial; padding-inline: initial; page: initial; page-orientation: initial; paint-order: initial; perspective: initial; perspective-origin: initial; pointer-events: initial; position-try: initial; position-visibility: initial; quotes: initial; r: initial; resize: initial; right: initial; rotate: initial; ruby-align: initial; ruby-position: initial; rx: initial; ry: initial; scale: initial; scroll-behavior: initial; scroll-initial-target: initial; scroll-margin-block: initial; scroll-margin: initial; scroll-margin-inline: initial; scroll-marker-group: initial; scroll-padding-block: initial; scroll-padding: initial; scroll-padding-inline: initial; scroll-snap-align: initial; scroll-snap-stop: initial; scroll-snap-type: initial; scroll-timeline: initial; scrollbar-color: initial; scrollbar-gutter: initial; scrollbar-width: initial; shape-image-threshold: initial; shape-margin: initial; shape-outside: initial; shape-rendering: initial; size: initial; speak: initial; stop-color: initial; stop-opacity: initial; stroke: initial; stroke-dasharray: initial; stroke-dashoffset: initial; stroke-linecap: initial; stroke-linejoin: initial; stroke-miterlimit: initial; stroke-opacity: initial; stroke-width: initial; tab-size: initial; table-layout: initial; text-align: initial; text-align-last: initial; text-anchor: initial; text-box: initial; text-combine-upright: initial; text-decoration: initial; text-decoration-skip-ink: initial; text-emphasis: initial; text-emphasis-position: initial; text-indent: initial; text-overflow: initial; text-shadow: initial; text-transform: initial; text-underline-offset: initial; text-underline-position: initial; text-wrap: initial; timeline-scope: initial; top: initial; touch-action: initial; transform: initial; transform-box: initial; transform-origin: initial; transform-style: initial; transition: initial; translate: initial; user-select: initial; vector-effect: initial; vertical-align: initial; view-timeline: initial; view-transition-class: initial; view-transition-name: initial; visibility: visible; border-spacing: initial; -webkit-box-align: initial; -webkit-box-decoration-break: initial; -webkit-box-direction: initial; -webkit-box-flex: initial; -webkit-box-ordinal-group: initial; -webkit-box-orient: initial; -webkit-box-pack: initial; -webkit-box-reflect: initial; -webkit-line-break: initial; -webkit-line-clamp: initial; -webkit-mask-box-image: initial; -webkit-print-color-adjust: initial; -webkit-rtl-ordering: initial; -webkit-ruby-position: initial; -webkit-tap-highlight-color: initial; -webkit-text-combine: initial; -webkit-text-decorations-in-effect: initial; -webkit-text-fill-color: initial; -webkit-text-security: initial; -webkit-text-stroke: initial; -webkit-user-drag: initial; white-space-collapse: initial; widows: initial; width: initial; will-change: initial; word-break: initial; word-spacing: initial; x: initial; y: initial; z-index: 2147483647;",
        );
        popup.classList.add("parcel-popup");
        if (mode) popup.classList.add(`mode-${mode}`);
        const root = popup.attachShadow({ mode: "closed" });
        popup.style.position = "absolute";
        if (position?.centered) {
            // rough centre until the first resize message arrives with the real size
            popup.style.top = `${window.scrollY + Math.max(0, (window.innerHeight - 300) / 2)}px`;
            popup.style.left = `${window.scrollX + Math.max(0, (window.innerWidth - 300) / 2)}px`;
        } else {
            popup.style.top = `${position.bottom + 5}px`;
            popup.style.left = `${position.left + 5}px`;
        }
        popup.style.color = "black";
        popup.style.backgroundColor = "white";
        popup.style.border = "1px solid black";
        popup.style.overflow = "hidden";
        popup.style.maxHeight = "400px";
        popup.style.minWidth = "200px";
        popup.style.boxSizing = "content-box";

        const scrimMode = SCRIM_MODES.has(mode);
        popup._scrimMode = scrimMode;
        if (scrimMode) {
            // fullscreen scrim: the ceremony card (iframe) is grid-centred over a dimmed,
            // inert page for visual separation; fill popups deliberately skip this
            popup.style.position = "fixed";
            popup.style.inset = "0";
            popup.style.display = "grid";
            popup.style.placeItems = "center";
            popup.style.backgroundColor = "rgba(0, 0, 0, 0.55)";
            popup.style.border = "none";
            popup.style.boxShadow = "none";
            popup.style.maxWidth = "none";
            popup.style.maxHeight = "none";
            popup.style.minWidth = "0";
            popup.style.minHeight = "0";
        }

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
                ${
                    scrimMode
                        ? // the card look lives on the iframe in scrim mode, as the host is the scrim
                          `border: 1px solid black;
                           border-radius: 6px;
                           box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);`
                        : ""
                }
            }
        }`;
        root.appendChild(style);

        // attach iframe (delegate clipboard-write so the popup's copy buttons work in this
        // extension-origin frame; without it the async Clipboard API is policy-denied)
        const frame = document.createElement("iframe");
        frame.setAttribute("allow", "clipboard-write");
        frame.src = chrome.runtime.getURL(
            `/html/popup.html?token=${token}&frameId=${frameId}${mode ? `&mode=${mode}` : ""}${targetClass ? `&targetClass=${targetClass}` : ""}`,
        );
        root.appendChild(frame);
        if (scrimMode) {
            // provisional card size until the popup reports its real size via resize-popup
            frame.style.width = "320px";
            frame.style.height = "320px";
        }

        // add hook to adjust size & position
        popup._resizeFn = async (width = 0, height = 0) => {
            if (scrimMode) {
                // only the card is sized; the scrim stays viewport-filling and self-centres it
                if (width) frame.style.width = `${width}px`;
                if (height) frame.style.height = `${height}px`;
                return;
            }
            if (width) popup.style.width = `${width}px`;
            if (height) popup.style.height = `${height}px`;
            await new Promise((resolve) => requestAnimationFrame(resolve)); // wait for the resize to take effect before adjusting position
            const rect = popup.getBoundingClientRect();
            if (position?.centered) {
                popup.style.top = `${window.scrollY + Math.max(0, (window.innerHeight - rect.height) / 2)}px`;
                popup.style.left = `${window.scrollX + Math.max(0, (window.innerWidth - rect.width) / 2)}px`;
                return;
            }
            if (position.y + rect.height + 5 > window.innerHeight) popup.style.top = `${position.top - rect.height - 5}px`;
            else popup.style.top = `${position.bottom + 5}px`;
            if (position.x + rect.width + 5 > window.innerWidth) popup.style.left = `${window.innerWidth - rect.width - 5}px`;
            else popup.style.left = `${position.left + 5}px`;
        };

        document.body.appendChild(popup);
        popup._resizeFn();
        if (scrimMode && typeof popup.animate === "function") {
            // fade the scrim in (WAAPI, matching the fade-out in removePopup)
            popup.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CEREMONY_FADE_MS, easing: "ease-out" });
        }
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

        try {
            const targetInfo = await getTargetInfo(target);
            if (!Object.prototype.hasOwnProperty.call(target, "_parcelToken") || target._parcelToken === "broadcast") {
                // A "broadcast" token is only ever set by the toolbar-popup (root-frame) binding path and is
                // cleaned up on fill. If the toolbar popup is closed without filling, a stale "broadcast"
                // token can remain on the element; reusing it for a context popup would load the popup iframe
                // with token=broadcast and trip the anti-framing guard. Regenerate it to a per-element token.
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
            if (targetInfo?.shadow) target.setAttribute("parcel-shadow", targetInfo.shadow);
            target.setAttribute("parcel-selector", targetInfo.selector);
            target.setAttribute("parcel-type", targetInfo.type);

            // resolve the target's class so the popup can filter entries accordingly
            const targetDef = (await config).targets.concat((await config).additionalTargets || []).find((t) => t.name === targetInfo.type);
            const targetClass = targetDef?.class || "login";

            // dispatch clicks to the handler in the root frame so that the popup can be rendered there
            triggerPort.postMessage({
                action: "trigger-popup",
                frameId,
                token: target._parcelToken,
                position: target.getBoundingClientRect(),
                targetClass,
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
            const err = chrome.runtime.lastError;
            if (err) console.debug("[integration] popup port postMessage failed:", err.message);
            cleanupInlineTarget(target, target._parcelPopupPort);
        }
    }

    if ((await configOK) && !(await config).disableContextPopup) {
        document.addEventListener("click", (ev) => handleTriggerClick(ev.target, ev.clientX, ev.clientY), { capture: true, passive: true });
        document.addEventListener("keydown", handleTargetKeydown, { capture: true });
        document.addEventListener(
            "parcel-shadow-click",
            async (ev) => {
                const target = Helpers.shadowSelector(`[parcel-shadow-event="${ev.detail.target}"]`, document);
                target?.removeAttribute("parcel-shadow-event");
                if (target) handleTriggerClick(target, ev.detail.x, ev.detail.y, true);
            },
            { capture: true, passive: true },
        );
    }

    /**
     * Post a message on a popup port, swallowing errors from a disconnected
     * port and consuming `chrome.runtime.lastError`. The popup port can die
     * between the popup sending a message and the content script responding —
     * most commonly when the page enters back/forward cache during an async
     * fill — so every response post must be safe against a dead port to avoid
     * unhandled rejections and "Unchecked runtime.lastError" warnings.
     * @since 1.0.2
     * @param {chrome.runtime.Port} port - The port (may be disconnected).
     * @param {any} msg - The message to post.
     * @returns {void}
     */
    function maybePost(port, msg) {
        try {
            port.postMessage(msg);
        } catch (_err) {
            const err = chrome.runtime.lastError;
            if (err) console.debug("[integration] maybePost failed:", err.message);
        }
    }

    // ---------------------------------------------------------------------
    // Passkey (WebAuthn) support. The MAIN-world interceptor in
    // js/main-world/webauthn.js relays navigator.credentials.create()/get() calls
    // here via DOM CustomEvents; the user consents via a centred inline popup
    // and the background worker performs the crypto via the native host.
    // ---------------------------------------------------------------------

    /**
     * Send a response back to the MAIN-world WebAuthn interceptor.
     * @since 1.0.4
     * @param {string} requestId - The request ID from the interceptor.
     * @param {object} payload - The response payload (`{type, ...}`).
     */
    function passkeyRespond(requestId, payload) {
        document.dispatchEvent(new CustomEvent("parcel-webauthn-response", { detail: JSON.stringify({ requestId, ...payload }) }));
    }

    /**
     * Perform a one-shot request/response exchange with the background worker on a fresh "passkey" port.
     * @since 1.0.4
     * @param {object} msg - The message to send (`{action: "passkey", phase, ...}`).
     * @returns {Promise<object>} The worker's reply: `{rpId, candidates}` for a candidates phase, `{result}` otherwise.
     * @throws {Error} If the worker reports an error, disconnects, or the exchange times out.
     */
    async function passkeyRequest(msg) {
        const timeout = (await config).decryptTimeout * 1000 + 5000;
        return new Promise((resolve, reject) => {
            let port;
            try {
                port = chrome.runtime.connect({ name: "passkey" });
            } catch (_err) {
                reject(new Error("Extension context invalidated — please reload the page."));
                return;
            }
            const timer = setTimeout(() => {
                port.disconnect();
                reject(new Error("Passkey request timed out."));
            }, timeout);
            const settle = (fn, value) => {
                clearTimeout(timer);
                fn(value);
                try {
                    port.disconnect();
                } catch (_err) {
                    chrome.runtime.lastError; // consume the disconnect error
                }
            };
            port.onMessage.addListener((response) => {
                if (response?.action === "error") settle(reject, new Error(response.error));
                else if (response?.action === "passkey-fallback") settle(resolve, { fallback: true });
                else if (response?.action === "passkey-candidates")
                    settle(resolve, { rpId: response.rpId, candidates: response.candidates });
                else if (response?.action === "passkey-result") settle(resolve, { result: response.result });
                // ignore other message types (e.g. status / clear-status progress messages etc.)
            });
            port.onDisconnect.addListener(() => {
                chrome.runtime.lastError; // consume the disconnect error
                settle(reject, new Error("Passkey request was disconnected."));
            });
            try {
                port.postMessage(msg);
            } catch (_err) {
                settle(reject, chrome.runtime.lastError || new Error("Passkey request could not be sent."));
            }
        });
    }

    /**
     * Convert standard base64 (as emitted by the native host) to padding-free base64url.
     * @since 1.0.4
     * @param {string} b64 - Standard base64 string.
     * @returns {string} The base64url equivalent without padding.
     */
    function b64StdToB64url(b64) {
        return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    /**
     * Convert a user name into a filesystem-safe slug for a suggested passkey entry name.
     * @since 1.0.4
     * @param {string} name - The user name (e.g. "alice@example.com").
     * @returns {string} The slug, or "credential" if nothing safe remains.
     */
    function slugifyPasskeyName(name) {
        const slug = String(name || "")
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^[^a-z0-9]+/, "")
            .slice(0, 100);
        return slug || "credential";
    }

    /**
     * WebAuthn hint token pattern (L3 spec): lowercase ASCII, digits, and hyphens,
     * starting with a letter. Values exceeding 32 characters are rejected to cap
     * display cost. This guard prevents attacker-controlled hint strings (the hints
     * originate in the MAIN world, where page script can forge them) from carrying
     * arbitrary content into the consent popup.
     * @since 1.0.5
     */
    const PASSKEY_HINT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

    /**
     * Hints that Parcel's software passkeys cannot satisfy, because they request
     * hardware or roaming authenticators. Values here are the full set of spec
     * hint tokens that imply a non-software authenticator.
     * @since 1.0.5
     */
    const PARCEL_UNSATISFIABLE_HINTS = new Set(["security-key", "hybrid"]);

    /**
     * Classify WebAuthn hints from a ceremony request into those Parcel cannot
     * satisfy and those that fail the spec-token regex guard. Both lists contain
     * only strings that have passed length-capping; the popup renders them via
     * textContent, so there is no injection surface.
     * @since 1.0.5
     * @param {string[]|undefined} hints - The hints array from serialised ceremony options.
     * @returns {{violated: string[], nonCompliant: string[]}} Classified hints.
     */
    function violatedPasskeyHints(hints) {
        const violated = [];
        const nonCompliant = [];
        if (!Array.isArray(hints)) return { violated, nonCompliant };
        for (const hint of hints) {
            if (typeof hint !== "string") continue;
            if (PASSKEY_HINT_PATTERN.test(hint)) {
                if (PARCEL_UNSATISFIABLE_HINTS.has(hint)) violated.push(hint);
            } else {
                nonCompliant.push(hint.length > 64 ? hint.slice(0, 64) + "\u2026" : hint);
            }
        }
        return { violated, nonCompliant };
    }

    /**
     * Gate cross-origin iframe ceremonies via Permissions-Policy when available;
     * otherwise allow (downstream layers still validate rpId and require consent).
     * @since 1.0.4
     * @param {string} op - The ceremony type ("get" or "create").
     * @returns {boolean} True when the frame is allowed to proceed.
     */
    function mayHandlePasskeyHere(op) {
        const policy = document.permissionsPolicy;
        if (!policy || typeof policy.allowsFeature !== "function") {
            // No policy API to consult: allow, deferring to the MAIN-world gate
            // and the downstream security layers (rpId validation, consent, host).
            return true;
        }
        // The default "self" allowlist covers top and same-origin frames; a cross-origin
        // iframe only passes when the top frame opted it in via the allow attribute
        if (op === "get") return policy.allowsFeature("publickey-credentials-get") || policy.allowsFeature("publickey-credentials");
        return policy.allowsFeature("publickey-credentials-create") || policy.allowsFeature("publickey-credentials");
    }

    /**
     * Handle a ceremony request relayed by the MAIN-world interceptor: fetch the candidate
     * entries, bind the ceremony state to a fresh token, and open the consent popup.
     * @since 1.0.4
     * @param {string} detailJSON - The JSON-serialised event detail (`{requestId, op, options}`).
     * @returns {Promise<void>}
     */
    async function handlePasskeyRequest(detailJSON) {
        let req;
        try {
            req = JSON.parse(detailJSON);
            Schema.validate(PasskeyRequestSchema, req);
        } catch (err) {
            console.warn("[integration] rejected malformed passkey request:", err.message);
            return;
        }
        const respond = (payload) => passkeyRespond(req.requestId, payload);
        try {
            if (!mayHandlePasskeyHere(req.op)) {
                console.debug("[integration] deferring passkey to browser: frame not permitted to handle ceremonies");
                respond({ type: "fallback" });
                return;
            }
            if (!(await configOK)) {
                // without a config we cannot make passkey decisions — defer to the browser
                console.debug("[integration] deferring passkey to browser: config unavailable");
                respond({ type: "fallback" });
                return;
            }
            if ((await config).handlePasskeys === false) {
                console.debug("[integration] deferring passkey to browser: handlePasskeys is disabled");
                respond({ type: "fallback" });
                return;
            }
            const origin = window.location.origin;
            const rpId = req.op === "get" ? req.options.rpId : req.options.rp?.id;
            if (passkeyDismissStreak >= PASSKEY_DISMISS_THRESHOLD && Date.now() - passkeyLastDismissAt < PASSKEY_POPUP_COOLDOWN_MS) {
                // refuse popup-free rather than falling back: handing a spam loop to the
                // browser's native UI would still interrupt the user, so mirror what
                // native implementations do for rapid repeats of a dismissed ceremony
                console.warn("[integration] passkey request refused: ceremony was dismissed too recently");
                respond({
                    type: "error",
                    name: "NotAllowedError",
                    message: "The operation is not allowed at this time.",
                });
                return;
            }
            const reply = await passkeyRequest({ action: "passkey", phase: "candidates", origin, rpId });
            if (reply.fallback) {
                // the site opted into browser passkeys via a browser-passkey rule
                console.debug(`[integration] deferring passkey to browser: browser-passkey rule matched for rpId ${rpId}`);
                respond({ type: "fallback" });
                return;
            }
            const { rpId: validRpId, candidates } = reply;

            if (req.op === "get" && candidates.length === 0) {
                // nothing stored for this relying party — silently hand the call back to the browser
                console.debug(`[integration] deferring passkey get() to browser: no stored candidates for rpId ${rpId}`);
                respond({ type: "fallback" });
                return;
            }

            // never discard a minted credential whose armored entry is still awaiting out-of-band saving
            for (const oldBinding of Object.values(passkeyBindings)) {
                if (oldBinding.minted) {
                    respond({
                        type: "error",
                        name: "NotAllowedError",
                        message: "Another passkey registration is still awaiting saving; save or discard it first.",
                    });
                    return;
                }
            }

            // a newer request supersedes any in-flight ceremony in this frame
            for (const [oldToken, oldBinding] of Object.entries(passkeyBindings)) {
                delete passkeyBindings[oldToken];
                passkeyRespond(oldBinding.requestId, { type: "fallback" });
            }

            let token;
            try {
                token = crypto.randomUUID();
            } catch (_err) {
                // fallback for browsers without crypto.randomUUID()
                token = Math.random().toString(36).substring(2) + Date.now().toString(36);
            }
            passkeyBindings[token] = {
                requestId: req.requestId,
                op: req.op,
                origin,
                rpId: validRpId,
                options: req.options,
                candidates,
                passkeyDir: (await config).passkeyDir,
                hintWarning: violatedPasskeyHints(req.options.hints),
                minted: null,
            };
            authPort.postMessage(token);
            triggerPort.postMessage({ action: "trigger-popup", frameId, token, position: { centered: true }, mode: "passkey" });
        } catch (err) {
            console.warn("[integration] passkey request failed:", err);
            respond({ type: "fallback" });
        }
    }

    /**
     * Handle an abort relayed by the MAIN-world interceptor (caller timeout or AbortSignal).
     * The interceptor has already rejected its promise, so no response is sent; the binding
     * is dropped and the consent popup closed.
     * @since 1.0.4
     * @param {string} detailJSON - The JSON-serialised event detail (`{requestId}`).
     */
    function handlePasskeyAbort(detailJSON) {
        let msg;
        try {
            msg = JSON.parse(detailJSON);
            Schema.validate(PasskeyAbortSchema, msg);
        } catch (err) {
            console.warn("[integration] rejected malformed passkey abort:", err.message);
            return;
        }
        const token = Object.keys(passkeyBindings).find((t) => passkeyBindings[t]?.requestId === msg?.requestId);
        if (!token) return;
        delete passkeyBindings[token];
        triggerPort.postMessage({ action: "close-popup" });
    }

    /**
     * Handle a conflict report from the MAIN-world interceptor: another extension controls
     * this page's WebAuthn API, so Parcel cannot serve passkeys here. When the user actually
     * holds Parcel passkeys for this origin (and has not dismissed the notice), surface a
     * modal so the conflict is visible instead of silently degrading. Sites the user has
     * deliberately configured for browser passkeys, or where Parcel passkeys are disabled,
     * are not alerted on — an explicit choice is not a conflict.
     * @since 1.0.4
     * @param {string} detailJSON - The JSON-serialised event detail (`{reason}`).
     * @returns {Promise<void>}
     */
    let passkeyConflictShown = false;
    async function handlePasskeyConflict(detailJSON) {
        let msg;
        try {
            msg = JSON.parse(detailJSON);
            Schema.validate(PasskeyConflictSchema, msg);
        } catch (err) {
            console.warn("[integration] rejected malformed passkey conflict:", err.message);
            return;
        }
        // one notice per frame lifetime is plenty, whatever happens later; the flag is
        // only consumed when a modal is actually about to be shown
        if (passkeyConflictShown) return;
        // only the top frame may raise UI
        if (window !== window.top) return;
        if (!(await configOK)) return;
        const cfg = await config;
        if (cfg.handlePasskeys === false) return;
        const hostname = window.location.hostname;
        const defersToBrowser = cfg.rules?.some((rule) => {
            if (rule.ignore || rule.class !== "browser-passkey") return false;
            try {
                return new RegExp(rule.pattern, "u").test(hostname);
            } catch (_err) {
                return false; // an invalid pattern cannot opt a site into anything
            }
        });
        if (defersToBrowser) return;
        const origin = window.location.origin;
        const stored = await chrome.storage.local.get("passkeyConflictDismissed");
        if (stored?.passkeyConflictDismissed?.[origin]) return;
        // only alert where the user holds Parcel passkeys for the site (rule-classed
        // passkey entries naming this origin's rpId); the host runs the same matching
        let candidates;
        try {
            ({ candidates } = await passkeyRequest({ action: "passkey", phase: "candidates", origin }));
        } catch (_err) {
            return; // background unavailable (or passkeys disabled); nothing to alert about
        }
        if (!Array.isArray(candidates) || candidates.length === 0) return;
        let token;
        try {
            token = crypto.randomUUID();
        } catch (_err) {
            token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        }
        passkeyBindings[token] = { conflict: true, reason: msg.reason, origin };
        passkeyConflictShown = true;
        // announce the popup token before the iframe connects, like a ceremony binding does
        authPort.postMessage(token);
        triggerPort.postMessage({ action: "trigger-popup", frameId, token, position: { centered: true }, mode: "passkey-conflict" });
    }

    /**
     * Drive the passkey conflict notice over a bridged popup port: supply the conflict
     * context, persist a per-origin dismissal, and close the modal when asked.
     * @since 1.0.4
     * @param {chrome.runtime.Port} port - The bridged popup connection.
     * @param {object} binding - The conflict state stored in `passkeyBindings` (`{conflict, reason, origin}`).
     * @param {string} token - The binding's key in `passkeyBindings`.
     * @returns {void}
     */
    function handlePasskeyConflictPort(port, binding, token) {
        let settled = false;
        const close = () => {
            if (settled) return;
            settled = true;
            delete passkeyBindings[token];
            try {
                port.disconnect();
            } catch (_err) {
                chrome.runtime.lastError; // consume the disconnect error
            }
            triggerPort.postMessage({ action: "close-popup" });
        };
        port.onDisconnect.addListener(() => {
            chrome.runtime.lastError; // consume the disconnect error
            if (Object.prototype.hasOwnProperty.call(passkeyBindings, token)) close();
        });
        port.onMessage.addListener(async (msg) => {
            try {
                if (msg?.action === "ready") {
                    maybePost(port, { action: "origin", origin: binding.origin });
                    maybePost(port, {
                        action: "passkey-conflict-context",
                        context: { origin: binding.origin, reason: binding.reason },
                    });
                } else if (msg?.action === "passkey-conflict-dismiss") {
                    const stored = await chrome.storage.local.get("passkeyConflictDismissed");
                    const dismissed =
                        stored?.passkeyConflictDismissed && typeof stored.passkeyConflictDismissed === "object"
                            ? stored.passkeyConflictDismissed
                            : {};
                    // delete-before-set keeps re-dismissals most-recent; string keys iterate oldest-first
                    delete dismissed[binding.origin];
                    dismissed[binding.origin] = true;
                    const origins = Object.keys(dismissed);
                    if (origins.length > PASSKEY_CONFLICT_DISMISSED_LIMIT) {
                        for (const oldOrigin of origins.slice(0, origins.length - PASSKEY_CONFLICT_DISMISSED_LIMIT)) {
                            delete dismissed[oldOrigin];
                        }
                    }
                    await chrome.storage.local.set({ passkeyConflictDismissed: dismissed });
                    close();
                } else if (msg?.action === "close") {
                    close();
                } else if (msg?.action === "resize") {
                    triggerPort.postMessage({ action: "resize-popup", height: msg.height, width: msg.width });
                }
            } catch (err) {
                console.warn("[integration] passkey conflict notice failed:", err);
                close();
            }
        });
    }

    /**
     * Drive a passkey consent ceremony over a bridged popup port: supply the ceremony context,
     * relay assert/create operations to the background worker, and settle the MAIN-world promise.
     * @since 1.0.4
     * @param {chrome.runtime.Port} port - The bridged popup connection.
     * @param {object} binding - The ceremony state stored in `passkeyBindings`.
     * @param {string} token - The binding's key in `passkeyBindings`.
     */
    function handlePasskeyPort(port, binding, token) {
        if (binding.conflict) return handlePasskeyConflictPort(port, binding, token);
        const respond = (payload) => passkeyRespond(binding.requestId, payload);
        let settled = false;
        // settle the ceremony: answer the MAIN world, drop the binding, and close the popup
        const finish = (payload = null) => {
            if (settled) return;
            settled = true;
            // track dismissals for the popup-spam guard; consented ceremonies clear it
            if (payload?.type === "response") {
                passkeyDismissStreak = 0;
            } else {
                passkeyDismissStreak += 1;
                passkeyLastDismissAt = Date.now();
            }
            if (payload) respond(payload);
            delete passkeyBindings[token];
            try {
                port.disconnect();
            } catch (_err) {
                chrome.runtime.lastError; // consume the disconnect error
            }
            triggerPort.postMessage({ action: "close-popup" });
        };
        port.onDisconnect.addListener(() => {
            chrome.runtime.lastError; // consume the disconnect error
            if (!Object.prototype.hasOwnProperty.call(passkeyBindings, token)) return; // already settled or superseded
            // the popup vanished mid-ceremony — never leave a minted credential or pending promise dangling
            finish({ type: "error", name: "NotAllowedError", message: "The passkey popup closed unexpectedly." });
        });
        port.onMessage.addListener(async (msg) => {
            try {
                if (msg?.action === "ready") {
                    maybePost(port, { action: "origin", origin: binding.origin });
                    maybePost(port, {
                        action: "passkey-context",
                        context: {
                            op: binding.op,
                            rpId: binding.rpId,
                            origin: binding.origin,
                            candidates: binding.candidates,
                            user: binding.op === "create" ? binding.options.user : null,
                            hintWarning: binding.hintWarning || { violated: [], nonCompliant: [] },
                        },
                    });
                } else if (msg?.action === "passkey-assert") {
                    const clientDataJSON = webauthn.buildClientDataJSON("webauthn.get", binding.options.challenge, binding.origin);
                    const { result } = await passkeyRequest({
                        action: "passkey",
                        phase: "assert",
                        rpId: binding.rpId,
                        origin: binding.origin,
                        path: msg.path,
                        clientDataJSON: webauthn.b64Encode(clientDataJSON),
                        allowCredentials: binding.options.allowCredentials?.map((c) => c.id),
                    });
                    finish({
                        type: "response",
                        credential: {
                            op: "get",
                            id: result.credentialId,
                            response: {
                                clientDataJSON: webauthn.b64urlEncode(clientDataJSON),
                                authenticatorData: b64StdToB64url(result.authenticatorData),
                                signature: b64StdToB64url(result.signature),
                                userHandle: result.userHandle || null,
                            },
                        },
                    });
                } else if (msg?.action === "passkey-create") {
                    const clientDataBytes = webauthn.buildClientDataJSON("webauthn.create", binding.options.challenge, binding.origin);
                    const { result } = await passkeyRequest({
                        action: "passkey",
                        phase: "create",
                        rpId: binding.rpId,
                        origin: binding.origin,
                        userHandle: binding.options.user?.id,
                        userName: binding.options.user?.name,
                        userDisplayName: binding.options.user?.displayName,
                        path: `${binding.passkeyDir}/${binding.rpId}/${slugifyPasskeyName(binding.options.user?.name)}.gpg`,
                    });
                    binding.createClientData = clientDataBytes;
                    binding.minted = result;
                    // present the encrypted entry for out-of-band saving; the ceremony completes only on ack
                    maybePost(port, {
                        action: "passkey-created",
                        path: result.path,
                        file: result.file,
                        armored: result.armored,
                        rpId: binding.rpId,
                    });
                } else if (msg?.action === "passkey-create-ack") {
                    if (!binding.minted) throw new Error("No credential has been created.");
                    const authData = await webauthn.buildAttestationAuthData(
                        binding.rpId,
                        webauthn.b64urlDecode(binding.minted.credentialId),
                        binding.minted.publicKey,
                    );
                    finish({
                        type: "response",
                        credential: {
                            op: "create",
                            id: binding.minted.credentialId,
                            response: {
                                clientDataJSON: webauthn.b64urlEncode(binding.createClientData),
                                authData: webauthn.b64urlEncode(authData),
                                spki: b64StdToB64url(binding.minted.spki),
                                attestationObject: webauthn.b64urlEncode(webauthn.buildAttestationObject(authData)),
                            },
                        },
                    });
                } else if (msg?.action === "passkey-cancel") {
                    finish({
                        type: "error",
                        name: "NotAllowedError",
                        message: binding.minted ? "The passkey creation was not completed." : "The passkey operation was cancelled.",
                    });
                } else if (msg?.action === "passkey-fallback") {
                    // after minting, a native fallback would mint a second credential for the site, so refuse instead
                    finish(
                        binding.minted
                            ? { type: "error", name: "NotAllowedError", message: "The passkey creation was not completed." }
                            : { type: "fallback" },
                    );
                } else if (msg?.action === "close") {
                    // popup dismissed without a terminal action — treat as user refusal
                    finish({ type: "error", name: "NotAllowedError", message: "The passkey operation was cancelled." });
                } else if (msg?.action === "resize") {
                    triggerPort.postMessage({ action: "resize-popup", height: msg.height, width: msg.width });
                }
            } catch (err) {
                console.warn("[integration] passkey ceremony failed:", err);
                finish({ type: "error", name: "NotAllowedError", message: err.message });
            }
        });
    }

    // bridge events from the MAIN-world interceptor; registered even when the context popup
    // is disabled, as the passkey ceremony popup is the only consent UI for WebAuthn calls
    document.addEventListener("parcel-webauthn-request", (ev) => handlePasskeyRequest(ev.detail));
    document.addEventListener("parcel-webauthn-abort", (ev) => handlePasskeyAbort(ev.detail));
    document.addEventListener("parcel-webauthn-conflict", (ev) => handlePasskeyConflict(ev.detail));
    // the MAIN-world interceptor runs at document_start too and may report a conflict
    // before this script has finished evaluating; pick up its marker if so
    const earlyConflict = document.documentElement?.getAttribute("data-parcel-webauthn-conflict");
    if (earlyConflict === "locked" || earlyConflict === "wrapped") {
        document.documentElement?.removeAttribute("data-parcel-webauthn-conflict");
        handlePasskeyConflict(JSON.stringify({ reason: earlyConflict }));
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
        if (port.name === "passkey") return; // one-shot background-worker exchange, never owned by this frame

        // passkey ceremony bindings are keyed by token, not by target element
        if (port.name !== "broadcast" && Object.prototype.hasOwnProperty.call(passkeyBindings, port.name)) {
            handlePasskeyPort(port, passkeyBindings[port.name], port.name);
            return;
        }

        // http-auth scrim popup: no target binding — only resize and close.
        // Handles both integration.js-created and executeScript-injected scrims.
        if (httpAuthTokens.has(port.name)) {
            httpAuthTokens.delete(port.name);
            port.onMessage.addListener((msg) => {
                const popup = document.querySelector(".parcel-popup");
                if (!popup) return;
                if (msg?.action === "resize") {
                    popup._resizeFn?.(msg.width, msg.height);
                } else if (msg?.action === "close" || msg?.action === "close-popup") {
                    if (msg.cancelNavigation) {
                        try {
                            window.stop();
                        } catch (_err) {
                            // window.stop can throw if the page is in a transitional state
                        }
                    }
                    removePopup(popup);
                }
            });
            port.onDisconnect.addListener(() => {
                chrome.runtime.lastError;
            });
            return;
        }

        if (!Object.prototype.hasOwnProperty.call(targetBindings, port.name) && port.name !== "broadcast") {
            maybePost(port, { action: "close" });
            port.disconnect();
            return;
        }
        if (!(await configOK)) {
            maybePost(port, { action: "error", error: "Parcel could not load its configuration — try reloading the page." });
            port.disconnect();
            return;
        }
        const updateStatus = (status) => maybePost(port, { action: "status", status });
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
                    maybePost(port, { action: "error", error: "Cannot find a suitable autofill target." });
                    port.disconnect();
                    return;
                }
            } else {
                throw new Error("Element binding is missing.");
            }
        }
        if (el._parcelToken !== port.name) {
            maybePost(port, { action: "error", error: "Invalid token." });
            port.disconnect();
            return;
        }
        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError;
            if (err) console.debug("[integration] popup port disconnected:", err.message);
            // Intentionally retain the binding (token, input-close listener, targetBindings entry)
            // so a transiently disconnected popup can reconnect; only the dead port reference is
            // cleared. Trade-off: an element abandoned without re-click is never GC'd from
            // targetBindings — a negligible one-entry leak since tokens are unique UUIDs.
            if (port.name !== "broadcast" && el._parcelPopupPort === port) delete el._parcelPopupPort;
        });
        try {
            await getTargetInfo(el);
        } catch (_err) {
            maybePost(port, { action: "error", error: "The selected autofill candidate was unsuitable." });
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
                maybePost(port, { action: "origin", origin: window.location.origin });
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
                maybePost(port, { action: "close" });
                triggerPort.postMessage({ action: "close-popup" });
            } else if (msg?.action === "fill") {
                // fill the target field, and related fields if configured
                try {
                    updateStatus("Filling values...");
                    if (!Object.prototype.hasOwnProperty.call(msg, "config")) throw new Error("Config is missing.");
                    if (!Object.prototype.hasOwnProperty.call(msg, "plaintext")) throw new Error("Plaintext is missing.");
                    if (Object.prototype.hasOwnProperty.call(msg, "origin") && msg.origin !== window.location.origin) {
                        throw new Error(
                            `Origin mismatch: refusing to fill a credential intended for ${msg.origin} into ${window.location.origin}.`,
                        );
                    }
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
                    maybePost(port, { action: "close" });
                    triggerPort.postMessage({ action: "close-popup" });

                    // try to focus the submit button
                    const submitTargets = (await validTargets).filter((t) => t.type === "submit");
                    let group;
                    const aggregationSelectors = (await targetSelectors).targetSelectors.filter((s) => s.type === "aggregate");
                    for (const s of aggregationSelectors) {
                        group = Helpers.shadowClosest(el, s.selector);
                        if (group) break;
                    }
                    if (group) {
                        for (const target of submitTargets) {
                            const submitButton = Helpers.shadowSelector(target.selector, group);
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
                    maybePost(port, { action: "error", error: err.message });
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

"use strict";

(async () => {
    const Helpers = (await import(chrome.runtime.getURL("/js/helpers.js"))).Helpers;
    const { Schema, SelectorSchema } = await import(chrome.runtime.getURL("/js/schema.js"));
    const { initPasskeys, passkeyRespond } = await import(chrome.runtime.getURL("/js/webauthn-integration.js"));
    const targetSelectors = import(chrome.runtime.getURL("/js/selectors.js"));
    const targetBindings = {};

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

    let frameId = 0;
    let frameFeatures = ["blacklist"];

    // Send a periodic keepalive message to the service worker so that MV3
    // doesn't suspend it during idle periods. Content scripts run in the tab's
    // process and are not subject to service worker suspension, so this timer
    // keeps firing as long as the tab is open. Each message resets the worker's
    // inactivity timer, which in turn keeps the native host ping interval alive.
    //
    // Only the top frame needs to send keepalives - integration.js runs with
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
        // clear any stale tab badge - a fresh document cannot hold the previous document's stash
        reportStashPresence(false);
        const keepalive = setInterval(() => {
            try {
                chrome.runtime.sendMessage({ type: "keepalive" }, () => void chrome.runtime.lastError);
            } catch (_err) {
                clearInterval(keepalive);
            }
        }, 25_000);
    }

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
                // Extension context invalidated - the content script is stale and
                // the page must be reloaded to get a fresh injection.
                rejectConfig(new Error("Extension context invalidated - please reload the page."));
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
                frameFeatures = Array.isArray(msg?.features) ? msg.features : ["blacklist"];
                broadcastFrameId(frameId);
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
     * URL-scope features applicable to this frame's URL, resolved with the config.
     * @since 1.0.8
     * @type {Promise<string[]>}
     */
    const features = config.then(() => frameFeatures);

    // Blacklisted URLs disable all in-page functionality: skip the expensive setup
    // entirely. The MAIN-world interceptor is never enabled here, so nothing should
    // emit parcel-webauthn-request; the fallback listener is kept defensively so a
    // stray emitter still gets browser deferral instead of a hang.
    if ((await configOK) && (await features).includes("blacklist")) {
        document.addEventListener("parcel-webauthn-request", (ev) => {
            try {
                const req = JSON.parse(ev.detail);
                passkeyRespond(req.requestId, { type: "fallback" });
            } catch (_err) {
                // malformed request; nothing to answer
            }
        });
        return;
    }

    const authPort = reconnectingPort("auth");
    window.addEventListener("pageshow", (ev) => {
        // re-establish connection to the auth port on bfcache restore
        if (ev.persisted) authPort.reconnect();
    });

    /**
     * Tell the root frame this frame's ID so its iframe mapping stays fresh for popup placement.
     * @since 1.0.8
     * @param {number} id - The frame ID to broadcast.
     * @returns {void}
     */
    function broadcastFrameId(id) {
        if (window === window.top) return;
        // Restrict the broadcast to the top-level origin so a cross-origin embedding page can't
        // observe it. ancestorOrigins exposes ancestor origins even cross-origin; fall back to "*"
        // in browsers that don't implement it.
        const ancestors = location.ancestorOrigins;
        const topOrigin = ancestors?.length ? ancestors.item(ancestors.length - 1) : "*";
        window.top.postMessage({ action: "parcel-frame-id", frameId: id }, topOrigin);
    }

    /**
     * Re-resolve `frameId` from the background worker; Chrome prerender
     * activation changes the ID after document_start (issue #163).
     * @since 1.0.8
     * @returns {Promise<number>} The (possibly unchanged) current frame ID.
     */
    async function resolveFrameId() {
        let port;
        try {
            port = chrome.runtime.connect({ name: "integration" });
        } catch (_err) {
            // Extension context invalidated - the stale content script cannot recover anyway.
            return frameId;
        }
        return new Promise((resolve) => {
            // keep the cached ID if the worker never answers this click-time query
            const timer = setTimeout(() => {
                port.disconnect();
                resolve(frameId);
            }, 1_000);
            port.onMessage.addListener((msg) => {
                if (msg?.action !== "frame-id") return;
                clearTimeout(timer);
                if (typeof msg.frameId === "number" && msg.frameId !== frameId) {
                    frameId = msg.frameId;
                    // refresh the root frame's iframe mapping for popup placement
                    broadcastFrameId(frameId);
                }
                port.disconnect();
                resolve(frameId);
            });
            port.onDisconnect.addListener(() => {
                chrome.runtime.lastError; // consume the disconnect error
                clearTimeout(timer);
                resolve(frameId);
            });
            port.postMessage({ action: "frame-id" });
        });
    }

    // Re-resolve immediately on prerender activation (issue #163); self-gating where prerendering is unsupported.
    if (document.prerendering) {
        document.addEventListener("prerenderingchange", () => resolveFrameId(), { once: true });
    }

    // Trigger the http-auth scrim popup from the background worker.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.action === "trigger-http-auth") {
            if (window !== window.top) return;
            httpAuthTokens.add(msg.token);
            triggerPopup(msg.token, 0, { centered: true }, "http-auth");
            sendResponse({ ok: true });
        } else if (msg?.action === "parcel-error-stash") {
            // Stash an error relayed by the background worker (top frame owns the stash); the
            // worker drives the tab badge from the presence report.
            if (window === window.top && typeof msg.error === "string" && msg.error) {
                // relayed stash write also follows latest-wins, overwriting any pending stash
                document._parcelError = msg.error;
                reportStashPresence(true);
            }
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
        // re-resolve the frame ID in case the restored frame was assigned a different ID
        if (ev.persisted) resolveFrameId();
        // re-assert the stashed-error badge for the restored document (top frame owns the stash)
        if (ev.persisted && window === window.top) reportStashPresence(Boolean(document._parcelError));
    });
    window.addEventListener("message", (ev) => {
        if (ev.data?.action === "parcel-frame-id" && typeof ev.source?.postMessage === "function") {
            const frameEl = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === ev.source);
            if (frameEl) frameEl._parcelFrameId = ev.data.frameId;
        }
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
                    // copy before decorating: entries live in the shared
                    // selectors registry and must not accumulate instance state
                    finalTarget = { ...target };

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
        if (typeof fillValue !== "string") throw new Error(`No value found for field type: ${type}`);

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

    /** Popup modes rendered as a centred card over a fullscreen scrim that fades in and out. */
    const SCRIM_MODES = new Set(["passkey", "passkey-conflict", "http-auth"]);

    /** Gap between the target element and the context popup, in pixels. */
    const POPUP_ANCHOR_GAP = 5;

    /**
     * Total border height of the context-popup host (1px top + 1px bottom): the host div is
     * content-box, so the border-box height measured for placement checks exceeds its style
     * height by this much.
     */
    const POPUP_BORDER_HEIGHT = 2;

    /**
     * Minimum context-popup height when resized to fit the space around its target; below this
     * the popup is centred instead of being anchored.
     */
    const MIN_POPUP_HEIGHT = 200;

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
     *
     * Too-tall context popups are resized down to a minimum height to fit beside the target,
     * or shown via the centred flow when neither side fits.
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

        // inner-height constraint currently applied to the popup content, or null when unconstrained
        let heightConstraint = null;

        /**
         * Clamp the popup content height so it scrolls internally instead of overflowing the
         * space around its target; null releases a prior constraint.
         * @since 1.0.7
         * @param {number|null} maxHeight - Maximum content height in pixels, or null to release.
         * @returns {void}
         */
        const constrainInnerHeight = (maxHeight) => {
            try {
                frame.contentWindow?.postMessage(
                    { source: "parcel-integration", action: "constrain-height", token, maxHeight },
                    new URL(chrome.runtime.getURL("/")).origin,
                );
            } catch (_err) {
                // The frame is not navigable yet (or is already gone); the next resize report retries.
            }
        };

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
                // Re-apply: the centring fallback may have run before the iframe loaded, dropping its message.
                if (heightConstraint !== null) constrainInnerHeight(heightConstraint);
                popup.style.top = `${window.scrollY + Math.max(0, (window.innerHeight - rect.height) / 2)}px`;
                popup.style.left = `${window.scrollX + Math.max(0, (window.innerWidth - rect.width) / 2)}px`;
                return;
            }

            // Border-box capacities either side of the target, in viewport coordinates
            // (position.top/bottom are document coordinates; x/y are viewport-relative).
            const spaceBelow = window.innerHeight - (position.bottom - window.scrollY) - POPUP_ANCHOR_GAP;
            const spaceAbove = position.top - window.scrollY - POPUP_ANCHOR_GAP;
            if (rect.height <= spaceBelow || rect.height <= spaceAbove) {
                if (heightConstraint !== null && rect.height < heightConstraint) {
                    // The content has shrunk below the constraint - release it so it can grow again.
                    heightConstraint = null;
                    constrainInnerHeight(null);
                }
                if (rect.height <= spaceBelow) popup.style.top = `${position.bottom + POPUP_ANCHOR_GAP}px`;
                else popup.style.top = `${position.top - rect.height - POPUP_ANCHOR_GAP}px`;
            } else if (Math.max(spaceAbove, spaceBelow) >= MIN_POPUP_HEIGHT) {
                // Too tall for both sides: clamp to whichever side has more space; the
                // popup's follow-up size report confirms the clamped height.
                const useSpaceBelow = spaceBelow >= spaceAbove;
                const space = useSpaceBelow ? spaceBelow : spaceAbove;
                heightConstraint = space - POPUP_BORDER_HEIGHT;
                constrainInnerHeight(heightConstraint);
                popup.style.height = `${heightConstraint}px`;
                popup.style.top = useSpaceBelow
                    ? `${position.bottom + POPUP_ANCHOR_GAP}px`
                    : `${position.top - heightConstraint - POPUP_BORDER_HEIGHT - POPUP_ANCHOR_GAP}px`;
            } else {
                // Fits neither side even at the minimum height: stop anchoring to the target
                // for this and all later resizes, and show it via the centred flow instead.
                position = { centered: true };
                heightConstraint = Math.max(MIN_POPUP_HEIGHT, window.innerHeight - 2 * POPUP_ANCHOR_GAP - POPUP_BORDER_HEIGHT);
                constrainInnerHeight(heightConstraint);
                popup.style.height = `${heightConstraint}px`;
                popup.style.top = `${window.scrollY + Math.max(0, (window.innerHeight - (heightConstraint + POPUP_BORDER_HEIGHT)) / 2)}px`;
                popup.style.left = `${window.scrollX + Math.max(0, (window.innerWidth - rect.width) / 2)}px`;
                return;
            }
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
        await resolveFrameId(); // refresh: prerender activation can swap frame IDs (issue #163)

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

    if ((await configOK) && !(await config).disableContextPopup && (await features).includes("context")) {
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
     * Error messages that cannot be delivered are stashed in the top frame
     * (see {@link reportStashedError}) so the next popup can display them.
     * @since 1.0.2
     * @param {chrome.runtime.Port} port - The port (may be disconnected).
     * @param {any} msg - The message to post.
     * @param {object} [opts] - `stashOnFailure` (default `true`) for error messages; set `false` to keep the post from re-stashing a display-prefixed error.
     * @returns {boolean} `true` when the message was posted, `false` when the post failed.
     */
    function maybePost(port, msg, { stashOnFailure = true } = {}) {
        try {
            port.postMessage(msg);
            return true;
        } catch (_err) {
            const err = chrome.runtime.lastError;
            if (err) console.debug("[integration] maybePost failed:", err.message);
            if (stashOnFailure && msg?.action === "error" && typeof msg.error === "string" && msg.error) {
                console.warn("[integration] error could not be delivered to the popup; stashed:", msg.error);
                if (window === window.top) {
                    // the top frame owns the stash - store it directly; the newest error wins, deliberately overwriting any pending stash
                    document._parcelError = msg.error;
                    reportStashPresence(true);
                } else {
                    // a frame cannot write another frame's document — relay through the worker
                    reportStashedError(msg.error);
                }
            }
            return false;
        }
    }

    /**
     * Relay a popup error that could not be delivered (via a non-top frame, which
     * cannot write the top frame's document) to the background worker, which
     * instructs the top frame to stash it on `document._parcelError` until the
     * next popup displays it.
     * @since 1.0.7
     * @param {string} error - The undelivered error message.
     * @returns {void}
     */
    function reportStashedError(error) {
        try {
            chrome.runtime.sendMessage({ type: "parcel-error-stash", error }, () => void chrome.runtime.lastError);
        } catch (_err) {
            // Extension context invalidated — nothing can be stashed or badged
        }
    }

    /**
     * Report the current stash state to the background worker so the tab badge
     * matches the presence of a stashed error on `document._parcelError`.
     * @since 1.0.7
     * @param {boolean} present - Whether a stashed error is present.
     * @returns {void}
     */
    function reportStashPresence(present) {
        try {
            chrome.runtime.sendMessage({ type: "parcel-error-stash", stashed: present }, () => void chrome.runtime.lastError);
        } catch (_err) {
            // Extension context invalidated — the badge cannot be updated
        }
    }

    const passkeys = initPasskeys({ config, configOK, features, authPort, triggerPort, resolveFrameId, maybePost });

    /**
     * Get the distinct rule classes of fillable targets present in the current frame.
     * @since 1.0.7
     * @returns {Promise<string[]>} The distinct target classes present on the page.
     */
    // Uses shadowSelector (first match only) rather than shadowSelectorAll for
    // performance with the large selector set. If the first matching field is hidden,
    // the class won't be reported — an accepted trade-off for popup responsiveness.
    async function getPageTargetClasses() {
        const targetDefs = (await config).targets.concat((await config).additionalTargets || []);
        const classes = new Set();
        for (const selector of (await validTargets).filter((t) => !t.relatedOnly)) {
            const cls = targetDefs.find((t) => t.name === selector.type)?.class || "login";
            if (classes.has(cls)) continue;
            const el = Helpers.shadowSelector(selector.selector);
            if (!el?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
            classes.add(cls);
        }
        return [...classes];
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
        // worker-bound connects never fire this listener in a real browser; the harness's flat onConnect delivers them
        if (port.name === "auth" || port.name === "integration") return;

        // passkey ceremony popup ports are claimed by the webauthn-integration module
        if (passkeys.handlePasskeyConnect(port)) return;

        // http-auth scrim popup: no target binding - only the ready handshake, resize, and close.
        // Handles both integration.js-created and executeScript-injected scrims.
        if (httpAuthTokens.has(port.name)) {
            httpAuthTokens.delete(port.name);
            port.onMessage.addListener(async (msg) => {
                if (msg?.action === "ready") {
                    maybePost(port, { action: "origin", origin: window.location.origin, features: await features });
                    return;
                }
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
        } catch (err) {
            maybePost(port, { action: "error", error: `The best-match autofill candidate was unsuitable: ${err.message}` });
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
                // push an error stashed from an earlier, undeliverable popup response (top frame owns the stash)
                if (window === window.top && typeof document._parcelError === "string" && document._parcelError) {
                    const delivered = maybePost(
                        port,
                        { action: "error", error: `An earlier error occurred: ${document._parcelError}` },
                        { stashOnFailure: false },
                    );
                    if (delivered) {
                        delete document._parcelError;
                        reportStashPresence(false);
                    }
                    // undelivered — the stash and badge stay for the next popup open
                }
                maybePost(port, {
                    action: "origin",
                    origin: window.location.origin,
                    features: await features,
                    targetClasses: port.name === "broadcast" ? await getPageTargetClasses() : undefined,
                });
            } else if (msg?.action === "focus-target") {
                el.focus();
            } else if (msg?.action === "focus-suspend") {
                el._parcelFocusSuspended = true;
            } else if (msg?.action === "focus-resume") {
                delete el._parcelFocusSuspended;
            } else if (msg?.action === "fill-value") {
                if (!(await features).includes("fill")) {
                    maybePost(port, { action: "error", error: "Filling is disabled on this page." });
                    return;
                }
                // ack before touching the DOM so the popup can confirm delivery of one-shot fills
                maybePost(port, { action: "ack", ack: "fill-value" });
                // Fill the target field with the selected value
                updateStatus("Filling value...");
                await fillBoundField(null, null, null, msg.value);
                cleanupInlineTarget(el, port);
                maybePost(port, { action: "close" });
                triggerPort.postMessage({ action: "close-popup" });
            } else if (msg?.action === "fill") {
                if (!(await features).includes("fill")) {
                    maybePost(port, { action: "error", error: "Filling is disabled on this page." });
                    return;
                }
                // ack before payload validation so the popup can distinguish a dead pipe from a fill error
                maybePost(port, { action: "ack", ack: "fill" });
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

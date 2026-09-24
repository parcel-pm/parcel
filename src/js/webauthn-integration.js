/**
 * Passkey (WebAuthn) ceremony support for the Parcel content script.
 *
 * The MAIN-world interceptor in js/main-world/webauthn.js relays
 * navigator.credentials.create()/get() calls here via DOM CustomEvents; the user
 * consents via a centred inline popup and the background worker performs the
 * crypto via the native host.
 *
 * This module is loaded by integration.js, which supplies its dependencies via
 * {@link initPasskeys}; the pure protocol building blocks live in webauthn.js.
 *
 * @module webauthn-integration
 * @since 1.0.8
 */

import { Schema, PasskeyRequestSchema, PasskeyAbortSchema, PasskeyConflictSchema } from "./schema.js";
import * as webauthn from "./webauthn.js";

/** Ceremony bindings keyed by popup token (set by {@link initPasskeys} handlers). */
const passkeyBindings = {};
// state for the popup-spam guard (see PASSKEY_DISMISS_THRESHOLD)
let passkeyDismissStreak = 0;
let passkeyLastDismissAt = 0;

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

// Dependencies supplied by integration.js via initPasskeys.
let config;
let configOK;
let features;
let authPort;
let triggerPort;
let resolveFrameId;
let maybePost;

/**
 * Send a response back to the MAIN-world WebAuthn interceptor.
 * @since 1.0.4
 * @param {string} requestId - The request ID from the interceptor.
 * @param {object} payload - The response payload (`{type, ...}`).
 */
export function passkeyRespond(requestId, payload) {
    document.dispatchEvent(new CustomEvent("parcel-webauthn-response", { detail: JSON.stringify({ requestId, ...payload }) }));
}

/**
 * Perform a one-shot request/response exchange with the background worker on a fresh "passkey" port.
 * @since 1.0.4
 * @param {object} msg - The message to send (`{action: "passkey", phase, ...}`).
 * @returns {Promise<object>} The worker's reply: `{rpId, candidates, topOrigin}` for a candidates phase, `{result}` otherwise.
 * @throws {Error} If the worker reports an error, disconnects, or the exchange times out.
 */
async function passkeyRequest(msg) {
    const timeout = (await config).decryptTimeout * 1000 + 5000;
    return new Promise((resolve, reject) => {
        let port;
        try {
            port = chrome.runtime.connect({ name: "passkey" });
        } catch (_err) {
            reject(new Error("Extension context invalidated - please reload the page."));
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
                settle(resolve, { rpId: response.rpId, candidates: response.candidates, topOrigin: response.topOrigin });
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
        .replace(/[^a-z0-9._@-]+/g, "-")
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
 * Determine the origin of the top-level frame, or null when it cannot be read.
 * @since 1.0.7
 * @returns {string|null} The top-level origin, or null when it cannot be determined.
 */
function getTopOrigin() {
    try {
        if (window === window.top) return location.origin;
        const ancestors = location.ancestorOrigins; // Chromium only
        if (ancestors?.length) return ancestors.item(ancestors.length - 1);
        return window.top.location.origin; // same-origin embeds only; throws cross-origin
    } catch (_err) {
        return null;
    }
}

/**
 * Whether this frame's origin matches every ancestor origin.
 * @since 1.0.7
 * @returns {boolean} False when any ancestor frame is cross-origin.
 */
function sameOriginWithAncestors(origin) {
    try {
        let w = window;
        while (w !== w.top) {
            if (w.parent.location.origin !== origin) return false;
            w = w.parent;
        }
        return true;
    } catch (_err) {
        return false; // opaque ancestor: the location read throws cross-origin
    }
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
            // without a config we cannot make passkey decisions - defer to the browser
            console.debug("[integration] deferring passkey to browser: config unavailable");
            respond({ type: "fallback" });
            return;
        }
        if ((await config).handlePasskeys === false) {
            console.debug("[integration] deferring passkey to browser: handlePasskeys is disabled");
            respond({ type: "fallback" });
            return;
        }
        if (!(await features).includes("passkey")) {
            console.debug("[integration] deferring passkey to browser: passkey not in scope for this URL");
            respond({ type: "fallback" });
            return;
        }
        const origin = window.location.origin;
        const crossOrigin = window !== window.top && !sameOriginWithAncestors(origin);
        let topOrigin = getTopOrigin();
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
        const reply = await passkeyRequest({
            action: "passkey",
            phase: "candidates",
            origin,
            rpId,
            // Firefox embeds cannot self-determine the top origin; the worker reads it from the tab's top-level URL
            needTopOrigin: crossOrigin && topOrigin === null,
        });
        if (reply.fallback) {
            // the site opted into browser passkeys via a browser-passkey rule
            console.debug(`[integration] deferring passkey to browser: browser-passkey rule matched for rpId ${rpId}`);
            respond({ type: "fallback" });
            return;
        }
        const { rpId: validRpId, candidates } = reply;
        if (crossOrigin && topOrigin === null && typeof reply.topOrigin === "string") topOrigin = reply.topOrigin;

        if (req.op === "get" && candidates.length === 0) {
            // nothing stored for this relying party - silently hand the call back to the browser
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
        const binding = {
            requestId: req.requestId,
            op: req.op,
            origin,
            crossOrigin,
            topOrigin,
            rpId: validRpId,
            options: req.options,
            candidates,
            passkeyDir: (await config).passkeyDir,
            hintWarning: violatedPasskeyHints(req.options.hints),
            minted: null,
        };
        passkeyBindings[token] = binding;
        const resolvedFrameId = await resolveFrameId(); // refresh: prerender activation can swap frame IDs (issue #163)
        if (passkeyBindings[token] !== binding) return; // aborted or superseded while refreshing
        authPort.postMessage(token);
        triggerPort.postMessage({
            action: "trigger-popup",
            frameId: resolvedFrameId,
            token,
            position: { centered: true },
            mode: "passkey",
        });
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
 * are not alerted on - an explicit choice is not a conflict.
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
    if (!(await features).includes("passkey")) return;
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
    const binding = { conflict: true, reason: msg.reason, origin };
    passkeyBindings[token] = binding;
    passkeyConflictShown = true;
    // announce the popup token before the iframe connects, like a ceremony binding does
    const resolvedFrameId = await resolveFrameId(); // refresh: prerender activation can swap frame IDs (issue #163)
    if (passkeyBindings[token] !== binding) return; // superseded while refreshing
    authPort.postMessage(token);
    triggerPort.postMessage({
        action: "trigger-popup",
        frameId: resolvedFrameId,
        token,
        position: { centered: true },
        mode: "passkey-conflict",
    });
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
 *
 * Note that passkey user consent lives here, *not* in the background worker.
 * Note also that as passkeys do not have an associated clicked field, they do not carry an 'auth'
 * correlation ID when launching the popup, which is ultimately triggered by the WebAuthn API intercept.
 *
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
        // the popup vanished mid-ceremony - never leave a minted credential or pending promise dangling
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
                const clientDataJSON = webauthn.buildClientDataJSON(
                    "webauthn.get",
                    binding.options.challenge,
                    binding.origin,
                    binding.crossOrigin,
                    binding.topOrigin,
                );
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
                const clientDataBytes = webauthn.buildClientDataJSON(
                    "webauthn.create",
                    binding.options.challenge,
                    binding.origin,
                    binding.crossOrigin,
                    binding.topOrigin,
                );
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
                // popup dismissed without a terminal action - treat as user refusal
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

/**
 * Wire the passkey/WebAuthn ceremony support into the content script: register the
 * MAIN-world event bridge, process an early conflict marker, dispatch the
 * interceptor-enable event when passkeys are enabled and in scope, and return the
 * popup-port dispatch hook for the caller's onConnect listener.
 * @since 1.0.8
 * @param {object} deps - The content-script dependencies.
 * @param {Promise<object>} deps.config - Resolves to the current parcel config.
 * @param {Promise<boolean>} deps.configOK - Resolves to whether the config loaded.
 * @param {Promise<string[]>} deps.features - Resolves to this frame's URL-scope features.
 * @param {{postMessage: (msg: any) => boolean, reconnect: () => void}} deps.authPort - The reconnecting "auth" port.
 * @param {{postMessage: (msg: any) => boolean, reconnect: () => void}} deps.triggerPort - The reconnecting "trigger" port.
 * @param {() => Promise<number>} deps.resolveFrameId - Re-resolves the current frame ID.
 * @param {(port: chrome.runtime.Port, msg: any, opts?: object) => boolean} deps.maybePost - Dead-port-safe postMessage.
 * @returns {{handlePasskeyConnect: (port: chrome.runtime.Port) => boolean}} `handlePasskeyConnect` returns true when it claimed the port.
 */
export function initPasskeys({
    config: cfg,
    configOK: ok,
    features: feats,
    authPort: ap,
    triggerPort: tp,
    resolveFrameId: rfi,
    maybePost: mp,
}) {
    config = cfg;
    configOK = ok;
    features = feats;
    authPort = ap;
    triggerPort = tp;
    resolveFrameId = rfi;
    maybePost = mp;

    // bridge events from the MAIN-world interceptor; registered even when the context popup
    // is disabled, as the passkey ceremony popup is the only consent UI for WebAuthn calls
    document.addEventListener("parcel-webauthn-request", (ev) => handlePasskeyRequest(ev.detail));
    document.addEventListener("parcel-webauthn-abort", (ev) => handlePasskeyAbort(ev.detail));
    document.addEventListener("parcel-webauthn-conflict", (ev) => handlePasskeyConflict(ev.detail));
    // vestigial: conflicts are now only reported at enable time (after these
    // listeners exist), but keep the marker pickup in case of unusual ordering
    const earlyConflict = document.documentElement?.getAttribute("data-parcel-webauthn-conflict");
    if (earlyConflict === "locked" || earlyConflict === "wrapped") {
        document.documentElement?.removeAttribute("data-parcel-webauthn-conflict");
        handlePasskeyConflict(JSON.stringify({ reason: earlyConflict }));
    }

    // Wake the inert MAIN-world interceptor only when passkeys are enabled
    // globally and in scope for this frame's URL; otherwise
    // navigator.credentials stays untouched so other password managers get
    // uncontended access to the API.
    (async () => {
        if ((await configOK) && (await config).handlePasskeys && (await features).includes("passkey")) {
            document.dispatchEvent(new CustomEvent("parcel-webauthn-enable"));
        }
    })();

    /**
     * Claim popup ports whose name matches a passkey ceremony binding token.
     * @since 1.0.8
     * @param {chrome.runtime.Port} port - The incoming popup connection.
     * @returns {boolean} True when the port was claimed and bound to a ceremony.
     */
    const handlePasskeyConnect = (port) => {
        // passkey ceremony bindings are keyed by token, not by target element
        if (port.name === "broadcast" || !Object.prototype.hasOwnProperty.call(passkeyBindings, port.name)) return false;
        handlePasskeyPort(port, passkeyBindings[port.name], port.name);
        return true;
    };
    return { handlePasskeyConnect };
}

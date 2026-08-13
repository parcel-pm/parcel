/**
 * Parcel passkey (WebAuthn) interceptor - MAIN world content script.
 *
 * Overrides navigator.credentials.create/get so that passkey ceremonies can be
 * served from the user's password store. Unsuitable requests are passed
 * through to the browser's native implementation unchanged.
 *
 * This is a classic script (like shadow.js): it must not use imports, and any
 * data crossing to/from integration.js travels as JSON strings inside
 * CustomEvent details (portable across Chrome and Firefox world isolation).
 * Some helpers (e.g. base64url codecs) are therefore duplicated deliberately
 * from the ES-module source in src/js/webauthn.js.
 *
 * @since 1.0.4
 */
/* global PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse */
(function () {
    "use strict";

    if (!("credentials" in navigator) || typeof PublicKeyCredential === "undefined") {
        return;
    }
    if (navigator.credentials.__parcelWrapped || navigator.credentials.__parcelConflict) {
        return; // already resolved one way or the other (e.g. duplicate injection)
    }

    // raw references are kept so a failed installation can be rolled back
    // exactly; the bound copies are the call targets used by the wrappers.
    const rawCreate = navigator.credentials.create;
    const rawGet = navigator.credentials.get;
    const nativeCreate = rawCreate.bind(navigator.credentials);
    const nativeGet = rawGet.bind(navigator.credentials);
    const pending = new Map();
    let requestCounter = 0;
    // hints only feed the consent-popup warning about transports Parcel cannot
    // satisfy, so a page must not be able to push an unbounded list across the
    // bridge; anything past this cap is dropped before serialisation
    const MAX_PASSKEY_HINTS = 16;

    /**
     * Encode bytes as base64url (no padding).
     *
     * Uint8Array only (no ArrayBuffer handling) — the near-duplicate in
     * src/js/webauthn.js also accepts ArrayBuffer for crypto.subtle.digest
     * callers.
     *
     * @param {Uint8Array} bytes - input bytes
     * @returns {string} base64url-encoded string
     */
    function b64urlEncode(bytes) {
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    /**
     * Decode a base64url string to an ArrayBuffer.
     *
     * Returns ArrayBuffer (not Uint8Array) because the WebAuthn credential
     * fields built here require BufferSource values — the near-duplicate in
     * src/js/webauthn.js returns Uint8Array for callers that need typed-array
     * access.
     *
     * @param {string} str - base64url-encoded string
     * @returns {ArrayBuffer} decoded bytes
     */
    function b64urlDecode(str) {
        const binary = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    /**
     * Serialise create options to a JSON-safe bridge representation.
     *
     * @param {PublicKeyCredentialCreationOptions} pk - publicKey options
     * @returns {Object} JSON-safe options
     */
    function serializeCreate(pk) {
        const out = {
            challenge: b64urlEncode(new Uint8Array(pk.challenge)),
            rp: { name: (pk.rp && pk.rp.name) || "", id: pk.rp && pk.rp.id },
            user: {
                id: b64urlEncode(new Uint8Array(pk.user.id)),
                name: pk.user.name || "",
                displayName: pk.user.displayName || "",
            },
            pubKeyCredParams: (pk.pubKeyCredParams || []).map(function (p) {
                return { type: p.type, alg: p.alg };
            }),
            timeout: pk.timeout,
            attestation: pk.attestation || "none",
            hints: serializeHints(pk.hints),
        };
        if (pk.authenticatorSelection) {
            out.authenticatorSelection = {
                authenticatorAttachment: pk.authenticatorSelection.authenticatorAttachment,
                residentKey: pk.authenticatorSelection.residentKey,
                requireResidentKey: pk.authenticatorSelection.requireResidentKey,
                userVerification: pk.authenticatorSelection.userVerification,
            };
        }
        if (pk.excludeCredentials) {
            out.excludeCredentials = pk.excludeCredentials.map(function (c) {
                return { type: c.type, id: b64urlEncode(new Uint8Array(c.id)), transports: c.transports };
            });
        }
        return out;
    }

    /**
     * Serialise get options to a JSON-safe bridge representation.
     *
     * @param {PublicKeyCredentialRequestOptions} pk - publicKey options
     * @returns {Object} JSON-safe options
     */
    function serializeGet(pk) {
        const out = {
            challenge: b64urlEncode(new Uint8Array(pk.challenge)),
            rpId: pk.rpId,
            timeout: pk.timeout,
            userVerification: pk.userVerification,
            hints: serializeHints(pk.hints),
        };
        if (pk.allowCredentials) {
            out.allowCredentials = pk.allowCredentials.map(function (c) {
                return { type: c.type, id: b64urlEncode(new Uint8Array(c.id)), transports: c.transports };
            });
        }
        return out;
    }

    /**
     * Serialise RP-supplied passkey hints, capping the count.
     *
     * Parcel installs its wrappers ahead of the browser's WebIDL coercion, so
     * pk.hints is a raw page-controlled value and may be a string, an object,
     * or a huge array; anything other than an array is dropped entirely.
     *
     * @param {*} hints - page-supplied pk.hints value
     * @returns {Array} at most MAX_PASSKEY_HINTS entries, or an empty list
     */
    function serializeHints(hints) {
        return Array.isArray(hints) ? hints.slice(0, MAX_PASSKEY_HINTS) : [];
    }

    /**
     * Build a duck-typed PublicKeyCredential from bridge response data.
     *
     * @param {Object} data - {op, id, response:{...base64url fields, authData, spki}}
     * @returns {PublicKeyCredential} credential object
     */
    function makeCredential(data) {
        const id = data.id;
        const rawId = b64urlDecode(id);
        let response;
        let userHandle = null;
        // function scope so the toJSON() closure below can serialise them
        let authData = null;
        let spki = null;
        if (data.op === "create") {
            authData = b64urlDecode(data.response.authData);
            spki = b64urlDecode(data.response.spki);
            response = {
                clientDataJSON: b64urlDecode(data.response.clientDataJSON),
                attestationObject: b64urlDecode(data.response.attestationObject),
                getAuthenticatorData: function () {
                    return authData;
                },
                getPublicKey: function () {
                    return spki;
                },
                getPublicKeyAlgorithm: function () {
                    return -7;
                },
                getTransports: function () {
                    return ["internal"];
                },
            };
            Object.setPrototypeOf(response, AuthenticatorAttestationResponse.prototype);
        } else {
            userHandle = data.response.userHandle ? b64urlDecode(data.response.userHandle) : null;
            response = {
                clientDataJSON: b64urlDecode(data.response.clientDataJSON),
                authenticatorData: b64urlDecode(data.response.authenticatorData),
                signature: b64urlDecode(data.response.signature),
                userHandle: userHandle,
            };
            Object.setPrototypeOf(response, AuthenticatorAssertionResponse.prototype);
        }
        const cred = {
            id: id,
            rawId: rawId,
            type: "public-key",
            authenticatorAttachment: "platform",
            response: response,
            getClientExtensionResults: function () {
                return {};
            },
            toJSON: function () {
                const json = {
                    type: "public-key",
                    id: id,
                    rawId: b64urlEncode(new Uint8Array(rawId)),
                    authenticatorAttachment: "platform",
                    clientExtensionResults: {},
                    response: {
                        clientDataJSON: b64urlEncode(new Uint8Array(response.clientDataJSON)),
                    },
                };
                if (data.op === "create") {
                    json.response.attestationObject = b64urlEncode(new Uint8Array(response.attestationObject));
                    json.response.transports = ["internal"];
                    json.response.publicKey = b64urlEncode(new Uint8Array(spki));
                    json.response.publicKeyAlgorithm = -7;
                    json.response.authenticatorData = b64urlEncode(new Uint8Array(authData));
                } else {
                    json.response.authenticatorData = b64urlEncode(new Uint8Array(response.authenticatorData));
                    json.response.signature = b64urlEncode(new Uint8Array(response.signature));
                    json.response.userHandle = userHandle ? b64urlEncode(new Uint8Array(userHandle)) : null;
                }
                return json;
            },
        };
        Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
        return cred;
    }

    /**
     * Relay a ceremony request through the integration script.
     *
     * @param {string} op - "create" or "get"
     * @param {Object} options - serialised publicKey options
     * @param {number|undefined} timeout - ceremony timeout in ms
     * @param {AbortSignal|undefined} signal - caller-supplied abort signal
     * @param {Function} nativeFn - native implementation for fallback
     * @param {Object} nativeOptions - original unmodified options for fallback
     * @returns {Promise<PublicKeyCredential>} the credential
     */
    function parcelRequest(op, options, timeout, signal, nativeFn, nativeOptions) {
        return new Promise(function (resolve, reject) {
            if (signal && signal.aborted) {
                reject(new DOMException("The operation was aborted.", "AbortError"));
                return;
            }
            const requestId = "pw" + ++requestCounter + Date.now().toString(36);
            let timer = null;
            let abortFn = function () {};

            const finish = function (fn) {
                if (!pending.has(requestId)) {
                    return; // already settled
                }
                pending.delete(requestId);
                if (timer !== null) {
                    clearTimeout(timer);
                }
                if (signal) {
                    signal.removeEventListener("abort", abortFn);
                }
                fn();
            };

            abortFn = function () {
                finish(function () {
                    document.dispatchEvent(
                        new CustomEvent("parcel-webauthn-abort", {
                            detail: JSON.stringify({ requestId: requestId }),
                        }),
                    );
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                });
            };

            pending.set(requestId, {
                op: op,
                resolve: function (data) {
                    finish(function () {
                        try {
                            resolve(makeCredential(data));
                        } catch (e) {
                            reject(e);
                        }
                    });
                },
                reject: function (name, message) {
                    finish(function () {
                        reject(new DOMException(message || "The operation failed.", name || "NotAllowedError"));
                    });
                },
                fallback: function () {
                    finish(function () {
                        nativeFn(nativeOptions).then(resolve, reject);
                    });
                },
            });

            if (timeout) {
                timer = setTimeout(function () {
                    finish(function () {
                        document.dispatchEvent(
                            new CustomEvent("parcel-webauthn-abort", {
                                detail: JSON.stringify({ requestId: requestId }),
                            }),
                        );
                        reject(new DOMException("The operation timed out.", "NotAllowedError"));
                    });
                }, timeout);
            }
            if (signal) {
                signal.addEventListener("abort", abortFn);
            }

            document.dispatchEvent(
                new CustomEvent("parcel-webauthn-request", {
                    detail: JSON.stringify({
                        requestId: requestId,
                        op: op,
                        options: options,
                    }),
                }),
            );
        });
    }

    /**
     * Fast gate: allow top/same-origin frames, or cross-origin iframes whose
     * hostname matches or is a subdomain of rpId. Authoritative rpId validation
     * happens later in the background worker.
     *
     * @param {string} [rpId] - The relying-party ID from the ceremony options.
     * @returns {boolean} true if Parcel may handle ceremonies here
     */
    function mayHandleHere(rpId) {
        if (!window.isSecureContext) {
            return false;
        }
        try {
            if (window.top.location.origin === window.location.origin) return true;
        } catch {
            // cross-origin iframe — fall through to rpId check below
        }
        // Defensive defaults: without an rpId, only the top / same-origin path applies.
        // Lowercased because domain comparison is case-insensitive (URL.hostname already
        // returns lowercase, and the background worker normalises rpId the same way)
        const effectiveRpId = (rpId || window.location.hostname).toLowerCase();
        const host = window.location.hostname;
        return host === effectiveRpId || host.endsWith("." + effectiveRpId);
    }

    /**
     * navigator.credentials.create override.
     *
     * @param {CredentialCreationOptions} options - creation options
     * @returns {Promise<Credential>} the credential
     */
    function create(options) {
        const pk = options && options.publicKey;
        if (!pk) {
            console.debug("Parcel passkeys: deferring create() to browser: no publicKey options");
            return nativeCreate(options);
        }
        if (!mayHandleHere(pk.rp && pk.rp.id)) {
            console.debug("Parcel passkeys: deferring create() to browser: frame not eligible for Parcel passkeys");
            return nativeCreate(options);
        }
        // only ES256 platform credentials can be served from the password store
        const supportsES256 = (pk.pubKeyCredParams || []).some(function (p) {
            return p.type === "public-key" && p.alg === -7;
        });
        if (!supportsES256) {
            console.debug("Parcel passkeys: deferring create() to browser: no ES256 (-7) in pubKeyCredParams");
            return nativeCreate(options);
        }
        if (pk.authenticatorSelection && pk.authenticatorSelection.authenticatorAttachment === "cross-platform") {
            console.debug("Parcel passkeys: deferring create() to browser: authenticatorAttachment is cross-platform");
            return nativeCreate(options);
        }
        return parcelRequest("create", serializeCreate(pk), pk.timeout, options.signal, nativeCreate, options);
    }

    /**
     * navigator.credentials.get override.
     *
     * @param {CredentialRequestOptions} options - request options
     * @returns {Promise<Credential>} the credential
     */
    function get(options) {
        const pk = options && options.publicKey;
        if (!pk) {
            console.debug("Parcel passkeys: deferring get() to browser: no publicKey options");
            return nativeGet(options);
        }
        if (!mayHandleHere(pk.rpId)) {
            console.debug("Parcel passkeys: deferring get() to browser: frame not eligible for Parcel passkeys");
            return nativeGet(options);
        }
        if (options.mediation === "conditional") {
            console.debug("Parcel passkeys: deferring get() to browser: conditional mediation (autofill UI)");
            return nativeGet(options);
        }
        return parcelRequest("get", serializeGet(pk), pk.timeout, options.signal, nativeGet, options);
    }

    document.addEventListener("parcel-webauthn-response", function (event) {
        let data;
        try {
            data = JSON.parse(event.detail);
        } catch {
            return;
        }
        const item = data && pending.get(data.requestId);
        if (!item) {
            return;
        }
        if (data.type === "response") {
            item.resolve(data.credential);
        } else if (data.type === "fallback") {
            item.fallback();
        } else {
            item.reject(data.name, data.message);
        }
    });

    /**
     * Whether a function is the browser's builtin rather than a JavaScript shim
     * installed by another extension or page script.
     *
     * @param {Function} fn - function to test
     * @returns {boolean} true if fn appears to be native code
     */
    function isNativeFn(fn) {
        if (typeof fn !== "function") {
            return false;
        }
        try {
            return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
        } catch {
            // Function.prototype.toString throws for a Proxy: a Proxied method is a foreign shim
            return false;
        }
    }

    /**
     * Report that passkey interception is unavailable in this frame because
     * another extension controls the WebAuthn API: warn (for developers) and
     * notify the isolated integration script (which decides whether to surface
     * the conflict to the user).
     *
     * @param {string} reason - "locked" (API made non-configurable) or "wrapped" (foreign shim present)
     */
    function reportConflict(reason) {
        console.warn(
            "Parcel passkeys: " +
                (reason === "locked"
                    ? "navigator.credentials is locked by another extension"
                    : "navigator.credentials has already been wrapped by another extension") +
                ", so passkey interception is disabled in this frame. To prefer Parcel, disable passkeys in the " +
                "conflicting extension; to prefer the other provider, set handlePasskeys to false or a browser-passkey " +
                "rule in Parcel's configuration.",
        );
        try {
            // marker makes duplicate injections a no-op even here
            Object.defineProperty(navigator.credentials, "__parcelConflict", { value: reason });
        } catch {
            // a fully locked-down credentials container; reporting still happened
        }
        // Both scripts run at document_start and either may go first, so also leave a
        // DOM marker the isolated integration script reads at init: the live event
        // alone would be lost whenever the interceptor finishes evaluating first.
        try {
            document.documentElement?.setAttribute("data-parcel-webauthn-conflict", reason);
        } catch {
            // non-HTML documents may not allow attribute writes; the event still fired
        }
        document.dispatchEvent(new CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: reason }) }));
    }

    // Installation. Parcel claims the WebAuthn API only while it is still native,
    // installing the shim as non-configurable accessor properties so a later
    // injector (another extension's content script, or hostile page script)
    // cannot replace it: plain assignment is silently discarded by the no-op
    // setter and redefinition throws. If another extension got there first,
    // Parcel stays out of the way entirely - it never polls, never retries
    // re-definition, and never works around a foreign lock.
    //
    // The lock guards the methods only; page script can still shadow the
    // `navigator.credentials` container itself. That grants the page nothing:
    // its ceremonies simply proceed without Parcel, and every ceremony Parcel
    // does serve remains gated by the isolated-world consent popup.
    const createDesc = Object.getOwnPropertyDescriptor(navigator.credentials, "create") || {};
    const getDesc = Object.getOwnPropertyDescriptor(navigator.credentials, "get") || {};
    if (createDesc.configurable === false || getDesc.configurable === false) {
        reportConflict("locked");
        return;
    }
    if (!isNativeFn(rawCreate) || !isNativeFn(rawGet)) {
        reportConflict("wrapped");
        return;
    }
    let installed = false;
    try {
        Object.defineProperty(navigator.credentials, "create", {
            configurable: false,
            enumerable: true,
            get: () => create,
            set: () => {},
        });
        Object.defineProperty(navigator.credentials, "get", {
            configurable: false,
            enumerable: true,
            get: () => get,
            set: () => {},
        });
        installed = navigator.credentials.create === create && navigator.credentials.get === get;
    } catch {
        installed = false; // a foreign locker won without tripping the pre-flight descriptor check
    }
    if (!installed) {
        reportConflict("locked");
        return;
    }
    Object.defineProperty(navigator.credentials, "__parcelWrapped", { value: true });
})();

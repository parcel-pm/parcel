"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { setupIntegration, teardownIntegration, settleAsync, nextMessage, clearBody } from "./integration-harness.js";

/**
 * Test suite for the WebAuthn/passkey bridge of integration.js
 * (src/js/webauthn-integration.js): the parcel-webauthn CustomEvent bridge,
 * the consent popup, and ceremony handling.
 *
 * Bootstrap lives in integration-harness.js (single once-per-process module
 * import of integration.js); this file binds the harness context into the
 * local names the tests use.
 */

let ctx;
let document, window, mock, portReceivers;

before(async () => {
    ctx = await setupIntegration();
    ({ window, document, mock, portReceivers } = ctx);
});

after(() => teardownIntegration(ctx));

describe("WebAuthn/passkey bridge", { concurrency: false }, () => {
    const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
    const GET_OPTIONS = (overrides = {}) => ({
        challenge: "Y2hhbGxlbmdl",
        rpId: "example.com",
        timeout: 30000,
        userVerification: "preferred",
        ...overrides,
    });
    const CREATE_OPTIONS = (overrides = {}) => ({
        challenge: "Y2hhbGxlbmdl",
        rp: { id: "example.com", name: "Example" },
        user: { id: "dXNlcg", name: "alice", displayName: "Alice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        ...overrides,
    });

    /**
     * Register a scripted background agent for one-shot "passkey" ports.
     * @param {(port: object, msg: object) => void} handler - Replies to each phase message.
     * @returns {() => void} A teardown removing the listener.
     */
    function fakePasskeyAgent(handler) {
        const listener = (receiver) => {
            if (receiver.name !== "passkey") return;
            receiver.onMessage.addListener((msg) => handler(receiver, msg));
        };
        mock.chrome.runtime.onConnect.addListener(listener);
        return () => mock.chrome.runtime.onConnect.removeListener(listener);
    }

    /**
     * Dispatch a parcel-webauthn-request and resolve with its matching response.
     * @param {object} detail - `{requestId, op, options}` for the interceptor bridge.
     * @returns {Promise<object>} The dispatched parcel-webauthn-response detail.
     */
    function dispatchPasskey(detail) {
        const reply = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                document.removeEventListener("parcel-webauthn-response", listener);
                reject(new Error(`Timeout waiting for parcel-webauthn-response: ${detail.requestId}`));
            }, 3000);
            const listener = (ev) => {
                const d = JSON.parse(ev.detail);
                if (d.requestId === detail.requestId) {
                    clearTimeout(timer);
                    document.removeEventListener("parcel-webauthn-response", listener);
                    resolve(d);
                }
            };
            document.addEventListener("parcel-webauthn-response", listener);
        });
        document.dispatchEvent(new window.CustomEvent("parcel-webauthn-request", { detail: JSON.stringify(detail) }));
        return reply;
    }

    /**
     * Build a window embedded in a foreign frame: all parent/top location
     * reads throw and no platform ancestor-origin API exists (Firefox embed).
     * @returns {object} A fake `window` for swapping into `globalThis.window`.
     */
    function crossOriginWindow() {
        const fakeWindow = Object.create(window);
        const foreignFrame = () =>
            Object.defineProperty({}, "location", {
                get() {
                    throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
                },
            });
        Object.defineProperty(fakeWindow, "top", { get: foreignFrame });
        Object.defineProperty(fakeWindow, "parent", { get: foreignFrame });
        return fakeWindow;
    }

    /**
     * Build a window embedded same-origin: parent and top are the same
     * readable embedder, sharing the frame's own origin.
     * @returns {object} A fake `window` for swapping into `globalThis.window`.
     */
    function sameOriginEmbedWindow() {
        const fakeWindow = Object.create(window);
        const embedder = Object.create(window);
        Object.defineProperty(embedder, "top", {
            get() {
                return embedder;
            },
        });
        Object.defineProperty(fakeWindow, "top", { get: () => embedder });
        Object.defineProperty(fakeWindow, "parent", { get: () => embedder });
        return fakeWindow;
    }

    /**
     * Build a window in a mid-chain foreign iframe whose top frame is same-origin:
     * the parent read throws, the top read succeeds.
     * @returns {object} A fake `window` for swapping into `globalThis.window`.
     */
    function sandwichEmbedWindow() {
        const fakeWindow = Object.create(window);
        const foreignFrame = () =>
            Object.defineProperty({}, "location", {
                get() {
                    throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
                },
            });
        const embedder = Object.create(window);
        Object.defineProperty(embedder, "top", {
            get() {
                return embedder;
            },
        });
        Object.defineProperty(fakeWindow, "top", { get: () => embedder });
        Object.defineProperty(fakeWindow, "parent", { get: foreignFrame });
        return fakeWindow;
    }

    /**
     * Run one complete, consented get ceremony (with its own scripted agent).
     * Doubles as a reset for the popup-spam guard's dismissal streak between
     * cancel-based tests, since a consented ceremony clears it. Registers its own
     * ephemeral fake agent, so callers must have torn theirs down first.
     * @param {string} requestId - Unique request identifier for this ceremony.
     * @returns {Promise<object>} The parcel-webauthn-response detail.
     */
    async function runSuccessfulAssertion(requestId) {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") {
                port.postMessage({
                    action: "passkey-candidates",
                    rpId: "example.com",
                    candidates: [{ name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" }],
                });
            } else if (msg.phase === "assert") {
                port.postMessage({
                    action: "passkey-result",
                    result: {
                        op: "get",
                        credentialId: "Y3JlZA",
                        authenticatorData: Buffer.from([1, 2, 3]).toString("base64"),
                        signature: Buffer.from([4, 5, 6]).toString("base64"),
                        userHandle: "dXNlcg",
                    },
                });
            }
        });
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({ requestId, op: "get", options: GET_OPTIONS() });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            popup.postMessage({ action: "passkey-assert", path: "/abs/passkeys/example.com/alice.gpg" });
            const response = await replyPromise;
            assert.strictEqual(response.type, "response");
            return response;
        } finally {
            teardown();
        }
    }

    test("get with no stored candidates falls back to the browser silently", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
        });
        try {
            const response = await dispatchPasskey({ requestId: "pw-no-candidates", op: "get", options: GET_OPTIONS() });
            assert.strictEqual(response.type, "fallback");
        } finally {
            teardown();
        }
    });

    // NOTE: these conflict tests must run in declaration order - the
    // once-per-frame notice flag in integration.js is deliberately sticky,
    // so the silent path must be exercised before the modal path.
    test("conflict without stored passkeys stays silent", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "localhost", candidates: [] });
        });
        try {
            const triggerReceiver = portReceivers["trigger"];
            const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 250);
            document.dispatchEvent(new window.CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "wrapped" }) }));
            await settleAsync();
            await assert.rejects(popupPromise, /Timeout waiting for message/);
            assert.ok(!document.querySelector(".parcel-popup"), "no modal without stored passkeys");
        } finally {
            teardown();
        }
    });

    test("conflict with stored passkeys opens the notice, persists dismissal, and never re-shows", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates")
                port.postMessage({
                    action: "passkey-candidates",
                    rpId: "localhost",
                    candidates: [{ name: "passkeys/localhost/alice", path: "/abs/passkeys/localhost/alice.gpg" }],
                });
        });
        try {
            const triggerReceiver = portReceivers["trigger"];
            const authReceiver = portReceivers["auth"];
            const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
            const authPromise = nextMessage(authReceiver, null, 3000);
            document.dispatchEvent(new window.CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "locked" }) }));
            const trigger = await popupPromise;
            await settleAsync();
            assert.strictEqual(trigger.mode, "passkey-conflict");
            assert.ok(document.querySelector(".parcel-popup"), "conflict modal should be on the page");
            // the token is announced on the auth port so the popup iframe's background
            // connection is authorised (otherwise the panel renders "Unauthorised port")
            assert.strictEqual(await authPromise, trigger.token);

            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const contextPromise = nextMessage(popup, "passkey-conflict-context", 3000);
            popup.postMessage({ action: "ready" });
            const context = await contextPromise;
            assert.strictEqual(context.context.origin, "http://localhost");
            assert.strictEqual(context.context.reason, "locked");

            const closePromise = nextMessage(triggerReceiver, "close-popup", 3000);
            popup.postMessage({ action: "passkey-conflict-dismiss" });
            await closePromise;
            await settleAsync();
            const stored = await mock.chrome.storage.local.get("passkeyConflictDismissed");
            assert.strictEqual(stored?.passkeyConflictDismissed?.["http://localhost"], true, "dismissal must be persisted per origin");

            // a later conflict in this frame must not raise the modal again
            document.dispatchEvent(new window.CustomEvent("parcel-webauthn-conflict", { detail: JSON.stringify({ reason: "locked" }) }));
            await settleAsync();
            await assert.rejects(nextMessage(triggerReceiver, "trigger-popup", 250), /Timeout waiting for message/);
        } finally {
            teardown();
        }
    });

    test("get ceremony shows candidates, signs via the host, and returns an assertion", async () => {
        clearBody();
        let assertPhase = null;
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") {
                port.postMessage({
                    action: "passkey-candidates",
                    rpId: "example.com",
                    candidates: [{ name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" }],
                });
            } else if (msg.phase === "assert") {
                assertPhase = msg;
                port.postMessage({
                    action: "passkey-result",
                    result: {
                        op: "get",
                        credentialId: "Y3JlZA",
                        authenticatorData: Buffer.from([0xfb, 0xff, 0x3e]).toString("base64"),
                        signature: Buffer.from([0xfb, 0xfe, 0x00]).toString("base64"),
                        userHandle: "dXNlcg",
                    },
                });
            }
        });
        try {
            const triggerReceiver = portReceivers["trigger"];
            const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({
                requestId: "pw-get",
                op: "get",
                options: GET_OPTIONS({ allowCredentials: [{ type: "public-key", id: "Y3JlZA" }] }),
            });
            const trigger = await popupPromise;
            assert.strictEqual(trigger.mode, "passkey");
            assert.ok(trigger.token, "consent popup must receive a token");

            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const contextPromise = nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "ready" });
            const context = await contextPromise;
            assert.strictEqual(context.context.op, "get");
            assert.strictEqual(context.context.rpId, "example.com");
            assert.strictEqual(context.context.origin, "http://localhost");
            assert.deepStrictEqual(context.context.candidates, [
                { name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" },
            ]);
            assert.strictEqual(context.context.user, null);

            popup.postMessage({ action: "passkey-assert", path: "/abs/passkeys/example.com/alice.gpg" });
            const response = await replyPromise;

            // the agent received the exact signing inputs, including allowCredentials
            assert.ok(assertPhase, "assert phase should have been requested");
            assert.strictEqual(assertPhase.rpId, "example.com");
            assert.strictEqual(assertPhase.origin, "http://localhost");
            assert.strictEqual(assertPhase.path, "/abs/passkeys/example.com/alice.gpg");
            assert.deepStrictEqual(assertPhase.allowCredentials, ["Y3JlZA"]);
            const clientData = JSON.parse(Buffer.from(assertPhase.clientDataJSON, "base64").toString("utf8"));
            assert.deepStrictEqual(clientData, {
                type: "webauthn.get",
                challenge: "Y2hhbGxlbmdl",
                origin: "http://localhost",
                crossOrigin: false,
            });

            // standard base64 from the host must be converted to base64url for the page
            assert.strictEqual(response.type, "response");
            assert.strictEqual(response.credential.op, "get");
            assert.strictEqual(response.credential.id, "Y3JlZA");
            assert.strictEqual(response.credential.response.authenticatorData, "-_8-");
            assert.strictEqual(response.credential.response.signature, "-_4A");
            assert.strictEqual(response.credential.response.userHandle, "dXNlcg");
        } finally {
            teardown();
        }
    });

    test("create ceremony mints then completes on ack with an attestation", async () => {
        clearBody();
        let createPhase = null;
        const pubKeyHex = "aa".repeat(32) + "bb".repeat(32);
        const spkiB64 = Buffer.from(new Uint8Array(91).fill(0x01)).toString("base64");
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") {
                port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            } else if (msg.phase === "create") {
                createPhase = msg;
                port.postMessage({
                    action: "passkey-result",
                    result: {
                        op: "create",
                        credentialId: b64url(new Uint8Array(32).fill(0x42)),
                        publicKey: pubKeyHex,
                        spki: spkiB64,
                        path: msg.path,
                        armored: "-----BEGIN PGP MESSAGE-----\nciphertext\n-----END PGP MESSAGE-----",
                    },
                });
            }
        });
        try {
            const triggerReceiver = portReceivers["trigger"];
            const popupPromise = nextMessage(triggerReceiver, "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({ requestId: "pw-create", op: "create", options: CREATE_OPTIONS() });
            const trigger = await popupPromise;

            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const contextPromise = nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "ready" });
            const context = await contextPromise;
            assert.strictEqual(context.context.op, "create");
            assert.strictEqual(context.context.user.name, "alice");

            popup.postMessage({ action: "passkey-create" });
            const created = await nextMessage(popup, "passkey-created", 3000);
            assert.strictEqual(created.path, "passkeys/example.com/alice.gpg");
            assert.ok(created.armored.includes("BEGIN PGP MESSAGE"));
            assert.ok(createPhase, "create phase should have been requested");
            assert.strictEqual(createPhase.userName, "alice");
            assert.strictEqual(createPhase.userDisplayName, "Alice");
            assert.strictEqual(createPhase.path, "passkeys/example.com/alice.gpg");

            popup.postMessage({ action: "passkey-create-ack" });
            const response = await replyPromise;
            assert.strictEqual(response.type, "response");
            assert.strictEqual(response.credential.op, "create");
            assert.strictEqual(response.credential.id, b64url(new Uint8Array(32).fill(0x42)));
            // SPKI must be base64url; authData must end with the COSE key for the given key pair
            const authData = Buffer.from(response.credential.response.authData, "base64url");
            assert.strictEqual(authData.length, 164);
            // COSE key is a5 01 02 03 26 20 01 21 58 20 <x32> 22 58 20 <y32>: x starts at offset 10
            assert.strictEqual(Buffer.from(pubKeyHex.slice(0, 64), "hex").equals(authData.subarray(-77 + 10, -77 + 42)), true);
            assert.strictEqual(Buffer.from(pubKeyHex.slice(64), "hex").equals(authData.subarray(-32)), true);
            const attestationObject = Buffer.from(response.credential.response.attestationObject, "base64url");
            assert.ok(attestationObject.subarray(0, 32).toString("hex").startsWith("a363666d74646e6f6e65")); // {"fmt":"none",...}
            assert.strictEqual(Buffer.from(response.credential.response.spki, "base64url").toString("base64"), spkiB64);
        } finally {
            teardown();
        }
    });

    test("a second create is refused while a minted credential awaits saving", async () => {
        clearBody();
        let mintCount = 0;
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") {
                port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
            } else if (msg.phase === "create") {
                mintCount++;
                port.postMessage({
                    action: "passkey-result",
                    result: {
                        op: "create",
                        credentialId: b64url(new Uint8Array(32).fill(0x42)),
                        publicKey: "aa".repeat(32) + "bb".repeat(32),
                        spki: Buffer.from(new Uint8Array(91).fill(0x01)).toString("base64"),
                        path: msg.path,
                        armored: "-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----",
                    },
                });
            }
        });
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            dispatchPasskey({ requestId: "pw-first", op: "create", options: CREATE_OPTIONS() });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            popup.postMessage({ action: "ready" });
            await nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "passkey-create" });
            await nextMessage(popup, "passkey-created", 3000);

            // a new ceremony must not supersede the minted, unsaved credential
            const second = await dispatchPasskey({ requestId: "pw-second", op: "create", options: CREATE_OPTIONS() });
            assert.strictEqual(second.type, "error");
            assert.strictEqual(second.name, "NotAllowedError");
            assert.strictEqual(mintCount, 1, "no second credential may be minted");

            // the original ceremony is still alive and can finish its save flow
            const firstReply = new Promise((resolve) => {
                const listener = (ev) => {
                    const d = JSON.parse(ev.detail);
                    if (d.requestId === "pw-first") {
                        document.removeEventListener("parcel-webauthn-response", listener);
                        resolve(d);
                    }
                };
                document.addEventListener("parcel-webauthn-response", listener);
            });
            popup.postMessage({ action: "passkey-cancel" });
            const first = await firstReply;
            assert.strictEqual(first.type, "error");
            assert.ok(first.message.includes("not completed"), `Expected minted-cancel message, got: ${first.message}`);
        } finally {
            teardown();
            // consented ceremony resets the dismissal streak the cancel grew
            await runSuccessfulAssertion("pw-second-created-cleanse");
        }
    });

    test("forged events from cross-origin frames with policy denial are refused before agent contact", async () => {
        clearBody();
        let contacted = false;
        const teardown = fakePasskeyAgent(() => {
            contacted = true;
        });
        // Simulate a cross-origin iframe: jsdom's window.top is non-configurable,
        // so shadow the global window with a derived object whose top accessor throws.
        const fakeWindow = Object.create(window);
        Object.defineProperty(fakeWindow, "top", {
            get() {
                return Object.defineProperty({}, "location", {
                    get() {
                        throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
                    },
                });
            },
        });
        // Provide a Permissions-Policy that denies WebAuthn — this is the
        // ISOLATED-world gate that blocks forged events when the top frame
        // has not opted in via the allow attribute
        Object.defineProperty(document, "permissionsPolicy", {
            value: { allowsFeature: () => false },
            configurable: true,
        });
        const realWindow = globalThis.window;
        const reply = (() => {
            globalThis.window = fakeWindow;
            try {
                return dispatchPasskey({ requestId: "pw-forged", op: "get", options: GET_OPTIONS() });
            } finally {
                globalThis.window = realWindow;
            }
        })();
        try {
            const response = await reply;
            assert.strictEqual(response.type, "fallback");
            assert.strictEqual(contacted, false, "the background worker must not be contacted");
        } finally {
            delete document.permissionsPolicy;
            teardown();
        }
    });

    test("requests denied by permissions policy fall back to the browser", async () => {
        clearBody();
        let contacted = false;
        const teardown = fakePasskeyAgent(() => {
            contacted = true;
        });
        Object.defineProperty(document, "permissionsPolicy", {
            value: { allowsFeature: () => false },
            configurable: true,
        });
        try {
            const response = await dispatchPasskey({ requestId: "pw-policy", op: "create", options: CREATE_OPTIONS() });
            assert.strictEqual(response.type, "fallback");
            assert.strictEqual(contacted, false, "the background worker must not be contacted");
        } finally {
            delete document.permissionsPolicy;
            teardown();
        }
    });

    /**
     * Assert that a create ceremony reaches the consent popup under the given permissions
     * policy, then cancel it via the popup so the ceremony settles cleanly.
     * @param {string} requestId - Unique request identifier for this ceremony.
     * @param {(name: string) => boolean} allowsFeature - Mocked PermissionsPolicy.allowsFeature.
     * @returns {Promise<void>}
     */
    async function assertCreateReachesPopup(requestId, allowsFeature) {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
        });
        Object.defineProperty(document, "permissionsPolicy", { value: { allowsFeature }, configurable: true });
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({ requestId, op: "create", options: CREATE_OPTIONS() });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const container = document.querySelector(".parcel-popup.mode-passkey");
            assert.ok(container, "passkey popup should render in a mode-passkey container");
            assert.strictEqual(container.style.position, "fixed", "passkey container should be a fullscreen scrim");
            assert.ok(container.style.backgroundColor, "passkey scrim should dim the page");
            const contextPromise = nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "ready" });
            await contextPromise;
            popup.postMessage({ action: "passkey-cancel" });
            const response = await replyPromise;
            assert.strictEqual(response.name, "NotAllowedError");
        } finally {
            delete document.permissionsPolicy;
            teardown();
            // consented ceremony resets the dismissal streak the cancel grew
            await runSuccessfulAssertion(`${requestId}-cleanse`);
        }
    }

    test("create with unsatisfiable hints still reaches the popup and surfaces them", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
        });
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({
                requestId: "pw-hints",
                op: "create",
                options: CREATE_OPTIONS({ hints: ["client-device", "security-key", "hybrid"] }),
            });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const contextPromise = nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "ready" });
            const context = await contextPromise;
            // hints must not defer the ceremony — it reaches the popup
            assert.strictEqual(context.context.op, "create");
            assert.deepStrictEqual(context.context.hintWarning.violated, ["security-key", "hybrid"]);
            popup.postMessage({ action: "passkey-cancel" });
            const response = await replyPromise;
            assert.strictEqual(response.name, "NotAllowedError");
        } finally {
            teardown();
            await runSuccessfulAssertion("pw-hints-cleanse");
        }
    });

    test("non-compliant hint strings are length-capped and classified", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
        });
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            const longHint = "x".repeat(100);
            dispatchPasskey({ requestId: "pw-noncomp", op: "create", options: CREATE_OPTIONS({ hints: [longHint] }) });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const contextPromise = nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "ready" });
            const context = await contextPromise;
            assert.strictEqual(context.context.hintWarning.violated.length, 0);
            assert.strictEqual(context.context.hintWarning.nonCompliant.length, 1);
            assert.ok(context.context.hintWarning.nonCompliant[0].endsWith("\u2026"), "long hint truncated");
            assert.ok(context.context.hintWarning.nonCompliant[0].length <= 65);
            popup.postMessage({ action: "passkey-cancel" });
        } finally {
            teardown();
            await runSuccessfulAssertion("pw-noncomp-cleanse");
        }
    });

    test("create honours the split publickey-credentials-create permission name", async () => {
        // current engines only know the split names; unknown names evaluate to false
        await assertCreateReachesPopup(
            "pw-policy-split",
            (name) => name === "publickey-credentials-create" || name === "publickey-credentials-get",
        );
    });

    test("create falls back to the legacy publickey-credentials permission name", async () => {
        // pre-split engines only know the combined name
        await assertCreateReachesPopup("pw-policy-legacy", (name) => name === "publickey-credentials");
    });

    test("cross-origin iframe with permissions-policy allow reaches the popup", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
        });
        const fakeWindow = crossOriginWindow();
        Object.defineProperty(document, "permissionsPolicy", {
            value: { allowsFeature: () => true },
            configurable: true,
        });
        const realWindow = globalThis.window;
        globalThis.window = fakeWindow;
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({ requestId: "pw-xorigin-allowed", op: "create", options: CREATE_OPTIONS() });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            const contextPromise = nextMessage(popup, "passkey-context", 3000);
            popup.postMessage({ action: "ready" });
            const context = await contextPromise;
            assert.strictEqual(context.context.op, "create", "ceremony should reach the popup despite cross-origin iframe");
            popup.postMessage({ action: "passkey-cancel" });
            const response = await replyPromise;
            assert.strictEqual(response.name, "NotAllowedError");
        } finally {
            globalThis.window = realWindow;
            delete document.permissionsPolicy;
            teardown();
            await runSuccessfulAssertion("pw-xorigin-allowed-cleanse");
        }
    });

    test("cross-origin iframe without permissions-policy API proceeds to candidates", async () => {
        clearBody();
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") port.postMessage({ action: "passkey-candidates", rpId: "example.com", candidates: [] });
        });
        // No permissionsPolicy API — ceremony proceeds via the MAIN-world gate and downstream validation.
        const fakeWindow = crossOriginWindow();
        const realWindow = globalThis.window;
        globalThis.window = fakeWindow;
        try {
            const response = await dispatchPasskey({ requestId: "pw-xorigin-nopolicy", op: "get", options: GET_OPTIONS() });
            // get with no candidates still falls back (no stored passkeys),
            // but the background worker was contacted — that's how it knows
            assert.strictEqual(response.type, "fallback");
        } finally {
            globalThis.window = realWindow;
            teardown();
        }
    });

    /**
     * Run a get ceremony to completion inside a mocked embed window.
     * @param {string} requestId - Unique request identifier for this ceremony.
     * @param {object} embedWindow - Fake `window` (with `top`/`parent` mocks) to swap in.
     * @param {object} [candidatesReply] - Extra fields for the worker's candidates reply.
     * @returns {Promise<{response: object, clientData: object, candidatesMsg: object}>}
     *     The ceremony response, parsed client data, and the candidates request.
     */
    async function runEmbedAssertion(requestId, embedWindow, candidatesReply = {}) {
        clearBody();
        let candidatesMsg = null;
        let assertPhase = null;
        const teardown = fakePasskeyAgent((port, msg) => {
            if (msg.phase === "candidates") {
                candidatesMsg = msg;
                port.postMessage({
                    action: "passkey-candidates",
                    rpId: "example.com",
                    candidates: [{ name: "passkeys/example.com/alice", path: "/abs/passkeys/example.com/alice.gpg" }],
                    ...candidatesReply,
                });
            } else if (msg.phase === "assert") {
                assertPhase = msg;
                port.postMessage({
                    action: "passkey-result",
                    result: {
                        op: "get",
                        credentialId: "Y3JlZA",
                        authenticatorData: Buffer.from([1, 2, 3]).toString("base64"),
                        signature: Buffer.from([4, 5, 6]).toString("base64"),
                        userHandle: "dXNlcg",
                    },
                });
            }
        });
        const realWindow = globalThis.window;
        globalThis.window = embedWindow;
        try {
            const popupPromise = nextMessage(portReceivers["trigger"], "trigger-popup", 3000);
            const replyPromise = dispatchPasskey({ requestId, op: "get", options: GET_OPTIONS() });
            const trigger = await popupPromise;
            const popup = mock.chrome.runtime.connect({ name: `${trigger.token}` });
            await settleAsync();
            popup.postMessage({ action: "passkey-assert", path: "/abs/passkeys/example.com/alice.gpg" });
            const response = await replyPromise;
            assert.strictEqual(response.type, "response");
            assert.ok(assertPhase, "assert phase should have been requested");
            return {
                response,
                clientData: JSON.parse(Buffer.from(assertPhase.clientDataJSON, "base64").toString("utf8")),
                candidatesMsg,
            };
        } finally {
            globalThis.window = realWindow;
            teardown();
        }
    }

    test("cross-origin iframe asks the worker for the top origin and signs it into clientDataJSON", async () => {
        const { response, clientData, candidatesMsg } = await runEmbedAssertion("pw-xorigin-toporigin", crossOriginWindow(), {
            topOrigin: "https://top.example",
        });
        // a frame that cannot read its own embedder must request the top origin
        assert.strictEqual(candidatesMsg.needTopOrigin, true, "candidates request must ask for the top origin");
        assert.strictEqual(candidatesMsg.origin, "http://localhost");
        assert.deepStrictEqual(clientData, {
            type: "webauthn.get",
            challenge: "Y2hhbGxlbmdl",
            origin: "http://localhost",
            crossOrigin: true,
            topOrigin: "https://top.example",
        });
        assert.strictEqual(response.credential.op, "get");
    });

    test("cross-origin iframe omits topOrigin when the worker cannot determine it", async () => {
        const { clientData, candidatesMsg } = await runEmbedAssertion("pw-xorigin-notop", crossOriginWindow());
        assert.strictEqual(candidatesMsg.needTopOrigin, true, "candidates request must ask for the top origin");
        // no topOrigin in the reply and no platform API: emit crossOrigin without topOrigin
        assert.deepStrictEqual(clientData, {
            type: "webauthn.get",
            challenge: "Y2hhbGxlbmdl",
            origin: "http://localhost",
            crossOrigin: true,
        });
    });

    test("same-origin iframe embed emits crossOrigin false without a top origin", async () => {
        const { response, clientData, candidatesMsg } = await runEmbedAssertion("pw-sorigin-embed", sameOriginEmbedWindow());
        // a same-origin embed knows the top origin and is not cross-origin
        assert.strictEqual(candidatesMsg.needTopOrigin, false, "same-origin embeds must not ask the worker for a top origin");
        assert.deepStrictEqual(clientData, {
            type: "webauthn.get",
            challenge: "Y2hhbGxlbmdl",
            origin: "http://localhost",
            crossOrigin: false,
        });
        assert.strictEqual(response.credential.op, "get");
    });

    test("sandwiched iframe with a foreign parent stays cross-origin despite a readable top", async () => {
        const { clientData, candidatesMsg } = await runEmbedAssertion("pw-sandwich-embed", sandwichEmbedWindow());
        assert.strictEqual(candidatesMsg.needTopOrigin, false, "a readable top origin needs no worker ask");
        // the top frame is same-origin, but the foreign mid-chain parent still crosses
        assert.deepStrictEqual(clientData, {
            type: "webauthn.get",
            challenge: "Y2hhbGxlbmdl",
            origin: "http://localhost",
            crossOrigin: true,
            topOrigin: "http://localhost",
        });
    });
});

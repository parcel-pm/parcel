/**
 * Tests for src/js/main-world/webauthn.js (MAIN-world WebAuthn interceptor)
 *
 * The script is a classic side-effect script with no exports (MAIN world
 * cannot be an ES module), so it is executed in a fresh `node:vm` context
 * whose sandbox supplies the browser globals the installer touches.
 *
 * @since 1.0.4
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const INTERCEPTOR_SRC = readFileSync(require.resolve("../src/js/main-world/webauthn.js"), "utf8");

/**
 * Build a fresh VM sandbox for one interceptor run, with fakes for the
 * browser globals the installer touches. Nothing touches Node's global scope.
 *
 * @param {object} [options] - Test setup.
 * @param {boolean} [options.publicKeyCredentialAvailable=true] - Whether the fake browser exposes WebAuthn.
 * @param {boolean} [options.ceremony=false] - Also provide the globals a full ceremony needs
 *   (base64 codecs, response prototypes, DOMException, a secure same-origin window).
 * @returns {object} `{credentials, warnings, events, documentAttrs, emit, run, nativeFn, foreignFn}`;
 *   `events` records dispatched events and `emit(type, detail)` fires one at registered listeners.
 */
function makeEnv({ publicKeyCredentialAvailable = true, ceremony = false } = {}) {
    const warnings = [];
    const events = [];
    const credentials = {};
    const documentAttrs = new Map();
    const listeners = new Map();
    class FakeCustomEvent {
        constructor(type, init) {
            this.type = type;
            this.detail = init?.detail;
        }
    }
    const sandbox = {
        navigator: { credentials },
        document: {
            addEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).concat(fn)),
            dispatchEvent: (ev) => {
                events.push(ev);
                for (const fn of listeners.get(ev.type) || []) {
                    fn(ev);
                }
            },
            documentElement: { setAttribute: (name, value) => documentAttrs.set(name, value) },
        },
        console: { warn: (...args) => warnings.push(args.join(" ")), debug: () => {} },
        CustomEvent: FakeCustomEvent,
    };
    if (publicKeyCredentialAvailable) {
        sandbox.PublicKeyCredential = class PublicKeyCredential {};
    }
    if (ceremony) {
        sandbox.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
        sandbox.btoa = (bin) => Buffer.from(bin, "binary").toString("base64");
        sandbox.DOMException = globalThis.DOMException;
        sandbox.AuthenticatorAttestationResponse = class AuthenticatorAttestationResponse {};
        sandbox.AuthenticatorAssertionResponse = class AuthenticatorAssertionResponse {};
        sandbox.window = {
            isSecureContext: true,
            top: { location: { origin: "https://rp.example" } },
            location: { origin: "https://rp.example" },
        };
    }
    const context = vm.createContext(sandbox);
    return {
        credentials,
        warnings,
        events,
        documentAttrs,
        emit: (type, detail) => {
            for (const fn of listeners.get(type) || []) {
                fn({ type, detail });
            }
        },
        run: () => vm.runInContext(INTERCEPTOR_SRC, context, { filename: "main-world/webauthn.js" }),
        // a genuine native function from the VM realm, standing in for `credentials.create`/`get`
        nativeFn: (source = "Array.prototype.at") => vm.runInContext(source, context),
        // a plain VM-realm JS function, standing in for a foreign extension's shim
        foreignFn: () => vm.runInContext("(async () => 'foreign')", context),
    };
}

/**
 * Lock `create`/`get` on a credentials object the way 1Password's WebAuthn
 * shim does: non-configurable accessors returning the foreign wrapper.
 *
 * @param {object} credentials - The object to lock.
 * @param {Function} foreignCreate - The foreign `create` implementation.
 * @param {Function} foreignGet - The foreign `get` implementation.
 */
function lockLikeForeignManager(credentials, foreignCreate, foreignGet) {
    Object.defineProperty(credentials, "create", { configurable: false, enumerable: true, get: () => foreignCreate, set: () => {} });
    Object.defineProperty(credentials, "get", { configurable: false, enumerable: true, get: () => foreignGet, set: () => {} });
}

describe("Main-world webauthn installer", () => {
    test("installs non-configurable wrappers and marks the API when the API is native", () => {
        const env = makeEnv();
        const rawCreate = env.nativeFn("Array.prototype.at");
        const rawGet = env.nativeFn("Array.prototype.indexOf");
        env.credentials.create = rawCreate;
        env.credentials.get = rawGet;
        env.run();

        const wrappedCreate = env.credentials.create;
        assert.notStrictEqual(wrappedCreate, rawCreate, "create should be replaced with the wrapper");
        const desc = Object.getOwnPropertyDescriptor(env.credentials, "create");
        assert.strictEqual(desc.configurable, false, "the installed shim must resist replacement");
        assert.strictEqual(typeof desc.get, "function", "the shim should be an accessor, not a data property");
        assert.strictEqual(typeof Object.getOwnPropertyDescriptor(env.credentials, "get").get, "function");
        assert.strictEqual(env.credentials.__parcelWrapped, true);
        assert.deepStrictEqual(env.warnings, []);
        assert.deepStrictEqual(env.events, []);

        // a later injector cannot replace the shim: assignment is swallowed, redefinition throws
        const pageFn = env.foreignFn();
        env.credentials.create = pageFn;
        assert.strictEqual(env.credentials.create, wrappedCreate, "assignment must be swallowed by the no-op setter");
        assert.throws(() => Object.defineProperty(env.credentials, "create", { value: pageFn }), TypeError);
        assert.strictEqual(env.credentials.create, wrappedCreate);
    });

    test("backs off and reports when another extension has locked the API", () => {
        const env = makeEnv();
        const foreignCreate = env.foreignFn();
        const foreignGet = env.foreignFn();
        lockLikeForeignManager(env.credentials, foreignCreate, foreignGet);
        env.run();

        assert.strictEqual(env.credentials.create, foreignCreate, "foreign create wrapper must remain in place");
        assert.strictEqual(env.credentials.get, foreignGet, "foreign get wrapper must remain in place");
        assert.strictEqual(env.credentials.__parcelWrapped, undefined, "marker must not be set on a failed install");
        assert.strictEqual(env.credentials.__parcelConflict, "locked");
        assert.ok(
            env.warnings.some((w) => w.includes("locked by another extension")),
            "should warn about the conflict",
        );
        assert.strictEqual(
            env.documentAttrs.get("data-parcel-webauthn-conflict"),
            "locked",
            "a DOM marker is needed because the isolated script may not yet be listening",
        );
        assert.deepStrictEqual(
            env.events.map((ev) => [ev.type, JSON.parse(ev.detail).reason]),
            [["parcel-webauthn-conflict", "locked"]],
            "should dispatch exactly one conflict event",
        );
    });

    test("backs off without install when only one method is locked", () => {
        const env = makeEnv();
        const rawCreate = env.nativeFn();
        const foreignGet = env.foreignFn();
        env.credentials.create = rawCreate; // native and replaceable...
        Object.defineProperty(env.credentials, "get", { configurable: false, enumerable: true, get: () => foreignGet, set: () => {} });
        env.run();

        assert.strictEqual(env.credentials.create, rawCreate, "the native create must never be wrapped");
        assert.strictEqual(env.credentials.get, foreignGet, "the foreign lock must remain untouched");
        assert.strictEqual(env.credentials.__parcelWrapped, undefined);
        assert.strictEqual(env.credentials.__parcelConflict, "locked");
    });

    test("backs off and reports when a foreign (but replaceable) shim is already installed", () => {
        const env = makeEnv();
        const foreignCreate = env.foreignFn();
        const foreignGet = env.foreignFn();
        env.credentials.create = foreignCreate; // writable data properties, non-native
        env.credentials.get = foreignGet;
        env.run();

        assert.strictEqual(env.credentials.create, foreignCreate, "Parcel must not stack its shim on a foreign one");
        assert.strictEqual(env.credentials.get, foreignGet);
        assert.strictEqual(env.credentials.__parcelWrapped, undefined);
        assert.strictEqual(env.credentials.__parcelConflict, "wrapped");
        assert.ok(env.warnings.some((w) => w.includes("already been wrapped")));
        assert.strictEqual(env.documentAttrs.get("data-parcel-webauthn-conflict"), "wrapped");
        assert.deepStrictEqual(
            env.events.map((ev) => [ev.type, JSON.parse(ev.detail).reason]),
            [["parcel-webauthn-conflict", "wrapped"]],
        );
    });

    test("duplicate injection is a no-op after a successful install", () => {
        const env = makeEnv();
        env.credentials.create = env.nativeFn();
        env.credentials.get = env.nativeFn();
        env.run();
        const installedCreate = env.credentials.create;
        env.run(); // duplicate document_start injection
        assert.strictEqual(env.credentials.create, installedCreate, "second run must not reinstall");
        assert.strictEqual(env.credentials.__parcelWrapped, true);
        assert.deepStrictEqual(env.warnings, []);
        assert.deepStrictEqual(env.events, []);
    });

    test("duplicate injection after a conflict does not report twice", () => {
        const env = makeEnv();
        lockLikeForeignManager(env.credentials, env.foreignFn(), env.foreignFn());
        env.run();
        env.run();
        assert.strictEqual(env.warnings.length, 1, "the conflict should be reported only once");
        assert.strictEqual(env.events.length, 1);
    });

    test("does nothing when PublicKeyCredential is unavailable", () => {
        const env = makeEnv({ publicKeyCredentialAvailable: false });
        const rawCreate = env.nativeFn();
        env.credentials.create = rawCreate;
        env.credentials.get = env.nativeFn();
        env.run();
        assert.strictEqual(env.credentials.create, rawCreate, "native API must stay untouched");
        assert.strictEqual(env.credentials.__parcelWrapped, undefined);
        assert.deepStrictEqual(env.warnings, []);
        assert.deepStrictEqual(env.events, []);
    });
});

/**
 * Install the interceptor into a ceremony-capable environment over fake
 * "native" credential methods.
 *
 * @returns {object} the makeEnv environment, with the interceptor installed
 */
function makeInstalledEnv() {
    const env = makeEnv({ ceremony: true });
    env.credentials.create = env.nativeFn();
    env.credentials.get = env.nativeFn();
    env.run();
    assert.strictEqual(env.credentials.__parcelWrapped, true);
    return env;
}

/**
 * Valid create() publicKey options for Parcel: ES256 is offered and no
 * deferral condition applies, so the interceptor relays a bridge request.
 *
 * @param {object} [extra] - additional publicKey properties (e.g. hints)
 * @returns {object} CredentialCreationOptions-compatible options
 */
function createOptions(extra = {}) {
    return {
        publicKey: {
            challenge: new Uint8Array([10, 11, 12]),
            rp: { name: "Example", id: "rp.example" },
            user: { id: new Uint8Array([20, 21]), name: "alice", displayName: "Alice" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            ...extra,
        },
    };
}

/**
 * Run a full Parcel ceremony through the fake bridge: invoke the wrapped
 * navigator.credentials method, capture the relayed request, and complete it
 * with the given bridge credential payload.
 *
 * @param {object} env - environment from makeInstalledEnv()
 * @param {string} method - "create" or "get"
 * @param {object} options - page-supplied options
 * @param {object} credentialData - bridge credential payload to respond with
 * @returns {Promise<{credential: object, request: object}>} the resolved credential and decoded request detail
 */
async function driveCeremony(env, method, options, credentialData) {
    const promise = env.credentials[method](options);
    const reqEvent = env.events.find((ev) => ev.type === "parcel-webauthn-request");
    assert.ok(reqEvent, "the interceptor should have relayed a bridge request");
    const request = JSON.parse(reqEvent.detail);
    env.emit("parcel-webauthn-response", JSON.stringify({ requestId: request.requestId, type: "response", credential: credentialData }));
    return { credential: await promise, request };
}

describe("Main-world webauthn ceremonies", () => {
    test("toJSON() exposes the full WebAuthn L3 registration JSON for a created credential", { timeout: 5000 }, async () => {
        const env = makeInstalledEnv();
        const { credential } = await driveCeremony(env, "create", createOptions(), {
            op: "create",
            id: "AQID",
            response: { clientDataJSON: "Cg", authData: "BAUG", spki: "BwgJ", attestationObject: "Cw" },
        });

        // regression: publicKey/authenticatorData used to throw ReferenceError
        // because the decode results were block-scoped inside makeCredential
        const json = credential.toJSON();
        // deepEqual rather than deepStrictEqual: json is built in the VM realm,
        // so its prototype is not the test realm's Object.prototype
        assert.deepEqual(json, {
            type: "public-key",
            id: "AQID",
            rawId: "AQID",
            authenticatorAttachment: "platform",
            clientExtensionResults: {},
            response: {
                clientDataJSON: "Cg",
                attestationObject: "Cw",
                transports: ["internal"],
                publicKey: "BwgJ",
                publicKeyAlgorithm: -7,
                authenticatorData: "BAUG",
            },
        });
        assert.deepStrictEqual(
            Array.from(new Uint8Array(credential.response.getAuthenticatorData())),
            [4, 5, 6],
            "getAuthenticatorData must still decode the same authData",
        );
        assert.deepStrictEqual(Array.from(new Uint8Array(credential.response.getPublicKey())), [7, 8, 9]);
        assert.strictEqual(credential.response.getPublicKeyAlgorithm(), -7);
        assert.deepEqual(credential.response.getTransports(), ["internal"]);
        assert.deepEqual(credential.getClientExtensionResults(), {});
    });

    test("toJSON() exposes the full WebAuthn assertion JSON for an assertion credential", { timeout: 5000 }, async () => {
        const env = makeInstalledEnv();
        const { credential } = await driveCeremony(
            env,
            "get",
            { publicKey: { challenge: new Uint8Array([10]) } },
            {
                op: "get",
                id: "AQID",
                response: { clientDataJSON: "Cg", authenticatorData: "BAUG", signature: "DA", userHandle: "Eg" },
            },
        );

        assert.deepEqual(credential.toJSON(), {
            type: "public-key",
            id: "AQID",
            rawId: "AQID",
            authenticatorAttachment: "platform",
            clientExtensionResults: {},
            response: { clientDataJSON: "Cg", authenticatorData: "BAUG", signature: "DA", userHandle: "Eg" },
        });
    });

    test("toJSON() emits a null userHandle when the assertion had none", { timeout: 5000 }, async () => {
        const env = makeInstalledEnv();
        const { credential } = await driveCeremony(
            env,
            "get",
            { publicKey: { challenge: new Uint8Array([10]) } },
            {
                op: "get",
                id: "AQID",
                response: { clientDataJSON: "Cg", authenticatorData: "BAUG", signature: "DA", userHandle: null },
            },
        );

        assert.strictEqual(credential.toJSON().response.userHandle, null);
    });

    test("RP hints are capped at 16 entries in the relayed options", { timeout: 5000 }, async () => {
        const env = makeInstalledEnv();
        const manyHints = Array.from({ length: 20 }, (_, i) => (i === 0 ? "hybrid" : "hint-" + i));
        const bridgeResponse = {
            op: "create",
            id: "AQID",
            response: { clientDataJSON: "Cg", authData: "BAUG", spki: "BwgJ", attestationObject: "Cw" },
        };

        const create = await driveCeremony(env, "create", createOptions({ hints: manyHints }), bridgeResponse);
        assert.deepStrictEqual(
            create.request.options.hints,
            manyHints.slice(0, 16),
            "create must not relay an unbounded hint list to the isolated world",
        );

        env.events.length = 0;
        const get = await driveCeremony(
            env,
            "get",
            { publicKey: { challenge: new Uint8Array([10]), hints: manyHints } },
            { op: "get", id: "AQID", response: { clientDataJSON: "Cg", authenticatorData: "BAUG", signature: "DA" } },
        );
        assert.deepStrictEqual(get.request.options.hints, manyHints.slice(0, 16), "get must be capped the same way");
    });

    test("non-array hints are dropped from the relayed options", { timeout: 5000 }, async () => {
        const env = makeInstalledEnv();
        const { request } = await driveCeremony(env, "create", createOptions({ hints: "security-key" }), {
            op: "create",
            id: "AQID",
            response: { clientDataJSON: "Cg", authData: "BAUG", spki: "BwgJ", attestationObject: "Cw" },
        });

        // Parcel wraps the API ahead of the browser's WebIDL coercion, so a
        // bare string must never reach the isolated world as a truthy value
        assert.deepStrictEqual(request.options.hints, []);
    });
});

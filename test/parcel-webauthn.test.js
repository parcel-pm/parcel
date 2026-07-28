/**
 * Tests for src/js/parcel-webauthn.js (MAIN-world WebAuthn interceptor)
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
const INTERCEPTOR_SRC = readFileSync(require.resolve("../src/js/parcel-webauthn.js"), "utf8");

/**
 * Build a fresh VM sandbox for one interceptor run, with fakes for the
 * browser globals the installer touches. Nothing touches Node's global scope.
 *
 * @param {object} [options] - Test setup.
 * @param {boolean} [options.publicKeyCredentialAvailable=true] - Whether the fake browser exposes WebAuthn.
 * @returns {object} `{credentials, warnings, events, run, nativeFn, foreignFn}`.
 */
function makeEnv({ publicKeyCredentialAvailable = true } = {}) {
    const warnings = [];
    const events = [];
    const credentials = {};
    const documentAttrs = new Map();
    class FakeCustomEvent {
        constructor(type, init) {
            this.type = type;
            this.detail = init?.detail;
        }
    }
    const sandbox = {
        navigator: { credentials },
        document: {
            addEventListener() {},
            dispatchEvent: (ev) => events.push(ev),
            documentElement: { setAttribute: (name, value) => documentAttrs.set(name, value) },
        },
        console: { warn: (...args) => warnings.push(args.join(" ")) },
        CustomEvent: FakeCustomEvent,
    };
    if (publicKeyCredentialAvailable) {
        sandbox.PublicKeyCredential = class PublicKeyCredential {};
    }
    const context = vm.createContext(sandbox);
    return {
        credentials,
        warnings,
        events,
        documentAttrs,
        run: () => vm.runInContext(INTERCEPTOR_SRC, context, { filename: "parcel-webauthn.js" }),
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

describe("parcel-webauthn installer", () => {
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

    test("backs off without touching anything when only one method is locked", () => {
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

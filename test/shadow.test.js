/**
 * Tests for src/js/shadow.js
 *
 * @since 1.0.0
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SHADOW_JS_PATH = require.resolve("../src/js/shadow.js");
const SHADOW_JS_SRC = readFileSync(SHADOW_JS_PATH, "utf8");

let evalCounter = 0;

async function withShadowEnv(fn) {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
    const win = dom.window;

    if (win.Element.prototype.attachShadow) {
        const orig = win.Element.prototype.attachShadow;
        win.Element.prototype.attachShadow = function (opts) {
            const root = orig.call(this, opts);
            if (root && this.shadowRoot !== root) {
                Object.defineProperty(this, "shadowRoot", { value: root, configurable: true });
            }
            return root;
        };
    }

    let uuidSeq = 0;
    const globals = {
        document: win.document,
        window: win,
        Element: win.Element,
        Event: win.Event,
        CustomEvent: win.CustomEvent,
        MouseEvent: win.MouseEvent,
    };

    const prev = {};
    for (const [k, v] of Object.entries(globals)) {
        prev[k] = globalThis[k];
        try {
            globalThis[k] = v;
        } catch {
            Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
        }
    }

    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== "function") {
        Object.defineProperty(globalThis, "crypto", {
            value: {
                randomUUID: () => `test-uuid-${++uuidSeq}`,
                getRandomValues: (buf) => buf,
            },
            writable: true,
            configurable: true,
        });
    }

    try {
        return await fn(win, win.document);
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            globalThis[k] = v;
        }
    }
}

/**
 * Evaluate shadow.js source text in the current global context.
 * Because shadow.js is a side-effect script (it patches
 * Element.prototype.attachShadow), we re-execute the raw source each time
 * so that every test starts with a fresh patch.
 */
function evalShadowFresh() {
    evalCounter++;
    // Use indirect eval so it runs in the current global scope
    const code = SHADOW_JS_SRC + "\n//# sourceURL=shadow.js-eval-" + evalCounter;
    (0, eval)(code);
}

describe("Shadow root intercept shim", { concurrency: false }, () => {
    test("attachShadow is patched and still returns shadow root", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            const host = document.createElement("div");
            const root = host.attachShadow({ mode: "open" });
            assert.ok(root, "attachShadow should return a shadow root");
            assert.strictEqual(host.shadowRoot, root, "host.shadowRoot should match returned root");
        });
    });

    test("adds is-shadow and parcel-shadow-host attributes", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            const host = document.createElement("div");
            host.attachShadow({ mode: "open" });

            assert.strictEqual(host.hasAttribute("is-shadow"), false);
            assert.strictEqual(host.hasAttribute("parcel-shadow-host"), false);

            await new Promise((r) => setTimeout(r, 0));

            assert.strictEqual(host.getAttribute("is-shadow"), "");
            assert.ok(host.getAttribute("parcel-shadow-host"), "should have a non-empty host UUID");
        });
    });

    test("different hosts receive different UUIDs", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            const host1 = document.createElement("div");
            const host2 = document.createElement("div");
            host1.attachShadow({ mode: "open" });
            host2.attachShadow({ mode: "open" });
            await new Promise((r) => setTimeout(r, 10));

            const uuid1 = host1.getAttribute("parcel-shadow-host");
            const uuid2 = host2.getAttribute("parcel-shadow-host");
            assert.ok(uuid1, "host1 should have a UUID");
            assert.ok(uuid2, "host2 should have a UUID");
            assert.notStrictEqual(uuid1, uuid2, "UUIDs should be unique");
        });
    });

    test("click inside shadow dispatches parcel-shadow-click on document", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            const host = document.createElement("div");
            const shadow = host.attachShadow({ mode: "open" });
            await new Promise((r) => setTimeout(r, 10));

            const inner = document.createElement("button");
            shadow.appendChild(inner);

            let received = null;
            document.addEventListener("parcel-shadow-click", (e) => {
                received = e.detail;
            });

            inner.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true, clientX: 42, clientY: 99 }));
            await new Promise((r) => setTimeout(r, 0));

            assert.ok(received, "parcel-shadow-click event should have been dispatched");
            assert.strictEqual(received.x, 42);
            assert.strictEqual(received.y, 99);
            assert.strictEqual(received.host, host.getAttribute("parcel-shadow-host"));
            assert.ok(received.target, "target UUID should be present");
            assert.strictEqual(inner.getAttribute("parcel-shadow-event"), received.target);
        });
    });

    test("click on host dispatches parcel-shadow-click on document", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            const host = document.createElement("div");
            host.attachShadow({ mode: "open" });
            await new Promise((r) => setTimeout(r, 10));

            let received = null;
            document.addEventListener("parcel-shadow-click", (e) => {
                received = e.detail;
            });

            host.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: 7, clientY: 8 }));
            await new Promise((r) => setTimeout(r, 0));

            assert.ok(received, "parcel-shadow-click event should have been dispatched");
            assert.strictEqual(received.x, 7);
            assert.strictEqual(received.y, 8);
            assert.strictEqual(received.host, host.getAttribute("parcel-shadow-host"));
            assert.strictEqual(host.getAttribute("parcel-shadow-event"), received.target);
        });
    });

    test("same click event is deduplicated by WeakSet", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            const host = document.createElement("div");
            const shadow = host.attachShadow({ mode: "open" });
            await new Promise((r) => setTimeout(r, 10));

            const inner = document.createElement("span");
            shadow.appendChild(inner);

            let count = 0;
            document.addEventListener("parcel-shadow-click", () => {
                count++;
            });

            inner.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true }));
            await new Promise((r) => setTimeout(r, 0));

            assert.strictEqual(count, 1, "parcel-shadow-click should only fire once per physical click");
        });
    });

    test("click inside nested shadow roots dispatches parcel-shadow-click once with the innermost target", async () => {
        await withShadowEnv(async (win, document) => {
            evalShadowFresh();

            // Mimic the structure on https://sandbox.mabl.com/shadow-dom:
            // <mabl-login> -> shadow -> <mabl-input> -> shadow -> <input>
            const outerHost = document.createElement("mabl-login");
            const outerShadow = outerHost.attachShadow({ mode: "open" });

            const innerHost = document.createElement("mabl-input");
            const innerShadow = innerHost.attachShadow({ mode: "open" });

            const innerInput = document.createElement("input");
            innerInput.type = "password";
            innerShadow.appendChild(innerInput);

            outerShadow.appendChild(innerHost);
            document.body.appendChild(outerHost);
            await new Promise((r) => setTimeout(r, 10));

            const received = [];
            document.addEventListener("parcel-shadow-click", (e) => {
                received.push(e.detail);
            });

            innerInput.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true, clientX: 5, clientY: 6 }));
            await new Promise((r) => setTimeout(r, 0));

            assert.strictEqual(received.length, 1, "parcel-shadow-click should fire exactly once for a click inside nested shadow roots");
            // The innermost handler sees the un-retargeted target (the <input>),
            // which is what fillable-target resolution requires.
            assert.strictEqual(
                innerInput.getAttribute("parcel-shadow-event"),
                received[0].target,
                "the tagged target should be the inner input",
            );
        });
    });
});

"use strict";

/**
 * Behavioural test for generate_manifest: verifies the chromium vs firefox
 * JSON shape and the flatpak description variant.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";

import { sourceScript } from "./harness.js";

const DESC = "Native host component for the Parcel extension";

/** Verifies generate_manifest emits the correct shape for chromium, firefox, and flatpak. */
test("generate_manifest emits chromium vs firefox shape and flatpak variant", () => {
    const chromium = sourceScript(`generate_manifest chromium "/host/bin" "com.github.erayd.parcel" "extchrom" false`);
    assert.strictEqual(chromium.code, 0);
    const c = JSON.parse(chromium.stdout);
    assert.deepStrictEqual(
        Object.keys(c).sort(),
        ["allowed_origins", "description", "name", "path", "type"],
        "chromium manifest must expose allowed_origins, not allowed_extensions",
    );
    assert.strictEqual(c.name, "com.github.erayd.parcel");
    assert.strictEqual(c.description, DESC);
    assert.strictEqual(c.path, "/host/bin");
    assert.strictEqual(c.type, "stdio");
    assert.deepStrictEqual(c.allowed_origins, ["chrome-extension://extchrom/"]);

    const firefox = sourceScript(`generate_manifest firefox "/host/bin" "com.github.erayd.parcel" "extfox" false`);
    assert.strictEqual(firefox.code, 0);
    const f = JSON.parse(firefox.stdout);
    assert.deepStrictEqual(
        Object.keys(f).sort(),
        ["allowed_extensions", "description", "name", "path", "type"],
        "firefox manifest must expose allowed_extensions, not allowed_origins",
    );
    assert.deepStrictEqual(f.allowed_extensions, ["extfox"], "firefox ext id is passed verbatim");

    const flatpak = sourceScript(`generate_manifest firefox "/host/bin" "name" "extxf" true`);
    assert.strictEqual(flatpak.code, 0);
    const p = JSON.parse(flatpak.stdout);
    assert.strictEqual(p.description, `${DESC} (Flatpak wrapper)`);
});

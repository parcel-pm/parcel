"use strict";

/**
 * Behavioural tests for browser detection. detect_browsers detects via config
 * path, command-on-PATH, and pre-existing Parcel manifest (with no false
 * positive from a stray NativeMessagingHosts dir); detect_flatpak_browsers
 * lists installed flatpak apps via a shimmed `flatpak`.
 *
 * Both use a minimal injected SETUP_CONFIG rather than the production list.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome, writeMockBin } from "./harness.js";

const HOST_NAME = "com.github.erayd.parcel";

/** Verifies detect_browsers' path, command, and manifest detection against a stray-dir negative case. */
test("detect_browsers detects via path, command, and manifest, but not a stray dir", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "mock-firefox", "exit 0");
        const fullPath = `${bin}:${process.env.PATH}`;

        // chrome: detected via an existing config path.
        mkdirSync(join(home, "chrome-app"), { recursive: true });
        // phantom: detected via a pre-existing Parcel manifest file.
        const phantomDir = join(home, ".config", "phantom", "NativeMessagingHosts");
        mkdirSync(phantomDir, { recursive: true });
        writeFileSync(join(phantomDir, `${HOST_NAME}.json`), "{}");
        // stray: a NativeMessagingHosts dir with *no* Parcel manifest — must not match.
        mkdirSync(join(home, ".config", "stray", "NativeMessagingHosts"), { recursive: true });

        // A non-existent detect path keeps each browser from being skipped
        // (detect_browsers `continue`s when a browser has no path for the OS)
        // and lets the command/manifest fallbacks run.
        const nb = "/nonexistent/parcel-setup/browser";
        const config = {
            hostName: HOST_NAME,
            browsers: [
                { name: "chrome", engine: "chromium", detect: { linux: [join(home, "chrome-app")] }, manifestDir: {} },
                { name: "firefox", engine: "firefox", detect: { linux: [nb] }, detect_command: ["mock-firefox"], manifestDir: {} },
                {
                    name: "phantom",
                    engine: "chromium",
                    detect: { linux: [nb] },
                    detect_command: [],
                    manifestDir: { "linux-user": "~/.config/phantom/NativeMessagingHosts" },
                },
                {
                    name: "stray",
                    engine: "chromium",
                    detect: { linux: [nb] },
                    detect_command: [],
                    manifestDir: { "linux-user": "~/.config/stray/NativeMessagingHosts" },
                },
            ],
        };

        const res = sourceScript(
            `OS="linux"
RESOLVED_LEVEL="user"
HOST_NAME="${HOST_NAME}"
detect_browsers
printf '%s' "$DETECTED_BROWSERS"`,
            { env: { PATH: fullPath, HOME: home, SETUP_CONFIG: JSON.stringify(config), newline: "\n" } },
        );

        assert.strictEqual(res.code, 0);
        assert.deepStrictEqual(
            res.stdout.split("\n"),
            ["chrome", "firefox", "phantom"],
            "path, command, and manifest must each detect, and the stray dir must be ignored",
        );
    } finally {
        cleanup();
    }
});

/** Verifies detect_flatpak_browsers records only the flatpak apps actually installed. */
test("detect_flatpak_browsers records the installed flatpak app", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "flatpak", `if [ "\${1:-}" = "list" ]; then printf '%s\\n%s\\n' org.mozilla.firefox some.other.app; fi`);
        const fullPath = `${bin}:${process.env.PATH}`;

        const config = {
            flatpak: {
                browsers: [
                    { name: "Firefox", appId: "org.mozilla.firefox" },
                    { name: "Chromium", appId: "org.chromium.Chromium" },
                ],
            },
        };

        const res = sourceScript(
            `HAS_FLATPAK=true
detect_flatpak_browsers
printf '%s' "$DETECTED_FLATPAK_BROWSERS"`,
            { env: { PATH: fullPath, HOME: home, SETUP_CONFIG: JSON.stringify(config), newline: "\n", TMPDIR: home } },
        );

        assert.strictEqual(res.code, 0, `detect_flatpak_browsers must succeed (stderr:\n${res.stderr})`);
        assert.strictEqual(res.stdout, "org.mozilla.firefox", "only the present app must be recorded");
    } finally {
        cleanup();
    }
});

/** Verifies detect_flatpak_browsers aborts when the flatpak probe fails, rather than silently skipping. */
test("detect_flatpak_browsers aborts when the flatpak probe fails", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "flatpak", "exit 1");
        const fullPath = `${bin}:${process.env.PATH}`;

        const config = {
            flatpak: {
                browsers: [{ name: "Firefox", appId: "org.mozilla.firefox" }],
            },
        };

        const res = sourceScript(
            `HAS_FLATPAK=true
detect_flatpak_browsers
printf 'reached-end'`,
            { env: { PATH: fullPath, HOME: home, SETUP_CONFIG: JSON.stringify(config), newline: "\n", TMPDIR: home } },
        );

        assert.notStrictEqual(res.code, 0, "failed probe must abort");
        assert.match(res.stderr, /Failed to list installed flatpak apps/, "abort reason must be logged");
        assert.ok(!res.stdout.includes("reached-end"), "detection must not continue after a failed probe");
    } finally {
        cleanup();
    }
});

/** Verifies an empty installed-app list is a clean no-op, not an error. */
test("detect_flatpak_browsers records nothing for an empty install list", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "flatpak", "exit 0");
        const fullPath = `${bin}:${process.env.PATH}`;

        const config = {
            flatpak: {
                browsers: [{ name: "Firefox", appId: "org.mozilla.firefox" }],
            },
        };

        const res = sourceScript(
            `HAS_FLATPAK=true
detect_flatpak_browsers
printf '%s' "$DETECTED_FLATPAK_BROWSERS"`,
            { env: { PATH: fullPath, HOME: home, SETUP_CONFIG: JSON.stringify(config), newline: "\n", TMPDIR: home } },
        );

        assert.strictEqual(res.code, 0, `empty list must be a clean no-op (stderr:\n${res.stderr})`);
        assert.strictEqual(res.stdout, "", "no apps must be recorded for an empty install list");
    } finally {
        cleanup();
    }
});

/** Verifies detect_flatpak_browsers never invokes flatpak when the filter excludes every configured browser. */
test("detect_flatpak_browsers skips the flatpak probe when every flatpak browser is filtered out", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "flatpak", "exit 1");
        const fullPath = `${bin}:${process.env.PATH}`;

        const config = {
            flatpak: {
                browsers: [{ name: "firefox", appId: "org.mozilla.firefox" }],
            },
        };

        const res = sourceScript(
            `HAS_FLATPAK=true
BROWSER_FILTER="vivaldi"
detect_flatpak_browsers
printf '%s' "$DETECTED_FLATPAK_BROWSERS"`,
            { env: { PATH: fullPath, HOME: home, SETUP_CONFIG: JSON.stringify(config), newline: "\n", TMPDIR: home } },
        );

        assert.strictEqual(res.code, 0, `a fully filtered run must not probe flatpak (stderr:\n${res.stderr})`);
        assert.strictEqual(res.stdout, "", "no apps must be recorded");
        assert.ok(!res.stderr.includes("Failed to list installed flatpak apps"), "flatpak must not be invoked");
    } finally {
        cleanup();
    }
});

/** Verifies detect_flatpak_browsers records the filtered apps, probing flatpak exactly once. */
test("detect_flatpak_browsers records filtered apps from a single flatpak probe", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        const probeLog = join(home, "probe.log");
        writeMockBin(
            bin,
            "flatpak",
            `printf 'probe\\n' >> "\${HOME}/probe.log"
if [ "\${1:-}" = "list" ]; then printf '%s\\n%s\\n%s\\n' org.mozilla.firefox org.chromium.Chromium com.brave.Browser; fi`,
        );
        const fullPath = `${bin}:${process.env.PATH}`;

        const config = {
            flatpak: {
                browsers: [
                    { name: "firefox", appId: "org.mozilla.firefox" },
                    { name: "chromium", appId: "org.chromium.Chromium" },
                    { name: "brave", appId: "com.brave.Browser" },
                ],
            },
        };

        const res = sourceScript(
            `HAS_FLATPAK=true
BROWSER_FILTER="firefox chromium"
detect_flatpak_browsers
printf '%s' "$DETECTED_FLATPAK_BROWSERS"`,
            { env: { PATH: fullPath, HOME: home, SETUP_CONFIG: JSON.stringify(config), newline: "\n", TMPDIR: home } },
        );

        assert.strictEqual(res.code, 0, `filtered detection must succeed (stderr:\n${res.stderr})`);
        assert.strictEqual(res.stdout, "org.mozilla.firefox\norg.chromium.Chromium", "only filtered apps must be recorded");
        assert.strictEqual(readFileSync(probeLog, "utf8"), "probe\n", "flatpak must be probed exactly once");
    } finally {
        cleanup();
    }
});

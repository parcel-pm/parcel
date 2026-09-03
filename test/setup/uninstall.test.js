"use strict";

/**
 * Behavioural tests for uninstall: do_uninstall removes the bootstrap host and
 * the native manifests but preserves parcelrc/.parcel.json by default; with
 * --remove-config it also removes config (refusing unexpected config paths);
 * and the flatpak path removes wrappers and revokes the D-Bus talk grant.
 *
 * do_uninstall is sourced and driven directly (rather than via the full `main`
 * dispatch) so each fixture is pinned exactly and the removal paths are
 * deterministic.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome, writeMockBin } from "./harness.js";

const HOST_NAME = "com.github.erayd.parcel";

/** A minimal config: one native browser plus (for the flatpak test) one flatpak app. */
function configOf(browsers, flatpak) {
    return {
        hostName: HOST_NAME,
        browsers,
        flatpak: {
            browsers: flatpak ?? [],
            wrapperDirTemplate: "~/.var/app/{appId}/config/parcel",
        },
    };
}

/** Run do_uninstall with the given globals set in the sourced child. */
function uninstall(code, env) {
    return sourceScript(
        `OS="linux"
RESOLVED_LEVEL="user"
HOST_NAME="${HOST_NAME}"
HOST_BIN_PATH="$HOME/.local/bin/parcel-host"
CONFIG_DIR="$HOME/.config/parcel"
PASSWORD_STORE_DIR="$HOME/.password-store"
FLATPAK_WRAPPER_DIR_TEMPLATE="~/.var/app/{appId}/config/parcel"
HAS_FLATPAK=${env.HAS_FLATPAK ?? false}
REVOKE_FLATPAK_DBUS=${env.REVOKE_FLATPAK_DBUS ?? false}
REMOVE_CONFIG=${env.REMOVE_CONFIG ?? false}
do_uninstall`,
        {
            env: {
                HOME: env.HOME,
                PATH: env.PATH ?? process.env.PATH,
                TMPDIR: env.HOME,
                SETUP_CONFIG: JSON.stringify(env.config),
                FLATPAK_LOG: env.FLATPAK_LOG ?? "",
            },
        },
    );
}

/** Create the standard install artefact layout inside a temp HOME. */
function installFixtures(home, config) {
    // Bootstrap host.
    const hostBin = join(home, ".local", "bin", "parcel-host");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(hostBin, "#!/usr/bin/env bash\nexit 0\n");

    // Native manifest for the single browser.
    for (const browser of config.browsers) {
        const manifestDir = join(home, ".config", `${browser.name}-test`, "NativeMessagingHosts");
        mkdirSync(manifestDir, { recursive: true });
        writeFileSync(join(manifestDir, `${HOST_NAME}.json`), "{}");
    }

    // Config to preserve/remove.
    const cfg = join(home, ".config", "parcel");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "parcelrc"), 'GPG="/usr/bin/gpg"\n');
    mkdirSync(join(home, ".password-store"), { recursive: true });
    writeFileSync(join(home, ".password-store", ".parcel.json"), "{}");

    return { hostBin, cfg };
}

/** Verifies do_uninstall removes host + manifest but preserves config by default. */
test("do_uninstall removes host and manifest but preserves parcelrc and .parcel.json", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const config = configOf([
            { name: "chrome", engine: "chromium", manifestDir: { "linux-user": "~/.config/chrome-test/NativeMessagingHosts" } },
        ]);
        const { hostBin, cfg } = installFixtures(home, config);

        const res = uninstall("", { HOME: home, config, HAS_FLATPAK: false });

        assert.strictEqual(res.code, 0, `uninstall must exit 0 (stderr:\n${res.stderr})`);
        assert.ok(!existsSync(hostBin), "host binary must be removed");
        assert.ok(
            !existsSync(join(home, ".config", "chrome-test", "NativeMessagingHosts", `${HOST_NAME}.json`)),
            "native manifest must be removed",
        );
        assert.ok(existsSync(join(cfg, "parcelrc")), "parcelrc must be preserved by default");
        assert.ok(existsSync(join(home, ".password-store", ".parcel.json")), ".parcel.json must be preserved by default");
        assert.match(res.stderr, /Removed: .*parcel-host/, "removal of the host must be reported");
    } finally {
        cleanup();
    }
});

/** Verifies --remove-config removes parcelrc/.parcel.json but refuses an unexpected config path. */
test("do_uninstall --remove-config removes config and refuses an unexpected config path", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const config = configOf([
            { name: "chrome", engine: "chromium", manifestDir: { "linux-user": "~/.config/chrome-test/NativeMessagingHosts" } },
        ]);
        const { cfg } = installFixtures(home, config);

        // Normal config dir (…/.config/parcel) is removed along with .parcel.json.
        const res = uninstall("", { HOME: home, config, HAS_FLATPAK: false, REMOVE_CONFIG: true });
        assert.strictEqual(res.code, 0);
        assert.ok(!existsSync(cfg), "parcelrc dir must be removed with --remove-config");
        assert.ok(!existsSync(join(home, ".password-store", ".parcel.json")), ".parcel.json must be removed with --remove-config");

        // A config path that does not match /*\/parcel must be refused, not deleted.
        const weirdCfg = join(home, "not-a-parcel-dir");
        mkdirSync(weirdCfg, { recursive: true });
        writeFileSync(join(weirdCfg, "parcelrc"), "x\n");
        const guarded = sourceScript(
            `OS="linux"
RESOLVED_LEVEL="user"
HOST_NAME="${HOST_NAME}"
HOST_BIN_PATH="$HOME/.local/bin/parcel-host"
CONFIG_DIR="$HOME/not-a-parcel-dir"
PASSWORD_STORE_DIR="$HOME/.password-store"
HAS_FLATPAK=false
REVOKE_FLATPAK_DBUS=false
REMOVE_CONFIG=true
do_uninstall`,
            { env: { HOME: home, SETUP_CONFIG: JSON.stringify(config), TMPDIR: home } },
        );
        assert.ok(existsSync(weirdCfg), "unexpected config path must not be removed");
        assert.match(guarded.stderr, /Refusing to remove unexpected config path/, "refusal must be logged");
    } finally {
        cleanup();
    }
});

/** Verifies the flatpak path removes wrappers and revokes the D-Bus talk grant. */
test("do_uninstall removes flatpak wrappers and revokes the D-Bus talk grant", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        writeMockBin(bin, "flatpak", `printf '%s\\n' "\${*:-}" >> "$FLATPAK_LOG"`);
        const flatpakLog = join(home, "flatpak.log");

        const config = configOf([], [{ name: "firefox", appId: "org.mozilla.firefox" }]);

        // Wrapper script in the flatpak wrapper dir.
        const wrapperDir = join(home, ".var", "app", "org.mozilla.firefox", "config", "parcel");
        mkdirSync(wrapperDir, { recursive: true });
        writeFileSync(join(wrapperDir, "parcel-flatpak-wrapper.sh"), "exec flatpak-spawn --host /x/y\n");

        const res = uninstall("", {
            HOME: home,
            config,
            PATH: `${bin}:${process.env.PATH}`,
            HAS_FLATPAK: true,
            REVOKE_FLATPAK_DBUS: true,
            FLATPAK_LOG: flatpakLog,
        });

        assert.strictEqual(res.code, 0, `flatpak uninstall must exit 0 (stderr:\n${res.stderr})`);
        assert.ok(!existsSync(join(wrapperDir, "parcel-flatpak-wrapper.sh")), "flatpak wrapper must be removed");
        const log = readFileSync(flatpakLog, "utf8");
        assert.ok(
            log.includes("override --user --no-talk-name=org.freedesktop.Flatpak org.mozilla.firefox"),
            `D-Bus revocation must be issued (got: ${JSON.stringify(log)})`,
        );
    } finally {
        cleanup();
    }
});

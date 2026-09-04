"use strict";

/**
 * Behavioural test for detect_password_store: verifies the precedence order
 * (explicit --passdir flag > parcelrc > environment > ~/.password-store), that
 * parcelrc/env values are tilde-expanded, and that CUSTOM_PASSWORD_STORE_DIR is
 * only set for a non-default location.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome } from "./harness.js";

/**
 * Run detect_password_store with a controlled env, reporting the resolved store
 * dir and whether it was marked custom.
 * @param {string} code - Bash snippet run after sourcing (must call detect_password_store).
 * @param {Record<string, string>} env - Extra environment variables.
 * @returns {{stdout:string, stderr:string, code:number|null}} Result tuple.
 * @since 1.0.7
 */
function detectStore(code, env) {
    const body = `${code}
detect_password_store
printf '%s|%s' "$PASSWORD_STORE_DIR" "$CUSTOM_PASSWORD_STORE_DIR"`;
    return sourceScript(body, { env: { HOME: env.HOME, ...env } });
}

/** Verifies detect_password_store resolves by precedence and expands tildes. */
test("detect_password_store resolves flag > parcelrc > env > default", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });

        // 1. Explicit --passdir flag beats a parcelrc value.
        writeFileSync(join(cfg, "parcelrc"), 'PASSWORD_STORE_DIR="/from/parcelrc"\n');
        const flag = detectStore(
            `CONFIG_DIR="$HOME/.config/parcel"
PASS_DIR_EXPLICIT=true
PASSWORD_STORE_DIR="/explicit/store"`,
            { HOME: home },
        );
        assert.strictEqual(flag.stdout, "/explicit/store|/explicit/store", "--passdir must win and be marked custom");

        // 2. parcelrc beats the environment, and tilde is expanded.
        const viaParcelrc = detectStore(
            `CONFIG_DIR="$HOME/.config/parcel"
PASSWORD_STORE_DIR="/from/env"`,
            { HOME: home },
        );
        assert.strictEqual(viaParcelrc.stdout, "/from/parcelrc|/from/parcelrc", "parcelrc must override the environment");

        // 3. Environment used when no parcelrc value is present.
        writeFileSync(join(cfg, "parcelrc"), 'JQ="/usr/bin/jq"\n');
        const viaEnv = detectStore(
            `CONFIG_DIR="$HOME/.config/parcel"
PASSWORD_STORE_DIR="/from/env"`,
            { HOME: home },
        );
        assert.strictEqual(viaEnv.stdout, "/from/env|/from/env", "environment must be used when parcelrc lacks the key");

        // 4. ~/.password-store default, not marked custom.
        mkdirSync(join(home, ".password-store"), { recursive: true });
        writeFileSync(join(cfg, "parcelrc"), "");
        const fallback = detectStore(`CONFIG_DIR="$HOME/.config/parcel"`, { HOME: home });
        assert.strictEqual(
            fallback.stdout,
            `${home}/.password-store|`,
            "~/.password-store must be the default and leave CUSTOM_PASSWORD_STORE_DIR empty",
        );

        // 5. Tilde-leading parcelrc value is expanded via $HOME.
        writeFileSync(join(cfg, "parcelrc"), 'PASSWORD_STORE_DIR="~/sub/store"\n');
        const tilde = detectStore(`CONFIG_DIR="$HOME/.config/parcel"`, { HOME: home });
        assert.strictEqual(tilde.stdout, `${home}/sub/store|${home}/sub/store`, "parcelrc tilde must expand against HOME");
    } finally {
        cleanup();
    }
});

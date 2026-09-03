"use strict";

/**
 * Behavioural tests for the error/signal paths: die's exit code + message,
 * cleanup's removal of registered temp files, on_signal's interrupt handling
 * (with the apply-phase caveat), and second_smoke_test's parcelrc rollback
 * when the verification smoke test fails.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome, writeMockBin } from "./harness.js";

/** Verifies die logs the message and exits with the requested code. */
test("die logs the message and exits with the requested code", () => {
    const res = sourceScript(`die "boom" 7`);
    assert.strictEqual(res.code, 7, "die must honour the explicit exit code");
    assert.match(res.stderr, /boom/, "die must print the message to stderr");
});

/** Verifies cleanup removes every file registered in TEMP_FILES. */
test("cleanup removes every file registered in TEMP_FILES", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const a = join(home, "a");
        const b = join(home, "b");
        writeFileSync(a, "x");
        writeFileSync(b, "y");

        const res = sourceScript(
            `TEMP_FILES="$T_A $T_B"
cleanup`,
            { env: { HOME: home, T_A: a, T_B: b } },
        );

        assert.strictEqual(res.code, 0);
        assert.ok(!existsSync(a), "first temp file must be removed");
        assert.ok(!existsSync(b), "second temp file must be removed");
    } finally {
        cleanup();
    }
});

/** Verifies on_signal warns about the interrupted phase, cleans up, and exits 3. */
test("on_signal warns, cleans up, and exits 3 during the apply phase", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const a = join(home, "partial");
        writeFileSync(a, "x");

        const res = sourceScript(
            `PHASE="apply"
TEMP_FILES="$T_A"
on_signal`,
            { env: { HOME: home, T_A: a } },
        );

        assert.strictEqual(res.code, 3, "on_signal must exit 3");
        assert.match(res.stderr, /Interrupted during apply phase/, "phase must be reported");
        assert.match(res.stderr, /Partial changes may exist/, "apply-phase caveat must be reported");
        assert.ok(!existsSync(a), "temp files must be cleaned up by on_signal");
    } finally {
        cleanup();
    }
});

/** Verifies a failed second smoke test reverts parcelrc from its backup. */
test("second_smoke_test reverts parcelrc customisations when the verify smoke test fails", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });
        const parcelrc = join(cfg, "parcelrc");
        writeFileSync(parcelrc, "customised\n");

        const backup = join(home, "backup-rc");
        writeFileSync(backup, "original\n");

        const bin = join(home, "bin");
        const hostBin = writeMockBin(bin, "parcel-host", "exit 1");

        const res = sourceScript(
            `CONFIG_DIR="$HOME/.config/parcel"
HOST_BIN_PATH="$HOST_BIN"
PARCELRC_BACKUP="$BACKUP"
APPLIED_PARCELRC_CHANGES="GPG JQ"
second_smoke_test`,
            { env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, HOST_BIN: hostBin, BACKUP: backup, TMPDIR: home } },
        );

        assert.strictEqual(res.code, 1, "a failed verification smoke test must die with exit 1");
        assert.match(res.stderr, /Second smoke test failed/, "the failure must be reported");
        assert.match(res.stderr, /Reverted parcelrc customisations/, "the rollback must be reported");
        assert.strictEqual(readFileSync(parcelrc, "utf8"), "original\n", "parcelrc must be restored from the backup");
    } finally {
        cleanup();
    }
});

/** Verifies main refuses a bare `sudo parcel-setup.sh` (root via sudo, not self-elevated). */
test("main refuses a manual sudo with guidance to run without it", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const bin = join(home, "bin");
        // Pretend to be root so the guard's id -u check fires.
        writeMockBin(bin, "id", 'printf "0\\n"');

        const noMarker = sourceScript(`main`, {
            env: { HOME: home, SUDO_USER: "alice", PATH: `${bin}:${process.env.PATH}` },
        });
        assert.strictEqual(noMarker.code, 1, "a bare sudo must be refused with exit 1");
        assert.match(noMarker.stderr, /without sudo/, "the refusal must advise running without sudo");
    } finally {
        cleanup();
    }
});

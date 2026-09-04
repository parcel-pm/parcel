"use strict";

/**
 * Behavioural tests for the parcelrc path: set_parcelrc_var's insert/no-op/
 * force/0600 semantics, apply_parcelrc_customisations' selective writes, and
 * apply_host_hash's opt-in pinning.
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceScript, makeTempHome } from "./harness.js";

/** Asserts a parcelrc file is private (0600). */
function expectPrivate(path) {
    assert.strictEqual(statSync(path).mode & 0o777, 0o600, `${path} must remain 0600`);
}

/** Verifies set_parcelrc_var insert-below-default, no-op, force-replace, and append behaviour. */
test("set_parcelrc_var inserts below the default, no-ops when set, replaces on force, and keeps 0600", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const rc = join(home, "parcelrc");
        writeFileSync(rc, '# GPG="/usr/bin/gpg"\nJQ="/usr/bin/jq"\n');

        const res = sourceScript(
            `set_parcelrc_var "$TEST_RC" "GPG" "/custom/gpg"; echo "1:$?"
set_parcelrc_var "$TEST_RC" "JQ" "/x"; echo "2:$?"
set_parcelrc_var "$TEST_RC" "JQ" "/y" force; echo "3:$?"
set_parcelrc_var "$TEST_RC" "HOST_HASH" "abc123"; echo "4:$?"`,
            { env: { HOME: home, TMPDIR: home, TEST_RC: rc } },
        );

        assert.strictEqual(res.code, 0);
        assert.deepStrictEqual(
            res.stdout.trim().split("\n"),
            ["1:0", "2:1", "3:0", "4:0"],
            "insert/no-op(1)/force/append must report 0,1,0,0",
        );
        assert.strictEqual(
            readFileSync(rc, "utf8"),
            '# GPG="/usr/bin/gpg"\nGPG="/custom/gpg"\nJQ="/y"\nHOST_HASH="abc123"\n',
            "GPG below its default, JQ force-replaced, HOST_HASH appended (no default line)",
        );
        expectPrivate(rc);
    } finally {
        cleanup();
    }
});

/** Verifies apply_parcelrc_customisations writes tool paths selectively and force-writes PASSWORD_STORE_DIR. */
test("apply_parcelrc_customisations writes tool paths and force-writes PASSWORD_STORE_DIR", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });
        const rc = join(cfg, "parcelrc");
        writeFileSync(rc, '# GPG="/usr/bin/gpg"\n# JQ="/usr/bin/jq"\nOPENSSL="/usr/bin/openssl"\n');

        const run = (code) => sourceScript(code, { env: { HOME: home, TMPDIR: home } });

        const applied = run(`CONFIG_DIR="$HOME/.config/parcel"
CUSTOM_GPG="/custom/gpg"
CUSTOM_JQ="/custom/jq"
CUSTOM_OPENSSL="/custom/openssl"
CUSTOM_PASSWORD_STORE_DIR="/custom/pass"
apply_parcelrc_customisations
printf 'CHANGES:%s\n' "$APPLIED_PARCELRC_CHANGES"
[ -n "$PARCELRC_BACKUP" ] && echo "BACKUP:set" || echo "BACKUP:unset"`);
        assert.strictEqual(applied.code, 0);

        // GPG/JQ inserted below their defaults; OPENSSL left untouched (already set, not forced);
        // PASSWORD_STORE_DIR always force-written (appended — it has no default comment).
        assert.strictEqual(
            readFileSync(rc, "utf8"),
            '# GPG="/usr/bin/gpg"\nGPG="/custom/gpg"\n# JQ="/usr/bin/jq"\nJQ="/custom/jq"\nOPENSSL="/usr/bin/openssl"\nPASSWORD_STORE_DIR="/custom/pass"\n',
        );
        assert.match(applied.stdout, /CHANGES: GPG JQ PASSWORD_STORE_DIR/, "applied changes recorded, OPENSSL excluded");
        assert.match(applied.stdout, /BACKUP:set/, "a pre-change backup must exist for rollback");
        expectPrivate(rc);

        // FORCE_* clobbers an existing (broken-parcelrc) value.
        const forced = run(`CONFIG_DIR="$HOME/.config/parcel"
FORCE_OPENSSL=true
CUSTOM_OPENSSL="/new/openssl"
apply_parcelrc_customisations
printf 'CHANGES:%s\n' "$APPLIED_PARCELRC_CHANGES"`);
        assert.match(forced.stdout, /CHANGES: OPENSSL/, "forced OPENSSL must be recorded alone");
        assert.match(readFileSync(rc, "utf8"), /OPENSSL="\/new\/openssl"/, "existing OPENSSL must be overwritten");
    } finally {
        cleanup();
    }
});

/** Verifies apply_host_hash pins the signed host hash only when the user opted in. */
test("apply_host_hash pins the signed host hash only when opted in", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });
        const rc = join(cfg, "parcelrc");

        const run = (code) => sourceScript(code, { env: { HOME: home, TMPDIR: home } });

        // No opt-in -> no-op.
        writeFileSync(rc, '# HOST_HASH=""\n');
        const skip = run(`CONFIG_DIR="$HOME/.config/parcel"
WANTS_HOST_HASH=false
SIGNED_HOST_SHA256="deadbeef"
apply_host_hash
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(skip.stdout, "CHANGES:", "no changes when not opted in");
        assert.strictEqual(readFileSync(rc, "utf8"), '# HOST_HASH=""\n');

        // Opted in -> pinned below the default.
        const apply = run(`CONFIG_DIR="$HOME/.config/parcel"
WANTS_HOST_HASH=true
SIGNED_HOST_SHA256="deadbeef"
apply_host_hash
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(apply.stdout, "CHANGES: HOST_HASH");
        assert.strictEqual(readFileSync(rc, "utf8"), '# HOST_HASH=""\nHOST_HASH="deadbeef"\n');
        expectPrivate(rc);
    } finally {
        cleanup();
    }
});

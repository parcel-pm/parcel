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

/** Verifies apply_minimum_host_version raises the floor but never lowers an existing higher one. */
test("apply_minimum_host_version raises the floor and preserves a higher existing floor", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });
        const rc = join(cfg, "parcelrc");

        const run = (code) => sourceScript(code, { env: { HOME: home, TMPDIR: home } });

        // Malformed embedded version -> no-op.
        writeFileSync(rc, '# MINIMUM_HOST_VERSION="0"\n');
        const skip = run(`CONFIG_DIR="$HOME/.config/parcel"
HOST_VERSION="bogus"
apply_minimum_host_version
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(skip.stdout, "CHANGES:", "no changes without a valid embedded version");
        assert.strictEqual(readFileSync(rc, "utf8"), '# MINIMUM_HOST_VERSION="0"\n');

        // Missing floor -> set below the commented default.
        const apply = run(`CONFIG_DIR="$HOME/.config/parcel"
HOST_VERSION="3"
apply_minimum_host_version
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(apply.stdout, "CHANGES: MINIMUM_HOST_VERSION");
        assert.strictEqual(readFileSync(rc, "utf8"), '# MINIMUM_HOST_VERSION="0"\nMINIMUM_HOST_VERSION="3"\n');
        expectPrivate(rc);

        // Higher existing floor -> preserved.
        const higher = run(`CONFIG_DIR="$HOME/.config/parcel"
HOST_VERSION="3"
apply_minimum_host_version
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(higher.stdout, "CHANGES:", "an equal floor is left alone");
        writeFileSync(rc, 'MINIMUM_HOST_VERSION="9"\n');
        const preserve = run(`CONFIG_DIR="$HOME/.config/parcel"
HOST_VERSION="3"
apply_minimum_host_version
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(preserve.stdout, "CHANGES:", "a higher floor is never lowered");
        assert.strictEqual(readFileSync(rc, "utf8"), 'MINIMUM_HOST_VERSION="9"\n');

        // Lower existing floor -> raised in place.
        writeFileSync(rc, 'MINIMUM_HOST_VERSION="1"\n');
        const raise = run(`CONFIG_DIR="$HOME/.config/parcel"
HOST_VERSION="5"
apply_minimum_host_version
printf 'CHANGES:%s' "$APPLIED_PARCELRC_CHANGES"`);
        assert.strictEqual(raise.stdout, "CHANGES: MINIMUM_HOST_VERSION");
        assert.strictEqual(readFileSync(rc, "utf8"), 'MINIMUM_HOST_VERSION="5"\n');
    } finally {
        cleanup();
    }
});

/** Verifies install_system_parcelrc creates the template only in system mode and never clobbers an existing file. */
test("install_system_parcelrc creates the template in system mode only, and never clobbers", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const sysrc = join(home, "parcelrc-system");

        const res = sourceScript(
            `SYSTEM_PARCELRC="$SYSRC"
RESOLVED_LEVEL="user"
install_system_parcelrc
printf 'user:%s\\n' "$([ -e "$SYSRC" ] && echo created || echo skipped)"
RESOLVED_LEVEL="system"
install_system_parcelrc
printf 'system:%s\\n' "$([ -f "$SYSRC" ] && echo created || echo missing)"
printf 'VALID_SIGNERS="ABC"\\n' > "$SYSRC"
install_system_parcelrc
printf 'clobber:%s\\n' "$(grep -c 'VALID_SIGNERS="ABC"' "$SYSRC")"`,
            { env: { HOME: home, TMPDIR: home, SYSRC: sysrc } },
        );

        assert.strictEqual(res.code, 0, `harness failed: ${res.stderr}`);
        assert.deepStrictEqual(res.stdout.trim().split("\n"), ["user:skipped", "system:created", "clobber:1"]);
        assert.strictEqual(statSync(sysrc).mode & 0o777, 0o644, "system parcelrc must be 0644");
    } finally {
        cleanup();
    }
});

/** Verifies the installed system parcelrc template passes the bootstrap's whitelist parser cleanly. */
test("system parcelrc template parses cleanly through the bootstrap whitelist parser", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const setupSrc = readFileSync(join(import.meta.dirname, "..", "..", "src", "parcel-setup.sh"), "utf8");
        const tpl = setupSrc.match(/cat > "\$SYSTEM_PARCELRC" <<'EOT'\n([\s\S]*?)\nEOT\n/);
        assert.ok(tpl, "parcel-setup.sh must contain the system parcelrc template heredoc");

        const bootstrapSrc = readFileSync(join(import.meta.dirname, "..", "..", "parcel-host"), "utf8");
        const fn = (name) => {
            const m = bootstrapSrc.match(new RegExp(`^function ${name}\\(\\) \\{\\n(?:.|\\n)*?^\\}\\n`, "m"));
            assert.ok(m, `parcel-host must define ${name}()`);
            return m[0];
        };

        const sysrc = join(home, "parcelrc-system");
        writeFileSync(sysrc, tpl[1] + "\n");

        const res = sourceScript(
            `FPR_PATTERN='[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?'
BLACKLIST_VALUE_RE="^(\${FPR_PATTERN}( \${FPR_PATTERN})*)?$"
PARCELRC_NOTES=""
function parcelrc_note() { PARCELRC_NOTES+="$1"$'\\n'; }
function parcelrc_fatal() { printf 'FATAL:%s\\n' "$1"; exit 43; }
${fn("parcelrc_apply")}
${fn("load_parcelrc")}
load_parcelrc "$SYSRC" "$SYSRC"
printf 'KEYS:%s\\n' "$PARCELRC_KEYS_SET"
printf 'NOTES:%s\\n' "$PARCELRC_NOTES"`,
            { env: { HOME: home, TMPDIR: home, SYSRC: sysrc } },
        );

        assert.strictEqual(res.code, 0, `template must not trip a fatal: ${res.stdout}`);
        const lines = res.stdout.trim().split("\n");
        assert.strictEqual(lines[0], "KEYS:", "a fully commented template must stage no keys");
        assert.strictEqual(lines[1], "NOTES:", "a fully commented template must produce no notes");
    } finally {
        cleanup();
    }
});

/** Verifies apply_minimum_host_version also raises the floor in the system parcelrc in system mode. */
test("apply_minimum_host_version raises the floor in the system parcelrc in system mode", () => {
    const { home, cleanup } = makeTempHome();
    try {
        const cfg = join(home, ".config", "parcel");
        mkdirSync(cfg, { recursive: true });
        const rc = join(cfg, "parcelrc");
        const sysrc = join(home, "parcelrc-system");
        writeFileSync(rc, '# MINIMUM_HOST_VERSION="0"\n');
        writeFileSync(sysrc, '# MINIMUM_HOST_VERSION="0"\n');

        const run = (code) => sourceScript(code, { env: { HOME: home, TMPDIR: home, SYSRC: sysrc } });

        // Missing system floor -> set alongside the user floor in system mode.
        const apply = run(`CONFIG_DIR="$HOME/.config/parcel"
SYSTEM_PARCELRC="$SYSRC"
RESOLVED_LEVEL="system"
HOST_VERSION="4"
apply_minimum_host_version`);
        assert.strictEqual(apply.code, 0, `harness failed: ${apply.stderr}`);
        assert.strictEqual(readFileSync(rc, "utf8"), '# MINIMUM_HOST_VERSION="0"\nMINIMUM_HOST_VERSION="4"\n');
        assert.strictEqual(readFileSync(sysrc, "utf8"), '# MINIMUM_HOST_VERSION="0"\nMINIMUM_HOST_VERSION="4"\n');
        // the host reads the system file while running unprivileged, so the write
        // must not tighten it to the user-file default of 0600
        assert.strictEqual(statSync(sysrc).mode & 0o777, 0o644, "system parcelrc must remain 0644 after the floor write");

        // Higher existing system floor -> preserved.
        const preserve = run(`CONFIG_DIR="$HOME/.config/parcel"
SYSTEM_PARCELRC="$SYSRC"
RESOLVED_LEVEL="system"
HOST_VERSION="2"
apply_minimum_host_version`);
        assert.strictEqual(preserve.code, 0, `harness failed: ${preserve.stderr}`);
        assert.strictEqual(readFileSync(sysrc, "utf8"), '# MINIMUM_HOST_VERSION="0"\nMINIMUM_HOST_VERSION="4"\n');

        // User-level installs never touch the system file.
        writeFileSync(sysrc, '# MINIMUM_HOST_VERSION="0"\n');
        const userMode = run(`CONFIG_DIR="$HOME/.config/parcel"
SYSTEM_PARCELRC="$SYSRC"
RESOLVED_LEVEL="user"
HOST_VERSION="6"
apply_minimum_host_version`);
        assert.strictEqual(userMode.code, 0, `harness failed: ${userMode.stderr}`);
        assert.strictEqual(readFileSync(sysrc, "utf8"), '# MINIMUM_HOST_VERSION="0"\n', "user mode must not touch the system file");
    } finally {
        cleanup();
    }
});

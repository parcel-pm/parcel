/**
 * Native Host Integration Tests
 *
 * Uses node:test (built-in, no third-party deps) to test both the bootstrap
 * script (parcel-host) and the main host script (src/parcel-host).
 *
 * Tests run in isolated temporary HOME directories to avoid side effects.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync, readdirSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary test environment with mock GPG, parcelrc, password store,
 * and .parcel.json config.
 */
function createTestEnv(opts = {}) {
    const home = mkdtempSync(join(tmpdir(), "parcel-test-"));
    const passdirName = opts.passdirName ?? ".password-store";
    const passdir = join(home, passdirName);
    const configdir = join(home, ".config", "parcel");
    const logdir = join(home, ".local", "log");
    const bindir = join(home, "bin");

    mkdirSync(configdir, { recursive: true });
    mkdirSync(logdir, { recursive: true });
    mkdirSync(bindir, { recursive: true });

    if (opts.rootSymlink) {
        const realPassdir = join(home, `${passdirName}-real`);
        mkdirSync(realPassdir, { recursive: true });
        symlinkSync(realPassdir, passdir);
    } else {
        mkdirSync(passdir, { recursive: true });
    }

    // Mock gpg binary.
    // The bootstrap extracts the signer via: grep VALIDSIG | cut -d' ' -f12
    // Real GnuPG field 12 is the primary fingerprint. We replicate the layout.
    const knownSigner = opts.knownSigner ?? "88FF14D6294AF4036B7F00FF676A3C09E2E47A72";
    const mockGpg = join(bindir, "gpg");
    writeFileSync(
        mockGpg,
        `#!/bin/bash
set -e
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    # Replicate VALIDSIG fields: [GNUPG:] VALIDSIG <subkey> <date> <ts> <expire> <hash> <pk> <x> <y> <z> <primary>
    echo "[GNUPG:] VALIDSIG ${knownSigner} 2026-05-01 0 0 4 0 1 8 00 ${knownSigner}"
    exit 0
fi
if [[ "$*" == *"--decrypt"* ]]; then
    echo "test-decrypted-content"
    exit 0
fi
if [[ "$*" == *"--version"* ]]; then
    echo "gpg (GnuPG) 2.5.0"
    exit 0
fi
exec $(which gpg || echo /usr/bin/gpg) "$@"
`,
    );
    chmodSync(mockGpg, 0o755);

    // parcelrc startup config
    const parcelrc = join(configdir, "parcelrc");
    writeFileSync(
        parcelrc,
        `PASSWORD_STORE_DIR="${passdir}"
LOGFILE="${join(logdir, "parcel-host.log")}"
VALID_SIGNERS="${knownSigner}"
`,
    );
    chmodSync(parcelrc, 0o600);

    // .parcel.json
    const parcelJson = join(passdir, ".parcel.json");
    writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }] }));

    // Fake password entries
    writeFileSync(join(passdir, "test-entry.gpg"), "encrypted-a");
    writeFileSync(join(passdir, "another-entry.gpg"), "encrypted-b");
    mkdirSync(join(passdir, "subfolder"), { recursive: true });
    writeFileSync(join(passdir, "subfolder", "nested.gpg"), "encrypted-c");

    // Internal symlink (target inside password store)
    writeFileSync(join(passdir, "internal-target.gpg"), "encrypted-i");
    symlinkSync(join(passdir, "internal-target.gpg"), join(passdir, "internal-link.gpg"));

    // Symlinked directory outside the password store
    const outsideDir = join(home, "outside-store");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "symlinked-entry.gpg"), "encrypted-d");
    mkdirSync(join(outsideDir, "symlinked-sub"), { recursive: true });
    writeFileSync(join(outsideDir, "symlinked-sub", "deep.gpg"), "encrypted-e");
    // Symlink the entire directory into the password store
    const linkTarget = join(passdir, "symlinked-dir");
    // Use Node's symlinkSync with type 'dir' for cross-platform compatibility
    // On Unix, type defaults to 'file', but for directories we don't strictly
    // need to specify it - the OS resolves it correctly.
    symlinkSync(outsideDir, linkTarget);

    return {
        home,
        passdir,
        bin: bindir,
        knownSigner,
        mockGpgPath: mockGpg,
        cleanup() {
            rmSync(home, { recursive: true, force: true });
        },
    };
}

/**
 * Recursively set directory modification times to a fixed point in the past.
 * This lets changes_since tests assert about specific newer directories without
 * the password store root itself appearing changed.
 */
function setDirectoryMtimesSync(dir, date) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
            setDirectoryMtimesSync(child, date);
        }
    }
    utimesSync(dir, date, date);
}

/**
 * Encode a message using the native messaging host protocol:
 * 4-byte little-endian length prefix + JSON payload.
 */
function encodeMessage(msg) {
    const json = typeof msg === "string" ? msg : JSON.stringify(msg);
    const buf = Buffer.alloc(4 + Buffer.byteLength(json, "utf8"));
    buf.writeUInt32LE(Buffer.byteLength(json, "utf8"), 0);
    buf.write(json, 4, "utf8");
    return buf;
}

/**
 * Async message reader for a native messaging stream.
 */
function createMessageReader(stream) {
    let buffer = Buffer.alloc(0);
    const pending = [];
    let ended = false;

    stream.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const len = buffer.readUInt32LE(0);
            if (buffer.length < 4 + len) break;
            const json = buffer.subarray(4, 4 + len).toString("utf8");
            buffer = buffer.subarray(4 + len);
            const resolve = pending.shift();
            if (resolve) {
                try {
                    resolve(JSON.parse(json));
                } catch (e) {
                    resolve({ _parseError: e.message, _raw: json });
                }
            }
        }
    });

    stream.on("end", () => {
        ended = true;
        while (pending.length) {
            const resolve = pending.shift();
            resolve({ _streamEnded: true });
        }
    });

    stream.on("error", (err) => {
        while (pending.length) {
            const resolve = pending.shift();
            resolve({ _streamError: err.message });
        }
    });

    return function readMessage() {
        return new Promise((resolve) => {
            if (ended && buffer.length < 4) {
                resolve({ _streamEnded: true });
                return;
            }
            pending.push(resolve);
        });
    };
}

/**
 * Spawn the bootstrap script with a test environment.
 */
function spawnBootstrap(env) {
    const proc = spawn("bash", ["./parcel-host"], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...process.env,
            HOME: env.home,
            PATH: `${env.bin}:${process.env.PATH}`,
        },
    });

    const read = createMessageReader(proc.stdout);

    const send = (msg) => {
        if (!proc.killed) {
            proc.stdin.write(encodeMessage(msg));
        }
    };

    // Suppress EPIPE errors when a test kills the process
    proc.stdin.on("error", () => {});

    return { proc, read, send };
}

/**
 * Install the main host script via the bootstrap, returning the connected
 * process and message reader ready for main-script actions.
 */
async function installMainScript(env) {
    const { proc, read, send } = spawnBootstrap(env);

    // Consume bootstrap announcement
    const bootstrapMsg = await read();
    assert.strictEqual(bootstrapMsg.data?.action, "bootstrap", "Expected bootstrap message, got: " + JSON.stringify(bootstrapMsg));

    const mainScript = readFileSync("src/parcel-host", "utf8");
    send({
        action: "install",
        script: mainScript,
        signature: "fake-signature",
    });

    // Consume install result
    const installResult = await read();
    assert.strictEqual(installResult.data?.success, true, `Install failed: ${JSON.stringify(installResult)}`);

    return { proc, read, send };
}

// ---------------------------------------------------------------------------
// Bootstrap script tests
// ---------------------------------------------------------------------------

describe("Bootstrap script", () => {
    test("sends bootstrap message on startup", async () => {
        const env = createTestEnv();
        const { proc, read } = spawnBootstrap(env);
        try {
            const msg = await read();
            assert.strictEqual(msg.token, "broadcast");
            assert.strictEqual(msg.data?.action, "bootstrap");
            assert.strictEqual(msg.data?.version, "1");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects install with missing signature", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            send({ action: "install", script: "test", signature: null });
            const msg = await read();
            // parcel_error wraps the JSON in a plain string inside msg.error
            assert.ok(msg.error, `Expected error, got: ${JSON.stringify(msg)}`);
            const errObj = JSON.parse(msg.error);
            assert.strictEqual(errObj.action, "install-result");
            assert.strictEqual(errObj.valid, false);
            assert.ok(errObj.message?.toLowerCase().includes("signature"));
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects install with missing script", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            send({ action: "install", script: null, signature: "sig" });
            const msg = await read();
            assert.ok(msg.error, `Expected error, got: ${JSON.stringify(msg)}`);
            const errObj = JSON.parse(msg.error);
            assert.strictEqual(errObj.valid, false);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects install with invalid signer", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            // Override mock gpg to return unknown signer
            writeFileSync(
                env.mockGpgPath,
                `#!/bin/bash
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    echo "[GNUPG:] VALIDSIG DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF 2026-05-01 0 0 4 0 1 8 00 DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"
    exit 0
fi
exec $(which gpg || echo /usr/bin/gpg) "$@"
`,
            );
            send({ action: "install", script: "test", signature: "sig" });
            const msg = await read();
            assert.ok(msg.error?.toLowerCase().includes("fingerprint"), `Expected fingerprint error, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("accepts install with valid signer and no hash", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            const script = "console.log('host script');";
            send({ action: "install", script, signature: "sig" });
            const msg = await read();
            assert.strictEqual(msg.data?.success, true);
            assert.ok(msg.data?.message?.toLowerCase().includes("installed"));
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects install when HOST_HASH does not match", async () => {
        const env = createTestEnv();
        // Set a HOST_HASH that won't match
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const existing = readFileSync(parcelrc, "utf8");
        writeFileSync(parcelrc, existing + '\nHOST_HASH="0000000000000000000000000000000000000000000000000000000000000000"\n');
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            const script = "console.log('host script');";
            send({ action: "install", script, signature: "sig" });
            const msg = await read();
            assert.ok(msg.error?.toLowerCase().includes("hash"), `Expected hash error, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects unknown action", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            send({ action: "nonexistent" });
            const msg = await read();
            assert.ok(msg.error?.toLowerCase().includes("unknown"), `Expected unknown action error, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("creates parcelrc if it does not exist", async () => {
        const home = mkdtempSync(join(tmpdir(), "parcel-test-"));
        const passdir = join(home, ".password-store");
        const logdir = join(home, ".local", "log");
        mkdirSync(passdir, { recursive: true });
        mkdirSync(logdir, { recursive: true });

        // No parcelrc, no .parcel.json, no password entries, and no mock GPG
        const env = { home, passdir, bin: null, knownSigner: null };
        const { proc, read } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            const parcelrc = join(home, ".config", "parcel", "parcelrc");
            const content = readFileSync(parcelrc, "utf8");
            assert.ok(content.includes("VALID_SIGNERS"), "parcelrc should contain default VALID_SIGNERS");
        } finally {
            proc.kill();
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("does not modify existing parcelrc", async () => {
        const env = createTestEnv();
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const original = '# custom header\nPASSWORD_STORE_DIR="custom"\n';
        writeFileSync(parcelrc, original);

        const { proc, read } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            const content = readFileSync(parcelrc, "utf8");
            assert.strictEqual(content, original, "Existing parcelrc should not be modified");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects parcelrc with incorrect permissions", async () => {
        const env = createTestEnv();
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        chmodSync(parcelrc, 0o644);

        const { proc, read } = spawnBootstrap(env);
        try {
            const msg = await read();
            assert.strictEqual(msg.error, "parcelrc file must have permissions 0600");
            assert.strictEqual(msg.token, "broadcast");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("installing a new host script can overwrite bootstrap functions", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg

            // Host script that overrides parcel_send and defines action_test_override.
            // The override happens during eval AFTER action_install returns,
            // so the install response still uses the original parcel_send format.
            const overrideScript = `function parcel_send() {
    parcel_transmit '{"token":"test","data":{"was_overridden":true}}'
}
function action_test_override() {
    parcel_send '{"custom_action":"fired"}'
}
`;
            send({ action: "install", script: overrideScript, signature: "sig" });
            const installMsg = await read();
            // Install uses the OLD parcel_send — expect standard format
            assert.strictEqual(
                installMsg.data?.success,
                true,
                "Install response should use original format, got: " + JSON.stringify(installMsg),
            );

            // After eval reload, send a message triggering the new action
            send({ action: "test_override" });
            const msg = await read();
            // Now parcel_send is overridden — expect the marker payload
            assert.strictEqual(msg.data?.was_overridden, true, "Expected overridden parcel_send after eval, got: " + JSON.stringify(msg));
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects oversized messages", async () => {
        const env = createTestEnv();
        const { proc, read } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg

            // Send a length prefix exceeding the 16 MiB limit
            const oversized = Buffer.alloc(4);
            oversized.writeUInt32LE(16777217, 0);
            proc.stdin.write(oversized);

            const response = await read();
            assert.ok(response.error?.toLowerCase().includes("too large"), `Expected size-limit error, got: ${JSON.stringify(response)}`);

            // The host should exit after rejecting the oversized message
            await new Promise((resolve) => proc.on("exit", resolve));
            assert.ok(proc.exitCode !== 0, "Host should exit with non-zero status");
        } finally {
            if (!proc.killed) proc.kill();
            env.cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Main host script tests (via bootstrap install)
// ---------------------------------------------------------------------------

describe("Main host script", () => {
    test("works with a non-default PASSWORD_STORE_DIR", async () => {
        const env = createTestEnv();
        const customPassdir = join(env.home, "custom-password-store");
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const logfile = join(env.home, ".local", "log", "parcel-host.log");

        mkdirSync(customPassdir, { recursive: true });
        mkdirSync(join(customPassdir, "subfolder"), { recursive: true });
        writeFileSync(join(customPassdir, ".parcel.json"), JSON.stringify({ rules: [{ pattern: "." }] }));
        writeFileSync(join(customPassdir, "custom-entry.gpg"), "encrypted-custom");
        writeFileSync(join(customPassdir, "subfolder", "nested-custom.gpg"), "encrypted-custom-nested");
        writeFileSync(
            parcelrc,
            `PASSWORD_STORE_DIR="${customPassdir}"
LOGFILE="${logfile}"
VALID_SIGNERS="${env.knownSigner}"
`,
        );

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "configure" });
            const configMsg = await read();
            assert.strictEqual(configMsg.data?.passdir, customPassdir);

            send({ action: "list" });
            const listMsg = await read();
            assert.ok(Array.isArray(listMsg.data), `Expected array, got: ${JSON.stringify(listMsg.data)}`);
            assert.deepStrictEqual(
                listMsg.data.map((entry) => entry.name),
                ["custom-entry", "subfolder/nested-custom"],
            );

            const testPath = join(customPassdir, "custom-entry.gpg");
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const decryptMsg = await read();
            assert.strictEqual(decryptMsg.data?.path, testPath);
            assert.strictEqual(decryptMsg.data?.plaintext, "test-decrypted-content");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_configure returns config with passdir and rules", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "configure" });
            const msg = await read();
            assert.strictEqual(msg.data?.passdir, env.passdir);
            assert.ok(Array.isArray(msg.data?.rules));
            assert.strictEqual(msg.data?.rules.length, 1);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list returns filtered entries sorted by name", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            assert.ok(Array.isArray(msg.data), `Expected array, got: ${JSON.stringify(msg.data)}`);
            assert.strictEqual(msg.data.length, 7);
            const names = msg.data.map((e) => e.name).sort();
            assert.deepStrictEqual(names, [
                "another-entry",
                "internal-link",
                "internal-target",
                "subfolder/nested",
                "symlinked-dir/symlinked-entry",
                "symlinked-dir/symlinked-sub/deep",
                "test-entry",
            ]);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list preserves entries with spaces in filenames", async () => {
        const env = createTestEnv();
        writeFileSync(join(env.passdir, "entry with space.gpg"), "encrypted-space");

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name).sort();
            assert.ok(names.includes("entry with space"), `Expected spaced entry in ${JSON.stringify(names)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list preserves literal path characters in store and entry names", async () => {
        const env = createTestEnv({ passdirName: ".password-store[qa]+(1)" });
        writeFileSync(join(env.passdir, "entry[with](regex)+^$.gpg"), "encrypted-regex");

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name).sort();
            assert.ok(names.includes("entry[with](regex)+^$"), `Expected literal entry name in ${JSON.stringify(names)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list populates ALLOWED_FILES for decrypt", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.strictEqual(msg.data?.plaintext, "test-decrypted-content");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list includes symlinked directory entries and allows decrypt", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const entries = msg.data;
            const symlinked = entries.find((e) => e.name === "symlinked-dir/symlinked-entry");
            assert.ok(symlinked, `Expected symlinked-dir/symlinked-entry in ${JSON.stringify(entries.map((e) => e.name))}`);

            send({ action: "decrypt", path: symlinked.path, intent: "test", origin: "test-origin" });
            const decryptMsg = await read();
            assert.strictEqual(decryptMsg.data?.plaintext, "test-decrypted-content");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list excludes symlinked entries when allowLinks is false", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: false }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const entries = msg.data;
            const symlinked = entries.find((e) => e.name === "symlinked-dir/symlinked-entry");
            assert.strictEqual(symlinked, undefined, `Expected no symlinked entries, got: ${JSON.stringify(entries.map((e) => e.name))}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list with allowLinks=true and allowExternalLinks=false includes internal links but excludes external links", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: false }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name).sort();
            assert.ok(names.includes("internal-link"), `Expected internal-link in ${JSON.stringify(names)}`);
            assert.ok(!names.includes("symlinked-dir/symlinked-entry"), `Expected no external links, got: ${JSON.stringify(names)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list with allowLinks=false and allowExternalLinks=true still excludes all links", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: false, allowExternalLinks: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name).sort();
            assert.ok(!names.includes("internal-link"), `Expected no internal links, got: ${JSON.stringify(names)}`);
            assert.ok(!names.includes("symlinked-dir/symlinked-entry"), `Expected no external links, got: ${JSON.stringify(names)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list avoids duplicate names with symlinked directories and files", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: true }));

        // Internal directory symlink pointing to a subdirectory inside the store
        mkdirSync(join(env.passdir, "real-dir"), { recursive: true });
        writeFileSync(join(env.passdir, "real-dir", "inside.gpg"), "encrypted-inside");
        symlinkSync(join(env.passdir, "real-dir"), join(env.passdir, "link-dir"));

        // Multiple file symlinks pointing to the same target
        writeFileSync(join(env.passdir, "shared-target.gpg"), "encrypted-shared");
        symlinkSync(join(env.passdir, "shared-target.gpg"), join(env.passdir, "shared-link-a.gpg"));
        symlinkSync(join(env.passdir, "shared-target.gpg"), join(env.passdir, "shared-link-b.gpg"));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name);
            const uniqueNames = [...new Set(names)];
            assert.strictEqual(names.length, uniqueNames.length, `Duplicate names in action_list output: ${JSON.stringify(names)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list does not get stuck on a symlink loop", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: true }));

        // Create two subdirectories that symlink to each other, forming a loop.
        const loopA = join(env.passdir, "loop-a");
        const loopB = join(env.passdir, "loop-b");
        mkdirSync(loopA, { recursive: true });
        mkdirSync(loopB, { recursive: true });
        symlinkSync(loopB, join(loopA, "to-b"), "dir");
        symlinkSync(loopA, join(loopB, "to-a"), "dir");

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            // The host must not hang; it may return either an error or the entry list.
            assert.ok(
                Array.isArray(msg.data) || msg.error?.toLowerCase().includes("unable to scan files"),
                `Expected response or scan error, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list rejects a symlinked password-store root when allowLinks is false", async () => {
        const env = createTestEnv({ rootSymlink: true });
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: false }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            assert.ok(
                msg.error?.toLowerCase().includes("password_store_dir is a symlink") ||
                    msg.error?.toLowerCase().includes("allowlinks is not enabled"),
                `Expected symlink root error, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_list works with a symlinked password-store root when allowLinks is true", async () => {
        const env = createTestEnv({ rootSymlink: true });
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name);
            assert.ok(names.includes("test-entry"), `Expected store entries from symlinked root, got: ${JSON.stringify(names)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt works with a symlinked password-store root when allowLinks is true", async () => {
        const env = createTestEnv({ rootSymlink: true });
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            send({ action: "decrypt", path: join(env.passdir, "test-entry.gpg"), intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.strictEqual(msg.data?.plaintext, "test-decrypted-content");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_changes_since works with a symlinked password-store root when allowLinks is true", async () => {
        const env = createTestEnv({ rootSymlink: true });
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            const since = String(Math.floor(Date.now() / 1000) - 5);
            send({ action: "changes_since", since });
            const msg = await read();
            assert.strictEqual(typeof msg.data?.changes, "number", `Expected numeric change count, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test(
        "action_list returns an error when find emits an error starting with 'find:'",
        { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "chmod restrictions don't apply to root" : false },
        async () => {
            const env = createTestEnv();
            const restrictedDir = join(env.passdir, "restricted");
            mkdirSync(restrictedDir, { recursive: true });
            writeFileSync(join(restrictedDir, "secret.gpg"), "encrypted-secret");
            chmodSync(restrictedDir, 0o000);

            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                const msg = await read();
                assert.ok(
                    msg.error?.toLowerCase().includes("unable to scan files") || msg.error?.toLowerCase().includes("find:"),
                    `Expected find scan error, got: ${JSON.stringify(msg)}`,
                );
            } finally {
                // restore permissions so cleanup can remove the directory
                chmodSync(restrictedDir, 0o755);
                proc.kill();
                env.cleanup();
            }
        },
    );

    test("action_decrypt rejects out-of-scope path", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            send({ action: "decrypt", path: "/etc/passwd", intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.ok(
                msg.error?.toLowerCase().includes("access denied") || msg.error?.toLowerCase().includes("out of scope"),
                `Expected access denied, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt rejects nonexistent file", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const fakePath = join(env.passdir, "missing.gpg");
            send({ action: "decrypt", path: fakePath, intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.ok(
                msg.error?.toLowerCase().includes("not found") || msg.error?.toLowerCase().includes("access denied"),
                `Expected not found or access denied, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt revalidates symlink scope at decrypt time", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: false }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const linkPath = join(env.passdir, "internal-link.gpg");
            const outsideFile = join(env.home, "outside-file.gpg");
            writeFileSync(outsideFile, "encrypted-outside");

            // Retarget the internal symlink to an external file
            rmSync(linkPath);
            symlinkSync(outsideFile, linkPath);

            send({ action: "decrypt", path: linkPath, intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.ok(
                msg.error?.toLowerCase().includes("access denied") ||
                    msg.error?.toLowerCase().includes("scope") ||
                    msg.error?.toLowerCase().includes("violation"),
                `Expected access denied for retargeted symlink, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt revalidates link policy when a regular file is replaced by a symlink", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: false }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const filePath = join(env.passdir, "test-entry.gpg");
            const outsideFile = join(env.home, "outside-file.gpg");
            writeFileSync(outsideFile, "encrypted-outside");

            // Replace the regular file with a symlink to an external file
            rmSync(filePath);
            symlinkSync(outsideFile, filePath);

            send({ action: "decrypt", path: filePath, intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.ok(
                msg.error?.toLowerCase().includes("access denied") ||
                    msg.error?.toLowerCase().includes("scope") ||
                    msg.error?.toLowerCase().includes("violation"),
                `Expected access denied for file replaced by symlink, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt audits on success", async () => {
        const env = createTestEnv();
        // Enable auditing
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], auditDecrypt: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            await read();

            const log = readFileSync(join(env.home, ".local", "log", "parcel-host.log"), "utf8");
            assert.ok(log.includes("DECRYPT"));
            assert.ok(log.includes("test-origin"));
            assert.ok(log.includes("Success"));
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt sanitises control characters in audit fields", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], auditDecrypt: true }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            send({
                action: "decrypt",
                path: testPath,
                intent: "bad\nintent",
                origin: "bad\norigin",
            });
            await read();

            const log = readFileSync(join(env.home, ".local", "log", "parcel-host.log"), "utf8");
            assert.ok(!log.includes("bad\n"), "Expected newlines to be stripped from audit log");
            assert.ok(log.includes("badintent"), "Expected intent to be concatenated after stripping newline");
            assert.ok(log.includes("badorigin"), "Expected origin to be concatenated after stripping newline");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt does not audit when disabled", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            await read();

            const log = readFileSync(join(env.home, ".local", "log", "parcel-host.log"), "utf8");
            assert.ok(!log.includes("DECRYPT"), "Expected no audit log when disabled");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_changes_since returns numeric change count", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "configure" });
            const config = await read();
            const since = String(config.data?.modified ?? Math.floor(Date.now() / 1000) - 3600);
            send({ action: "changes_since", since });
            const msg = await read();
            assert.strictEqual(typeof msg.data?.changes, "number");
            assert.ok(msg.data.changes >= 0);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_changes_since rejects invalid timestamp", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "changes_since", since: "not-a-timestamp" });
            const msg = await read();
            assert.ok(msg.error?.toLowerCase().includes("invalid"), `Expected invalid timestamp error, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_changes_since ignores denied external symlink directory changes", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: false }));

        // Ensure the password store itself does not appear newer than the reference time.
        setDirectoryMtimesSync(env.passdir, new Date("2000-01-01T00:00:00Z"));

        const { proc, read, send } = await installMainScript(env);
        try {
            const since = Math.floor(Date.now() / 1000);
            const future = new Date((since + 5) * 1000);
            utimesSync(join(env.home, "outside-store", "symlinked-sub"), future, future);

            send({ action: "changes_since", since: String(since) });
            const msg = await read();
            assert.strictEqual(msg.data?.changes, 0, `Expected denied external changes to be ignored, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_changes_since does not get stuck on a symlink loop", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: true }));

        // Create two subdirectories that symlink to each other, forming a loop.
        const loopA = join(env.passdir, "loop-a");
        const loopB = join(env.passdir, "loop-b");
        mkdirSync(loopA, { recursive: true });
        mkdirSync(loopB, { recursive: true });
        symlinkSync(loopB, join(loopA, "to-b"), "dir");
        symlinkSync(loopA, join(loopB, "to-a"), "dir");

        const { proc, read, send } = await installMainScript(env);
        try {
            const since = String(Math.floor(Date.now() / 1000));
            send({ action: "changes_since", since });
            const msg = await read();
            assert.strictEqual(typeof msg.data?.changes, "number", `Expected numeric change count, got: ${JSON.stringify(msg)}`);
            assert.ok(msg.data.changes >= 0, `Expected non-negative change count, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_changes_since includes allowed external symlink directory changes", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], allowLinks: true, allowExternalLinks: true }));

        // Ensure the password store itself does not appear newer than the reference time.
        setDirectoryMtimesSync(env.passdir, new Date("2000-01-01T00:00:00Z"));

        const { proc, read, send } = await installMainScript(env);
        try {
            const since = Math.floor(Date.now() / 1000);
            const future = new Date((since + 5) * 1000);
            utimesSync(join(env.home, "outside-store", "symlinked-sub"), future, future);

            send({ action: "changes_since", since: String(since) });
            const msg = await read();
            assert.ok(msg.data?.changes > 0, `Expected allowed external changes to be counted, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("config is cached between actions", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "configure" });
            const first = await read();
            const firstModified = first.data?.modified;

            send({ action: "configure" });
            const second = await read();
            const secondModified = second.data?.modified;

            assert.strictEqual(firstModified, secondModified, "Config should be cached (same mtime)");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt respects rate limit: allows within bucket", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 3, decryptRate: 1 }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            const anotherPath = join(env.passdir, "another-entry.gpg");

            // First 3 decrypts should succeed
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg1 = await read();
            assert.strictEqual(msg1.data?.plaintext, "test-decrypted-content", `First decrypt failed: ${JSON.stringify(msg1)}`);

            send({ action: "decrypt", path: anotherPath, intent: "test", origin: "test-origin" });
            const msg2 = await read();
            assert.strictEqual(msg2.data?.plaintext, "test-decrypted-content", `Second decrypt failed: ${JSON.stringify(msg2)}`);

            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg3 = await read();
            assert.strictEqual(msg3.data?.plaintext, "test-decrypted-content", `Third decrypt failed: ${JSON.stringify(msg3)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt respects rate limit: blocks excess", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        // Use a very slow refill rate so that timing differences between the
        // two decrypts (e.g. slow processing on CI) cannot refill enough
        // tokens for the second decrypt to succeed.
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg1 = await read();
            assert.strictEqual(msg1.data?.plaintext, "test-decrypted-content", `First decrypt failed: ${JSON.stringify(msg1)}`);

            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg2 = await read();
            assert.ok(msg2.error?.toLowerCase().includes("rate limit"), `Expected rate limit error, got: ${JSON.stringify(msg2)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_decrypt disables rate limit when decryptRate is zero", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0 }));

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");

            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg1 = await read();
            assert.strictEqual(msg1.data?.plaintext, "test-decrypted-content", `First decrypt failed: ${JSON.stringify(msg1)}`);

            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg2 = await read();
            assert.strictEqual(msg2.data?.plaintext, "test-decrypted-content", `Second decrypt failed: ${JSON.stringify(msg2)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });
});

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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync } from "node:fs";
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
    const passdir = join(home, ".password-store");
    const configdir = join(home, ".config", "parcel");
    const logdir = join(home, ".local", "log");
    const bindir = join(home, "bin");

    mkdirSync(passdir, { recursive: true });
    mkdirSync(configdir, { recursive: true });
    mkdirSync(logdir, { recursive: true });
    mkdirSync(bindir, { recursive: true });

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

    // .parcel.json
    const parcelJson = join(passdir, ".parcel.json");
    writeFileSync(
        parcelJson,
        JSON.stringify({ rules: [{ pattern: "." }] }),
    );

    // Fake password entries
    writeFileSync(join(passdir, "test-entry.gpg"), "encrypted-a");
    writeFileSync(join(passdir, "another-entry.gpg"), "encrypted-b");
    mkdirSync(join(passdir, "subfolder"), { recursive: true });
    writeFileSync(join(passdir, "subfolder", "nested.gpg"), "encrypted-c");

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

describe("bootstrap script", () => {
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
        const original = "# custom header\nPASSWORD_STORE_DIR=\"custom\"\n";
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
            assert.strictEqual(installMsg.data?.success, true, "Install response should use original format, got: " + JSON.stringify(installMsg));

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
});

// ---------------------------------------------------------------------------
// Main host script tests (via bootstrap install)
// ---------------------------------------------------------------------------

describe("main host script actions", () => {
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
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            assert.ok(Array.isArray(msg.data), `Expected array, got: ${JSON.stringify(msg.data)}`);
            assert.strictEqual(msg.data.length, 3);
            const names = msg.data.map((e) => e.name).sort();
            assert.deepStrictEqual(names, ["another-entry", "subfolder/nested", "test-entry"]);
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

    test("action_decrypt rejects out-of-scope path", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            send({ action: "decrypt", path: "/etc/passwd", intent: "test", origin: "test-origin" });
            const msg = await read();
            assert.ok(msg.error?.toLowerCase().includes("access denied") || msg.error?.toLowerCase().includes("out of scope"), `Expected access denied, got: ${JSON.stringify(msg)}`);
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
            assert.ok(msg.error?.toLowerCase().includes("not found") || msg.error?.toLowerCase().includes("access denied"), `Expected not found or access denied, got: ${JSON.stringify(msg)}`);
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
});

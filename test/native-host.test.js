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
import { createHash, verify } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import {
    mkdtempSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    chmodSync,
    readFileSync,
    readdirSync,
    symlinkSync,
    utimesSync,
    statSync,
    existsSync,
} from "node:fs";
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
 * Compute the SHA-256 hash of a file, the same way a user would:
 * `sha256sum <file>`.
 */
function sha256sumFile(filePath) {
    const sha256Bin = execSync("command -v sha256sum || command -v sha256", { encoding: "utf8" }).trim();
    return execSync(`${sha256Bin} "${filePath}" | awk '{print $1}'`, {
        encoding: "utf8",
    }).trim();
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
function spawnBootstrap(env, extraEnv = {}) {
    const proc = spawn("bash", ["./parcel-host"], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...process.env,
            HOME: env.home,
            PATH: `${env.bin}:${process.env.PATH}`,
            ...extraEnv,
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
async function installMainScript(env, extraEnv = {}) {
    const { proc, read, send } = spawnBootstrap(env, extraEnv);

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

    test("logs gpg output when signature verification fails", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            // Override mock gpg to simulate a verification failure with a diagnostic message
            writeFileSync(
                env.mockGpgPath,
                `#!/bin/bash
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    echo "[GNUPG:] FAILURE verify 4294967295" >&1
    echo "gpg: verify signatures failed: Unknown system error" >&2
    exit 1
fi
if [[ "$*" == *"--version"* ]]; then
    echo "gpg (GnuPG) 2.5.0"
    exit 0
fi
exit 1
`,
            );
            send({ action: "install", script: "test", signature: "sig" });
            const msg = await read();
            assert.ok(msg.error?.includes("Signature verification failed"), `Expected signature error, got: ${JSON.stringify(msg)}`);

            // Check that the gpg output was written to the log file
            const logContent = readFileSync(join(env.home, ".local", "log", "parcel-host.log"), "utf8");
            assert.ok(logContent.includes("FAILURE verify"), `Expected GPG error in log, got: ${logContent}`);
            assert.ok(logContent.includes("Unknown system error"), `Expected gpg diagnostic in log, got: ${logContent}`);
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

    test("accepts install with multiple valid signers in a multi-sig blob", async () => {
        const env = createTestEnv();
        const secondSigner = "56C3E775E72B0C8B1C0C1BD0B5DB77409B11B601";
        // Add a second valid signer to parcelrc
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const existing = readFileSync(parcelrc, "utf8");
        writeFileSync(
            parcelrc,
            existing.replace(`VALID_SIGNERS="${env.knownSigner}"`, `VALID_SIGNERS="${env.knownSigner} ${secondSigner}"`),
        );
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            // Override mock gpg to return two VALIDSIG lines from two valid signers
            writeFileSync(
                env.mockGpgPath,
                `#!/bin/bash
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    echo "[GNUPG:] VALIDSIG ${env.knownSigner} 2026-05-01 0 0 4 0 1 8 00 ${env.knownSigner}"
    echo "[GNUPG:] VALIDSIG ${secondSigner} 2026-05-01 0 0 4 0 1 8 00 ${secondSigner}"
    exit 0
fi
if [[ "$*" == *"--version"* ]]; then
    echo "gpg (GnuPG) 2.5.0"
    exit 0
fi
exec $(which gpg || echo /usr/bin/gpg) "$@"
`,
            );
            send({ action: "install", script: "console.log('host script');", signature: "sig" });
            const msg = await read();
            assert.strictEqual(msg.data?.success, true, `Expected success, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("accepts install with one trusted and one untrusted signer in a multi-sig blob", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            writeFileSync(
                env.mockGpgPath,
                `#!/bin/bash
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    echo "[GNUPG:] VALIDSIG DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF 2026-05-01 0 0 4 0 1 8 00 DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"
    echo "[GNUPG:] VALIDSIG ${env.knownSigner} 2026-05-01 0 0 4 0 1 8 00 ${env.knownSigner}"
    exit 0
fi
if [[ "$*" == *"--version"* ]]; then
    echo "gpg (GnuPG) 2.5.0"
    exit 0
fi
exec $(which gpg || echo /usr/bin/gpg) "$@"
`,
            );
            send({ action: "install", script: "console.log('host script');", signature: "sig" });
            const msg = await read();
            assert.strictEqual(
                msg.data?.success,
                true,
                `Expected success with one trusted signer in multi-sig blob, got: ${JSON.stringify(msg)}`,
            );
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("rejects install with multiple untrusted signers in a multi-sig blob", async () => {
        const env = createTestEnv();
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            writeFileSync(
                env.mockGpgPath,
                `#!/bin/bash
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    echo "[GNUPG:] VALIDSIG DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF 2026-05-01 0 0 4 0 1 8 00 DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"
    echo "[GNUPG:] VALIDSIG CAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE 2026-05-01 0 0 4 0 1 8 00 CAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE"
    exit 0
fi
if [[ "$*" == *"--version"* ]]; then
    echo "gpg (GnuPG) 2.5.0"
    exit 0
fi
exec $(which gpg || echo /usr/bin/gpg) "$@"
`,
            );
            send({ action: "install", script: "console.log('host script');", signature: "sig" });
            const msg = await read();
            assert.ok(msg.error?.toLowerCase().includes("fingerprint"), `Expected fingerprint error, got: ${JSON.stringify(msg)}`);
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

    test("accepts install when HOST_HASH matches sha256sum of a file with a trailing newline", async () => {
        const env = createTestEnv();
        const script = 'echo "Hello world!"\n';
        const scriptFile = join(env.home, "test-script.sh");
        writeFileSync(scriptFile, script, "utf8");
        const hash = sha256sumFile(scriptFile);
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const existing = readFileSync(parcelrc, "utf8");
        writeFileSync(parcelrc, existing + `\nHOST_HASH="${hash}"\n`);
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            send({ action: "install", script, signature: "sig" });
            const msg = await read();
            assert.strictEqual(msg.data?.success, true, `Expected successful install, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("accepts install when HOST_HASH matches sha256sum of a file without a trailing newline", async () => {
        const env = createTestEnv();
        const script = 'echo "Hello world!"';
        const scriptFile = join(env.home, "test-script.sh");
        writeFileSync(scriptFile, script, "utf8");
        const hash = sha256sumFile(scriptFile);
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const existing = readFileSync(parcelrc, "utf8");
        writeFileSync(parcelrc, existing + `\nHOST_HASH="${hash}"\n`);
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            send({ action: "install", script, signature: "sig" });
            const msg = await read();
            assert.strictEqual(msg.data?.success, true, `Expected successful install, got: ${JSON.stringify(msg)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("accepts install when HOST_HASH matches sha256sum of a file with multiple trailing newlines", async () => {
        const env = createTestEnv();
        const script = 'echo "Hello world!"\n\n';
        const scriptFile = join(env.home, "test-script.sh");
        writeFileSync(scriptFile, script, "utf8");
        const hash = sha256sumFile(scriptFile);
        const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
        const existing = readFileSync(parcelrc, "utf8");
        writeFileSync(parcelrc, existing + `\nHOST_HASH="${hash}"\n`);
        const { proc, read, send } = spawnBootstrap(env);
        try {
            await read(); // bootstrap msg
            send({ action: "install", script, signature: "sig" });
            const msg = await read();
            assert.strictEqual(msg.data?.success, true, `Expected successful install, got: ${JSON.stringify(msg)}`);
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

    test("action_configure works when .parcel.json is missing (no hang)", async () => {
        const env = createTestEnv();
        // Remove .parcel.json so the host must operate without a config file
        rmSync(join(env.passdir, ".parcel.json"));
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "configure" });
            const msg = await read();
            assert.strictEqual(msg.data?.passdir, env.passdir);
            assert.ok(Array.isArray(msg.data?.rules), `Expected default rules array, got: ${JSON.stringify(msg)}`);
            assert.deepStrictEqual(msg.data?.rules, [
                { pattern: "^passkeys/", class: "passkey" },
                { pattern: "^cards/", class: "card" },
                { pattern: "." },
            ]);
            assert.strictEqual(msg.data?.defaultRules, true);
            // modified must be >= 1 to pass schema validation (minimum: 1)
            assert.ok(msg.data?.modified >= 1, `Expected modified >= 1, got: ${msg.data?.modified}`);

            // action_list should also work and return all entries
            send({ action: "list" });
            const listMsg = await read();
            assert.ok(Array.isArray(listMsg.data), `Expected array, got: ${JSON.stringify(listMsg.data)}`);
            assert.ok(listMsg.data.length > 0, "Expected at least one entry with default rules");

            // A second configure should return the same modified value (stable, no loop)
            send({ action: "configure" });
            const msg2 = await read();
            assert.strictEqual(msg2.data?.modified, msg.data?.modified, "modified should be stable across calls");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("action_ping responds with ok", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "ping" });
            const msg = await read();
            assert.deepStrictEqual(msg.data, { ok: true }, `Expected {"ok": true}, got: ${JSON.stringify(msg)}`);
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
            // Assert the order as returned — do not .sort(), or a host-side
            // sorting regression will go undetected
            const names = msg.data.map((e) => e.name);
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

    test("browser-passkey rules never apply to entry matching", async () => {
        const env = createTestEnv();
        mkdirSync(join(env.passdir, "browser-site"), { recursive: true });
        writeFileSync(join(env.passdir, "browser-site", "foo.gpg"), "encrypted-f");
        // class+ignore both filtered out of entry matching: this rule must not
        // hide the entry even though its pattern matches
        writeFileSync(
            join(env.passdir, ".parcel.json"),
            JSON.stringify({ rules: [{ pattern: "^browser", ignore: true, class: "browser-passkey" }, { pattern: "." }] }),
        );

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            const msg = await read();
            const names = msg.data.map((e) => e.name);
            assert.ok(names.includes("browser-site/foo"), `Expected browser-site/foo to remain listed in ${JSON.stringify(names)}`);
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
            const parcelJson = join(env.passdir, ".parcel.json");

            // Modify config content but reset mtime so a caching host won't reload.
            // A non-caching host rebuilds CONFIG from the same mtime but new content,
            // so its returned rules would differ.
            writeFileSync(
                parcelJson,
                JSON.stringify({
                    rules: [{ pattern: "^passkeys/", class: "passkey" }, { pattern: "." }],
                    allowLinks: true,
                }),
            );
            utimesSync(parcelJson, new Date(firstModified * 1000), new Date(firstModified * 1000));

            send({ action: "configure" });
            const second = await read();
            const secondModified = second.data?.modified;

            assert.strictEqual(firstModified, secondModified, "modified should be stable when mtime unchanged");
            // The cached config should still reflect the old rules (1 rule, no passkey class)
            assert.strictEqual(second.data?.rules.length, 1, "Cached config should not reflect mid-flight config change");
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

    test("action_decrypt rate limit persists across host restarts", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        // Use a very slow refill rate so tokens don't recover between hosts
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));

        const testPath = join(env.passdir, "test-entry.gpg");

        // First host: exhaust the single-token bucket
        const host1 = await installMainScript(env);
        try {
            host1.send({ action: "list" });
            await host1.read();

            host1.send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg1 = await host1.read();
            assert.strictEqual(msg1.data?.plaintext, "test-decrypted-content", `First decrypt failed: ${JSON.stringify(msg1)}`);
        } finally {
            host1.proc.kill();
        }

        // Second host: rate limit should still be exhausted
        const host2 = await installMainScript(env);
        try {
            host2.send({ action: "list" });
            await host2.read();

            host2.send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            const msg2 = await host2.read();
            assert.ok(
                msg2.error?.toLowerCase().includes("rate limit"),
                `Expected rate limit error after restart, got: ${JSON.stringify(msg2)}`,
            );
        } finally {
            host2.proc.kill();
            env.cleanup();
        }
    });

    test("rate limit state file is created with 0600 permissions", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));

        const stateFile = join(env.home, ".config", "parcel", "state");

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            const testPath = join(env.passdir, "test-entry.gpg");
            send({ action: "decrypt", path: testPath, intent: "test", origin: "test-origin" });
            await read();

            assert.ok(existsSync(stateFile), `State file not created at ${stateFile}`);
            const mode = statSync(stateFile).mode & 0o777;
            assert.strictEqual(mode, 0o600, `State file permissions should be 0600, got 0${mode.toString(8)}`);
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("state file with malicious content is rejected", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));

        const stateFile = join(env.home, ".config", "parcel", "state");
        const markerFile = join(env.home, "pwned");

        // Write a malicious state file that attempts command substitution
        // Using a whitelisted variable name so the regex must reject the value
        writeFileSync(
            stateFile,
            `DECRYPT_BUCKET_TOKENS=$(touch ${markerFile})
`,
        );
        chmodSync(stateFile, 0o600);

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            // The malicious content should have been rejected — marker file must not exist
            assert.ok(!existsSync(markerFile), "Command substitution in state file was executed");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("state file with backtick substitution is rejected", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));

        const stateFile = join(env.home, ".config", "parcel", "state");
        const markerFile = join(env.home, "pwned");

        writeFileSync(
            stateFile,
            `DECRYPT_BUCKET_TOKENS=\`touch ${markerFile}\`
`,
        );
        chmodSync(stateFile, 0o600);

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            assert.ok(!existsSync(markerFile), "Backtick substitution in state file was executed");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("state file with subshell is rejected", async () => {
        const env = createTestEnv();
        const parcelJson = join(env.passdir, ".parcel.json");
        writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));

        const stateFile = join(env.home, ".config", "parcel", "state");
        const markerFile = join(env.home, "pwned");

        writeFileSync(
            stateFile,
            `DECRYPT_BUCKET_TOKENS=0
DECRYPT_BUCKET_LAST=0
$(touch ${markerFile})
`,
        );
        chmodSync(stateFile, 0o600);

        const { proc, read, send } = await installMainScript(env);
        try {
            send({ action: "list" });
            await read();

            assert.ok(!existsSync(markerFile), "Subshell in state file was executed");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });

    test("state file with pipe and redirection operators is rejected", async () => {
        // Whitelisted variable names so the regex must reject the operators in the value.
        // Covers pipe (|), output redirection (>), input redirection (<), and append (>>).
        const payloads = [
            `DECRYPT_BUCKET_TOKENS=0 | touch {marker}\n`,
            `DECRYPT_BUCKET_TOKENS=0 > {marker}\n`,
            `DECRYPT_BUCKET_TOKENS=0 < {marker}\n`,
            `DECRYPT_BUCKET_TOKENS=0 >> {marker}\n`,
        ];

        for (const template of payloads) {
            const env = createTestEnv();
            const parcelJson = join(env.passdir, ".parcel.json");
            writeFileSync(parcelJson, JSON.stringify({ rules: [{ pattern: "." }], decryptBucket: 1, decryptRate: 0.001 }));
            const stateFile = join(env.home, ".config", "parcel", "state");
            const markerFile = join(env.home, "pwned");

            writeFileSync(stateFile, template.replace("{marker}", markerFile));
            chmodSync(stateFile, 0o600);

            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();

                assert.ok(!existsSync(markerFile), `Redirection was executed for payload: ${template.trim()}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        }
    });

    // ---------------------------------------------------------------------------
    // Passkey (WebAuthn) tests
    // ---------------------------------------------------------------------------

    // Static ES256 (P-256) keypair used by the passkey tests.
    const PASSKEY_TEST_PRIV_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZqcvRnRuFDLXT64p
ZfKMZ5IhTbfvj8+n6Pq/5OxeYpGhRANCAAS2xCECWKSyk7itRbPjsrBfLfN6Ix/C
RTzcu1m2d79bMkdqYyp2NBirQsMFJGrC4Xq3UGxR2Pn6cn+rNWYRjdQ1
-----END PRIVATE KEY-----`;
    const PASSKEY_TEST_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtsQhAlikspO4rUWz47KwXy3zeiMf
wkU83LtZtne/WzJHamMqdjQYq0LDBSRqwuF6t1BsUdj5+nJ/qzVmEY3UNQ==
-----END PUBLIC KEY-----`;

    /**
     * Build a passkey entry in the `#!parcel-passkey v1` host format.
     */
    function makePasskeyEntry(overrides = {}) {
        const fields = {
            rpId: "example.com",
            credentialId: "dGVzdC1jcmVkZW50aWFsLWlkLTEyMzQ1Njc4OTAxMjM",
            algorithm: "ES256",
            userHandle: "dXNlci1oYW5kbGUtMQ",
            userName: "alice@example.com",
            userDisplayName: "Alice",
            ...overrides,
        };
        return [
            "#!parcel-passkey v1",
            `rpId: ${fields.rpId}`,
            `credentialId: ${fields.credentialId}`,
            `algorithm: ${fields.algorithm}`,
            `userHandle: ${fields.userHandle}`,
            `userName: ${fields.userName}`,
            `userDisplayName: ${fields.userDisplayName}`,
            "privateKey:",
            PASSKEY_TEST_PRIV_PEM,
            "",
        ].join("\n");
    }

    /**
     * Create a test environment whose mock gpg passes content through
     * (decrypt cats stdin; encrypt wraps stdin in fake armor and records its args).
     */
    function createPasskeyEnv(opts = {}) {
        const env = createTestEnv(opts);
        const gpgId = opts.gpgId === undefined ? "TESTKEY-ROOT" : opts.gpgId;
        writeFileSync(
            env.mockGpgPath,
            `#!/bin/bash
set -e
if [[ "$*" == *"--status-fd=1 --quiet --verify"* ]]; then
    echo "[GNUPG:] VALIDSIG ${env.knownSigner} 2026-05-01 0 0 4 0 1 8 00 ${env.knownSigner}"
    exit 0
fi
if [[ "$*" == *"--version"* ]]; then
    echo "gpg (GnuPG) 2.5.0"
    exit 0
fi
if [[ "$*" == *"--decrypt"* ]]; then
    cat -
    exit 0
fi
if [[ "$*" == *"--encrypt"* ]]; then
    printf '%s\\n' "$*" > "$HOME/gpg-encrypt-args"
    echo "-----BEGIN PGP MESSAGE-----"
    cat -
    echo "-----END PGP MESSAGE-----"
    exit 0
fi
exit 1
`,
        );
        chmodSync(env.mockGpgPath, 0o755);
        if (gpgId !== null) {
            writeFileSync(join(env.passdir, ".gpg-id"), `# comment line\n${gpgId}\n\n`);
        }
        mkdirSync(join(env.passdir, "passkeys", "example.com"), { recursive: true });
        writeFileSync(join(env.passdir, "passkeys", "example.com", "alice.gpg"), makePasskeyEntry());
        if (opts.rules === undefined) {
            writeFileSync(
                join(env.passdir, ".parcel.json"),
                JSON.stringify({ rules: [{ pattern: "^passkeys/", class: "passkey" }, { pattern: "." }] }),
            );
        }
        return env;
    }

    /**
     * Send an action_passkey get request for the alice fixture entry.
     */
    function passkeyGetRequest(env, overrides = {}) {
        return {
            action: "passkey",
            op: "get",
            path: join(env.passdir, "passkeys", "example.com", "alice.gpg"),
            rpId: "example.com",
            origin: "https://example.com",
            clientDataJSON: Buffer.from(
                JSON.stringify({
                    type: "webauthn.get",
                    challenge: "Y2hhbGxlbmdl",
                    origin: "https://example.com",
                    crossOrigin: false,
                }),
            ).toString("base64"),
            ...overrides,
        };
    }

    describe("action_passkey", () => {
        test("get produces a verifiable assertion with correct authenticatorData", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();

                send(passkeyGetRequest(env));
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                assert.strictEqual(msg.data.op, "get");
                assert.strictEqual(msg.data.credentialId, "dGVzdC1jcmVkZW50aWFsLWlkLTEyMzQ1Njc4OTAxMjM");
                assert.strictEqual(msg.data.userHandle, "dXNlci1oYW5kbGUtMQ");

                // authenticatorData must be SHA256(rpId) || flags(0x1d) || signCount(0)
                const authData = Buffer.from(msg.data.authenticatorData, "base64");
                const rpIdHash = createHash("sha256").update("example.com").digest();
                const expected = Buffer.concat([rpIdHash, Buffer.from([0x1d, 0, 0, 0, 0])]);
                assert.ok(authData.equals(expected), "authenticatorData mismatch");

                // signature must verify over authenticatorData || SHA256(clientDataJSON)
                const sig = Buffer.from(msg.data.signature, "base64");
                assert.strictEqual(sig[0], 0x30, "signature must be DER encoded");
                const clientHash = createHash("sha256")
                    .update(Buffer.from(passkeyGetRequest(env).clientDataJSON, "base64"))
                    .digest();
                const signed = Buffer.concat([authData, clientHash]);
                assert.ok(
                    verify("sha256", signed, { key: PASSKEY_TEST_PUB_PEM, dsaEncoding: "der" }, sig),
                    "signature verification failed",
                );
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get honours allowCredentials when the credential matches", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(
                    passkeyGetRequest(env, { allowCredentials: ["b3RoZXItY3JlZGVudGlhbA", "dGVzdC1jcmVkZW50aWFsLWlkLTEyMzQ1Njc4OTAxMjM"] }),
                );
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                assert.strictEqual(msg.data.credentialId, "dGVzdC1jcmVkZW50aWFsLWlkLTEyMzQ1Njc4OTAxMjM");
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get rejects a credential excluded by allowCredentials", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { allowCredentials: ["b3RoZXItY3JlZGVudGlhbA"] }));
                const msg = await read();
                assert.ok(msg.error?.includes("Credential not allowed"), `Expected credential not allowed, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get ignores a malformed allowCredentials field", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { allowCredentials: "not-an-array" }));
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get ignores an empty allowCredentials list", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { allowCredentials: [] }));
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get rejects when allowCredentials is provided but all entries are malformed", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { allowCredentials: ["!!!invalid!!!"] }));
                const msg = await read();
                assert.ok(msg.error?.includes("not allowed by request"), `Expected credential not allowed, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get rejects an rpId that does not match the entry", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { rpId: "different.com" }));
                const msg = await read();
                assert.ok(msg.error?.includes("rpId does not match"), `Expected rpId mismatch, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get rejects an unsupported algorithm", async () => {
            const env = createPasskeyEnv();
            writeFileSync(join(env.passdir, "passkeys", "example.com", "alice.gpg"), makePasskeyEntry({ algorithm: "RS256" }));
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env));
                const msg = await read();
                assert.ok(
                    msg.error?.includes("Unsupported or missing algorithm"),
                    `Expected algorithm rejection, got: ${JSON.stringify(msg)}`,
                );
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get rejects a file that is not a passkey entry", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { path: join(env.passdir, "test-entry.gpg") }));
                const msg = await read();
                assert.ok(msg.error?.includes("Not a passkey entry"), `Expected format error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get rejects an out-of-scope path", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env, { path: "/etc/passwd" }));
                const msg = await read();
                assert.ok(msg.error?.includes("Path out of scope"), `Expected scope error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("get shares the decrypt rate limiter", async () => {
            const env = createPasskeyEnv();
            writeFileSync(
                join(env.passdir, ".parcel.json"),
                JSON.stringify({
                    rules: [{ pattern: "^passkeys/", class: "passkey" }, { pattern: "." }],
                    decryptBucket: 1,
                    decryptRate: 0.0000001,
                }),
            );
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send(passkeyGetRequest(env));
                const msg1 = await read();
                assert.ok(msg1.data?.signature, `First get failed: ${JSON.stringify(msg1)}`);
                send(passkeyGetRequest(env));
                const msg2 = await read();
                assert.ok(msg2.error?.includes("rate limit"), `Expected rate limit error, got: ${JSON.stringify(msg2)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create returns a valid credential encrypted to the .gpg-id recipient", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlci1oYW5kbGUtMg",
                    userName: "bob@example.com",
                    userDisplayName: "Bob",
                    path: "passkeys/example.com/bob.gpg",
                });
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                assert.strictEqual(msg.data.op, "create");
                assert.strictEqual(msg.data.path, "passkeys/example.com/bob.gpg");
                assert.strictEqual(msg.data.file, join(env.passdir, "passkeys", "example.com", "bob.gpg"));
                assert.match(msg.data.credentialId, /^[A-Za-z0-9_-]{43}$/);
                assert.match(msg.data.publicKey, /^[0-9a-f]{128}$/);

                // SPKI must be DER for a P-256 key ending in the x||y coordinates
                const spki = Buffer.from(msg.data.spki, "base64");
                assert.strictEqual(spki.length, 91, "unexpected SPKI length");
                assert.strictEqual(spki.subarray(-64).toString("hex"), msg.data.publicKey, "publicKey does not match SPKI");

                // fake armor wraps the entry; the plaintext must contain the entry + coordinates + private key
                assert.ok(msg.data.armored.startsWith("-----BEGIN PGP MESSAGE-----"), "armored output missing armor header");
                assert.ok(msg.data.armored.includes("-----END PGP MESSAGE-----"), "armored output missing armor footer");
                assert.ok(msg.data.armored.includes("#!parcel-passkey v1"), "armored output missing entry header");
                assert.ok(msg.data.armored.includes(`publicKey: ${msg.data.publicKey}`), "armored output missing public key");
                assert.ok(msg.data.armored.includes("-----BEGIN PRIVATE KEY-----"), "armored output missing private key");

                // the encrypt call must target the root .gpg-id recipient
                const args = readFileSync(join(env.home, "gpg-encrypt-args"), "utf8");
                assert.ok(args.includes("-r TESTKEY-ROOT"), `missing recipient in: ${args}`);
                assert.ok(args.includes("--armor"), `missing --armor in: ${args}`);
                assert.ok(args.includes("--trust-model always"), `missing trust model in: ${args}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create prefers a subdirectory .gpg-id over the store root", async () => {
            const env = createPasskeyEnv();
            writeFileSync(join(env.passdir, "passkeys", "example.com", ".gpg-id"), "TESTKEY-SUBDIR\n");
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlci1oYW5kbGUtMw",
                    userName: "carol@example.com",
                    userDisplayName: "Carol",
                    path: "passkeys/example.com/carol.gpg",
                });
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                const args = readFileSync(join(env.home, "gpg-encrypt-args"), "utf8");
                assert.ok(args.includes("-r TESTKEY-SUBDIR"), `missing subdir recipient in: ${args}`);
                assert.ok(!args.includes("TESTKEY-ROOT"), `unexpected root recipient in: ${args}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create preserves interior whitespace in .gpg-id recipients", async () => {
            const env = createPasskeyEnv();
            writeFileSync(join(env.passdir, ".gpg-id"), "  Test User <test@example.com>  \n\n");
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlci1oYW5kbGUtNA",
                    userName: "dave@example.com",
                    userDisplayName: "Dave",
                    path: "passkeys/example.com/dave.gpg",
                });
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                const args = readFileSync(join(env.home, "gpg-encrypt-args"), "utf8");
                assert.ok(args.includes("-r Test User <test@example.com>"), `recipient mangled in: ${args}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create rejects a suggested path containing traversal", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlcg",
                    userName: "mallory",
                    userDisplayName: "Mallory",
                    path: "passkeys/example.com/../../evil.gpg",
                });
                const msg = await read();
                assert.ok(msg.error?.includes("Invalid suggested path"), `Expected path error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create honors a custom passkeyDir from config", async () => {
            const env = createPasskeyEnv();
            writeFileSync(
                join(env.passdir, ".parcel.json"),
                JSON.stringify({ passkeyDir: "keys", rules: [{ pattern: "^keys/", class: "passkey" }, { pattern: "." }] }),
            );
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlci1oYW5kbGUtNQ",
                    userName: "erin@example.com",
                    userDisplayName: "Erin",
                    path: "keys/example.com/erin.gpg",
                });
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                assert.strictEqual(msg.data.op, "create");
                assert.strictEqual(msg.data.path, "keys/example.com/erin.gpg");
                assert.strictEqual(msg.data.file, join(env.passdir, "keys", "example.com", "erin.gpg"));
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create with a custom passkeyDir rejects the default prefix", async () => {
            const env = createPasskeyEnv();
            writeFileSync(
                join(env.passdir, ".parcel.json"),
                JSON.stringify({ passkeyDir: "keys", rules: [{ pattern: "^keys/", class: "passkey" }, { pattern: "." }] }),
            );
            const { proc, read, send } = await installMainScript(env);
            try {
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlcg",
                    userName: "mallory",
                    userDisplayName: "Mallory",
                    path: "passkeys/example.com/mallory.gpg",
                });
                const msg = await read();
                assert.ok(msg.error?.includes("Invalid suggested path"), `Expected path error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create honors a passkeyDir containing spaces and unicode", async () => {
            const env = createPasskeyEnv();
            writeFileSync(
                join(env.passdir, ".parcel.json"),
                JSON.stringify({ passkeyDir: "我的密钥 dir", rules: [{ pattern: "^我的密钥 dir/", class: "passkey" }, { pattern: "." }] }),
            );
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlci1oYW5kbGUtNg",
                    userName: "fang@example.com",
                    userDisplayName: "Fang",
                    path: "我的密钥 dir/example.com/fang.gpg",
                });
                const msg = await read();
                assert.ok(msg.data, `Expected data, got: ${JSON.stringify(msg)}`);
                assert.strictEqual(msg.data.op, "create");
                assert.strictEqual(msg.data.path, "我的密钥 dir/example.com/fang.gpg");
                assert.strictEqual(msg.data.file, join(env.passdir, "我的密钥 dir", "example.com", "fang.gpg"));
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create rejects an invalid passkeyDir in config", async () => {
            const env = createPasskeyEnv();
            writeFileSync(join(env.passdir, ".parcel.json"), JSON.stringify({ passkeyDir: "keys*", rules: [{ pattern: "." }] }));
            const { proc, read, send } = await installMainScript(env);
            try {
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlcg",
                    userName: "mallory",
                    userDisplayName: "Mallory",
                    path: "keys*/example.com/mallory.gpg",
                });
                const msg = await read();
                assert.ok(msg.error?.includes("Invalid passkeyDir in config"), `Expected config error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create rejects an invalid userHandle", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "A".repeat(87),
                    userName: "alice",
                    userDisplayName: "Alice",
                    path: "passkeys/example.com/alice2.gpg",
                });
                const msg = await read();
                assert.ok(msg.error?.includes("Invalid user handle"), `Expected handle error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create rejects a request missing an rpId", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({
                    action: "passkey",
                    op: "create",
                    origin: "https://example.com",
                    userHandle: "dXNlcg",
                    userName: "mallory",
                    userDisplayName: "Mallory",
                    path: "passkeys/null/mallory.gpg",
                });
                const msg = await read();
                assert.ok(msg.error?.includes("Invalid relying party id"), `Expected rpId error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create rejects when no .gpg-id exists", async () => {
            const env = createPasskeyEnv({ gpgId: null });
            const { proc, read, send } = await installMainScript(env);
            try {
                send({
                    action: "passkey",
                    op: "create",
                    rpId: "example.com",
                    origin: "https://example.com",
                    userHandle: "dXNlcg",
                    userName: "alice",
                    userDisplayName: "Alice",
                    path: "passkeys/example.com/alice2.gpg",
                });
                const msg = await read();
                assert.ok(msg.error?.includes("No .gpg-id found"), `Expected .gpg-id error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("create refuses .gpg-id files outside the store when the store path has a trailing slash", async () => {
            const env = createPasskeyEnv({ gpgId: null });
            try {
                // plant a recipient file above the store — must never be picked up
                writeFileSync(join(env.home, ".gpg-id"), "OUTSIDE-KEY\n");
                // configure the store path with a trailing slash
                const parcelrc = join(env.home, ".config", "parcel", "parcelrc");
                const original = readFileSync(parcelrc, "utf8");
                writeFileSync(parcelrc, original.replace(`PASSWORD_STORE_DIR="${env.passdir}"`, `PASSWORD_STORE_DIR="${env.passdir}/"`));
                const { proc, read, send } = await installMainScript(env);
                try {
                    send({
                        action: "passkey",
                        op: "create",
                        rpId: "example.com",
                        origin: "https://example.com",
                        userHandle: "dXNlcg",
                        userName: "alice",
                        userDisplayName: "Alice",
                        path: "passkeys/example.com/alice2.gpg",
                    });
                    const msg = await read();
                    assert.ok(msg.error?.includes("No .gpg-id found"), `Expected .gpg-id containment error, got: ${JSON.stringify(msg)}`);
                } finally {
                    proc.kill();
                }
            } finally {
                env.cleanup();
            }
        });

        test("rejects an invalid operation", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "passkey", op: "delete", rpId: "example.com", origin: "https://example.com" });
                const msg = await read();
                assert.ok(msg.error?.includes("Invalid passkey operation"), `Expected op error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("action_decrypt refuses to decrypt a passkey-class entry", async () => {
            const env = createPasskeyEnv();
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                const keyPath = join(env.passdir, "passkeys", "example.com", "alice.gpg");
                send({ action: "decrypt", path: keyPath, intent: "fill", origin: "https://example.com" });
                const msg = await read();
                assert.ok(
                    msg.error?.includes("Passkey entries may not be decrypted"),
                    `Expected decrypt denial, got: ${JSON.stringify(msg)}`,
                );
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("default rules classify entries under passkeyDir as passkeys", async () => {
            const env = createPasskeyEnv();
            // no "rules" key - the host must synthesize a passkey-class rule for the passkey dir
            writeFileSync(join(env.passdir, ".parcel.json"), JSON.stringify({ handlePasskeys: true }));
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                const keyPath = join(env.passdir, "passkeys", "example.com", "alice.gpg");
                send({ action: "decrypt", path: keyPath, intent: "fill", origin: "https://example.com" });
                const msg = await read();
                assert.ok(
                    msg.error?.includes("Passkey entries may not be decrypted"),
                    `Expected decrypt denial, got: ${JSON.stringify(msg)}`,
                );
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("action_decrypt refuses passkey-format plaintext even without a passkey-class rule", async () => {
            const env = createPasskeyEnv();
            // every entry is login-classed: neither the rule gate nor default-rule synthesis applies
            writeFileSync(join(env.passdir, ".parcel.json"), JSON.stringify({ rules: [{ pattern: "." }] }));
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                // alice.gpg is login-classed here, but its decrypted content carries the
                // parcel-passkey marker - the content check must still deny the decrypt
                const keyPath = join(env.passdir, "passkeys", "example.com", "alice.gpg");
                send({ action: "decrypt", path: keyPath, intent: "fill", origin: "https://example.com" });
                const msg = await read();
                assert.ok(
                    msg.error?.includes("Passkey entries may not be decrypted"),
                    `Expected decrypt denial, got: ${JSON.stringify(msg)}`,
                );
                // a hypothetical future format version must be refused by this host version too
                writeFileSync(keyPath, "#!parcel-passkey v2\nfuture-format-content\n");
                send({ action: "decrypt", path: keyPath, intent: "fill", origin: "https://example.com" });
                const future = await read();
                assert.ok(
                    future.error?.includes("Passkey entries may not be decrypted"),
                    `Expected decrypt denial, got: ${JSON.stringify(future)}`,
                );
                // and removing the marker de-registers the passkey: it decrypts as plain login content
                writeFileSync(keyPath, "alice-password");
                send({ action: "decrypt", path: keyPath, intent: "fill", origin: "https://example.com" });
                const dereg = await read();
                assert.strictEqual(dereg.data?.plaintext, "alice-password");
                // a regular login entry in the same store must still decrypt normally
                send({ action: "decrypt", path: join(env.passdir, "test-entry.gpg"), intent: "fill", origin: "https://example.com" });
                const ok = await read();
                assert.strictEqual(ok.data?.plaintext, "encrypted-a");
            } finally {
                proc.kill();
                env.cleanup();
            }
        });

        test("action_passkey get rejects entries not classified as passkey", async () => {
            const env = createPasskeyEnv();
            // regular login entry (no passkey-class rule matching)
            writeFileSync(join(env.passdir, "test-entry.gpg"), "encrypted-a");
            const { proc, read, send } = await installMainScript(env);
            try {
                send({ action: "list" });
                await read();
                const keyPath = join(env.passdir, "test-entry.gpg");
                send(
                    Object.assign(passkeyGetRequest(env), {
                        path: keyPath,
                    }),
                );
                const msg = await read();
                assert.ok(msg.error?.includes("Not a passkey entry"), `Expected not-a-passkey error, got: ${JSON.stringify(msg)}`);
            } finally {
                proc.kill();
                env.cleanup();
            }
        });
    });
});

describe("dd() idle watchdog", () => {
    test("host exits when stdin goes silent for PARCEL_IDLE_TIMEOUT", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env, { PARCEL_IDLE_TIMEOUT: "1" });
        try {
            // Confirm the host is alive and responsive.
            send({ action: "ping" });
            const msg = await read();
            assert.deepStrictEqual(msg.data, { ok: true });
            const silentAt = Date.now();

            // Stop sending messages. The dd() watchdog should fire after ~1s
            // and the host process should exit on its own.
            const exitCode = await new Promise((resolve) => {
                proc.on("exit", resolve);
                // Safety timeout: if the process doesn't exit within 10s,
                // something is wrong.
                setTimeout(() => {
                    if (!proc.killed) proc.kill();
                    resolve(null);
                }, 10_000);
            });
            const elapsed = Date.now() - silentAt;

            assert.ok(exitCode !== null, "Host did not exit within 10s of stdin going silent");
            // An instant exit for an unrelated reason (crash after replying)
            // would also satisfy the check above; require the exit to line up
            // with the 1s idle watchdog so we test the claimed cause.
            assert.ok(elapsed >= 800, `Host exited after only ${elapsed}ms — too soon for the 1s idle watchdog`);
        } finally {
            if (!proc.killed) proc.kill();
            env.cleanup();
        }
    });

    test("message delivered just before timeout is still handled", async () => {
        const env = createTestEnv();
        const { proc, read, send } = await installMainScript(env, { PARCEL_IDLE_TIMEOUT: "3" });
        try {
            // Confirm the host is alive.
            send({ action: "ping" });
            await read();

            // Wait for most of the timeout to elapse, then send a message.
            // The dd() call for this message starts a fresh watchdog, so the
            // host should stay alive and respond. The ~1s margin absorbs CI
            // scheduler jitter without letting a stale watchdog fire.
            await new Promise((resolve) => setTimeout(resolve, 2000));
            send({ action: "ping" });
            const msg = await read();
            assert.deepStrictEqual(msg.data, { ok: true }, "Host should still respond to messages near the timeout boundary");

            // The host should still be alive (not killed by the previous
            // watchdog). Note: proc.killed only tracks signals *this* process
            // sent, so check the exit state instead.
            assert.ok(proc.exitCode === null && proc.signalCode === null, "Host process exited after message near timeout");
        } finally {
            proc.kill();
            env.cleanup();
        }
    });
});

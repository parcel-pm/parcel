"use strict";

/**
 * Shared harness for the parcel-setup.sh runtime test suite.
 *
 * This suite is standalone (see setup-test-plan.md): it owns all of its own
 * scaffolding and shares no code, fixtures, or state with `test/*.test.js`.
 * The style follows `test/native-host.test.js` (node:test, isolated temp
 * dirs, mock toolchain) but nothing is imported from it.
 *
 * @since 1.0.7
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the setup script under test.
export const SETUP_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "parcel-setup.sh");

/**
 * Quote a string for safe single-quoted use inside a bash command.
 * @param {string} value - String to quote.
 * @returns {string} The string wrapped in single quotes.
 * @since 1.0.7
 */
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a snippet of bash, returning its stdout, stderr, and exit code.
 *
 * The child starts from a minimal environment (only `PATH`), not the full
 * `process.env`, so ambient variables such as `HOME`, `PASSWORD_STORE_DIR`,
 * `SUDO_USER`, or `IS_NIXOS` cannot leak into the sourced script and skew
 * detection. Callers supply every other variable through `opts.env`.
 * @param {string} code - Bash source fed to the child on stdin.
 * @param {object} [opts] - Options.
 * @param {Record<string, string>} [opts.env] - Extra environment variables.
 * @param {string} [opts.cwd] - Working directory for the child.
 * @returns {{stdout:string, stderr:string, code:number|null}} Result tuple.
 * @since 1.0.7
 */
export function runBash(code, opts = {}) {
    const res = spawnSync("bash", ["--noprofile", "--norc"], {
        input: code,
        encoding: "utf8",
        // Decouple the child from any controlling terminal so `/dev/tty` reads
        // (e.g. in `prompt`) fail deterministically, rather than hanging when
        // the suite is run from an interactive shell.
        detached: true,
        env: { PATH: process.env.PATH ?? "", ...(opts.env ?? {}) },
        cwd: opts.cwd,
    });
    return {
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        code: res.status ?? null,
    };
}

/**
 * Source the setup script, then run `code` in the same child. The guard keeps
 * `main` from running, so only the script's functions and globals are loaded.
 *
 * The appended `code` runs under the script's `set -uo pipefail`, so a snippet
 * that references an unset variable will fail under `set -u` (see
 * setup-test-plan.md §6). This mirrors real execution and is deliberate.
 * @param {string} code - Bash source to run after the script is sourced.
 * @param {object} [opts] - Same options as {@link runBash}.
 * @returns {{stdout:string, stderr:string, code:number|null}} Result tuple.
 * @since 1.0.7
 */
export function sourceScript(code, opts = {}) {
    return runBash(`source ${shellQuote(SETUP_SCRIPT)}\n${code}`, opts);
}

/**
 * Source the setup script once, then run several snippets in sequence in the
 * same child so they share shell state. Each snippet's stdout is captured
 * separately, keyed by array position.
 * @param {string[]} snippets - Bash snippets to run in order after sourcing.
 * @param {object} [opts] - Same options as {@link runBash}.
 * @returns {{outputs:string[], stderr:string, code:number|null}} Per-snippet results.
 * @since 1.0.7
 */
export function withSrcLoaded(snippets, opts = {}) {
    const delim = "PARCEL_HARNESS_END_";
    const body = snippets
        .map((snippet) => snippet.replace(/\n*$/, ""))
        .join(`\nprintf '%s\\n' "${delim}"\n`)
        .concat(`\nprintf '%s\\n' "${delim}"`);
    const { stdout, stderr, code } = sourceScript(body, opts);
    const outputs = stdout.split(`${delim}\n`).slice(0, -1);
    if (outputs.length !== snippets.length) {
        throw new Error(
            `withSrcLoaded: expected ${snippets.length} outputs, got ${outputs.length} (child exited ${code}); ` +
                `a snippet likely terminated the shell early.\nstderr:\n${stderr}`,
        );
    }
    return {
        outputs,
        stderr,
        code,
    };
}

/**
 * Create an isolated temporary HOME directory for a test.
 * @returns {{home:string, cleanup:Function}} The temp dir path plus a cleanup
 *   function that removes it recursively.
 * @since 1.0.7
 */
export function makeTempHome() {
    const home = mkdtempSync(join(tmpdir(), "parcel-setup-test-"));
    return {
        home,
        cleanup: () => rmSync(home, { recursive: true, force: true }),
    };
}

/**
 * Write a mock executable into `dir` and make it runnable. The directory is
 * created (recursively, idempotently) if it does not already exist.
 * @param {string} dir - Directory to place the mock in.
 * @param {string} name - File name of the mock binary.
 * @param {string} body - Bash source for the mock (a shebang is prepended).
 * @returns {string} The absolute path to the created mock.
 * @since 1.0.7
 */
export function writeMockBin(dir, name, body) {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, name);
    writeFileSync(target, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(target, 0o755);
    return target;
}

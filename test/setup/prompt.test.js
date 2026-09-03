"use strict";

/**
 * Behavioural tests for the interactive prompt helpers. Covers the --yes
 * short-circuit and no-TTY hard-fail guard for all three, plus prompt_bool's
 * accept-list and re-prompt loop via a stubbed `prompt`. prompt_yesno's inline
 * accept-list is left untested (low value).
 *
 * @since 1.0.7
 */

import { test } from "node:test";
import assert from "node:assert";

import { sourceScript } from "./harness.js";

/**
 * Run the real prompt_bool with its `prompt` dependency stubbed to serve the
 * given canned answers (one per call, read from a shared fd so state survives
 * the `$(...)` subshell), exercising the accept-list and re-prompt loop.
 * @param {string[]} replies - Answers the stub returns, in order.
 * @param {string} defaultVal - Default value passed to prompt_bool.
 * @returns {{stdout:string, stderr:string, code:number|null}} Result tuple.
 * @since 1.0.7
 */
function promptBool(replies, defaultVal) {
    return sourceScript(
        `exec 3<<'PARCEL_REPLIES'\n${replies.join("\n")}\nPARCEL_REPLIES\n` +
            `prompt() { IFS= read -r r <&3 || return 1; printf '%s' "$r"; }\n` +
            `printf '%s' "$(prompt_bool 'label' '${defaultVal}')"`,
    );
}

/** Verifies prompt returns its default (or empty) under --yes and exits on a missing TTY. */
test("prompt returns default in --yes mode and hard-fails without a TTY", () => {
    const withDefault = sourceScript(`YES=true\nprompt 'label' 'abc'`);
    assert.strictEqual(withDefault.code, 0);
    assert.strictEqual(withDefault.stdout, "abc", "--yes must return the default verbatim");

    const emptyDefault = sourceScript(`YES=true\nprompt 'label'`);
    assert.strictEqual(emptyDefault.code, 0);
    assert.strictEqual(emptyDefault.stdout, "", "--yes with no default must return an empty string");

    const noTty = sourceScript(`prompt 'label' 'abc'`);
    assert.strictEqual(noTty.code, 1, "prompt must exit non-zero without a TTY");
    assert.match(noTty.stderr, /No TTY available/, "prompt must explain why it aborted");
});

/** Verifies prompt_yesno's --yes polarity mapping and its missing-TTY failure. */
test("prompt_yesno short-circuits on --yes per default polarity and fails without TTY", () => {
    const defaultNo = sourceScript(`YES=true\nprompt_yesno 'label' true`);
    assert.strictEqual(defaultNo.code, 1, "--yes with default_no=true must answer 'no' (exit 1)");

    const defaultYes = sourceScript(`YES=true\nprompt_yesno 'label' false`);
    assert.strictEqual(defaultYes.code, 0, "--yes with default_no=false must answer 'yes' (exit 0)");

    const noTty = sourceScript(`prompt_yesno 'label' true`);
    assert.strictEqual(noTty.code, 1, "prompt_yesno must exit non-zero without a TTY");
    assert.match(noTty.stderr, /No TTY available/);
});

/** Verifies prompt_bool's --yes default, accept-list normalisation, and invalid-input re-prompt. */
test("prompt_bool normalises answers and re-prompts until valid", () => {
    // --yes short-circuit returns the default verbatim.
    const truthyDefault = sourceScript(`YES=true\nprompt_bool 'label' true`);
    assert.strictEqual(truthyDefault.code, 0);
    assert.strictEqual(truthyDefault.stdout, "true", "--yes true must emit 'true'");
    const falsyDefault = sourceScript(`YES=true\nprompt_bool 'label' false`);
    assert.strictEqual(falsyDefault.stdout, "false", "--yes false must emit 'false'");

    // No TTY is a hard failure, not a hang.
    const noTty = sourceScript(`prompt_bool 'label' true`);
    assert.strictEqual(noTty.code, 1, "prompt_bool must exit non-zero without a TTY");
    assert.match(noTty.stderr, /No TTY available/);

    // Accept-list maps each truthy spelling to 'true' (case-insensitive).
    for (const answer of ["t", "true", "y", "yes", "1", "YeS"]) {
        const r = promptBool([answer], "false");
        assert.strictEqual(r.stdout, "true", `'${answer}' must be accepted as true`);
    }
    // Accept-list maps each falsy spelling to 'false' (case-insensitive).
    for (const answer of ["f", "false", "n", "no", "0", "No"]) {
        const r = promptBool([answer], "true");
        assert.strictEqual(r.stdout, "false", `'${answer}' must be accepted as false`);
    }

    // Invalid input warns and re-prompts until a valid answer arrives.
    const retry = promptBool(["maybe", "1"], "false");
    assert.strictEqual(retry.code, 0);
    assert.strictEqual(retry.stdout, "true", "re-prompt must accept the second answer");
    assert.match(retry.stderr, /Please answer yes\/no or true\/false/);
});

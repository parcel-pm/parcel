"use strict";

import { Helpers } from "./helpers.js";

/**
 * Build the self-contained shell snippet that saves an armored passkey entry to disk.
 * Paths are single-quote-escaped and the heredoc delimiter is quoted so the blob
 * cannot be mangled by shell expansion. The delimiter is deliberately distinctive
 * so the command cannot terminate early should the content ever contain the line.
 *
 * @since 1.0.4
 * @param {string} file - Absolute path of the entry file to write.
 * @param {string} content - Armored, already-encrypted entry content.
 * @param {string} [rpId] - Relying party ID, used for the git commit message when included.
 * @param {string} [passdir] - Absolute path of the password store root, used as git -C target.
 * @returns {string} The shell command.
 */
function buildPasskeySaveCommand(file, content, rpId, passdir) {
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    let cmd = `mkdir -p ${q(dir)} && cat > ${q(file)} <<'PARCEL_PASSKEY_EOF'\n${content}\nPARCEL_PASSKEY_EOF\n`;
    if (rpId) {
        const gitDir = passdir && file.startsWith(passdir) ? passdir : dir;
        cmd += `git -C ${q(gitDir)} add ${q(file)} && git -C ${q(gitDir)} commit -m "Add passkey for ${rpId} to store."\n`;
    }
    return cmd;
}

/**
 * Initialise the passkey consent ceremony interface: replace the fill view with the
 * ceremony view, render the ceremony context when it arrives from the content script,
 * and wire the consent/cancel/fallback actions back over the tab port. Creation is
 * only offered for "create" operations - answering a "get" call with an
 * attestation-shaped credential would break the relying party, so new credentials
 * cannot be registered from an assertion ceremony.
 * @since 1.0.4
 * @param {object} deps - Wiring provided by the popup script.
 * @param {object} deps.tabPort - Bidirectional content-script port (postMessage/onMessage).
 * @param {Promise<object>} deps.config - The config promise; awaited inside.
 * @param {Function} deps.copyText - Copy text to the clipboard; resolves `true` on success.
 * @param {Function} deps.setStatus - Update the status bar.
 * @returns {void}
 */
export function initPasskeyPopup(deps) {
    const { tabPort, config, copyText, setStatus } = deps;
    const elRoot = document.getElementById("passkey");
    const elTitle = document.getElementById("passkey-title");
    const elOrigin = document.getElementById("passkey-origin");
    const elUser = document.getElementById("passkey-user");
    const elHints = document.getElementById("passkey-hints");
    const elExisting = document.getElementById("passkey-existing");
    const elExistingList = document.getElementById("passkey-existing-list");
    const elEntries = document.getElementById("passkey-entries");

    /**
     * The display name for a passkey candidate, with its rule's strip pattern
     * applied (falls back to the raw entry name when the rule sets no strip).
     *
     * @param {Object} candidate - candidate entry ({name, rule})
     * @returns {string} display name
     * @since 1.0.4
     */
    function stripName(candidate) {
        return candidate.rule?.strip ? candidate.name.replace(new RegExp(candidate.rule.strip, "ui"), "") : candidate.name;
    }
    const elSave = document.getElementById("passkey-save");
    const elActions = document.getElementById("passkey-actions");
    const elCreate = document.getElementById("passkey-create");
    const elFallback = document.getElementById("passkey-fallback");
    const elCopy = document.getElementById("passkey-copy");
    // the raw armored entry, its target path, and the ceremony rpId, kept
    // separately from the textarea (which shows the full shell command) so
    // downloads stay pristine
    let passkeySaveFile = "";
    let passkeySaveContent = "";
    let passkeyRpId = "";
    let passkeyPassdir = "";

    const elCommitToggle = document.getElementById("passkey-commit");
    const elBlob = document.getElementById("passkey-blob");

    /**
     * Rebuild the textarea command from the cached save data and checkbox state.
     * @since 1.0.4
     * @returns {void}
     */
    function refreshSaveCommand() {
        elBlob.value = buildPasskeySaveCommand(
            passkeySaveFile,
            passkeySaveContent,
            elCommitToggle.checked ? passkeyRpId : undefined,
            passkeyPassdir,
        );
    }

    elCommitToggle.addEventListener("change", refreshSaveCommand);

    document.body.classList.add("passkey-popup");
    elRoot.classList.remove("hidden");

    // prevent further input while the content script settles the ceremony; the
    // iframe is closed once it has
    const disableActions = () => elRoot.querySelectorAll("button").forEach((button) => (button.disabled = true));

    elRoot.querySelectorAll(".passkey-cancel").forEach((button) =>
        button.addEventListener("click", () => {
            disableActions();
            tabPort.postMessage({ action: "passkey-cancel" });
        }),
    );
    elFallback.addEventListener("click", () => {
        disableActions();
        tabPort.postMessage({ action: "passkey-fallback" });
    });
    elCreate.addEventListener("click", () => {
        // the ceremony continues with the save view, so only the decision buttons are retired
        elCreate.disabled = true;
        elFallback.disabled = true;
        tabPort.postMessage({ action: "passkey-create" });
    });
    elCopy.addEventListener("click", async () => {
        const elBlob = document.getElementById("passkey-blob");
        if (await copyText(elBlob.value)) {
            elCopy.textContent = "Copied!";
        } else {
            // copy failed - select the text for manual copying
            elBlob.select();
        }
    });
    document.getElementById("passkey-download").addEventListener("click", () => {
        if (!passkeySaveContent) return;
        // the blob is already encrypted ciphertext; an anchor download needs no extra permission
        const filename = passkeySaveFile.split("/").pop() || "passkey.gpg";
        const url = URL.createObjectURL(new Blob([passkeySaveContent + "\n"], { type: "application/pgp-encrypted" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    });
    document.getElementById("passkey-ack").addEventListener("click", () => {
        disableActions();
        tabPort.postMessage({ action: "passkey-create-ack" });
    });

    /**
     * Render the ceremony context received from the content script: heading, requesting
     * origin, the candidate account list (assertion) or account details (creation), and
     * the actions appropriate to the operation.
     * @since 1.0.4
     * @param {object} context - Ceremony context `{op, rpId, origin, candidates, user}`.
     * @returns {void}
     */
    async function renderPasskeyContext(context) {
        elActions.classList.remove("hidden");
        elOrigin.textContent = `Requested by ${context.origin}`;
        // Surface WebAuthn hints Parcel cannot satisfy (e.g. security-key, hybrid)
        // and any non-compliant hint tokens, so the user can make an informed choice.
        const { violated = [], nonCompliant = [] } = context.hintWarning || {};
        if (violated.length || nonCompliant.length) {
            const parts = [];
            if (violated.length) {
                parts.push(
                    `This site requested authenticator hints Parcel cannot satisfy (${violated.join(", ")}). ` +
                        "Proceed only if you understand the site may reject the credential.",
                );
            }
            if (nonCompliant.length) {
                parts.push(`Non-compliant WebAuthn hint received: ${nonCompliant.join(", ")}.`);
            }
            elHints.textContent = parts.join(" ");
            elHints.classList.remove("hidden");
        } else {
            elHints.classList.add("hidden");
        }
        if (context.op === "create") {
            elTitle.textContent = `Create a passkey for ${context.rpId}?`;
            elUser.textContent = context.user?.displayName
                ? `Account: ${context.user.displayName} (${context.user.name})`
                : `Account: ${context.user?.name || "unnamed account"}`;
            elUser.classList.remove("hidden");
            // Parcel cannot honour excludeCredentials (credential IDs live inside
            // encrypted entries, so they can't be checked without decryption), so
            // existing passkeys for this site are surfaced here instead - letting
            // the user spot a duplicate registration before creating another one
            if (context.candidates?.length) {
                elExisting.textContent = `You already have ${context.candidates.length === 1 ? "a passkey" : `${context.candidates.length} passkeys`} for this site:`;
                elExistingList.replaceChildren(
                    ...context.candidates.map((candidate) => {
                        const li = document.createElement("li");
                        if (candidate.rule?.tag) {
                            const tag = document.createElement("span");
                            tag.classList.add("tag");
                            tag.textContent = candidate.rule.tag;
                            tag.style.backgroundColor = `#${candidate.rule.color}`;
                            const luma = Helpers.getLuma(candidate.rule.color);
                            tag.style.color = luma < 0.35 ? "var(--color-text-tag-inverted)" : "var(--color-text-tag)";
                            li.appendChild(tag);
                        }
                        li.appendChild(document.createTextNode(stripName(candidate)));
                        return li;
                    }),
                );
                elExisting.classList.remove("hidden");
                elExistingList.classList.remove("hidden");
            } else {
                elExisting.classList.add("hidden");
                elExistingList.classList.add("hidden");
            }
            elCreate.focus({ preventScroll: true });
        } else {
            elExisting.classList.add("hidden");
            elExistingList.classList.add("hidden");
            elTitle.textContent = `Sign in to ${context.rpId} with a passkey?`;
            elCreate.classList.add("hidden");
            for (const candidate of context.candidates) {
                const button = document.createElement("button");
                button.type = "button";

                if (candidate.rule?.tag) {
                    const tag = document.createElement("span");
                    tag.classList.add("tag");
                    tag.textContent = candidate.rule.tag;
                    tag.style.backgroundColor = `#${candidate.rule.color}`;
                    const luma = Helpers.getLuma(candidate.rule.color);
                    tag.style.color = luma < 0.35 ? "var(--color-text-tag-inverted)" : "var(--color-text-tag)";
                    button.appendChild(tag);
                }

                const nameContainer = document.createElement("span");
                nameContainer.classList.add("name-container");

                const displayName = stripName(candidate);

                const name = document.createElement("span");
                name.classList.add("name");
                name.textContent = displayName;
                nameContainer.appendChild(name);

                // store-relative path, shown only when it differs from the name
                const passdir = (await config).passdir;
                const pathSpan = document.createElement("span");
                pathSpan.classList.add("path");
                if (passdir && candidate.path.startsWith(passdir)) {
                    pathSpan.textContent = candidate.path.slice(passdir.length + (candidate.path.charAt(passdir.length) === "/" ? 1 : 0));
                } else {
                    pathSpan.textContent = candidate.path;
                }
                if (pathSpan.textContent.replace(/.gpg$/, "") !== name.textContent) nameContainer.appendChild(pathSpan);

                button.appendChild(nameContainer);

                // candidate consent signs an assertion for this entry
                button.addEventListener("click", () => {
                    disableActions();
                    tabPort.postMessage({ action: "passkey-assert", path: candidate.path });
                });
                elEntries.appendChild(document.createElement("li")).appendChild(button);
            }
            elEntries.querySelector("button")?.focus({ preventScroll: true });
        }
    }

    tabPort.onMessage.addListener((msg) => {
        if (msg?.action === "passkey-context") {
            renderPasskeyContext(msg.context);
        } else if (msg?.action === "passkey-created") {
            // the credential has been minted but is not yet stored; the user must save
            // the entry out-of-band and confirm before the ceremony completes
            elActions.classList.add("hidden");
            passkeySaveFile = msg.file || msg.path;
            passkeySaveContent = msg.armored || "";
            passkeyRpId = msg.rpId || "";
            config.then((c) => {
                passkeyPassdir = c.passdir;
                elCommitToggle.checked = !!c.gitInPasskeyCommand;
                refreshSaveCommand();
            });
            setStatus("Save the new passkey entry to continue");
            elSave.classList.remove("hidden");
            // preventScroll: the enlarged body may not have been re-measured yet, and
            // scrolling the overflow-hidden body to the new button would clip the title
            elCopy.focus({ preventScroll: true });
        }
    });
}

/**
 * Initialise the passkey conflict notice: shown instead of the fill view when another
 * extension controls the page's WebAuthn API while the user holds Parcel passkeys for
 * the site. Offers a per-origin dismissal (persisted by the content script), a link to
 * the documentation, and a plain close.
 * @since 1.0.4
 * @param {object} deps - Wiring provided by the popup script.
 * @param {object} deps.tabPort - Bidirectional content-script port (postMessage/onMessage).
 * @returns {void}
 */
export function initPasskeyConflict(deps) {
    const { tabPort } = deps;
    const elRoot = document.getElementById("passkey-conflict");
    const disableActions = () => elRoot.querySelectorAll("button").forEach((button) => (button.disabled = true));

    document.body.classList.add("passkey-popup");
    elRoot.classList.remove("hidden");

    tabPort.onMessage.addListener((msg) => {
        if (msg?.action === "passkey-conflict-context" && msg.context?.origin) {
            document.getElementById("passkey-conflict-origin").textContent = msg.context.origin;
        }
    });
    document.getElementById("passkey-conflict-dismiss").addEventListener("click", () => {
        disableActions();
        tabPort.postMessage({ action: "passkey-conflict-dismiss" });
    });
    document.getElementById("passkey-conflict-docs").addEventListener("click", () => {
        window.open("https://github.com/parcel-pm/parcel#passkey-conflicts-with-other-password-managers", "_blank", "noopener,noreferrer");
    });
    elRoot.querySelectorAll(".passkey-conflict-close").forEach((button) =>
        button.addEventListener("click", () => {
            disableActions();
            tabPort.postMessage({ action: "close" });
        }),
    );
    document.getElementById("passkey-conflict-dismiss").focus();
}

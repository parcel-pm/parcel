"use strict";
(async () => {
    const token = new URLSearchParams(window.location.search).get("token") || "broadcast";
    const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const tabPort = chrome.tabs.connect(tab.id, { name: token });
    tabPort.onDisconnect.addListener(() => {
        chrome.runtime.lastError; // suppress errors on pages where the content script is not injected
        tabPort.disconnected = true;
    });
    const port = chrome.runtime.connect({ name: "popup" });
    const ul = document.querySelector("ul");
    let limit = true;

    // init specific to the popup invocation type
    if (token === "broadcast") {
        document.body.classList.add("action-popup");
        window.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
                ev.preventDefault();
                if (document.getElementById("detail").classList.contains("hidden")) {
                    window.close();
                } else {
                    document.getElementById("detail").classList.add("hidden");
                    document.getElementById("modal-shade").classList.add("hidden");
                    document.querySelector(".selected").scrollIntoView({ behavior: "smooth", block: "nearest" });
                    document.querySelector(".selected").focus();
                }
            } else if (ev.key === "ArrowLeft") {
                document.getElementById("detail").classList.add("hidden");
                document.getElementById("modal-shade").classList.add("hidden");
                document.querySelector(".selected").scrollIntoView({ behavior: "smooth", block: "nearest" });
                document.querySelector(".selected").focus();
            }
        });
        tabPort.onMessage.addListener((msg) => {
            if (msg?.action === "close") {
                window.close();
            }
        });
    } else {
        document.body.classList.add("context-popup");
        // the iframe is off-limits to the page origin, so need to tell it when we change size
        new ResizeObserver((entries) => {
            tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });
            console.log("resize", document.body.scrollWidth, document.body.scrollHeight);
        }).observe(document.body);
        tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });
        window.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
                tabPort.postMessage({ action: "close" });
            }
        });
    }

    if (!tab.url) {
        limit = false;
        document.getElementById("origin").classList.add("hidden");
    }

    document.getElementById("modal-shade").addEventListener("click", () => {
        document.getElementById("detail").classList.add("hidden");
        document.getElementById("modal-shade").classList.add("hidden");
        document.querySelector(".selected").focus();
    });

    window.addEventListener("keydown", (ev) => {
        let selected = document.querySelector(".selected");
        if (ev.key === "ArrowDown") {
            ev.preventDefault();
            selected.classList.remove("selected");
            if (selected.tagName === "LI" && selected.nextElementSibling) {
                selected = selected.nextElementSibling;
            } else if (selected.tagName === "INPUT") {
                selected = document.querySelector("li") || selected;
            }
            selected.classList.add("selected");
            selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
            selected.focus();
        } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            selected.classList.remove("selected");
            if (selected.tagName === "LI") {
                if (selected.previousElementSibling) selected = selected.previousElementSibling;
                else selected = document.getElementById("searchPattern");
            }
            selected.classList.add("selected");
            selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
            selected.focus();
        } else if (ev.key === "ArrowRight" && selected.tagName === "LI") {
            ev.preventDefault();
            if (document.body.classList.contains("action-popup")) {
                document.querySelector("li.selected button").click();
            }
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            (document.querySelector("li.selected") || document.querySelector("li"))?.click();
        }
    });

    // parcel config from the native host
    const config = new Promise((resolve) => {
        port.postMessage({ action: "config" });
        port.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                resolve(msg?.config);
            }
        });
    });

    // listen for error messages returned from the content script
    tabPort.onMessage.addListener((msg) => {
        if (msg?.action === "error") {
            const p = document.createElement("p");
            p.classList.add("error");
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => el.remove());
            document.body.insertAdjacentElement("afterbegin", p);
        }
    });

    // listen for messages from the native host
    port.onMessage.addListener(async (msg) => {
        if (msg.action === "match") {
            while (ul.firstChild) {
                ul.removeChild(ul.firstChild);
            }
            for (const entry of msg.entries) {
                const li = document.createElement("li");

                const tag = document.createElement("span");
                tag.classList.add("tag");
                tag.textContent = entry.rule.tag;
                tag.style.backgroundColor = `#${entry.rule.color}`;
                let rgb = parseInt(entry.rule.color, 16);
                rgb = [rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff];
                const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
                if (luma < 75) tag.style.color = "#eee";
                li.appendChild(tag);

                const name = document.createElement("span");
                name.setAttribute("title", entry.path);
                name.classList.add("name");
                name.textContent = entry.rule.strip ? entry.name.replace(new RegExp(entry.rule.strip, "ui"), "") : entry.name;
                li.appendChild(name);

                const button = document.createElement("button");
                button.classList.add("detail");
                button.textContent = ">";
                button.setAttribute("title", "Show detailed content");
                button.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    document.querySelector(".selected")?.classList.remove("selected");
                    button.closest("li").classList.add("selected");
                    const detail = document.getElementById("detail");
                    const plaintext = document.getElementById("plaintext");
                    plaintext.textContent = "Loading...";
                    detail.classList.remove("hidden");
                    document.getElementById("modal-shade").classList.remove("hidden");
                    port.postMessage({ action: "decrypt", intent: "detail", path: entry.path });
                });
                li.appendChild(button);

                li.addEventListener("click", (ev) => {
                    port.postMessage({ action: "decrypt", intent: "fill", path: entry.path });
                });

                ul.appendChild(li);
            }
        } else if (msg.action === "plaintext") {
            if (msg.intent === "fill" && !tabPort.disconnected) {
                tabPort.postMessage({ action: "fill", token, plaintext: msg.plaintext, config: await config });
            } else if (msg.intent === "detail") {
                document.getElementById("plaintext").textContent = msg.plaintext;
                document.body.style.minHeight = document.getElementById("detail").scrollHeight + "px";
            }
        } else if (msg.action === "error") {
            const p = document.createElement("p");
            p.classList.add("error");
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => el.remove());
            document.body.insertAdjacentElement("afterbegin", p);
            document.getElementById("detail").classList.add("hidden");
            document.getElementById("modal-shade").classList.add("hidden");
            p.scrollIntoView({ behavior: "instant", block: "nearest" });
        }
    });

    const search = document.getElementById("searchPattern");

    // re-run the search when the search input changes
    search.addEventListener("input", (ev) => {
        update();
        document.querySelector(".selected").classList.remove("selected");
        search.classList.add("selected");
    });

    // re-run the search
    function update() {
        port.postMessage({ action: "match", url: tab.url || "unknown-url://", search: search.value, limit });
    }

    // initial search
    update();

    // UI updates when the anti-phishing mode is toggled
    document.getElementById("searchPattern").focus();
    document.getElementById("searchPattern").addEventListener("keydown", (ev) => {
        if (ev.key === "Backspace" && search.value.length === 0) {
            limit = false;
            document.getElementById("origin").classList.add("hidden");
        }
    });
})();

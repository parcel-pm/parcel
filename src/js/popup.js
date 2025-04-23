"use strict";
(async () => {
    const token = new URLSearchParams(window.location.search).get("token") || "broadcast";
    const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const tabPort = chrome.tabs.connect(tab.id, { name: token });
    const port = chrome.runtime.connect({ name: "popup" });
    const ul = document.querySelector("ul");

    // parcel config from the native host
    const config = new Promise((resolve) => {
        port.postMessage({ action: "config" });
        port.onMessage.addListener((msg) => {
            if (msg?.action === "config") {
                resolve(msg?.config);
            }
        });
    });

    // the iframe is off-limits to the page origin, so need to tell it when we change size
    new ResizeObserver((entries) => {
        tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });
        console.log("resize", document.body.scrollWidth, document.body.scrollHeight);
    }).observe(document.body);
    tabPort.postMessage({ action: "resize", width: document.body.scrollWidth, height: document.body.scrollHeight });

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

                li.addEventListener("click", (ev) => {
                    port.postMessage({ action: "decrypt", path: entry.path });
                });

                ul.appendChild(li);
            }
        } else if (msg.action === "plaintext") {
            tabPort.postMessage({ action: "fill", token, plaintext: msg.plaintext, config: await config });
            //alert(JSON.stringify(msg, null, 2));
        } else if (msg.action === "error") {
            const p = document.createElement("p");
            p.classList.add("error");
            p.textContent = msg.error;
            document.querySelectorAll("p.error").forEach((el) => el.remove());
            document.body.insertAdjacentElement("afterbegin", p);
        }
    });

    // re-run the search when the origin limit is toggled
    const limit = document.getElementById("limit");
    limit.addEventListener("change", (ev) => {
        update();
    });

    // re-run the search when the search input changes
    const search = document.getElementById("search");
    search.addEventListener("input", (ev) => {
        update();
    });

    // re-run the search
    function update() {
        port.postMessage({ action: "match", url: tab.url, search: search.value, limit: limit.checked });
    }

    // initial search
    update();

    // UI updates when the anti-phishing mode is toggled
    document.getElementById("search").focus();
    document.getElementById("search").addEventListener("keydown", (ev) => {
        if (ev.key === "Backspace" && search.value.length === 0) {
            document.getElementById("limit").checked = false;
            document.getElementById("search").setAttribute("placeholder", "Reckless global search...");
        }
    });
})();

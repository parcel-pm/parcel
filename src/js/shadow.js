"use strict";

// Track shadow roots as they are created so we don't have to search for them later
var _attachShadow;
if (!_attachShadow) {
    _attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
        const root = _attachShadow.call(this, options);
        const hostUUID = crypto.randomUUID();
        this.setAttribute("is-shadow", "");
        this.setAttribute("parcel-shadow-host", hostUUID);
        root.addEventListener("click", (ev) => {
            const evUUID = crypto.randomUUID();
            ev.target.setAttribute("parcel-shadow-event", evUUID);
            document.dispatchEvent(new CustomEvent("parcel-shadow-click", { detail: { host: hostUUID, target: evUUID } }));
        });
        return root;
    };
}

"use strict";

// Track shadow roots as they are created so we don't have to search for them later
var _attachShadow;
if (!_attachShadow) {
    _attachShadow = Element.prototype.attachShadow;
    /**
     * Override of Element.prototype.attachShadow that tags shadow hosts so they can be
     * located later, and re-dispatches clicks originating inside shadow roots.
     * @since 1.0.0
     * @param {object} options - The shadow root init options (mode, delegatesFocus, etc.).
     * @returns {ShadowRoot} The created shadow root (click tracking is attached asynchronously on the next macrotask).
     */
    Element.prototype.attachShadow = function (options) {
        const root = _attachShadow.call(this, options);
        setTimeout(() => {
            // move the hook logic outside of the attachShadow call to avoid it from running inside anybody's custom element constructor
            const hostUUID = crypto.randomUUID();
            this.setAttribute("is-shadow", "");
            this.setAttribute("parcel-shadow-host", hostUUID);

            const shadowEvents = new WeakSet();
            const clickHandler = (ev) => {
                if (shadowEvents.has(ev)) return; // avoids handling the same event on both the target element *and* the shadow host
                shadowEvents.add(ev);
                const evUUID = crypto.randomUUID();
                ev.target.setAttribute("parcel-shadow-event", evUUID);
                document.dispatchEvent(
                    new CustomEvent("parcel-shadow-click", { detail: { host: hostUUID, target: evUUID, x: ev.clientX, y: ev.clientY } }),
                );
            };

            root.addEventListener("click", clickHandler);
            this.addEventListener("click", clickHandler);
        }, 0);
        return root;
    };
}

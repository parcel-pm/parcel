"use strict";

// Track shadow roots as they are created so we don't have to search for them later
let _attachShadow;
if (!_attachShadow) {
    _attachShadow = Element.prototype.attachShadow;

    // Shared across all shadow hosts so that a single physical click is only
    // re-dispatched once, even when it bubbles through several nested shadow
    // roots. Without this, a click inside e.g. <custom-login> -> <custom-input> ->
    // <input> would fire parcel-shadow-click twice: once for the innermost root
    // (with the real <input> as ev.target) and again for each ancestor root
    // (where ev.target has been retargeted to the ancestor host). The ancestor
    // dispatch would then resolve to the host element rather than the real
    // input, causing handleTriggerClick to reject it and close the popup that
    // the innermost dispatch just opened.
    const handledClicks = new WeakSet();

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

            const clickHandler = (ev) => {
                // Dedup across both the shadow root and its host, and across all
                // ancestor shadow roots the same click bubbles through. The
                // innermost handler runs first and sees the un-retargeted target,
                // which is the element we actually want to handle.
                if (handledClicks.has(ev)) return;
                handledClicks.add(ev);
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

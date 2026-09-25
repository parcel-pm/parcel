"use strict";

/**
 * Delay before reconnecting a dead native host, in milliseconds. Both unexpected
 * disconnects and the ping watchdog use it. Short enough that an MV3 service-worker
 * suspension inside the window is covered by the constructor's cold-start connect.
 *
 * @since 1.0.8
 */
const RECONNECT_DELAY_MS = 1000;

/**
 * Native host transport for the background agent.
 *
 * Owns the native messaging connection: initial connect, reconnect scheduling, the
 * keepalive ping, serialised request/response calls, and broadcast-message dispatch.
 * Higher-level handling of config, entries, and broadcast payloads is delegated to the
 * owner via constructor callbacks; the transport itself is agnostic of Agent state.
 *
 * @since 1.0.8
 */
export class NativeTransport extends EventTarget {
    #connectedNative = false;
    #host;
    #pendingCall = null;
    /** Always-fulfilled promise settling when the previous native call has fully finished (including timeouts); see {@link NativeTransport.call}. */
    #nativeCallLock = Promise.resolve();
    #nativePingInterval = null;
    #nativePingFailures = 0;
    #reconnectTimer = null;
    #destroyed = false;
    // Injected callbacks into the owning Agent
    #onError;
    #onBroadcast;
    #onDisconnect;

    /**
     * Construct a new transport, connecting to the native host immediately.
     * @since 1.0.8
     * @param {object} callbacks - Handlers for host-originated events.
     * @param {function(string): void} callbacks.onError - Broadcast error from the host.
     * @param {function(string, object): void} callbacks.onBroadcast - Broadcast action payload from the host.
     * @param {function(): void} callbacks.onDisconnect - The host disconnected unexpectedly.
     */
    constructor({ onError, onBroadcast, onDisconnect }) {
        super();
        this.#onError = onError;
        this.#onBroadcast = onBroadcast;
        this.#onDisconnect = onDisconnect;
        this.connectNative();
    }

    /**
     * Whether the native host connection is currently considered live.
     * @since 1.0.8
     * @returns {boolean} `true` when connected and not destroyed.
     */
    get connected() {
        return this.#connectedNative;
    }

    /**
     * Stop all timers and disconnect. No reconnect is attempted after this.
     * @since 1.0.8
     * @returns {void}
     */
    destroy() {
        this.#destroyed = true;
        this.stopNativePing();
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        this.#rejectPendingCall?.("Agent destroyed");
        if (this.#host) {
            try {
                this.#host.disconnect();
            } catch {
                // already disconnected
            }
        }
    }

    /**
     * Ensure the native host connection is open, (re)connecting if necessary.
     *
     * Idempotent: a no-op when the connection is already live, so it is safe to
     * call from multiple lifecycle hooks (constructor, onStartup, onInstalled).
     * @since 1.0.2
     * @returns {void}
     */
    ensureConnected() {
        if (this.#destroyed || this.#connectedNative) return;
        this.connectNative();
    }

    /**
     * Schedule a native-host reconnect, replacing any pending reconnect.
     *
     * If the current connection is still considered live (e.g. init failed
     * against a wedged host that never disconnected), the port is forcibly
     * disconnected so the retry spawns a fresh host process; the resulting
     * `#onNativeDisconnect` then schedules the actual reconnect on its normal
     * short timer. Should the browser never deliver `onDisconnect` for the
     * forced disconnect, an identity-guarded fallback clears the stale state
     * and reconnects, so the agent cannot wedge with a dead-but-flagged-live
     * port while no ping watchdog is running.
     * @since 1.0.7
     * @param {number} delay - Time to wait before reconnecting, in milliseconds.
     * @returns {void}
     */
    scheduleReconnect(delay) {
        if (this.#destroyed) return;
        if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            if (this.#connectedNative && this.#host) {
                const host = this.#host;
                try {
                    host.disconnect();
                } catch (_err) {
                    // already disconnected; nothing to clean up
                }
                // Fallback if onDisconnect is never delivered for the forced disconnect
                setTimeout(() => {
                    if (!this.#destroyed && this.#connectedNative && this.#host === host) {
                        this.#connectedNative = false;
                        this.ensureConnected();
                    }
                }, 1000);
            }
            this.ensureConnected();
        }, delay);
    }

    /**
     * Open a connection to the native host.
     * @since 1.0.0
     * @returns {void}
     */
    connectNative() {
        if (this.#destroyed) return;
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        this.#host = chrome.runtime.connectNative("com.github.erayd.parcel");
        this.#connectedNative = true;
        this.#host.onDisconnect.addListener(this.#onNativeDisconnect.bind(this));
        this.#host.onMessage.addListener(this.#onNativeMessage.bind(this));
    }

    /**
     * Start a periodic ping to the native host to prevent the idle watchdog
     * (in src/parcel-host's dd() shadow) from killing the host during normal
     * idle periods. The interval is well within the host's 300s timeout.
     *
     * A ping timeout does not necessarily mean the host is dead - the ping's
     * 5s window can lapse while the host is legitimately busy (e.g. a long
     * pinentry wait inside a decrypt). But if several pings fail in a row the
     * host is assumed wedged with its pipe still open (where the watchdog
     * cannot help), so a reconnect is scheduled through scheduleReconnect():
     * it force-disconnects the port, and its identity-guarded fallback
     * recovers even when the browser never delivers onDisconnect for that
     * self-initiated disconnect (which it does not for a host that never
     * exits).
     *
     * @since 1.0.5
     * @returns {void}
     */
    startNativePing() {
        if (this.#nativePingInterval) this.stopNativePing();
        this.#nativePingInterval = setInterval(() => {
            if (!this.#connectedNative) return;
            this.call("ping", {}, 5000)
                .then(() => {
                    this.#nativePingFailures = 0;
                })
                .catch((err) => {
                    console.error(`Native host ping failed: ${err.message}`);
                    if (++this.#nativePingFailures >= 3 && this.#connectedNative) {
                        console.error("Native host unresponsive after 3 consecutive pings - reconnecting");
                        this.#nativePingFailures = 0;
                        this.scheduleReconnect(RECONNECT_DELAY_MS);
                    }
                });
        }, 60_000);
    }

    /**
     * Stop the periodic native host ping.
     * @since 1.0.5
     * @returns {void}
     */
    stopNativePing() {
        if (this.#nativePingInterval) {
            clearInterval(this.#nativePingInterval);
            this.#nativePingInterval = null;
        }
    }

    /**
     * Call the native host.
     *
     * Calls are strictly serialised via a promise chain: the native messaging
     * transport can drop messages sent in rapid succession, so the next call must
     * not post to the host until the previous call has fully settled. Awaiting a
     * shared "current call" promise is not sufficient - two concurrent callers both
     * read the settled promise before either publishes its own, defeating the mutex.
     * @since 1.0.0
     * @param {string} action - The action to send to the native host.
     * @param {object} [message={}] - The message to send to the native host.
     * @param {number} [timeout=2000] - The timeout for the call in milliseconds.
     * @param {number} [deadline=null] - Epoch-ms deadline; the call is dropped if it has passed once the lock is free.
     * @returns {Promise<*>} The native host response payload.
     * @throws {Error} If not connected, the dispatch deadline has passed, the call times out, or the host errors.
     */
    async call(action, message = {}, timeout = 2000, deadline = null) {
        // executed only once the previous call has settled
        const run = () => {
            if (deadline !== null && Date.now() > deadline) {
                const err = new Error(`Native call deadline expired: ${action}`);
                err.notDispatched = true;
                throw err;
            }
            return new Promise((resolve, reject) => {
                if (!this.#connectedNative) {
                    const err = new Error("Not connected to native host");
                    err.notDispatched = true;
                    reject(err);
                    return;
                }
                const token = crypto.randomUUID();
                // Remove the listener on settle to prevent a late response for a
                // timed-out call from corrupting a subsequent in-flight call.
                const onMessage = (ev) => {
                    cleanup();
                    if (ev.detail?.error) reject(new Error(ev.detail.error));
                    else resolve(ev.detail.data);
                };
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error(`Native host call timed out: ${action}`));
                }, timeout);
                const cleanup = () => {
                    clearTimeout(timer);
                    this.removeEventListener(token, onMessage);
                    if (this.#pendingCall?.token === token) this.#pendingCall = null;
                };
                this.#pendingCall = { reject, cleanup, token };
                this.addEventListener(token, onMessage, { once: true });
                this.#host.postMessage({ ...message, token, action });
            });
        };

        const result = this.#nativeCallLock.then(run);
        this.#nativeCallLock = result.then(
            () => {},
            () => {},
        );
        return result;
    }

    /**
     * Reject any pending native call with the given error message.
     *
     * This is used when the host sends a broadcast error or disconnects
     * unexpectedly - the pending call (if any) should receive the actual
     * error immediately rather than waiting for the timeout to fire.
     * @param {string} message - The error message.
     * @since 1.0.4
     * @returns {void}
     */
    #rejectPendingCall(message) {
        if (!this.#pendingCall) return;
        this.#pendingCall.reject(new Error(message));
        this.#pendingCall.cleanup();
        this.#pendingCall = null;
    }

    /**
     * Handle messages from the native host.
     * @since 1.0.0
     * @param {object} message - The message from the native host.
     * @returns {Promise<void>}
     */
    async #onNativeMessage(message) {
        if (message.token === "broadcast") {
            if ("error" in message) {
                this.#onError(message.error);
                this.#rejectPendingCall(message.error);
            }
            if (message?.data?.action) {
                this.#onBroadcast(message.data.action, message.data);
            }
        } else {
            this.dispatchEvent(new CustomEvent(message.token, { detail: message }));
        }
    }

    /**
     * Handle disconnections from the native host, reinitialising on unexpected disconnects.
     *
     * The owner's `onDisconnect` callback clears any derived state (e.g. the config),
     * so `Agent` waits for the new host's init.
     * @since 1.0.0
     * @returns {Promise<void>}
     */
    async #onNativeDisconnect() {
        this.#connectedNative = false;
        this.stopNativePing();
        this.#onDisconnect();
        if (this.#host.error) {
            console.error(new Error(this.#host.error.message));
        }
        if (chrome.runtime.lastError) {
            console.error(new Error(chrome.runtime.lastError.message));
        }
        this.#rejectPendingCall("Native host disconnected unexpectedly");
        console.error("Native host disconnected unexpectedly - reinitialising...");
        // Reconnect on the next tick. Under MV3 the service worker may be
        // terminated inside this 1s window; on the next cold start the
        // constructor re-runs connectNative() anyway, so correctness is
        // preserved either way.
        this.scheduleReconnect(RECONNECT_DELAY_MS);
    }
}

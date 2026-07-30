/**
 * Shared helpers for Parcel's passkey (WebAuthn) support.
 *
 * Provides base64url codecs, a minimal CBOR encoder, and builders for the
 * protocol structures Parcel synthesises (clientDataJSON, attestationObject).
 *
 * Parcel's fixed AAGUID is 5ca471bb-a56d-46ad-a496-67e70e9ed9fb.
 *
 * @module webauthn
 * @since 1.0.4
 */

/**
 * Encode bytes as base64url (no padding).
 *
 * Accepts ArrayBuffer in addition to Uint8Array because callers (e.g.
 * crypto.subtle.digest) return ArrayBuffer.
 *
 * @param {Uint8Array|ArrayBuffer} bytes - input bytes
 * @returns {string} base64url-encoded string
 * @since 1.0.4
 */
export function b64urlEncode(bytes) {
    if (bytes instanceof ArrayBuffer) {
        bytes = new Uint8Array(bytes);
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a base64url string (padding optional) to bytes.
 *
 * Returns Uint8Array (not ArrayBuffer) because callers need typed-array
 * access (.length, .set()).
 *
 * @param {string} str - base64url-encoded string
 * @returns {Uint8Array} decoded bytes
 * @since 1.0.4
 */
export function b64urlDecode(str) {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Encode bytes as standard base64.
 *
 * @param {Uint8Array|ArrayBuffer} bytes - input bytes
 * @returns {string} base64-encoded string
 * @since 1.0.4
 */
export function b64Encode(bytes) {
    if (bytes instanceof ArrayBuffer) {
        bytes = new Uint8Array(bytes);
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Encode a string as UTF-8 bytes.
 *
 * @param {string} str - input string
 * @returns {Uint8Array} UTF-8 bytes
 * @since 1.0.4
 */
export function utf8Encode(str) {
    return new TextEncoder().encode(str);
}

/**
 * Encode a value as CBOR. Supports unsigned/negative integers, byte strings
 * (Uint8Array), text strings, arrays, and Maps.
 *
 * @param {*} value - value to encode
 * @returns {Uint8Array} CBOR-encoded bytes
 * @since 1.0.4
 */
export function cborEncode(value) {
    const out = [];
    const pushInt = (major, n) => {
        let val;
        if (n >= 0) {
            val = n;
        } else {
            major = 1;
            val = -1 - n;
        }
        if (val < 24) {
            out.push((major << 5) | val);
        } else if (val < 256) {
            out.push((major << 5) | 24, val);
        } else if (val < 65536) {
            out.push((major << 5) | 25, (val >> 8) & 0xff, val & 0xff);
        } else if (val < 4294967296) {
            out.push((major << 5) | 26, (val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff);
        } else {
            throw new Error("CBOR integer too large");
        }
    };
    const cborEncodeHead = (major, val) => {
        const head = [];
        if (val < 24) {
            head.push((major << 5) | val);
        } else if (val < 256) {
            head.push((major << 5) | 24, val);
        } else if (val < 65536) {
            head.push((major << 5) | 25, (val >> 8) & 0xff, val & 0xff);
        } else if (val < 4294967296) {
            head.push((major << 5) | 26, (val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff);
        } else {
            throw new Error("CBOR length too large");
        }
        return head;
    };
    const pushBytes = (bytes) => {
        out.push(...cborEncodeHead(2, bytes.length), ...bytes);
    };
    const pushText = (str) => {
        const bytes = utf8Encode(str);
        out.push(...cborEncodeHead(3, bytes.length), ...bytes);
    };
    const encode = (v) => {
        if (typeof v === "number" && Number.isInteger(v)) {
            pushInt(0, v);
        } else if (v instanceof Uint8Array) {
            pushBytes(v);
        } else if (typeof v === "string") {
            pushText(v);
        } else if (Array.isArray(v)) {
            out.push(...cborEncodeHead(4, v.length));
            v.forEach(encode);
        } else if (v instanceof Map) {
            out.push(...cborEncodeHead(5, v.size));
            v.forEach((val, key) => {
                encode(key);
                encode(val);
            });
        } else {
            throw new Error("Unsupported CBOR value type");
        }
    };
    encode(value);
    return new Uint8Array(out);
}

/**
 * Build the authenticatorData for an attestation (registration). Flags are
 * UP|UV|BE|BS|AT (0x5d) and the sign count is always zero - parcel passkeys
 * are multi-device style credentials with no monotonic counter.
 *
 * @param {string} rpId - relying party id
 * @param {Uint8Array} credentialId - raw credential id bytes
 * @param {string} publicKeyHex - uncompressed P-256 coordinates (x||y) as hex
 * @returns {Promise<Uint8Array>} authenticatorData bytes
 * @since 1.0.4
 */
export async function buildAttestationAuthData(rpId, credentialId, publicKeyHex) {
    const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(rpId)));
    const flags = new Uint8Array([0x5d]);
    const signCount = new Uint8Array(4);
    const aaguid = new Uint8Array([0x5c, 0xa4, 0x71, 0xbb, 0xa5, 0x6d, 0x46, 0xad, 0xa4, 0x96, 0x67, 0xe7, 0x0e, 0x9e, 0xd9, 0xfb]);
    const idLen = new Uint8Array([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]);
    const pubBytes = new Uint8Array(publicKeyHex.match(/../g).map((b) => parseInt(b, 16)));
    const x = pubBytes.subarray(0, 32);
    const y = pubBytes.subarray(32, 64);
    // COSE_Key: {1:2 (EC2), 3:-7 (ES256), -1:1 (P-256), -2:x, -3:y}
    // Insertion order must be preserved: Map.forEach is order-stable and the
    // resulting byte sequence must match what the host signs. The order here
    // also happens to be canonical-CBOR (sorted by key), but that's incidental.
    const cose = cborEncode(
        new Map([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x],
            [-3, y],
        ]),
    );
    const out = new Uint8Array(rpIdHash.length + flags.length + 4 + 16 + 2 + credentialId.length + cose.length);
    let offset = 0;
    for (const part of [rpIdHash, flags, signCount, aaguid, idLen, credentialId, cose]) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/**
 * Build a "none"-type attestationObject wrapping the given authenticatorData.
 *
 * The "none" format omits attestation statements: the relying party receives
 * no provenance claim about the authenticator. This is the standard choice for
 * software authenticators that cannot attest to hardware roots of trust.
 *
 * @param {Uint8Array} authData - authenticatorData bytes
 * @returns {Uint8Array} attestationObject bytes (CBOR)
 * @since 1.0.4
 */
export function buildAttestationObject(authData) {
    return cborEncode(
        new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
        ]),
    );
}

/**
 * Build clientDataJSON for a ceremony. Key order is fixed for determinism.
 *
 * @param {string} type - "webauthn.create" or "webauthn.get"
 * @param {string} challengeB64Url - challenge as a base64url string
 * @param {string} origin - caller origin
 * @returns {Uint8Array} clientDataJSON bytes
 * @since 1.0.4
 */
export function buildClientDataJSON(type, challengeB64Url, origin) {
    return utf8Encode(
        JSON.stringify({
            type: type,
            challenge: challengeB64Url,
            origin: origin,
            crossOrigin: false,
        }),
    );
}

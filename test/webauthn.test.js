/**
 * Tests for src/js/webauthn.js
 *
 * @since 1.0.4
 */

"use strict";

import { test, describe } from "node:test";
import assert from "node:assert";
import nodeCrypto from "node:crypto";
import * as webauthn from "../src/js/webauthn.js";

function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(str) {
    return new Uint8Array(str.match(/../g).map((b) => parseInt(b, 16)));
}

describe("Webauthn", () => {
    // -----------------------------------------------------------------------
    // b64urlEncode / b64urlDecode
    describe("b64urlEncode / b64urlDecode", () => {
        test("encodes bytes as unpadded base64url", () => {
            assert.strictEqual(webauthn.b64urlEncode(new Uint8Array([0xfb, 0xff, 0xbe])), "-_--"); // "+/++" -> "-_--"
            assert.strictEqual(webauthn.b64urlEncode(new Uint8Array([])), "");
            assert.strictEqual(webauthn.b64urlEncode(new TextEncoder().encode("hi")), "aGk");
        });

        test("accepts an ArrayBuffer input", () => {
            assert.strictEqual(webauthn.b64urlEncode(new Uint8Array([1, 2, 3]).buffer), "AQID");
        });

        test("decodes with and without padding", () => {
            assert.deepStrictEqual(webauthn.b64urlDecode("aGk"), new TextEncoder().encode("hi"));
            assert.deepStrictEqual(webauthn.b64urlDecode("aGk="), new TextEncoder().encode("hi"));
        });
    });

    // -----------------------------------------------------------------------
    // b64Encode
    describe("b64Encode", () => {
        test("encodes standard padded base64", () => {
            assert.strictEqual(webauthn.b64Encode(new TextEncoder().encode("hello?")), "aGVsbG8/");
            assert.strictEqual(webauthn.b64Encode(new Uint8Array([0xfb])), "+w==");
        });
    });

    // -----------------------------------------------------------------------
    // cborEncode (known-answer vectors from RFC 8949 appendix A)
    describe("cborEncode", () => {
        const vectors = [
            [0, "00"],
            [1, "01"],
            [10, "0a"],
            [23, "17"],
            [24, "1818"],
            [100, "1864"],
            [255, "18ff"],
            [256, "190100"],
            [1000, "1903e8"],
            [65535, "19ffff"],
            [65536, "1a00010000"],
            [1000000, "1a000f4240"],
            [4294967295, "1affffffff"],
            [-1, "20"],
            [-10, "29"],
            [-24, "37"],
            [-25, "3818"],
            [-100, "3863"],
            [-1000, "3903e7"],
            [new Uint8Array([]), "40"],
            [fromHex("0102ff"), "430102ff"],
            ["", "60"],
            ["a", "6161"],
            ["fmt", "63666d74"],
            ["IETF", "6449455446"],
            [[], "80"],
            [[1, 2, 3], "83010203"],
            [[1, [2, 3], [4, 5]], "8301820203820405"],
            [new Map(), "a0"],
            [new Map([[1, 2]]), "a10102"],
            [new Map([["a", 1]]), "a1616101"],
            [
                new Map([
                    ["a", 1],
                    ["b", [2, 3]],
                ]),
                "a26161016162820203",
            ],
        ];
        for (const [value, expected] of vectors) {
            const label =
                value instanceof Uint8Array ? `h'${hex(value)}'` : value instanceof Map ? `map(${value.size})` : JSON.stringify(value);
            test(`encodes ${label} as ${expected}`, () => {
                assert.strictEqual(hex(webauthn.cborEncode(value)), expected);
            });
        }

        test("encodes multi-byte UTF-8 text with a byte-count length", () => {
            // "ü" is two bytes in UTF-8 but a single UTF-16 code unit
            assert.strictEqual(hex(webauthn.cborEncode("ü")), "62c3bc");
        });

        test("rejects integers above 2^32-1", () => {
            assert.throws(() => webauthn.cborEncode(4294967296), /too large/);
        });

        test("rejects unsupported types", () => {
            assert.throws(() => webauthn.cborEncode(null), /Unsupported/);
            assert.throws(() => webauthn.cborEncode({}), /Unsupported/);
            assert.throws(() => webauthn.cborEncode(1.5), /Unsupported/);
        });

        test("encodes the COSE ES256 key shape used by buildAttestationAuthData", () => {
            const x = new Uint8Array(32).fill(0x01);
            const y = new Uint8Array(32).fill(0x02);
            const cose = webauthn.cborEncode(
                new Map([
                    [1, 2],
                    [3, -7],
                    [-1, 1],
                    [-2, x],
                    [-3, y],
                ]),
            );
            const expected =
                "a5" + // map(5)
                "0102" + // 1: 2 (kty EC2)
                "0326" + // 3: -7 (alg ES256)
                "2001" + // -1: 1 (crv P-256)
                "215820" + // -2: bytes(32)
                hex(x) +
                "225820" + // -3: bytes(32)
                hex(y);
            assert.strictEqual(hex(cose), expected);
        });
    });

    // -----------------------------------------------------------------------
    // buildAttestationAuthData
    describe("buildAttestationAuthData", () => {
        const credentialId = new Uint8Array(32).fill(0x42);
        const publicKeyHex = hex(new Uint8Array(32).fill(0xaa)) + hex(new Uint8Array(32).fill(0xbb));

        test("produces the expected structure", async () => {
            const authData = await webauthn.buildAttestationAuthData("example.com", credentialId, publicKeyHex);
            // rpIdHash
            const rpIdHash = nodeCrypto.createHash("sha256").update("example.com").digest();
            assert.strictEqual(hex(authData.subarray(0, 32)), rpIdHash.toString("hex"));
            // flags UP|UV|BE|BS|AT
            assert.strictEqual(authData[32], 0x5d);
            // sign count zero
            assert.deepStrictEqual(authData.subarray(33, 37), new Uint8Array(4));
            // AAGUID 5ca471bb-a56d-46ad-a496-67e70e9ed9fb
            assert.deepStrictEqual(
                authData.subarray(37, 53),
                new Uint8Array([0x5c, 0xa4, 0x71, 0xbb, 0xa5, 0x6d, 0x46, 0xad, 0xa4, 0x96, 0x67, 0xe7, 0x0e, 0x9e, 0xd9, 0xfb]),
            );
            // credential id length + id
            assert.deepStrictEqual(authData.subarray(53, 55), new Uint8Array([0, 32]));
            assert.deepStrictEqual(authData.subarray(55, 87), credentialId);
            // COSE key follows (77 bytes: map(5) + 7 head bytes + 2 keyed bstr(32) pairs)
            assert.strictEqual(authData[87], 0xa5);
            assert.strictEqual(authData.length, 87 + 77);
        });
    });

    // -----------------------------------------------------------------------
    // buildAttestationObject
    describe("buildAttestationObject", () => {
        test("wraps authData in a fmt:none attestation object", () => {
            const attObj = webauthn.buildAttestationObject(new Uint8Array([0x00]));
            const expected =
                "a3" + // map(3)
                "63666d74" + // "fmt"
                "646e6f6e65" + // "none"
                "6761747453746d74" + // "attStmt"
                "a0" + // {}
                "686175746844617461" + // "authData"
                "4100"; // bytes(1) 00
            assert.strictEqual(hex(attObj), expected);
        });
    });

    // -----------------------------------------------------------------------
    // buildClientDataJSON
    describe("buildClientDataJSON", () => {
        test("produces deterministic field order", () => {
            const bytes = webauthn.buildClientDataJSON("webauthn.get", "Y2hhbGxlbmdl", "https://example.com");
            assert.strictEqual(
                new TextDecoder().decode(bytes),
                '{"type":"webauthn.get","challenge":"Y2hhbGxlbmdl","origin":"https://example.com","crossOrigin":false}',
            );
        });
    });
});

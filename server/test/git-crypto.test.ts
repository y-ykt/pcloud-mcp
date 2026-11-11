// © 2026 Yasuhiko Yokote

/**
 * Tests of git decryption (`src/git/crypto.ts`).
 *
 * The ciphertext is built inside the tests. The storage format is
 * nonce(12) + ciphertext + authentication tag(16). **No real key and no real data is used.**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  ENCRYPT_OVERHEAD,
  GitDecryptError,
  decrypt,
  parseKeyHex,
} from "../src/git/crypto.ts";

const KEY = Buffer.alloc(32, 7);

/** Encrypts in the storage format (test only). */
function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

describe("decrypt - round trip", () => {
  it("restores what was encrypted", () => {
    const plain = Buffer.from("ref: refs/heads/main\n");
    assert.deepEqual(decrypt(KEY, encrypt(KEY, plain)), plain);
  });

  it("encryption adds exactly 28 bytes", () => {
    const plain = Buffer.from("x");
    assert.equal(encrypt(KEY, plain).length, plain.length + ENCRYPT_OVERHEAD);
  });

  it("restores binary data too (including NUL)", () => {
    const plain = Buffer.from([0x74, 0x72, 0x65, 0x65, 0x00, 0xff, 0x00, 0x01]);
    assert.deepEqual(decrypt(KEY, encrypt(KEY, plain)), plain);
  });
});

describe("decrypt - reporting failures", () => {
  it("throws GitDecryptError for a wrong key", () => {
    const other = Buffer.alloc(32, 8);
    assert.throws(() => decrypt(other, encrypt(KEY, Buffer.from("a"))), GitDecryptError);
  });

  it("throws GitDecryptError when a single byte of the body changes (authentication tag)", () => {
    const data = encrypt(KEY, Buffer.from("hello"));
    data.writeUInt8(data.readUInt8(14) ^ 0x01, 14);
    assert.throws(() => decrypt(KEY, data), GitDecryptError);
  });

  it("throws GitDecryptError for input that is too short", () => {
    assert.throws(() => decrypt(KEY, Buffer.alloc(ENCRYPT_OVERHEAD)), GitDecryptError);
  });

  it("throws GitDecryptError when the key is not 32 bytes long", () => {
    assert.throws(() => decrypt(Buffer.alloc(16), Buffer.alloc(64)), GitDecryptError);
  });
});

describe("parseKeyHex - key format", () => {
  it("turns 64 hexadecimal characters (surrounding whitespace allowed) into 32 bytes", () => {
    const hex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    assert.deepEqual(parseKeyHex(` ${hex}\n`), Buffer.from(hex, "hex"));
  });

  it("throws GitDecryptError for a wrong length or non-hexadecimal input", () => {
    assert.throws(() => parseKeyHex("abcd"), GitDecryptError);
    assert.throws(() => parseKeyHex("g".repeat(64)), GitDecryptError);
  });
});

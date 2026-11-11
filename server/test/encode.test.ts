// © 2026 Yasuhiko Yokote

/**
 * Tests for the choice of output format (`src/image/encode.ts`).
 *
 * **Simply taking the smaller one makes the text in line drawings unreadable.**
 * That is what actually made PDF drawings unreadable. These tests prevent it from happening again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JPEG_WINS_BELOW, pickEncoding } from "../src/image/encode.ts";

const buf = (kib: number): Uint8Array => new Uint8Array(Math.round(kib * 1024));

describe("pickEncoding - choosing between PNG and JPEG", () => {
  it("**takes PNG for line drawings** (even when JPEG is slightly smaller)", () => {
    // Measured on a patent drawing at 150 dpi: PNG 169 KiB / JPEG 158 KiB (ratio 0.93)
    assert.equal(pickEncoding(buf(169), buf(158)).mimeType, "image/png");
    // Measured at 192 dpi: ratio 0.95
    assert.equal(pickEncoding(buf(225), buf(215)).mimeType, "image/png");
  });

  it("takes PNG when JPEG is the larger one", () => {
    assert.equal(pickEncoding(buf(137), buf(139)).mimeType, "image/png");
  });

  it("**takes JPEG for photographs**", () => {
    // Measured: PNG 837 KiB / JPEG 89 KiB (ratio 0.11)
    assert.equal(pickEncoding(buf(837), buf(89)).mimeType, "image/jpeg");
  });

  it("takes JPEG even for a screenshot with text when it is small enough", () => {
    // Measured: PNG 85 KiB / JPEG 54 KiB (ratio 0.63)
    assert.equal(pickEncoding(buf(85), buf(54)).mimeType, "image/jpeg");
  });

  it("switches on either side of the threshold", () => {
    const png = buf(100);
    const justUnder = new Uint8Array(Math.floor(png.byteLength * JPEG_WINS_BELOW) - 1);
    const justOver = new Uint8Array(Math.ceil(png.byteLength * JPEG_WINS_BELOW) + 1);
    assert.equal(pickEncoding(png, justUnder).mimeType, "image/jpeg");
    assert.equal(pickEncoding(png, justOver).mimeType, "image/png");
  });

  it("returns the bytes of the chosen one", () => {
    const png = buf(100);
    const jpeg = buf(10);
    assert.equal(pickEncoding(png, jpeg).bytes, jpeg);
    assert.equal(pickEncoding(jpeg, png).bytes, jpeg);
  });

  it("does not crash when the PNG is empty", () => {
    assert.equal(pickEncoding(new Uint8Array(0), buf(1)).mimeType, "image/jpeg");
  });
});

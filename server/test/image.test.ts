// © 2026 Yasuhiko Yokote

/**
 * Tests for image downscaling (`src/image/downscale.ts`).
 *
 * The images used by the tests are built in code (`fixtures.ts`), so that no binaries are kept in the repository.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  downscaleImage,
  edgeLadder,
  IMAGE_LIMITS,
  ImageError,
  isSupportedImage,
  visualTokens,
} from "../src/image/downscale.ts";
import { makeGif, makePng, makeWebp } from "./fixtures.ts";

// ---------------------------------------------------------------- pure calculations

describe("isSupportedImage - formats the receiving side can read", () => {
  for (const m of ["image/jpeg", "image/png", "image/gif", "image/webp", "IMAGE/PNG"]) {
    it(`accepts: ${m}`, () => assert.equal(isSupportedImage(m), true));
  }
  for (const m of ["image/heic", "image/tiff", "image/bmp", "image/svg+xml", "application/pdf"]) {
    it(`rejects: ${m}`, () => assert.equal(isSupportedImage(m), false));
  }
});

describe("visualTokens - counts in 28x28 cells", () => {
  it("a size that divides evenly", () => assert.equal(visualTokens(280, 280), 100));
  it("rounds a remainder up", () => assert.equal(visualTokens(281, 281), 121));
  it("1000x1000 gives 1296, matching the reference documentation", () => assert.equal(visualTokens(1000, 1000), 1296));
});

describe("edgeLadder - long edges to try", () => {
  it("shrinks to 80% at each step and ends at the lower limit itself", () => {
    assert.deepEqual(edgeLadder(1024), [1024, 819, 655, 524, 419, 384]);
  });

  it("produces nothing below the lower limit", () => {
    assert.ok(edgeLadder(1024).every((e) => e >= IMAGE_LIMITS.minEdge));
  });

  it("**always reaches the lower limit**", () => {
    assert.equal(edgeLadder(1024).at(-1), IMAGE_LIMITS.minEdge);
  });

  it("**returns a value below the lower limit as it is (does not enlarge it)**", () => {
    assert.deepEqual(edgeLadder(100), [100]);
  });
});

// ---------------------------------------------------------------- downscaling

describe("downscaleImage - when it does not downscale", () => {
  it("returns the original as it is when both dimensions and byte count fit", async () => {
    const png = makePng(200, 150);
    const r = await downscaleImage(png, "image/png");
    assert.equal(r.unchanged, true);
    assert.equal(r.bytes, png, "must return the original array itself");
    assert.deepEqual([r.originalWidth, r.originalHeight], [200, 150]);
    assert.deepEqual([r.width, r.height], [200, 150]);
    assert.equal(r.overBudget, false);
  });


  // A small GIF is returned as it is, so the reported format must be the input format.
  it("an unchanged GIF keeps its format", async () => {
    const input = makeGif();
    const r = await downscaleImage(input, "image/gif");
    assert.equal(r.unchanged, true);
    assert.equal(r.mimeType, "image/gif");
    assert.equal(r.bytes, input, "must return the original array itself");
  });

  it("the format is matched without regard to case", async () => {
    const r = await downscaleImage(makeGif(), "IMAGE/GIF");
    assert.equal(r.mimeType, "image/gif");
  });
  it("reports the original pixel dimensions correctly", async () => {
    const r = await downscaleImage(makePng(640, 480), "image/png");
    assert.deepEqual([r.originalWidth, r.originalHeight], [640, 480]);
  });
});

describe("downscaleImage - when it downscales", () => {
  it("shrinks when the long edge exceeds the limit", async () => {
    const r = await downscaleImage(makePng(2000, 1000), "image/png", { maxEdge: 512 });
    assert.equal(r.unchanged, false);
    assert.equal(Math.max(r.width, r.height), 512);
    assert.deepEqual([r.originalWidth, r.originalHeight], [2000, 1000]);
  });

  it("keeps the aspect ratio", async () => {
    const r = await downscaleImage(makePng(1600, 400), "image/png", { maxEdge: 800 });
    assert.ok(Math.abs(r.width / r.height - 4) < 0.05, `the aspect ratio changed: ${r.width}x${r.height}`);
  });

  it("**does not enlarge beyond the original**", async () => {
    const r = await downscaleImage(makePng(300, 300, true), "image/png", {
      maxEdge: 2000,
      maxBytes: 100,
    });
    assert.ok(Math.max(r.width, r.height) <= 300, `it was enlarged: ${r.width}x${r.height}`);
  });

  it("outputs either JPEG or PNG", async () => {
    const r = await downscaleImage(makePng(1200, 900, true), "image/png", { maxEdge: 512 });
    assert.ok(["image/jpeg", "image/png"].includes(r.mimeType));
  });

  it("**chooses PNG for a flat image**", async () => {
    // Solid black makes the PNG extremely small
    const r = await downscaleImage(makePng(1200, 900), "image/png", { maxEdge: 512 });
    assert.equal(r.mimeType, "image/png");
  });

  it("fits within the byte limit", async () => {
    const budget = 128 * 1024;
    const r = await downscaleImage(makePng(1600, 1200, true), "image/png", {
      maxEdge: 1024,
      maxBytes: budget,
    });
    assert.ok(r.bytes.byteLength <= budget, `it does not fit: ${r.bytes.byteLength}`);
    assert.equal(r.overBudget, false);
    assert.ok(Math.max(r.width, r.height) < 1024, "it fit without shrinking, so this does not test anything");
  });

  it("**sets overBudget and returns when it cannot fit at all**", async () => {
    const r = await downscaleImage(makePng(1600, 1200, true), "image/png", { maxBytes: 200 });
    assert.equal(r.overBudget, true);
    assert.ok(r.bytes.byteLength > 200, "overBudget is not set although it does not fit");
    assert.equal(Math.max(r.width, r.height), IMAGE_LIMITS.minEdge, "it was not shrunk to the lower limit");
  });
});

describe("downscaleImage - clamping of options and rejection", () => {
  it("clamps the requested long edge to the allowed range", async () => {
    const r = await downscaleImage(makePng(4000, 4000), "image/png", { maxEdge: 99_999 });
    assert.ok(Math.max(r.width, r.height) <= IMAGE_LIMITS.maxMaxEdge);
  });

  it("throws ImageError for an unsupported format", async () => {
    await assert.rejects(
      downscaleImage(makePng(10, 10), "image/heic"),
      (e: unknown) => e instanceof ImageError && e.reason === "unsupported-format",
    );
  });

  it("throws ImageError for data that cannot be opened as an image", async () => {
    await assert.rejects(
      downscaleImage(new TextEncoder().encode("this is not an image"), "image/png"),
      (e: unknown) => e instanceof ImageError,
    );
  });
});

// ---------------------------------------------------------------- WebP

/**
 * WebP cannot be decoded here, so it is returned as it is; only its header is read.
 * The headers below are built by hand. Nothing after the header is ever looked at.
 */
function riff(fourcc: string, payload: number[]): Uint8Array {
  const body = [...Buffer.from("WEBP"), ...Buffer.from(fourcc), ...le32(payload.length), ...payload];
  return new Uint8Array([...Buffer.from("RIFF"), ...le32(body.length), ...body]);
}
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/** Extended format: flags, 3 reserved bytes, then width-1 and height-1 as 24-bit values. */
const webpExtended = (w: number, h: number) => riff("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
/** Lossy format: a 3-byte frame tag, the start code, then 14-bit width and height. */
const webpLossy = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
/** Lossless format: the signature byte, then width-1 and height-1 packed as 14 bits each. */
const webpLossless = (w: number, h: number) =>
  riff("VP8L", [0x2f, ...le32(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14))]);

describe("downscaleImage - WebP", () => {
  it("**returns a real WebP as it is, as image/webp**", async () => {
    // A complete 1x1 lossless WebP, not only a header
    const input = makeWebp();
    const r = await downscaleImage(input, "image/webp");
    assert.equal(r.unchanged, true);
    assert.equal(r.mimeType, "image/webp");
    assert.equal(r.bytes, input, "must return the original array itself");
    assert.deepEqual([r.width, r.height, r.originalWidth, r.originalHeight], [1, 1, 1, 1]);
    assert.equal(r.overBudget, false);
  });

  for (const [name, make] of [
    ["extended", webpExtended],
    ["lossy", webpLossy],
    ["lossless", webpLossless],
  ] as const) {
    it(`reads the pixel dimensions from the ${name} header`, async () => {
      const r = await downscaleImage(make(640, 480), "image/webp");
      assert.deepEqual([r.width, r.height], [640, 480]);
      assert.equal(r.visualTokens, 23 * 18);
    });
  }

  it("**is not downscaled even when the long edge is over the requested one**", async () => {
    const r = await downscaleImage(webpExtended(2000, 1500), "image/webp", { maxEdge: 512 });
    assert.equal(r.unchanged, true);
    assert.deepEqual([r.width, r.height], [2000, 1500]);
  });

  it("**reports the long edge it could not apply**", async () => {
    // Requested explicitly
    assert.equal((await downscaleImage(webpExtended(2000, 1500), "image/webp", { maxEdge: 512 })).edgeNotApplied, 512);
    // The default applies in the same way
    assert.equal((await downscaleImage(webpExtended(1500, 2000), "image/webp")).edgeNotApplied, IMAGE_LIMITS.defaultMaxEdge);
    // Within the long edge there is nothing to report
    assert.equal((await downscaleImage(webpExtended(512, 100), "image/webp", { maxEdge: 512 })).edgeNotApplied, undefined);
    assert.equal((await downscaleImage(makeWebp(), "image/webp")).edgeNotApplied, undefined);
  });

  it("an image that can be downscaled never reports it", async () => {
    assert.equal((await downscaleImage(makePng(2000, 1000), "image/png", { maxEdge: 512 })).edgeNotApplied, undefined);
    assert.equal((await downscaleImage(makePng(200, 150), "image/png")).edgeNotApplied, undefined);
  });

  it("**refuses a WebP whose long edge is over the largest one accepted, because it cannot be made smaller**", async () => {
    const limit = IMAGE_LIMITS.maxMaxEdge;
    // At the limit it is still returned, in either orientation
    assert.equal((await downscaleImage(webpExtended(limit, 10), "image/webp")).unchanged, true);
    assert.equal((await downscaleImage(webpExtended(10, limit), "image/webp")).unchanged, true);
    for (const [w, h] of [[limit + 1, 10], [10, limit + 1], [10000, 10000]] as const) {
      await assert.rejects(
        downscaleImage(webpExtended(w, h), "image/webp"),
        (e: unknown) =>
          e instanceof ImageError &&
          e.reason === "webp-too-many-pixels" &&
          e.message.includes(`${w}x${h} px`) &&
          e.message.includes(`limit ${limit} px`),
        `accepted: ${w}x${h}`,
      );
    }
  });

  it("**refuses a WebP over the byte limit, because it cannot be made smaller**", async () => {
    await assert.rejects(
      downscaleImage(webpExtended(640, 480), "image/webp", { maxBytes: 20 }),
      (e: unknown) =>
        e instanceof ImageError &&
        e.reason === "webp-too-large" &&
        /30 bytes/.test(e.message) &&
        /limit 20 bytes/.test(e.message),
    );
  });

  for (const [name, bytes] of [
    ["not RIFF", new Uint8Array(Buffer.from("this is not a WebP image at all"))],
    ["cut off inside the header", webpExtended(640, 480).subarray(0, 22)],
    ["an unknown chunk", riff("XXXX", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["a lossy header without the start code", riff("VP8 ", [0, 0, 0, 0, 0, 0, ...le16(10), ...le16(10)])],
  ] as const) {
    it(`throws ImageError for a broken WebP: ${name}`, async () => {
      await assert.rejects(
        downscaleImage(bytes, "image/webp"),
        (e: unknown) => e instanceof ImageError && e.reason === "cannot-open",
      );
    });
  }
});

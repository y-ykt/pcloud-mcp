// © 2026 Yasuhiko Yokote

/**
 * Downscale an image to a size that Claude can read.
 *
 * **Why this is needed.**
 * Passed as it is, the tool result is too large to reach the receiving side.
 * By measurement, 43,876 characters of base64 went through and 216,520 characters did not.
 * **The same file sometimes goes through and sometimes does not**, so the limit appears to be
 * not fixed but dependent on the amount of context free at that moment.
 *
 * **The unit is pixels, not dpi.**
 * A photograph has no physical dimensions. The dpi value embedded in a file
 * may be absent, and may not match reality.
 * The rules of the receiving side are also defined in pixels (counted in cells of 28x28).
 *
 * **There are two separate limits.**
 *   - Pixels: decide the number of visual tokens. The receiving side downscales anything beyond a certain long edge;
 *             this file takes that edge to be 2,576 px. The value has not been verified (`pdf/render.ts` takes 1568)
 *   - Bytes : decide whether the tool result goes through. **This is the one that fails**
 */

import { pickEncoding } from "./encode.ts";

/** The image formats that Claude can receive. Anything else is not treated as an image. */
const SUPPORTED_INPUT = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const IMAGE_LIMITS = {
  /**
   * Default long edge (pixels).
   * A 3:2 image at this size (1024x683) is 37 x 25 = 925 visual tokens; a square one (1024x1024) is 37 x 37 = 1,369.
   */
  defaultMaxEdge: 1024,
  minMaxEdge: 256,
  /** Taken as the high-resolution limit of the receiving side (not verified), beyond which an image is only downscaled. */
  maxMaxEdge: 2576,
  defaultQuality: 80,
  minQuality: 40,
  maxQuality: 95,
  /**
   * Limit on the size after encoding (bytes).
   *
   * In base64 it is about 87,000 characters.
   * That is about 2 times the size that went through (43,876 characters) and about 1/2.5 of the size that failed (216,520 characters).
   */
  defaultMaxBytes: 64 * 1024,
  /** Do not shrink below this. The image becomes unreadable. */
  minEdge: 384,
} as const;

/** The reason an image cannot be downscaled. */
export class ImageError extends Error {
  reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ImageError";
    this.reason = reason;
  }
}

export function isSupportedImage(mime: string): boolean {
  return SUPPORTED_INPUT.has(mime.toLowerCase());
}

export interface DownscaleOptions {
  maxEdge?: number;
  quality?: number;
  maxBytes?: number;
}

export interface Downscaled {
  bytes: Uint8Array;
  /** Output format. When re-encoded, **JPEG only if it is sufficiently smaller than the PNG, otherwise PNG** (see `pickEncoding`). */
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** Returned as it was, without downscaling. */
  unchanged: boolean;
  /** Approximate number of visual tokens (`ceil(w/28) x ceil(h/28)`). */
  visualTokens: number;
  /** Returned without shrinking further, although it does not fit within the limit. */
  overBudget: boolean;
  /**
   * The long edge (pixels) that was asked for but could not be applied.
   * Set only for a format that cannot be downscaled here (WebP) when the image is larger than that.
   * **The caller always states it in the response**, so that the request does not look honored.
   */
  edgeNotApplied?: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Approximate number of visual tokens, counted the way the receiving side counts. */
export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/**
 * List the long edges to try, largest first.
 *
 * Each step shrinks to 80%, and **the last entry is always the lower bound itself.**
 * If a value smaller than the lower bound is given, **only that value is returned. It is never enlarged.**
 */
export function edgeLadder(maxEdge: number): number[] {
  const start = Math.round(maxEdge);
  if (start <= IMAGE_LIMITS.minEdge) return [start];
  const out = [start];
  let e = start;
  for (;;) {
    e = Math.round(e * 0.8);
    if (e <= IMAGE_LIMITS.minEdge) {
      out.push(IMAGE_LIMITS.minEdge);
      return out;
    }
    out.push(e);
  }
}

/**
 * Read the pixel dimensions from the header of a WebP file. Undefined when it is not a WebP header.
 *
 * A WebP file is a RIFF container whose first chunk is one of three kinds:
 *   - `VP8X` (extended): width-1 and height-1 as 24-bit values
 *   - `VP8 ` (lossy):    after a 3-byte frame tag and the start code `9d 01 2a`, 14-bit width and height
 *   - `VP8L` (lossless): after the signature byte `2f`, width-1 and height-1 packed as 14 bits each
 * All values are little-endian.
 */
export function webpDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const tag = (o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
  if (b.length < 16 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return undefined;
  const at = (o: number) => b[o] ?? 0;
  // Each kind needs a different number of header bytes. A file cut off before them is not accepted
  switch (tag(12)) {
    case "VP8X":
      if (b.length < 30) return undefined;
      return {
        width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
        height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
      };
    case "VP8 ":
      if (b.length < 30 || at(23) !== 0x9d || at(24) !== 0x01 || at(25) !== 0x2a) return undefined;
      return {
        width: (at(26) | (at(27) << 8)) & 0x3fff,
        height: (at(28) | (at(29) << 8)) & 0x3fff,
      };
    case "VP8L": {
      if (b.length < 25 || at(20) !== 0x2f) return undefined;
      const bits = (at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)) >>> 0;
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    default:
      return undefined;
  }
}

/** Whether a MIME type is WebP. The one place this is decided. */
export function isWebp(mime: string): boolean {
  return mime.toLowerCase() === "image/webp";
}

/** The message for a WebP over the byte limit. The same wording wherever the limit is applied. */
export function webpTooLarge(bytes: number, limit: number = IMAGE_LIMITS.defaultMaxBytes): string {
  return (
    `This WebP image is too large to return (${bytes} bytes / limit ${limit} bytes). ` +
    "A WebP image cannot be downscaled by this connector."
  );
}

/**
 * The largest original file worth fetching for an image of this format.
 *
 * Other formats are downscaled after the fetch, so the general limit applies.
 * **A WebP is returned as it is, so a file over the limit of a tool result is refused whatever happens.**
 * Knowing that before the fetch avoids transferring a file that is always refused.
 */
export function imageFetchLimit(mime: string, general: number): number {
  return isWebp(mime) ? Math.min(general, IMAGE_LIMITS.defaultMaxBytes) : general;
}

/**
 * Return a WebP image as it is.
 *
 * **`mupdf` cannot open WebP**, so a WebP can be neither decoded nor re-encoded here.
 * The receiving side can read WebP, so the bytes are passed on unchanged and only the header is read.
 * `max_edge` cannot be honored, since nothing here can change the pixels.
 * When the image is larger than that, `edgeNotApplied` reports it and the response states it.
 * **A file over the byte limit, or with a long edge over `maxMaxEdge`, is refused**,
 * because there is no way to make it smaller. A small file can still hold a very large image
 * (a flat drawing compresses well), and the receiving side may reject the whole result for it.
 */
function passThroughWebp(input: Uint8Array, maxBytes: number, maxEdge: number): Downscaled {
  const dim = webpDimensions(input);
  if (dim === undefined || !(dim.width > 0) || !(dim.height > 0)) {
    throw new ImageError("Could not open the image: not a valid WebP header", "cannot-open");
  }
  if (Math.max(dim.width, dim.height) > IMAGE_LIMITS.maxMaxEdge) {
    throw new ImageError(
      `This WebP image has too many pixels to return (${dim.width}x${dim.height} px / ` +
        `limit ${IMAGE_LIMITS.maxMaxEdge} px on the long edge). ` +
        "A WebP image cannot be downscaled by this connector.",
      "webp-too-many-pixels",
    );
  }
  if (input.byteLength > maxBytes) {
    throw new ImageError(webpTooLarge(input.byteLength, maxBytes), "webp-too-large");
  }
  return {
    bytes: input,
    mimeType: "image/webp",
    width: dim.width,
    height: dim.height,
    originalWidth: dim.width,
    originalHeight: dim.height,
    unchanged: true,
    visualTokens: visualTokens(dim.width, dim.height),
    overBudget: false,
    // The long edge asked for is not met, and nothing here can meet it. The caller must say so
    ...(Math.max(dim.width, dim.height) > maxEdge ? { edgeNotApplied: maxEdge } : {}),
  };
}

/**
 * Downscale an image to a size that fits within the limits.
 *
 * **WebP is the exception: it is returned as it is** (see `passThroughWebp`).
 *
 *
 * Steps:
 *   1. If the original **already fits within the limits in both dimensions and bytes, do nothing**
 *   2. If it does not fit, lower the long edge step by step while
 *      **encoding as both PNG and JPEG and taking the one `pickEncoding` chooses**
 *      (JPEG only when it is under 0.7 of the PNG size, otherwise PNG)
 *   3. If it does not fit even at the lower bound, return that result and set `overBudget`
 *
 * Step 3 is not a failure because **an image that arrives small is better than one that cannot be read**.
 * The caller always states in the response that it did not fit.
 */
export async function downscaleImage(
  input: Uint8Array,
  mime: string,
  opts: DownscaleOptions = {},
): Promise<Downscaled> {
  if (!isSupportedImage(mime)) {
    throw new ImageError(`This format cannot be handled as an image: ${mime}`, "unsupported-format");
  }
  const maxEdge = clamp(
    opts.maxEdge ?? IMAGE_LIMITS.defaultMaxEdge,
    IMAGE_LIMITS.minMaxEdge,
    IMAGE_LIMITS.maxMaxEdge,
  );
  const quality = clamp(
    opts.quality ?? IMAGE_LIMITS.defaultQuality,
    IMAGE_LIMITS.minQuality,
    IMAGE_LIMITS.maxQuality,
  );
  const maxBytes = opts.maxBytes ?? IMAGE_LIMITS.defaultMaxBytes;

  if (isWebp(mime)) return passThroughWebp(input, maxBytes, maxEdge);

  const mupdf = await import("mupdf");

  let doc: import("mupdf").Document;
  try {
    doc = mupdf.Document.openDocument(input, mime.toLowerCase());
  } catch (e) {
    throw new ImageError(
      `Could not open the image: ${e instanceof Error ? e.message : "unknown cause"}`,
      "cannot-open",
    );
  }

  try {
    // **`openDocument` opens lazily.** That the content is not an image
    // becomes known only here ("unknown image file format")
    let page: import("mupdf").PDFPage | import("mupdf").Page;
    try {
      page = doc.loadPage(0);
    } catch (e) {
      throw new ImageError(
        `Could not read it as an image: ${e instanceof Error ? e.message : "unknown cause"}`,
        "cannot-open",
      );
    }
    try {
      const b = page.getBounds();
      // mupdf returns the bounds in "points". Only the ratio is used here, so
      // the embedded dpi has no effect, whatever it is
      const bw = b[2] - b[0];
      const bh = b[3] - b[1];
      if (!(bw > 0) || !(bh > 0)) {
        throw new ImageError("Could not get the dimensions of the image", "no-dimensions");
      }

      // The original pixel count is taken from `Image`.
      // **`toPixmap(scale 1)` does not give it.** That renders in points, and
      // differs from the actual pixel count by the resolution embedded in the file
      // (a 632x948 photograph comes out as 190x285)
      let originalWidth: number;
      let originalHeight: number;
      let img: import("mupdf").Image;
      try {
        img = new mupdf.Image(input);
      } catch (e) {
        throw new ImageError(
          `Could not read it as an image: ${e instanceof Error ? e.message : "unknown cause"}`,
          "cannot-open",
        );
      }
      try {
        originalWidth = img.getWidth();
        originalHeight = img.getHeight();
      } finally {
        img.destroy();
      }
      if (!(originalWidth > 0) || !(originalHeight > 0)) {
        throw new ImageError("Could not get the pixel count of the image", "no-dimensions");
      }

      const originalLongEdge = Math.max(originalWidth, originalHeight);

      // 1. If the original already fits, leave it untouched
      if (originalLongEdge <= maxEdge && input.byteLength <= maxBytes) {
        return {
          bytes: input,
          // The bytes are the input, so the format is the input format
          mimeType: mime.toLowerCase() as Downscaled["mimeType"],
          width: originalWidth,
          height: originalHeight,
          originalWidth,
          originalHeight,
          unchanged: true,
          visualTokens: visualTokens(originalWidth, originalHeight),
          overBudget: false,
        };
      }

      // 2. Lower the long edge and look for a size that fits
      let last: Downscaled | undefined;
      for (const edge of edgeLadder(Math.min(maxEdge, originalLongEdge))) {
        const scale = edge / Math.max(bw, bh);
        const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
        try {
          // **JPEG is chosen only when it is sufficiently smaller** (the reason is recorded at `pickEncoding`)
          const enc = pickEncoding(pm.asPNG(), pm.asJPEG(quality));
          const w = pm.getWidth();
          const h = pm.getHeight();
          const chosen: Downscaled = {
            bytes: enc.bytes,
            mimeType: enc.mimeType,
            width: w,
            height: h,
            originalWidth,
            originalHeight,
            unchanged: false,
            visualTokens: visualTokens(w, h),
            overBudget: false,
          };
          if (chosen.bytes.byteLength <= maxBytes) return chosen;
          last = chosen;
        } finally {
          pm.destroy();
        }
      }

      // 3. It did not fit even at the lower bound
      if (last === undefined) {
        throw new ImageError("Could not downscale the image", "downscale-failed");
      }
      return { ...last, overBudget: true };
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

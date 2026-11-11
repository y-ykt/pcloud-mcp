// © 2026 Yasuhiko Yokote

/**
 * Decide whether rendered pixels are returned as PNG or as JPEG.
 *
 * **Simply choosing the smaller one is wrong.**
 * JPEG degrades thin lines and small text. For line art it does not get smaller, and it becomes unreadable.
 *
 * Measured (including the cases that failed before this decision was added):
 *
 * | Content | PNG | JPEG | Ratio |
 * |---|---|---|---|
 * | Patent drawing (line art), 150 dpi | 169 KiB | 158 KiB | **0.93** |
 * | Patent drawing (line art), 192 dpi | 225 KiB | 215 KiB | **0.95** |
 * | Patent drawing (another page) | 137 KiB | 139 KiB | **1.02** |
 * | Screenshot (contains text) | 85 KiB | 54 KiB | 0.63 |
 * | Photograph | 837 KiB | 89 KiB | 0.11 |
 *
 * **Line art is 0.93 or more, and the photograph is 0.11. There is a gap between them.**
 * So the rule is: "**JPEG is chosen only when it is sufficiently smaller**".
 */

/**
 * The condition for choosing JPEG: only when it is smaller than this ratio to the PNG.
 *
 * At 0.7, line art (0.93 to 1.02) becomes PNG, and the screenshot (0.63) and the photograph (0.11) become JPEG.
 */
export const JPEG_WINS_BELOW = 0.7;

export interface Encoded {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

/**
 * Decide which of the 2 encodings to return.
 *
 * **When in doubt, choose PNG.** The size can be reduced by the limit mechanism, but
 * text that has been degraded cannot be restored.
 */
export function pickEncoding(png: Uint8Array, jpeg: Uint8Array): Encoded {
  if (png.byteLength === 0) return { bytes: jpeg, mimeType: "image/jpeg" };
  return jpeg.byteLength < png.byteLength * JPEG_WINS_BELOW
    ? { bytes: jpeg, mimeType: "image/jpeg" }
    : { bytes: png, mimeType: "image/png" };
}

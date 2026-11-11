// © 2026 Yasuhiko Yokote

/**
 * Parsing of the pack index (`.idx`, version 2).
 *
 * An idx is an index from a SHA-1 to an offset in the pack file.
 * It is small (1072 + 28N bytes + the large offset table), so
 * **reading only the idx first tells cheaply which pack holds the wanted object.**
 *
 * Structure (all big-endian):
 *
 *   magic 0xff 't' 'O' 'c' + version (4)
 *   fanout[256]  ... cumulative number of objects whose first byte is b or less
 *   SHA-1 x N (20 bytes each, ascending)
 *   CRC32 x N (4 bytes each; not used)
 *   offset x N (4 bytes each; if the most significant bit is set, an index into the large offset table)
 *   large offset x M (8 bytes each; only when the pack exceeds 2 GiB)
 *   SHA-1 of the pack + SHA-1 of the idx itself (20 bytes each)
 *
 * Version 1 (the old format without a magic) is not supported. Recent git writes version 2.
 */
import { GitFormatError } from "./object.ts";

const MAGIC = 0xff744f63; // 0xff 't' 'O' 'c'
const HEADER = 8;
const FANOUT = 256 * 4;

export interface PackIndex {
  /** Number of objects contained. */
  count: number;
  /** Looks up the offset in the pack for a SHA-1 (40 hexadecimal characters). undefined if absent. */
  find(hash: string): number | undefined;
}

export function parseIndex(data: Buffer): PackIndex {
  if (data.length < HEADER + FANOUT + 40) {
    throw new GitFormatError(`The idx is too short (${data.length} bytes)`);
  }
  if (data.readUInt32BE(0) !== MAGIC) {
    throw new GitFormatError("The idx magic is wrong (the old version 1 format is not supported)");
  }
  const version = data.readUInt32BE(4);
  if (version !== 2) {
    throw new GitFormatError(`Unexpected idx version: ${version}`);
  }

  const fanout = (b: number) => data.readUInt32BE(HEADER + b * 4);
  const count = fanout(255);

  const shaBase = HEADER + FANOUT;
  const crcBase = shaBase + 20 * count;
  const offBase = crcBase + 4 * count;
  const largeBase = offBase + 4 * count;
  // The number of entries in the large offset table is not known here (only that it ends before the last 40 bytes)
  if (data.length < largeBase + 40) {
    throw new GitFormatError(
      `The idx length does not match (${data.length} bytes; with ${count} objects it must be at least ${largeBase + 40})`,
    );
  }

  return {
    count,
    find(hash: string): number | undefined {
      if (!/^[0-9a-f]{40}$/.test(hash)) return undefined;
      const wanted = Buffer.from(hash, "hex");
      const first = wanted.readUInt8(0);
      let lo = first === 0 ? 0 : fanout(first - 1);
      let hi = fanout(first); // exclusive
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const cmp = wanted.compare(data, shaBase + 20 * mid, shaBase + 20 * mid + 20);
        if (cmp === 0) {
          const raw = data.readUInt32BE(offBase + 4 * mid);
          if ((raw & 0x80000000) === 0) return raw;
          const idx = raw & 0x7fffffff;
          const pos = largeBase + 8 * idx;
          if (pos + 8 > data.length - 40) {
            throw new GitFormatError(`Large offset table index out of range: ${idx}`);
          }
          const big = data.readBigUInt64BE(pos);
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new GitFormatError("The offset is too large to handle");
          }
          return Number(big);
        }
        if (cmp < 0) hi = mid;
        else lo = mid + 1;
      }
      return undefined;
    },
  };
}

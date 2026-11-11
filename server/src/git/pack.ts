// © 2026 Yasuhiko Yokote

/**
 * Extracting objects from a pack file.
 *
 * Structure of a pack:
 *
 *   "PACK" + version (4) + object count (4)
 *   entry x N ... variable-length header (3-bit type + length) + zlib-compressed data
 *   SHA-1 of the pack itself (20 bytes)
 *
 * The position of an entry is looked up in the idx (`idx.ts`). **There is no need to read from the start in order.**
 *
 * Types 6 (ofs_delta) and 7 (ref_delta) are deltas. The object is restored by applying
 * the delta instructions (copy / insert) to a base object. The base can itself be a delta,
 * so this recurses (with a limit on the depth; git's own default depth is 50).
 *
 * The extracted result is not verified here. The caller (repo.ts) checks that
 * the object name equals the SHA-1 of the content. An error in applying a delta is caught there too.
 */
import { inflateSync } from "node:zlib";

import { GitFormatError, type GitObject, type GitObjectType } from "./object.ts";

/** Limit on the depth of a delta chain. Set slightly above git's default (50). */
const MAX_DELTA_DEPTH = 64;

const TYPE_NAMES: Record<number, GitObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

export function parsePackHeader(pack: Buffer): { version: number; count: number } {
  if (pack.length < 12 + 20 || pack.toString("latin1", 0, 4) !== "PACK") {
    throw new GitFormatError("The pack magic is wrong");
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new GitFormatError(`Unexpected pack version: ${version}`);
  }
  return { version, count: pack.readUInt32BE(8) };
}

/** The means of looking up an object outside the pack, such as the base of a ref_delta. */
export type BaseResolver = (hash: string) => Promise<GitObject>;

/**
 * Extracts the object at `offset` in the pack.
 *
 * `findInPack` looks up the offset of the base in the idx of the same pack;
 * if it is not found there, `resolveBase` is used (the base is loose or in another pack).
 */
export async function readPackedObject(
  pack: Buffer,
  offset: number,
  findInPack: (hash: string) => number | undefined,
  resolveBase: BaseResolver,
  depth = 0,
): Promise<GitObject> {
  if (depth > MAX_DELTA_DEPTH) {
    throw new GitFormatError(`The delta chain is too deep (${depth})`);
  }
  if (offset < 12 || offset >= pack.length - 20) {
    throw new GitFormatError(`Offset in the pack out of range: ${offset}`);
  }

  // ---- variable-length header: 3-bit type + length (7 bits at a time, least significant first)
  let pos = offset;
  let byte = pack.readUInt8(pos++);
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = pack.readUInt8(pos++);
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }

  // ---- additional header, depending on the type
  let baseOffset: number | undefined;
  let baseHash: string | undefined;
  if (type === OFS_DELTA) {
    // Negative offset. An encoding specific to this field that accumulates ((value + 1) << 7)
    byte = pack.readUInt8(pos++);
    let value = byte & 0x7f;
    while (byte & 0x80) {
      byte = pack.readUInt8(pos++);
      value = (value + 1) * 128 + (byte & 0x7f);
    }
    baseOffset = offset - value;
    if (baseOffset < 12) {
      throw new GitFormatError(`ofs_delta base out of range: ${baseOffset}`);
    }
  } else if (type === REF_DELTA) {
    baseHash = pack.subarray(pos, pos + 20).toString("hex");
    pos += 20;
  } else if (TYPE_NAMES[type] === undefined) {
    throw new GitFormatError(`Unexpected type in the pack: ${type}`);
  }

  // ---- zlib inflation of the body. The compressed length is not recorded, so everything up to the end is passed
  //      (inflation stops at the end of the stream, and the entries that follow are ignored)
  let inflated: Buffer;
  try {
    inflated = inflateSync(pack.subarray(pos, pack.length - 20));
  } catch {
    throw new GitFormatError(`zlib inflation in the pack failed (offset ${offset})`);
  }
  if (inflated.length !== size) {
    throw new GitFormatError(
      `The length in the pack does not match (header ${size}, inflated ${inflated.length})`,
    );
  }

  const plainType = TYPE_NAMES[type];
  if (plainType !== undefined) {
    return { type: plainType, body: inflated };
  }

  // ---- delta. Extract the base, then apply the delta
  let base: GitObject;
  if (baseOffset !== undefined) {
    base = await readPackedObject(pack, baseOffset, findInPack, resolveBase, depth + 1);
  } else {
    const inPack = findInPack(baseHash!);
    base =
      inPack !== undefined
        ? await readPackedObject(pack, inPack, findInPack, resolveBase, depth + 1)
        : await resolveBase(baseHash!);
  }
  return { type: base.type, body: applyDelta(base.body, inflated) };
}

/** Reads a variable-length integer packed 7 bits at a time, least significant first. */
function readVarint(data: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    if (pos >= data.length) throw new GitFormatError("The length encoding of the delta is truncated");
    byte = data.readUInt8(pos++);
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, next: pos };
}

/** Applies the sequence of delta instructions (copy / insert) to the base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const baseSize = readVarint(delta, pos);
  pos = baseSize.next;
  if (baseSize.value !== base.length) {
    throw new GitFormatError(
      `The base length of the delta does not match (recorded ${baseSize.value}, actual ${base.length})`,
    );
  }
  const resultSize = readVarint(delta, pos);
  pos = resultSize.next;

  const out = Buffer.alloc(resultSize.value);
  let outPos = 0;
  while (pos < delta.length) {
    const cmd = delta.readUInt8(pos++);
    if (cmd & 0x80) {
      // copy: only the bytes whose bit is set are present in the offset and the length
      let copyOffset = 0;
      for (let i = 0; i < 4; i++) {
        if (cmd & (1 << i)) copyOffset |= delta.readUInt8(pos++) << (8 * i);
      }
      let copySize = 0;
      for (let i = 0; i < 3; i++) {
        if (cmd & (0x10 << i)) copySize |= delta.readUInt8(pos++) << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) {
        throw new GitFormatError("A delta copy exceeds the range of the base");
      }
      base.copy(out, outPos, copyOffset, copyOffset + copySize);
      outPos += copySize;
    } else if (cmd !== 0) {
      // insert: copy cmd bytes as they are
      if (pos + cmd > delta.length) {
        throw new GitFormatError("A delta insert is truncated");
      }
      delta.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new GitFormatError("Delta instruction 0 is invalid");
    }
  }
  if (outPos !== resultSize.value) {
    throw new GitFormatError(
      `The length of the delta result does not match (recorded ${resultSize.value}, actual ${outPos})`,
    );
  }
  return out;
}

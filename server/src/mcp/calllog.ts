// © 2026 Yasuhiko Yokote

/**
 * Builds the log record of a `tools/call`.
 *
 * **Only shape and size are recorded. Content is not.**
 * File names, sizes and modification dates are metadata and may be recorded.
 * File content, base64 data and the URLs returned by `getfilelink` are not recorded.
 *
 * The verbosity is set with `LOG_LEVEL`.
 *
 * | Level | What is recorded about a `tools/call` |
 * |---|---|
 * | `warn` / `error` | Nothing (only rejections and internal errors are logged) |
 * | `info` | Tool name, target, elapsed time, success or failure, response length in characters, block types |
 * | `debug` | The above, plus the arguments named in `LOGGABLE_ARGS` and a per-block breakdown |
 */
import { isForbiddenName } from "../guard/path.ts";
import type { ContentBlock, ToolResult } from "./protocol.ts";

/** Names of the arguments that may be recorded. **No others are recorded.** */
const LOGGABLE_ARGS = [
  "path", "file_id", "folder_id", "recursive", "max_depth", "max_entries", "pages", "dpi", "region",
] as const;

/**
 * Masks the names in a path that policy forbids handling.
 *
 * Arguments are recorded even for a rejected call, so **without masking here the log would
 * break the rule that neither the listing nor the content of such a folder is recorded**.
 */
export function redactPath(path: string): string {
  return path
    .split("/")
    // **Leading and trailing whitespace is removed before the test.** It must not be looser than the check in `normalizePath`.
    // Masking too much does no harm, but a name that was not masked cannot be removed from the log afterwards
    .map((seg) => (seg.trim() !== "" && isForbiddenName(seg.trim()) ? "***" : seg))
    .join("/");
}

/** Expresses the target as a single value: the path when there is one, otherwise the id. */
export function describeTarget(args: Record<string, unknown>): string | undefined {
  const p = args["path"];
  if (typeof p === "string") return redactPath(p);
  const f = args["file_id"];
  if (typeof f === "number") return `file_id:${f}`;
  const d = args["folder_id"];
  if (typeof d === "number") return `folder_id:${d}`;
  return undefined;
}

/** Extracts only the arguments that may be recorded. The path is masked. */
function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of LOGGABLE_ARGS) {
    const v = args[k];
    if (v === undefined) continue;
    out[k] = k === "path" && typeof v === "string" ? redactPath(v) : v;
  }
  return out;
}

/** Summary of one content block, without its content. */
function describeBlock(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", chars: b.text.length };
    case "image":
      return { type: "image", mime: b.mimeType, chars: b.data.length };
    case "resource":
      return { type: "resource", mime: b.resource.mimeType, chars: b.resource.blob.length };
  }
}

export interface CallLog extends Record<string, unknown> {
  tool: string;
  target?: string;
  /** Total number of characters in the content blocks. For the whole body see `body_chars`. */
  content_chars: number;
  /** The content block types, in order. Example: `"text,image"`. */
  blocks: string;
  is_error: boolean;
  /** Present only at `debug`. */
  args?: Record<string, unknown>;
  block_detail?: Record<string, unknown>[];
}

/**
 * Builds the log record of a `tools/call`.
 *
 * @param verbose True at the `debug` level. Adds the arguments and the breakdown
 */
export function summarizeCall(
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult | undefined,
  verbose: boolean,
): CallLog {
  const blocks = result?.content ?? [];
  const detail = blocks.map(describeBlock);
  const target = describeTarget(args);
  const out: CallLog = {
    tool,
    ...(target === undefined ? {} : { target }),
    // Total of the content blocks only. The size of the whole body is recorded separately in `body_chars`
    content_chars: detail.reduce((n, b) => n + (b["chars"] as number), 0),
    blocks: blocks.map((b) => b.type).join(",") || "(none)",
    is_error: result?.isError === true,
  };
  if (verbose) {
    out.args = safeArgs(args);
    out.block_detail = detail;
  }
  return out;
}

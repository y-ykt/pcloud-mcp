// © 2026 Yasuhiko Yokote

/**
 * Definitions and execution of the three tools.
 *
 *   list      listing of a folder
 *   stat      metadata of one entry
 *   read_file read content (text, images, Office documents, PDF)
 *
 * Rules:
 *   - Always pass a path through {@link normalizePath} before giving it to pCloud
 *   - Forbidden names are also removed from listings, and **the response states that they were removed**
 *   - Truncation and partial returns **always appear in the response.** Nothing is cut silently
 *   - Fetched bytes are **verified by size and SHA-1 before they are returned**
 */
import { HARD_LIMITS, type Config } from "../config.ts";
import {
  childPath,
  freshAllowedUntil,
  hasForbiddenNames,
  isForbiddenName,
  knownFolder,
  normalizePath,
  PathRejected,
  rememberAllowedFolders,
} from "../guard/path.ts";
import {
  downscaleImage,
  imageFetchLimit,
  IMAGE_LIMITS,
  ImageError,
  isSupportedImage,
  isWebp,
  webpTooLarge,
} from "../image/downscale.ts";
import { docxToMarkdown } from "../office/docx.ts";
import { pptxToMarkdown } from "../office/pptx.ts";
import { clampMaxChars, OFFICE_LIMITS, OfficeError, type OfficeMarkdown } from "../office/types.ts";
import { xlsxToMarkdown } from "../office/xlsx.ts";
import { inkFraction, inkMap, INK_LIMITS, isBlank, notableCells } from "../pdf/ink.ts";
import {
  describeRegion,
  FULL_REGION,
  parseRegion,
  type Region,
  REGION_NAMES,
} from "../pdf/region.ts";
import { clampDpi, PDF_LIMITS, PdfError, renderPdf } from "../pdf/render.ts";
import { IntegrityError, PCloudClient, PCloudError } from "../pcloud/client.ts";
import type { Metadata } from "../pcloud/types.ts";
import type { ContentBlock, ToolDefinition, ToolResult } from "./protocol.ts";

// ---------------------------------------------------------------- formatting

/**
 * Shape pCloud metadata into the form placed in a response.
 *
 * `path` is null when the location of the entry is not known (it was reached by ID and pCloud
 * returned no path). **Then no path is given**: one made up from the name alone would point at
 * a different entry. The ID in the entry reaches it.
 */
function toEntry(m: Metadata, path: string | null): Record<string, unknown> {
  const iso = (t?: number) => (t === undefined ? undefined : new Date(t * 1000).toISOString());
  return {
    name: m.name,
    ...(path === null ? {} : { path }),
    is_folder: m.isfolder,
    ...(m.isfolder ? { folder_id: m.folderid } : { file_id: m.fileid }),
    size: m.size,
    content_type: m.contenttype,
    category: m.category,
    hash: m.hash,
    has_thumbnail: m.thumb,
    created: iso(m.created),
    modified: iso(m.modified),
    width: m.width,
    height: m.height,
  };
}

/** Return both the structured data and its formatted string. */
export function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Format a byte count for a human reader. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]} (${n.toLocaleString("en-US")} bytes)`;
}

/**
 * Describe a fetched file in one sentence.
 *
 * **Machine-readable values go in `structuredContent`, not here.**
 * If the same JSON is put in both, `content` looks like a copy.
 */
function describeFile(name: string, size: number, mime: string): string {
  const kind = mime.startsWith("image/") ? "image" : "file";
  return (
    `${name} (${formatBytes(size)}, ${mime}) was fetched from pCloud. ` +
    `The size and SHA-1 were confirmed to match pCloud. ` +
    `The content of the ${kind} is in the next block.`
  );
}

/**
 * Where a binary (PDF, Office, image) comes from.
 *
 * The conversion and the assembly of the response ({@link renderBinaryContent} onward) are shared by
 * `read_file` (the ordinary area of pCloud) and `git_read` (the folder named by `gitRoot`).
 * **Only the way of fetching and verifying differs**, so this type holds that difference.
 */
export interface BinarySource {
  /** File name used for display. */
  name: string;
  /** Identifiers spread into the response as they are: `path` / `file_id`, or `ref` / `commit` / `path`. */
  ids: Record<string, unknown>;
  size: number;
  mime: string;
  /** Label of the origin: `pCloud`, or a repository and commit such as `example.git` and `23d399c`. */
  origin: string;
  /** Text placed in `verified` of structuredContent. */
  verified: string;
  /** One sentence for the body text saying that the content was verified. */
  verifiedProse: string;
}

/**
 * Describe a fetched image in one sentence.
 *
 * **Always says whether the image was downscaled.**
 */
function describeImage(
  src: BinarySource,
  img: { originalWidth: number; originalHeight: number; width: number; height: number; unchanged: boolean; overBudget: boolean; edgeNotApplied?: number },
): string {
  const head = `${src.name} (${formatBytes(src.size)}, ${src.mime}, ${img.originalWidth}x${img.originalHeight} px) was fetched from ${src.origin}.`;
  const verified = src.verifiedProse;
  if (img.unchanged) {
    // **A request that was not met must not look met.** The size and the token count are those of the original
    const notApplied =
      img.edgeNotApplied === undefined
        ? ""
        : ` **It was not downscaled to the long edge of ${img.edgeNotApplied} px:** ` +
          "A WebP image cannot be downscaled by this connector.";
    return `${head} ${verified} It is in the next block with its original pixels.${notApplied}`;
  }
  const shrunk =
    `To fit a size that can be received, it is returned **downscaled to ${img.width}x${img.height} px**. ` +
    `These are not the original pixels.`;
  const over = img.overBudget
    ? " It was not downscaled any further. If it cannot be read, download the original file from pCloud by other means."
    : "";
  return `${head} ${verified} ${shrunk}${over}`;
}

/** Tool execution error. The wording lets Claude rephrase and retry. */
export function fail(message: string, extra: Record<string, unknown> = {}): ToolResult {
  const data = { error: message, ...extra };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * Time allowed for walking a listing (milliseconds).
 *
 * Stops by itself before the Lambda timeout (25 seconds).
 * **The truncation always appears in the response.**
 */
const LIST_TIME_BUDGET_MS = 18_000;

/** How many folders above an entry are followed before giving up. Far deeper than any real tree. */
const MAX_ANCESTORS = 64;

/**
 * Time allowed for following the folders above an entry (milliseconds).
 *
 * Each folder is one call to pCloud. Without a limit, a deep tree or a slow pCloud would run into
 * the Lambda timeout (25 seconds), and the caller would get a server error instead of a reason.
 * The time is looked at between calls: a single call already under way is not cut short.
 */
const ANCESTOR_TIME_BUDGET_MS = 10_000;

/** Joins a folder path and a name. The root is `/`. */
const joinPath = (folder: string, name: string): string => (folder === "/" ? `/${name}` : `${folder}/${name}`);

/**
 * Finds where a file or folder that was reached by ID is: **returns its path, and applies the
 * forbidden names on the way.**
 *
 * pCloud returns no path for an entry asked for by ID (measured against the real service).
 * An ID therefore says nothing about where the entry is, and two things depend on that:
 *   - **An ID must not get around the forbidden folders.** A path is checked before pCloud is
 *     called; for an ID the check is made on what pCloud returns
 *   - **The answer should carry the real path**, so that the caller can go on by path
 *
 * Both are settled by following the folders above the entry, one by one, up to the root, and
 * putting their names together. A folder whose place is already known settles the rest at once;
 * folders are remembered for a few minutes so that they are not asked about on every call.
 * The root folder is `/` and needs nothing. A `path` returned by pCloud, should there be one, is used as it is.
 *
 * When the root cannot be reached (a folder without a parent, a chain that does not end, a folder
 * pCloud does not describe, or too much time):
 *   - **with names forbidden, the entry is refused.** Nothing is returned on a guess
 *   - with no name forbidden, there is nothing to protect: the entry is returned **without a
 *     path** (null). A path made up from the name alone would point at a different entry
 *
 * The messages do not contain the name of the entry: it may be the very thing that must stay hidden.
 */
async function locateById(client: PCloudClient, meta: Metadata): Promise<string | null> {
  const strict = hasForbiddenNames();
  if (meta.isfolder && meta.folderid === 0) return "/";
  if (meta.path !== undefined) {
    if (strict) normalizePath(meta.path);
    return meta.path;
  }
  const forbiddenEntry = () => new PathRejected("forbidden-name", "This entry cannot be handled, by policy");
  if (strict && isForbiddenName(meta.name)) throw forbiddenEntry();

  /** The place could not be found: refuse when names are forbidden, otherwise go on without a path. */
  const notFound = (message: string): null => {
    if (strict) throw new PathRejected("location-unknown", message);
    return null;
  };
  const UNKNOWN =
    "The location of this entry could not be determined, so it is not returned. Specify it by path instead";

  // The folders passed on the way up, nearest first. Remembered only once the whole way is known
  const passed: { id: number; name: string }[] = [];
  /** The path of the highest folder reached, and how long the finding about it is good. */
  let top: { path: string; until: number } | undefined;
  /** A folder whose path pCloud itself returned on the way. Remembered as well. */
  let named: { id: number; path: string } | undefined;
  const deadline = Date.now() + ANCESTOR_TIME_BUDGET_MS;
  let parentId = meta.parentfolderid;
  for (let hop = 0; hop < MAX_ANCESTORS && top === undefined; hop++) {
    // Reached the root: every folder on the way was allowed, as found just now
    if (parentId === 0) {
      top = { path: "/", until: freshAllowedUntil() };
      break;
    }
    if (parentId === undefined) return notFound(UNKNOWN);
    // Reached a folder whose place is already known. **The folders passed rest on that finding,
    // so they are remembered until it ends, not for a new period**
    const known = knownFolder(parentId);
    if (known !== undefined) {
      top = known;
      break;
    }
    if (Date.now() > deadline) {
      return notFound(
        `Checking where this entry is took too long (over ${ANCESTOR_TIME_BUDGET_MS / 1000} seconds), ` +
          "so it is not returned. Specify it by path instead",
      );
    }
    // Only the name and the parent are needed, so the files of the folder are not asked for
    let parent: Metadata;
    try {
      parent = await client.folderInfo(parentId);
    } catch (e) {
      // With names forbidden a failure here must not let the entry through; it is reported as it is.
      // Otherwise only the path is lost
      if (strict || !(e instanceof PCloudError)) throw e;
      return null;
    }
    if (parent.path !== undefined) {
      if (strict) normalizePath(parent.path);
      top = { path: parent.path, until: freshAllowedUntil() };
      named = { id: parentId, path: parent.path };
      break;
    }
    if (strict && isForbiddenName(parent.name)) throw forbiddenEntry();
    passed.push({ id: parentId, name: parent.name });
    parentId = parent.parentfolderid;
  }
  if (top === undefined) return notFound(UNKNOWN);

  // Put the paths together from the top down, and remember every folder on the way
  const found: { id: number; path: string }[] = named === undefined ? [] : [named];
  let folder = top.path;
  for (const f of passed.reverse()) {
    folder = joinPath(folder, f.name);
    found.push({ id: f.id, path: folder });
  }
  const path = joinPath(folder, meta.name);
  if (meta.isfolder && meta.folderid !== undefined) found.push({ id: meta.folderid, path });
  rememberAllowedFolders(found, top.until);
  return path;
}

/** Accepts either `path` or `file_id`. */
function fileTarget(args: Record<string, unknown>): { path: string } | { fileid: number } {
  const id = args["file_id"];
  if (typeof id === "number" && Number.isInteger(id)) return { fileid: id };
  return { path: normalizePath(args["path"]) };
}

/** Accepts either `path` or `folder_id`. */
function folderTarget(args: Record<string, unknown>): { path: string } | { folderid: number } {
  const id = args["folder_id"];
  if (typeof id === "number" && Number.isInteger(id)) return { folderid: id };
  return { path: normalizePath(args["path"]) };
}

// ---------------------------------------------------------------- text detection

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yml", "yaml", "toml", "ini", "cfg",
  "log", "sql", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh",
  "bash", "zsh", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "swift", "kt", "php",
  "pl", "r", "tex", "srt", "vtt", "gitignore", "env",
]);

/**
 * Whether to treat the file as text.
 *
 * The pCloud `contenttype` is `application/octet-stream` for some extensions, so
 * **both `contenttype` and the extension are checked.**
 * **When in doubt, the file is not treated as text.** Treating it as text by mistake would return garbled characters.
 */
export function looksLikeText(name: string, contentType?: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("text/")) return true;
  if (ct === "application/json" || ct === "application/xml") return true;
  if (/\+(json|xml)$/.test(ct)) return true;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Whether to treat the file as a PDF.
 *
 * For the same reason as `looksLikeText`, both `contenttype` and the extension are checked.
 * Treating a non-PDF as a PDF only makes `renderPdf` fail to open the file, so the check can be loose.
 * A PDF that is not recognized here never reaches `renderPdf`; it is handled as whatever the other
 * format checks decide, or refused.
 */
export function looksLikePdf(name: string, contentType?: string): boolean {
  if ((contentType ?? "").toLowerCase() === "application/pdf") return true;
  return name.toLowerCase().endsWith(".pdf");
}

/** Kind of Office document. `legacy` is a format from before 2007 and cannot be handled. */
export type OfficeKind = "docx" | "xlsx" | "pptx" | "legacy";

const OFFICE_TYPES: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "legacy",
  "application/vnd.ms-excel": "legacy",
  "application/vnd.ms-powerpoint": "legacy",
};

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  doc: "legacy",
  xls: "legacy",
  ppt: "legacy",
};

/**
 * Whether to treat the file as an Office document, and if so, which kind.
 *
 * For the same reason as `looksLikeText`, both `contenttype` and the extension are checked.
 * **The extension takes precedence.** The pCloud `contenttype` can be
 * `application/octet-stream`, and the document would be missed in that case.
 */
export function officeKind(name: string, contentType?: string): OfficeKind | undefined {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return OFFICE_EXTENSIONS[ext] ?? OFFICE_TYPES[(contentType ?? "").toLowerCase()];
}

/** Order of the character encodings to try: the order expected for Japanese text. */
const ENCODINGS = ["utf-8", "shift_jis", "euc-jp", "iso-2022-jp"] as const;

export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * Decode bytes into a UTF-8 string.
 *
 * 1. If there is a BOM, follow it
 * 2. Otherwise decode strictly as UTF-8
 * 3. If that fails, try the encodings in the order expected for Japanese text
 * 4. If none can decode it, return `null` (the caller does not return it as text)
 *
 * When `partial` is true, the end may be cut in the middle of a multi-byte character, so
 * **the content is taken up to the last character boundary that decodes.**
 */
export function decodeText(bytes: Uint8Array, partial = false): DecodedText | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom" };
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }

  for (const enc of ENCODINGS) {
    // When the end is cut, look for the boundary while dropping the last few bytes
    const trims = partial ? [0, 1, 2, 3] : [0];
    for (const trim of trims) {
      const slice = trim === 0 ? bytes : bytes.subarray(0, bytes.byteLength - trim);
      try {
        return { text: new TextDecoder(enc, { fatal: true }).decode(slice), encoding: enc };
      } catch {
        /* try the next one */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- tool definitions

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function toolDefinitions(cfg: Config): ToolDefinition[] {
  return [
    {
      name: "list",
      description:
        "List the contents of a pCloud folder. Non-recursive by default. " +
        "When the number of entries reaches the limit, truncated is true and note says so.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target folder. Default is /" },
          folder_id: { type: "integer", description: "Use instead of path. The root is 0" },
          recursive: { type: "boolean", description: "Also descend into subfolders. Default is false" },
          max_depth: {
            type: "integer",
            description: `Depth when recursive is true. Default ${cfg.listMaxDepth}, limit ${HARD_LIMITS.listMaxDepth}`,
          },
          max_entries: {
            type: "integer",
            description: `Number of entries to return. Default ${cfg.listMaxEntries}, limit ${HARD_LIMITS.listMaxEntries}`,
          },
        },
      },
      annotations: READ_ONLY,
    },
    {
      name: "stat",
      description: "Return the metadata of a file or folder on pCloud.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target path" },
          file_id: { type: "integer", description: "Use instead of path" },
        },
      },
      annotations: READ_ONLY,
    },
    {
      name: "read_file",
      description:
        "Read the content of a file on pCloud. The server determines the format. " +
        "Text is returned as its content (the character encoding is detected and converted to UTF-8), " +
        "an image is downscaled to a readable size, " +
        "Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) are converted to Markdown, " +
        "and for a PDF the specified pages are returned as images (region can return only part of a page at a higher resolution). " +
        "When a conversion or downscaling was done, the response states that fact. " +
        "After fetching, the size and SHA-1 are verified against pCloud. " +
        "The content of any other format (legacy Office formats, archives, audio and so on) cannot be provided.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the target file" },
          file_id: { type: "integer", description: "Use instead of path" },
          as_text: {
            type: "boolean",
            description:
              "Ignore the format detection and read as text. " +
              "Use for text files without an extension and the like. Default is false",
          },
          pages: {
            type: "string",
            description:
              "For a **PDF**: the pages to render. Counted from 1. In the form 1 or 1-3,7. " +
              "If omitted, only information such as the page count is returned and nothing is rendered",
          },
          region: {
            type: "string",
            description:
              "For a **PDF**: which part of the page to draw. If omitted, the whole page. " +
              `One of ${REGION_NAMES.join(", ")}, or the form 3x3:5` +
              " (a cell of a grid that divides the page evenly down and across, counted from the top left to the right). " +
              "**When small text in a figure cannot be read, narrow the area with this.** " +
              "The resolution rises by as much as the drawn area shrinks, so 1/4 of the page is about 2 times finer. " +
              "The returned image is always a single one, so call again with a different value for the other parts",
          },
          dpi: {
            type: "integer",
            description:
              `Resolution for a **PDF**. Default ${PDF_LIMITS.defaultDpi}, ` +
              `clamped to the range ${PDF_LIMITS.minDpi}-${PDF_LIMITS.maxDpi}. ` +
              `However, one image is kept within ${Math.round(PDF_LIMITS.maxPageBytes / 1024)} KiB, so ` +
              "a large value is lowered automatically. **Raising it does not make the image sharper. " +
              "To see finer detail, use region, not dpi**",
          },
          max_edge: {
            type: "integer",
            description:
              `Limit on the long edge of an **image** (pixels). Default ${IMAGE_LIMITS.defaultMaxEdge}, ` +
              `${IMAGE_LIMITS.minMaxEdge}-${IMAGE_LIMITS.maxMaxEdge}. ` +
              "Increase it to read text. However, an image that is too large will not be delivered",
          },
          quality: {
            type: "integer",
            description:
              `Quality when an **image** is encoded as JPEG. Default ${IMAGE_LIMITS.defaultQuality}, ` +
              `${IMAGE_LIMITS.minQuality}-${IMAGE_LIMITS.maxQuality}`,
          },
          max_chars: {
            type: "integer",
            description:
              `Limit on the number of characters when an **Office document** is converted to Markdown. ` +
              `Default ${OFFICE_LIMITS.defaultMaxChars}, ` +
              `${OFFICE_LIMITS.minMaxChars}-${OFFICE_LIMITS.maxMaxChars}. ` +
              "The excess is cut off, and the response says so",
          },
          include_notes: {
            type: "boolean",
            description: "Also include the speaker notes of a **PowerPoint**. Not included by default",
          },
        },
      },
      annotations: READ_ONLY,
    },
  ];
}

// ---------------------------------------------------------------- execution

export async function callTool(
  client: PCloudClient,
  cfg: Config,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "list":
        return await toolList(client, cfg, args);
      case "stat":
        return await toolStat(client, args);
      case "read_file":
        return await toolReadFile(client, cfg, args);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof PathRejected) return fail(e.message, { reason: e.reason });
    if (e instanceof PCloudError) {
      const hint =
        e.result === 2002
          ? "Walk down again from the upper folders, one level at a time."
          : e.result === 2055 || e.result === 2009
            ? "Check with list that the path is correct."
            : undefined;
      return fail(e.message, { pcloud_result: e.result, ...(hint ? { hint } : {}) });
    }
    if (e instanceof IntegrityError) return fail(e.message, { detail: e.detail });
    if (e instanceof PdfError) return fail(e.message, { reason: e.reason });
    if (e instanceof ImageError) return fail(e.message, { reason: e.reason });
    if (e instanceof OfficeError) return fail(e.message, { reason: e.reason });
    return fail(e instanceof Error ? e.message : "unknown failure");
  }
}

// ---------------------------------------------------------------- list

async function toolList(
  client: PCloudClient,
  cfg: Config,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const recursive = args["recursive"] === true;
  // The configured value is a **default**, not a limit.
  // A value the caller states explicitly is accepted up to the limit of the implementation
  const maxEntries = clamp(
    typeof args["max_entries"] === "number" ? args["max_entries"] : cfg.listMaxEntries,
    1,
    HARD_LIMITS.listMaxEntries,
  );
  const maxDepth = recursive
    ? clamp(
        typeof args["max_depth"] === "number" ? args["max_depth"] : cfg.listMaxDepth,
        1,
        HARD_LIMITS.listMaxDepth,
      )
    : 1;

  const root = folderTarget(args);
  // The path of the starting folder. By ID it is not known yet: it is taken from what pCloud
  // returns for that folder, and stays null if pCloud returns none (see below)
  let rootPath: string | null = "path" in root ? root.path : null;

  const deadline = Date.now() + LIST_TIME_BUDGET_MS;
  const entries: Record<string, unknown>[] = [];
  const excluded: { name: string; reason: string }[] = [];
  let seen = 0;
  let truncated = false;
  /** Why the listing stopped: tells apart the entry count and the time. */
  let stoppedBy: "entries" | "time" | null = null;

  // pCloud's recursive=1 is not used (the count cannot be controlled and the result has no path)
  const queue: { t: { path: string } | { folderid: number }; path: string | null; depth: number }[] = [
    { t: root, path: rootPath, depth: 1 },
  ];

  while (queue.length > 0 && !truncated) {
    if (Date.now() > deadline) {
      truncated = true;
      stoppedBy = "time";
      break;
    }
    const node = queue.shift()!;
    // Only the starting folder can be given by ID; the folders below it were found by name.
    // Its place is found first (see `locateById`): that gives the path for the answer and applies
    // the forbidden names. **With names forbidden this is done before the content is asked for**:
    // the files of a forbidden folder must not be fetched at all, not fetched and then thrown away
    const byId = node.t === root && "folderid" in root && root.folderid !== 0;
    if (byId && hasForbiddenNames()) {
      node.path = await locateById(client, await client.folderInfo((root as { folderid: number }).folderid));
    }
    const meta = await client.listFolder(node.t);
    // With no name forbidden there is nothing to check first, so the listing itself tells the folder
    if (byId && !hasForbiddenNames()) node.path = await locateById(client, meta);
    // Where this folder is: what pCloud says, else what is already known. The root folder is `/`.
    // **Null when neither tells**: the entries below then carry no path, only their IDs
    const here = meta.path ?? node.path ?? (meta.folderid === 0 ? "/" : null);
    if (node.t === root) rootPath = here;

    for (const c of meta.contents ?? []) {
      seen++;
      if (isForbiddenName(c.name)) {
        excluded.push({ name: c.name, reason: "Cannot be handled, by policy" });
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        stoppedBy = "entries";
        break;
      }
      const p = here === null ? null : childPath(here, c.name);
      entries.push(toEntry(c, p));
      if (c.isfolder && node.depth < maxDepth && c.folderid !== undefined) {
        queue.push({ t: { folderid: c.folderid }, path: p, depth: node.depth + 1 });
      }
    }
  }

  // More than one note can apply at once, so they are joined rather than written to the same key
  const notes: string[] = [];
  if (rootPath === null) {
    notes.push(
      "The location of this folder is not known, so no path is given for it or for its entries. " +
        "Reach the entries with their file_id or folder_id.",
    );
  }
  if (truncated) {
    notes.push(
      stoppedBy === "time"
        ? `The traversal was taking too long, so it was stopped at ${LIST_TIME_BUDGET_MS / 1000} seconds. ` +
            "Reduce max_depth, or specify the subfolders individually."
        : `Stopped because the limit on the number of entries (${maxEntries}) was reached. ` +
            `max_entries can be set up to ${HARD_LIMITS.listMaxEntries} and ` +
            `max_depth up to ${HARD_LIMITS.listMaxDepth}. ` +
            "Specifying the subfolders individually is another way.",
    );
  }

  return ok({
    ...(rootPath === null
      ? { folder_id: "folderid" in root ? root.folderid : undefined }
      : { path: rootPath }),
    recursive,
    entries,
    total_seen: seen,
    truncated,
    ...(excluded.length > 0 ? { excluded } : {}),
    ...(truncated ? { stopped_by: stoppedBy } : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  });
}

// ---------------------------------------------------------------- stat

async function toolStat(client: PCloudClient, args: Record<string, unknown>): Promise<ToolResult> {
  const t = fileTarget(args);
  const meta = await client.stat(t);
  // By ID the path is found from the folders above the entry, or is none. The name alone is not a path
  const path = "path" in t ? t.path : await locateById(client, meta);
  return ok(toEntry(meta, path));
}

// ---------------------------------------------------------------- read_file
/**
 * Read content. **The server determines the format.**
 *
 * | Target | What is returned |
 * |---|---|
 * | Text | Content (encoding detected, converted to UTF-8; if large, only the beginning via Range) |
 * | Image | An `image` downscaled to a readable size |
 * | `.docx` / `.xlsx` / `.pptx` | Markdown |
 * | PDF | The specified pages as images (page count only when `pages` is omitted) |
 * | Anything else | **Returns that it cannot be handled** |
 *
 * **Nothing that cannot be handled is sent.**
 * The receiving side cannot expand an embedded resource (`blob`), and it does not stay in the working area either.
 * Transferring something known not to get through only costs waiting time and transfer volume.
 */
async function toolReadFile(
  client: PCloudClient,
  cfg: Config,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const t = fileTarget(args);
  const meta = await client.stat(t);
  // By ID the path is found from the folders above the file, or is none. **The name alone is not a
  // path**: used as one, it would point at a file of that name directly under the root
  const path = "path" in t ? t.path : await locateById(client, meta);
  /** What identifies the file in every answer: its path when known, and always its ID. */
  const where = { ...(path === null ? {} : { path }), file_id: meta.fileid };

  if (meta.isfolder) {
    return fail("A folder cannot be read. Use list.", where);
  }

  const name = meta.name;
  const mime = meta.contenttype ?? "application/octet-stream";
  const size = meta.size ?? 0;
  const asText = args["as_text"] === true;

  const office = officeKind(name, meta.contenttype);
  // **Legacy Office formats are refused without even being fetched.** They are a different binary format and cannot be converted
  if (office === "legacy" && !asText) {
    return fail(
      "Office formats from before 2007 (.doc / .xls / .ppt) cannot be handled. " +
        "Save the file again as .docx / .xlsx / .pptx, or download it from pCloud by other means.",
      { ...where, size, content_type: mime },
    );
  }

  const isText = asText || looksLikeText(name, meta.contenttype);
  const isPdf = !asText && looksLikePdf(name, meta.contenttype);
  const isImage = !asText && mime.startsWith("image/");
  const isOffice = !asText && office !== undefined && office !== "legacy";

  // A format with no way to reach the receiving side is **refused before it is fetched**
  if (!isText && !isPdf && !isImage && !isOffice) {
    return fail(
      `The content of this format cannot be provided (${mime}). ` +
        "Text, images, PDF and Word/Excel/PowerPoint can be read. " +
        "To read it as text, set as_text to true. " +
        "If the file itself is needed, download it from pCloud by other means.",
      { ...where, size, content_type: mime },
    );
  }

  if (isImage && !isSupportedImage(mime)) {
    return fail(
      `This image format cannot be handled (${mime}). ` +
        "The receiving side can read JPEG, PNG, GIF and WebP. " +
        "Download the file from pCloud by other means.",
      { ...where, content_type: mime },
    );
  }

  // **Argument errors are also refused before fetching.**
  // A PDF must not be transferred in full just because region is written the wrong way
  // (the value used for rendering is parsed again by {@link renderBinaryContent})
  if (isPdf) parseRegion(args["region"]);

  // The limit on the original file depends on the format. **For converted output, the amount returned is not proportional to the original size**
  const sizeLimit = isPdf
    ? PDF_LIMITS.maxPdfBytes
    : isOffice
      ? OFFICE_LIMITS.maxDocBytes
      : isImage
        ? imageFetchLimit(mime, cfg.downloadMaxBytes)
        : Number.POSITIVE_INFINITY; // text can be fetched from the beginning only, via Range
  // A WebP has its own, smaller limit and its own reason: it cannot be downscaled
  if (isImage && isWebp(mime) && size > sizeLimit) {
    return fail(webpTooLarge(size, sizeLimit), { ...where, size, limit: sizeLimit, reason: "webp-too-large" });
  }
  if (size > sizeLimit) {
    return fail(
      `The file exceeds the limit (${size} bytes / limit ${sizeLimit} bytes). ` +
        "This connector cannot handle it. Download the file from pCloud by other means.",
      { ...where, size, limit: sizeLimit },
    );
  }

  const link = await client.getFileLink(t);

  // ---- text
  if (isText) {
    const overLimit = size > cfg.readMaxBytes;
    const bytes = overLimit
      ? await client.fetchContent(link, { start: 0, end: cfg.readMaxBytes - 1 })
      : await client.fetchContent(link);
    if (!overLimit) {
      // Integrity can be verified only when the whole file was fetched
      client.verifyIntegrity(bytes, { size, sha1: await client.checksum(t) });
    }
    const decoded = decodeText(bytes, overLimit);
    if (decoded === null) {
      return fail(
        "Could not decode the file as text. " +
          "Download the file from pCloud by other means.",
        { ...where, size, content_type: mime },
      );
    }
    return ok({
      kind: "text",
      ...where,
      size,
      encoding: decoded.encoding,
      content: decoded.text,
      truncated: overLimit,
      ...(overLimit
        ? {
            returned_bytes: bytes.byteLength,
            note:
              `Only the first ${bytes.byteLength} bytes of ${size} bytes in total were returned. ` +
              "This connector cannot handle the whole file. To get all of it, download the file from pCloud by other means.",
          }
        : { verified: "Size and SHA-1 match pCloud" }),
    });
  }

  // From here on the whole file is needed
  const bytes = await client.fetchContent(link);
  client.verifyIntegrity(bytes, { size, sha1: await client.checksum(t) });

  const src: BinarySource = {
    name,
    ids: where,
    size,
    mime,
    origin: "pCloud",
    verified: "Size and SHA-1 match pCloud",
    verifiedProse: "The size and SHA-1 were confirmed to match pCloud.",
  };
  if (isPdf) return renderBinaryContent(src, { kind: "pdf" }, bytes, args);
  if (isOffice) {
    return renderBinaryContent(
      src,
      { kind: "office", office: office as Exclude<OfficeKind, "legacy"> },
      bytes,
      args,
    );
  }
  return renderBinaryContent(src, { kind: "image" }, bytes, args);
}

/**
 * Conversion of a binary and assembly of the response (PDF, Office documents, images).
 *
 * Shared by `read_file` and `git_read`. **The caller must have finished fetching and verifying**
 * (size + SHA-1 on the pCloud side; object name = SHA-1 of the content on the git side).
 */
export async function renderBinaryContent(
  src: BinarySource,
  format:
    | { kind: "pdf" }
    | { kind: "office"; office: Exclude<OfficeKind, "legacy"> }
    | { kind: "image" },
  bytes: Uint8Array,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // ---- PDF
  if (format.kind === "pdf") {
    const region = parseRegion(args["region"]);
    const spec = typeof args["pages"] === "string" ? args["pages"] : undefined;
    // **If the area is narrowed but the default is kept, the freed byte allowance goes unused** (render.ts gives the reason)
    const dpi =
      args["dpi"] === undefined && region.label !== "full"
        ? PDF_LIMITS.defaultRegionDpi
        : clampDpi(args["dpi"]);
    const result = await renderPdf(bytes, spec, dpi, { region });
    return pdfResult(src, result, spec, dpi, region);
  }

  // ---- Office documents
  if (format.kind === "office") {
    const maxChars = clampMaxChars(args["max_chars"]);
    const converted =
      format.office === "docx"
        ? await docxToMarkdown(bytes, { maxChars })
        : format.office === "xlsx"
          ? await xlsxToMarkdown(bytes, { maxChars })
          : await pptxToMarkdown(bytes, {
              maxChars,
              ...(args["include_notes"] === true ? { includeNotes: true } : {}),
            });
    return officeResult(src, converted);
  }

  // ---- images
  const img = await downscaleImage(bytes, src.mime, {
    ...(typeof args["max_edge"] === "number" ? { maxEdge: args["max_edge"] } : {}),
    ...(typeof args["quality"] === "number" ? { quality: args["quality"] } : {}),
  });
  return imageResult(src, img);
}

/**
 * Turn the conversion result of an Office document into a response.
 *
 * **The summary sentence and the Markdown go in separate blocks.**
 * In a single block, it is unclear where the explanation ends and the content begins.
 * Machine-readable values go in `structuredContent`.
 */
function officeResult(src: BinarySource, converted: OfficeMarkdown): ToolResult {
  // **The value needed to get the whole document is given here.**
  // The total character count is known, so there is no reason to make the reader calculate it
  const howToGetAll = converted.truncated
    ? converted.fullChars <= OFFICE_LIMITS.maxMaxChars
      ? `To get the whole document, set max_chars to ${converted.fullChars} or more` +
        ` (limit ${OFFICE_LIMITS.maxMaxChars}).`
      : `The whole document is ${converted.fullChars} characters, **which exceeds the limit of ${OFFICE_LIMITS.maxMaxChars} characters that can be returned at once.** ` +
        `Even with max_chars set to ${OFFICE_LIMITS.maxMaxChars}, the end cannot be obtained. ` +
        "If the full text is needed, download the file from pCloud by other means."
    : "";

  const summary = {
    kind: "office",
    ...src.ids,
    size: src.size,
    content_type: src.mime,
    source_kind: converted.kind,
    verified: src.verified,
    // Always state that a conversion was done
    converted:
      `The source (${converted.kind}) was converted to Markdown and is returned in that form. This is not the original file itself. ` +
      "Formatting, layout and embedded images are lost.",
    markdown_chars: converted.markdown.length,
    full_chars: converted.fullChars,
    truncated: converted.truncated,
    ...(converted.omitted.length > 0 ? { omitted: converted.omitted } : {}),
    ...(converted.truncated
      ? {
          note:
            `Only the first ${converted.markdown.length} characters of ${converted.fullChars} characters in total were returned. ` +
            howToGetAll,
        }
      : {}),
  };

  const head =
    `${src.name} (${formatBytes(src.size)}, ${converted.kind}) was fetched from ${src.origin} and ` +
    `converted to Markdown. ${src.verifiedProse}` +
    (converted.omitted.length > 0 ? ` Dropped in the conversion: ${converted.omitted.join(", ")}.` : "") +
    (converted.truncated
      ? ` **Only the first ${converted.markdown.length} characters of ${converted.fullChars} characters in total are returned.** ` +
        howToGetAll
      : "") +
    " The content is in the next block.";

  return {
    content: [
      { type: "text", text: head },
      { type: "text", text: converted.markdown },
    ],
    structuredContent: summary,
  };
}

// ---------------------------------------------------------------- image and PDF responses

/** Turn a downscaled image into a response. **Always states that it was downscaled.** */
function imageResult(
  src: BinarySource,
  img: Awaited<ReturnType<typeof downscaleImage>>,
): ToolResult {
  const summary = {
    kind: "image",
    ...src.ids,
    size: src.size,
    content_type: src.mime,
    verified: src.verified,
    original_pixels: `${img.originalWidth}x${img.originalHeight}`,
    returned_pixels: `${img.width}x${img.height}`,
    returned_bytes: img.bytes.byteLength,
    returned_content_type: img.mimeType,
    visual_tokens: img.visualTokens,
    downscaled: !img.unchanged,
    ...(img.edgeNotApplied === undefined ? {} : { max_edge_not_applied: img.edgeNotApplied }),
    ...(img.unchanged
      ? {}
      : {
          converted:
            "To fit a size that can be received, the image was downscaled and re-encoded. These are not the original pixels.",
        }),
    ...(img.overBudget
      ? {
          note:
            `Even at the smallest size (long edge ${IMAGE_LIMITS.minEdge} px) it did not fit in ` +
            `${Math.round(IMAGE_LIMITS.defaultMaxBytes / 1024)} KiB. ` +
            "If it cannot be read, download the original file from pCloud by other means.",
        }
      : {}),
  };
  return {
    content: [
      { type: "text", text: describeImage(src, img) },
      { type: "image", data: Buffer.from(img.bytes).toString("base64"), mimeType: img.mimeType },
    ],
    structuredContent: summary,
  };
}

/**
 * The one sentence that says where the content of a page is. Undefined when nothing can be said.
 *
 * **Decided here only**, so that the sentence in the text block and the fields in
 * `structuredContent` cannot disagree.
 *   - Several pages were returned: nothing. The ink of each page is not measured then,
 *     and a statement about "this page" would be read as a statement about all of them
 *   - Ink was found: where it is
 *   - No ink was found: **"almost blank" only when the page has no text either.**
 *     Ink is measured at 36 dpi, so a page with only text comes out faint.
 *     When the text could not be extracted, whether there is text is unknown, so nothing is said
 */
export function contentNote(
  only: { text: import("../pdf/text.ts").PageText } | undefined,
  filled: string[],
): string | undefined {
  if (only === undefined) return undefined;
  if (filled.length > 0) return `The content is concentrated in ${filled.join(", ")}.`;
  if (only.text.totalLines > 0 || only.text.failed) return undefined;
  return "This page is almost blank.";
}

/**
 * The fields of `structuredContent` that describe the text of one page.
 *
 * **When the extraction failed, only the failure is reported.** Whether there is a text layer and
 * how many lines there are is unknown; `false` would be read as "a scanned page" and `0` as "no text".
 */
export function pdfTextFields(text: import("../pdf/text.ts").PageText): Record<string, unknown> {
  if (text.failed) return { text_extraction_failed: true };
  return {
    has_text_layer: text.hasTextLayer,
    text_lines: text.lines.length,
    page_text_lines: text.totalLines,
    text_truncated: text.truncated,
  };
}

/**
 * Put in the response where on the page the content is.
 *
 * **Without this, the region is chosen by guessing.**
 * Measured: the top-left 1/9 was requested and drawn at 300 dpi, but it was almost blank.
 * The receiving side described that as "the resolution is too low to read" and,
 * **having mistaken the cause, tried to raise dpi.**
 *
 * The guide is always stated in 3x3. Whatever division was requested,
 * this **keeps a single scheme for saying where the content is**.
 */
function inkFields(
  only: { ink: import("../pdf/ink.ts").InkGrid; text: import("../pdf/text.ts").PageText } | undefined,
  guide: Record<string, number> | undefined,
  filled: string[],
  where: string | undefined,
  whole: boolean,
  region: Region,
): Record<string, unknown> {
  // **Not included when two or more pages are returned.** The distribution of one page must not look like a statement about all of them
  if (only === undefined || guide === undefined) return {};

  if (whole) {
    return {
      ink_map: guide,
      content_at: filled,
      // Absent when nothing can be said: the ink is too faint to locate, yet the page is not blank
      ...(where === undefined
        ? {}
        : {
            ink_note:
              where +
              (filled.length === 0
                ? ""
                : " **To read details, pass one of these labels to region exactly as written.**"),
          }),
    };
  }

  const fraction =
    Math.round(inkFraction(only.ink, region.cols, region.rows, region.index) * 100) / 100;
  // **A region is called blank only when no text was read from it either.**
  // Ink is measured at 36 dpi, so a region with only text comes out faint; and when the text
  // could not be extracted, whether there is text is unknown. The same rule as `contentNote`
  const noText = only.text.lines.length === 0 && !only.text.failed;
  return {
    ink_map: guide,
    region_ink: fraction,
    ...(isBlank(fraction) && noText
      ? {
          blank_note:
            `**Almost nothing is drawn in this cell** (ink is ${Math.round(fraction * 100)}%; ` +
            `${Math.round(INK_LIMITS.blankBelow * 100)}% or less is regarded as blank).` +
            (where === undefined ? "" : ` ${where}`) +
            " **The resolution is not the reason it cannot be read.** " +
            "Call again with a different region.",
        }
      : {}),
  };
}

/**
 * Assemble the text block of a PDF response.
 *
 * **No copy of the JSON is placed here** (same policy as `describeFile`).
 * Machine-readable values are in `structuredContent`; placing them twice would
 * attach two sets of numbers and notes to a single image.
 *
 * What is placed instead is **the text itself that is visible in this region**.
 * Measured: the receiving side returned an answer that stated symbols absent from the actual document.
 * **Text taken mechanically from the text layer leaves no room for invention.**
 */
export function pdfProse(
  summary: Record<string, unknown>,
  only: { text: import("../pdf/text.ts").PageText } | undefined,
  region: Region,
  whole: boolean,
  where: string | undefined,
  verifiedProse: string,
): string {
  const parts: string[] = [String(summary["shows"])];
  parts.push(verifiedProse);
  if (whole && where !== undefined) parts.push(where);

  const text = only?.text;
  if (text === undefined) {
    // When two or more pages are returned, text from different pages would be mixed, so it is not included
    parts.push("Per-page text is returned when one page is requested at a time.");
    return parts.join(" ");
  }

  if (text.failed) {
    // Not the same as a scanned page: the text may exist. Saying "no text layer" here would be wrong
    parts.push(
      "\n\n[Text] The text of this page could not be extracted. " +
        "Whether the page has a text layer is not known. " +
        "**State only the text and symbols that can be read from the image.** " +
        "Do not fill in from common formats or stock phrases. " +
        "Where something cannot be read, say that it cannot be read.",
    );
    return parts.join(" ");
  }

  if (!text.hasTextLayer) {
    parts.push(
      "\n\n[Text] This PDF has no text layer (it is a scanned image). " +
        "**State only the text and symbols that can be read from the image.** " +
        "Do not fill in from common formats or stock phrases. " +
        "Where something cannot be read, say that it cannot be read.",
    );
    return parts.join(" ");
  }

  if (text.lines.length === 0) {
    parts.push(
      `\n\n[Text] This page has ${text.totalLines} lines of text, but ` +
        `none of them fall within this region: ${describeRegion(region)}. A different region extracts them.`,
    );
    return parts.join(" ");
  }

  parts.push(
    `\n\n[Text visible in this region] ${text.lines.length} lines` +
      (text.truncated ? " (the limit was reached, so the rest is omitted)" : "") +
      ". Taken mechanically from the text layer of the PDF.\n" +
      "The [x,y] at the start of each line is the position with the top left of the **page** as 0,0 and the bottom right as 100,100" +
      " (words at nearby positions belong to the same box).\n" +
      text.lines.map((l) => `[${l.x},${l.y}] ${l.text}`).join("\n") +
      "\n\n**Use this list as the authority for symbols and labels.** " +
      "Do not fill in words that are not here from common formats or stock phrases.",
  );
  return parts.join(" ");
}

/** Turn the PDF rendering result into a response. */
function pdfResult(
  src: BinarySource,
  result: Awaited<ReturnType<typeof renderPdf>>,
  spec: string | undefined,
  dpi: number,
  region: Region,
): ToolResult {
  const whole = region.label === "full";

  // **Show where the content is.**
  // region is chosen by guessing. Measured: the top-left 1/9 drawn at 300 dpi was
  // almost blank, and the receiving side described it as "cannot be read"
  const only = result.rendered.length === 1 ? result.rendered[0] : undefined;
  const guide = only === undefined ? undefined : inkMap(only.ink, 3, 3);
  const filled = guide === undefined ? [] : notableCells(guide);
  const where = contentNote(only, filled);

  // When only the page count was asked for
  if (spec === undefined) {
    return ok({
      kind: "pdf_info",
      ...src.ids,
      size: src.size,
      page_count: result.pageCount,
      verified: src.verified,
      note:
        `There are ${result.pageCount} pages. ` +
        "Call again with pages set, and those pages are returned as images" +
        ` (up to ${PDF_LIMITS.maxPagesPerCall} pages at a time). ` +
        "To read even the small text in a figure, narrow to part of the page with region" +
        " (example: top-left).",
    });
  }

  const usedDpi = [...new Set(result.rendered.map((p) => p.dpi))];
  const first = result.rendered[0];
  // **State what is there before what cannot be done.**
  // Measured: the receiving side that read the note talked about the note, not the image
  const shows =
    result.rendered.length === 1 && first !== undefined
      ? `Page ${first.page}, ${describeRegion(region)}, is rendered as an image at ` +
        `${first.dpi} dpi (${first.width}x${first.height} px, ` +
        `${first.mimeType === "image/png" ? "PNG" : "JPEG"}) ` +
        "and placed in the image block of this response."
      : `Pages ${result.rendered.map((p) => p.page).join(", ")} are rendered as images ` +
        "and placed in the image blocks of this response.";

  const summary = {
    kind: "pdf_pages",
    shows,
    // **A rule about sources. It says nothing about what can or cannot be done.**
    // When this was removed, an answer came back that filled unreadable parts with the common format of drawings (measured).
    // **Presenting something that was not read as read is worse** than having it say "cannot be read"
    reading_rule:
      "State only the text and symbols that can be read from the image. " +
      "Do not fill in from the common format of drawings or stock phrases. " +
      "Where something cannot be read, say that it cannot be read.",
    ...src.ids,
    size: src.size,
    page_count: result.pageCount,
    rendered_pages: result.rendered.map((p) => p.page),
    region: region.label,
    // **Say where was drawn in recounted words, not as a number.**
    // With the number alone, the receiving side cannot notice a mistake in how the cells are counted
    region_shows: describeRegion(region),
    ...(whole
      ? {}
      : {
          region_note:
            `Only this part of the page is drawn: ${describeRegion(region)}. ` +
            "**For parts not shown here, call again with a different region.** " +
            "The cells overlap at their boundaries, so text on a boundary is not cut off.",
        }),
    ...inkFields(only, guide, filled, where, whole, region),
    requested_dpi: dpi,
    // **Built only from the actual values.**
    // It used to branch on "is there a page that was lowered", and when the part held down by the long-edge limit
    // was taken out of `reduced`, it carried a value that differed from the fact (134 actual against 150 requested)
    used_dpi: usedDpi.length === 1 ? usedDpi[0] : Object.fromEntries(result.rendered.map((p) => [p.page, p.dpi])),
    returned_bytes: result.totalBytes,
    returned_content_types: [...new Set(result.rendered.map((p) => p.mimeType))],
    ...(result.reduced.length > 0
      ? {
          reduced_pages: result.reduced,
          reduced_note:
            `To keep one image within ${Math.round(PDF_LIMITS.maxPageBytes / 1024)} KiB, ` +
            `the following pages were rendered at a lower resolution than requested: ${result.reduced.join(", ")}. ` +
            (whole
              ? "**To see finer detail, specify part of the page with region** (example: top-left). "
              : "**To see finer detail, make region smaller still** (example: 3x3:5). ") +
            "The resolution rises as the drawn area shrinks.",
        }
      : {}),
    ...(result.edgeCapped.length > 0
      ? {
          edge_capped_pages: result.edgeCapped,
          edge_capped_note:
            `A long edge of ${PDF_LIMITS.maxEdgePixels} px is the limit on the pixels that can be received, so ` +
            `the resolution was stopped there for the following pages: ${result.edgeCapped.join(", ")}. ` +
            "**To see finer detail, narrow the area with region.** Raising dpi does not add pixels.",
        }
      : {}),
    ...(only === undefined ? {} : pdfTextFields(only.text)),
    verified: src.verified,
    // Always state that a conversion was done. **But state only the fact, briefly**
    converted: "The PDF pages were converted to images (these are not the original bytes).",
    truncated: result.truncated,
    ...(result.truncated
      ? {
          skipped_pages: result.skipped,
          note:
            `The size that fits in one response (${Math.round(PDF_LIMITS.maxTotalBytes / 1024)} KiB) ` +
            `was reached, so the following pages were not rendered: ${result.skipped.join(", ")}. ` +
            "Call again with the pages split across calls.",
        }
      : {}),
  };

  const images: ContentBlock[] = result.rendered.map((p) => ({
    type: "image",
    data: Buffer.from(p.bytes).toString("base64"),
    mimeType: p.mimeType,
  }));

  // **Images go first.**
  // Measured: with the note first, the receiving side talked about the note and said "cannot be read" without looking at the image
  return {
    content: [
      ...images,
      { type: "text", text: pdfProse(summary, only, region, whole, where, src.verifiedProse) },
    ],
    structuredContent: summary,
  };
}

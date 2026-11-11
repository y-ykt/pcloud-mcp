// © 2026 Yasuhiko Yokote

/**
 * Definition and execution of the git tools (git_ls / git_read / git_log).
 *
 * They cover only the bare repositories directly under the folder named by `gitRoot`.
 * Validation of the repository name keeps a call inside this range (a name containing `/` is not accepted).
 *
 * The three existing tools (list / stat / read_file) cannot read this area
 * (its contents are encrypted with AES-256-GCM). The git tools are the ones that decrypt it.
 * Conversely, there is no path through these tools that reads outside the folder named by `gitRoot`.
 */
import type { Config } from "../config.ts";
import { imageFetchLimit, ImageError, isSupportedImage, isWebp, webpTooLarge } from "../image/downscale.ts";
import { OFFICE_LIMITS, OfficeError } from "../office/types.ts";
import { PDF_LIMITS, PdfError } from "../pdf/render.ts";
import { PCloudError, type PCloudClient } from "../pcloud/client.ts";
import type { ToolDefinition, ToolResult } from "../mcp/protocol.ts";
import {
  decodeText,
  fail,
  looksLikePdf,
  officeKind,
  ok,
  READ_ONLY,
  renderBinaryContent,
  type BinarySource,
  type OfficeKind,
} from "../mcp/tools.ts";
import { GitDecryptError, type KeyProvider } from "./crypto.ts";
import { GitFormatError, type TreeEntry } from "./object.ts";
import { normalizePath, rejectionReason } from "../guard/path.ts";
import { GitRepo, GitRepoError, pcloudGitFetcher } from "./repo.ts";

const MAX_LOG_COUNT = 100;
const DEFAULT_LOG_COUNT = 10;

// ---------------------------------------------------------------- definitions

/** Returned when a git tool is called although the feature is disabled. */
const DISABLED =
  "The git tools are disabled on this server (gitRoot is not set). " +
  "Repositories cannot be read through this connector.";

/**
 * The definitions of the git tools. **Empty when the feature is disabled** (no `gitRoot`):
 * a tool that cannot work is not shown, because a tool that is shown gets used.
 */
export function gitToolDefinitions(cfg: Config): ToolDefinition[] {
  if (cfg.gitRoot === null) return [];
  const repoArg = {
    type: "string",
    description: `Repository name (example: example.git). Looked up directly under ${cfg.gitRoot}. .git can be omitted`,
  };
  const refArg = {
    type: "string",
    description: "Branch name, tag name or commit hash. Default is HEAD",
  };
  return [
    {
      name: "git_ls",
      description:
        `Returns the file listing, at the given commit, of a bare repository on pCloud (under ${cfg.gitRoot}). ` +
        "The contents of the repository are encrypted, so the ordinary list cannot read them. " +
        "Both formats are supported: loose and pack (after git gc).",
      inputSchema: {
        type: "object",
        properties: {
          repo: repoArg,
          ref: refArg,
          path: { type: "string", description: "Directory to list. Default is the root" },
        },
        required: ["repo"],
      },
      annotations: READ_ONLY,
    },
    {
      name: "git_read",
      description:
        `Reads the content of a file, at the given commit, from a bare repository on pCloud (under ${cfg.gitRoot}). ` +
        "The format is determined from the file name. Text is returned as its content, an image is downscaled to a readable size, " +
        "Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) are converted to Markdown, " +
        "and for a PDF the specified pages are returned as images. The arguments mean the same as in read_file. " +
        "Any other binary is refused, reporting only its path, size and mode " +
        "(for an unsupported image format, only its path). " +
        "What is fetched is verified by checking that the object name equals the SHA-1 of the content.",
      inputSchema: {
        type: "object",
        properties: {
          repo: repoArg,
          path: { type: "string", description: "Path of the file in the repository (example: docs/guide.md)" },
          ref: refArg,
          as_text: {
            type: "boolean",
            description: "Ignore the format detection and read as text. Default is false",
          },
          pages: {
            type: "string",
            description:
              "Pages to render for a **PDF**. Counted from 1. Written as 1 or 1-3,7. " +
              "If omitted, only information such as the page count is returned and nothing is rendered",
          },
          region: {
            type: "string",
            description:
              "Which part of the page to render for a **PDF**. Same notation as read_file (examples: top-left, 3x3:5). " +
              "If omitted, the whole page",
          },
          dpi: { type: "integer", description: "Resolution for a **PDF**. Same as read_file" },
          max_edge: {
            type: "integer",
            description: "Limit on the long edge of an **image** (pixels). Same as read_file",
          },
          quality: {
            type: "integer",
            description: "Quality when an **image** is converted to JPEG. Same as read_file",
          },
          max_chars: {
            type: "integer",
            description: "Limit on the number of characters when an **Office document** is converted to Markdown. Same as read_file",
          },
          include_notes: {
            type: "boolean",
            description: "Also include the speaker notes of a **PowerPoint** file. Not included by default",
          },
        },
        required: ["repo", "path"],
      },
      annotations: READ_ONLY,
    },
    {
      name: "git_log",
      description:
        `Returns the history of a bare repository on pCloud (under ${cfg.gitRoot}), newest first. ` +
        "A merge is followed through its first parent (side branches are not entered).",
      inputSchema: {
        type: "object",
        properties: {
          repo: repoArg,
          ref: refArg,
          max_count: {
            type: "integer",
            description: `Number of commits to return. Default ${DEFAULT_LOG_COUNT}, limit ${MAX_LOG_COUNT}`,
          },
        },
        required: ["repo"],
      },
      annotations: READ_ONLY,
    },
  ];
}

// ---------------------------------------------------------------- execution

/**
 * Validates the repository name and turns it into an absolute path.
 *
 * `/` is not accepted in a name, so **no path can point outside `gitRoot`.**
 */
export function repoPathOf(raw: unknown, gitRoot: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new GitRepoError("Specify repo (example: example.git)");
  }
  const trimmed = raw.trim();
  const name = trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw new GitRepoError(`Cannot be interpreted as a repository name: ${raw}`);
  }
  const path = `${gitRoot}/${name}`;
  // **The forbidden names apply to the folder and the name of the repository**, the two parts
  // the user chose. What is inside the repository is not compared with them
  try {
    normalizePath(path);
  } catch (e) {
    throw new GitRepoError(`This repository cannot be read: ${rejectionReason(e)}`);
  }
  return path;
}

/** Turns an exception into a response from which Claude can rephrase the call and retry. */
function gitFail(e: unknown): ToolResult {
  if (e instanceof GitRepoError) return fail(e.message);
  if (e instanceof GitDecryptError) {
    return fail(`${e.message}. Check that the key is registered (bin/set-git-encrypt-key)`);
  }
  if (e instanceof GitFormatError) {
    return fail(`Could not be read as git format: ${e.message}`);
  }
  if (e instanceof PCloudError) return fail(e.message, { pcloud_result: e.result });
  // Failures of the shared conversion steps keep their reason, as they do in `read_file`
  if (e instanceof PdfError || e instanceof ImageError || e instanceof OfficeError) {
    return fail(e.message, { reason: e.reason });
  }
  return fail(e instanceof Error ? e.message : "Unknown failure");
}

/**
 * The main part. The way a repository is created can be injected (because tests do not use pCloud).
 */
export async function dispatchGitTool(
  repoFor: (repoPath: string) => GitRepo,
  cfg: Config,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // The protocol layer refuses a tool that is not listed, so a call does not normally get here
  // while the feature is disabled. Checked all the same, so that nothing is read if one does
  if (cfg.gitRoot === null) return fail(DISABLED);
  try {
    const repo = repoFor(repoPathOf(args["repo"], cfg.gitRoot));
    const ref = typeof args["ref"] === "string" && args["ref"].trim() !== "" ? args["ref"] : "HEAD";
    switch (name) {
      case "git_ls":
        return await toolGitLs(repo, ref, args);
      case "git_read":
        return await toolGitRead(repo, cfg, ref, args);
      case "git_log":
        return await toolGitLog(repo, ref, args);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return gitFail(e);
  }
}

/** Entry point from the Lambda. Connects the key and the pCloud client. */
export async function callGitTool(
  client: PCloudClient,
  keyProvider: KeyProvider | undefined,
  cfg: Config,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Checked first: when the feature is disabled, neither the key nor pCloud is asked for anything
  if (cfg.gitRoot === null) return fail(DISABLED);
  if (keyProvider === undefined) {
    return fail("The git feature is not configured (GIT_SECRET_ARN is missing)");
  }
  let key: Buffer;
  try {
    key = await keyProvider.get();
  } catch (e) {
    return gitFail(e);
  }
  const fetcher = pcloudGitFetcher(client, cfg.downloadMaxBytes);
  const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  return dispatchGitTool(
    (repoPath) =>
      new GitRepo({
        fetcher,
        key,
        repoPath,
        packMaxBytes: cfg.gitPackMaxBytes,
        // Record how long fetching and decrypting a pack took (the basis of the measured values)
        onPackLoad: (info) => {
          if (levels.info < levels[cfg.logLevel]) return;
          process.stdout.write(
            `${JSON.stringify({
              level: "info",
              event: "git_pack_load",
              pack: info.pack,
              source: info.source,
              bytes: info.bytes,
              fetch_ms: info.fetchMs,
              decrypt_ms: info.decryptMs,
            })}\n`,
          );
        },
      }),
    cfg,
    name,
    args,
  );
}

// ---------------------------------------------------------------- the individual tools

function entryType(e: TreeEntry): string {
  if (e.isDir) return "dir";
  if (e.mode === "120000") return "symlink";
  if (e.mode === "160000") return "submodule";
  return "file";
}

async function toolGitLs(
  repo: GitRepo,
  ref: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const dir = typeof args["path"] === "string" ? args["path"] : "";
  const commit = await repo.resolveRef(ref);
  const entries = await repo.listTree(commit, dir);
  return ok({
    ref,
    commit,
    path: dir === "" ? "/" : dir,
    entries: entries.map((e) => ({
      name: e.name,
      type: entryType(e),
      mode: e.mode,
      hash: e.hash,
    })),
    note: "Sizes are not recorded in a tree, so the listing has none. If needed, git_read returns size.",
  });
}

/** Looks up the image MIME type from the extension. Only the 4 formats the receiving side can read are treated as images. */
const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** Formats that are images but that the receiving side cannot read. Listed so that they can be refused with the reason stated. */
const UNSUPPORTED_IMAGE_EXTS = new Set(["bmp", "tiff", "tif", "heic", "heif", "svg", "ico"]);

const OFFICE_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const extOf = (name: string) =>
  name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

async function toolGitRead(
  repo: GitRepo,
  cfg: Config,
  ref: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const path = args["path"];
  if (typeof path !== "string" || path.trim() === "") {
    return fail("Specify path (example: docs/guide.md)");
  }
  const name = path.split("/").filter((s) => s.length > 0).pop() ?? path;
  const wantsText = args["as_text"] === true;

  /**
   * The format is determined from the file name alone. A git tree has neither a contenttype nor a size.
   * The size check that `read_file` performs before fetching is replaced here by the **fetch limit** (loose)
   * and a **check after inflation** (objects from a pack).
   */
  const office = officeKind(name);
  // **These two refusals are decided by the name alone, so they come before the repository is read.**
  // Finding the entry can mean fetching a whole pack; a request that will be refused must not pay for it.
  // A symbolic link with such a name is refused here too; `as_text` returns the path of its target
  if (office === "legacy" && !wantsText) {
    return fail(
      "Office formats from before 2007 (.doc / .xls / .ppt) cannot be handled. " +
        "A copy saved again as .docx / .xlsx / .pptx can be read.",
      { path },
    );
  }
  if (!wantsText && UNSUPPORTED_IMAGE_EXTS.has(extOf(name))) {
    return fail(
      `This image format cannot be handled (.${extOf(name)}). ` +
        "The receiving side can read JPEG, PNG, GIF and WebP.",
      { path },
    );
  }

  const commit = await repo.resolveRef(ref);
  const entry = await repo.findEntry(commit, path);
  // **The content of a symbolic link is the path of its target, whatever its name looks like.**
  // It is always read as text. Passing it to the image or PDF converter would only fail
  const isLink = entry.mode === "120000";
  const asText = wantsText || isLink;

  const isPdf = !asText && looksLikePdf(name);
  const isOffice = !asText && office !== undefined && office !== "legacy";
  const imageMime = IMAGE_MIME[extOf(name)];
  const isImage = !asText && imageMime !== undefined;

  // The limit on the original file depends on the format (the same values as read_file)
  const sizeLimit = isPdf
    ? PDF_LIMITS.maxPdfBytes
    : isOffice
      ? OFFICE_LIMITS.maxDocBytes
      : cfg.downloadMaxBytes;

  // **The limit passed to the read is about the stored object**, which is encrypted and compressed:
  // its size is not the size of the file. A limit on the file itself is applied below, to the content
  const body = await repo.readEntry(entry, path, sizeLimit);

  // The fetch limit does not apply to a blob from a pack, so it is checked again after inflation.
  // Not applied to text (as before, only the beginning is returned; exceeding the limit is shown by truncated below)
  // A WebP cannot be downscaled, so its limit is that of a tool result (see `imageFetchLimit`).
  // Applied to the content: a tree has no size, so it cannot be known before the read
  if (isImage && isWebp(imageMime)) {
    const webpLimit = imageFetchLimit(imageMime, sizeLimit);
    if (body.length > webpLimit) {
      return fail(webpTooLarge(body.length, webpLimit), { path, size: body.length, reason: "webp-too-large" });
    }
  }
  if ((isPdf || isOffice || isImage) && body.length > sizeLimit) {
    return fail(
      `The file exceeds the limit (${body.length} bytes / limit ${sizeLimit} bytes).`,
      { path, size: body.length },
    );
  }

  const src: BinarySource = {
    name,
    ids: { ref, commit, path },
    size: body.length,
    mime: isPdf
      ? "application/pdf"
      : isOffice
        ? (OFFICE_MIME[office] ?? "application/octet-stream")
        : (imageMime ?? "application/octet-stream"),
    origin: `${commit.slice(0, 7)} of ${repo.name}`,
    verified: "object name matches the SHA-1 of the content",
    verifiedProse: "The object name has been verified to match the SHA-1 of the content.",
  };

  if (isPdf) return renderBinaryContent(src, { kind: "pdf" }, body, args);
  if (isOffice) {
    return renderBinaryContent(
      src,
      { kind: "office", office: office as Exclude<OfficeKind, "legacy"> },
      body,
      args,
    );
  }
  if (isImage) {
    if (!isSupportedImage(src.mime)) {
      return fail(`This image format cannot be handled (${src.mime}).`, { path });
    }
    return renderBinaryContent(src, { kind: "image" }, body, args);
  }

  // ---- text
  const overLimit = body.length > cfg.readMaxBytes;
  const slice = overLimit ? body.subarray(0, cfg.readMaxBytes) : body;
  // Same heuristic as git itself: content that contains NUL is treated as binary.
  // This check exists because a tree has no contenttype, and every name that is not a PDF, Office or image
  // extension reaches this point, so the name does not show whether the content is text
  const decoded = slice.includes(0) ? null : decodeText(new Uint8Array(slice), overLimit);
  if (decoded === null) {
    return fail(
      `Could not be decoded as text. git_read cannot return binary`,
      { path, size: body.length, mode: entry.mode },
    );
  }
  // Both notes can apply at once, so they are joined rather than written to the same key separately
  const notes: string[] = [];
  if (overLimit) {
    notes.push(`Only the first ${slice.length} bytes of ${body.length} bytes in total were returned.`);
  }
  if (isLink) {
    notes.push("This is a symbolic link. content is the path of the link target.");
  }
  return ok({
    kind: "text",
    ref,
    commit,
    path,
    size: body.length,
    encoding: decoded.encoding,
    content: decoded.text,
    truncated: overLimit,
    verified: "verified that the object name matches the SHA-1 of the content",
    ...(overLimit ? { returned_bytes: slice.length } : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  });
}

async function toolGitLog(
  repo: GitRepo,
  ref: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const raw = args["max_count"];
  const maxCount = Math.min(
    Math.max(typeof raw === "number" && Number.isInteger(raw) ? raw : DEFAULT_LOG_COUNT, 1),
    MAX_LOG_COUNT,
  );
  const start = await repo.resolveRef(ref);
  const entries = await repo.log(start, maxCount);
  return ok({
    ref,
    count: entries.length,
    ...(entries.length === maxCount ? { note: `The result may have been cut off at the count limit (${maxCount})` } : {}),
    commits: entries.map((e) => ({
      hash: e.hash,
      author: e.author?.name,
      date: e.author?.date,
      message: e.message.trimEnd(),
      ...(e.parents.length > 1 ? { merge: true } : {}),
    })),
  });
}

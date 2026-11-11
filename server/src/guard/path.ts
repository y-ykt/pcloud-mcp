// © 2026 Yasuhiko Yokote

/**
 * Path normalization and checks.
 *
 * This module is central to the safety of this server and is implemented as
 * **pure functions that depend on no other module**. Every path passes through it before pCloud is queried.
 *
 * Design points:
 *   - `..` is not resolved and then checked against a range: **its mere presence is rejected**.
 *     This way a mistake in the order of normalization cannot let a path escape the check
 *   - The only separator is `/`. **`\` is not converted to `/`**.
 *     `\` is a legitimate character that a pCloud file name may contain,
 *     and converting it would split a name in the middle
 *   - Forbidden names are compared **case-insensitively**.
 *     pCloud itself is case-sensitive, but here the choice is made in favor of rejecting
 *   - **Checks are done on the NFC form, but the form that was received is returned.**
 *     pCloud matches a path as a byte sequence as it is and does not normalize it.
 *     Names uploaded from macOS are stored in NFD, so sending them converted to NFC
 *     would miss every name that contains a voiced or semi-voiced sound mark (dakuten or handakuten)
 */

/**
 * Names of folders that must not be entered, in the form used for comparison (NFC, lower case).
 *
 * **Empty unless the configuration lists some: by default nothing is excluded.**
 * The list comes from the configuration (`FORBIDDEN_NAMES`) and is set once at startup with
 * {@link setForbiddenNames}. It is held here rather than passed to every call, so that no caller
 * can leave it out: every path check in the server reads the same list.
 *
 * **`null` until it is set, and a check made before that fails** ({@link inForce}).
 * "Not set" is not the same as "nothing is forbidden": a way into the server that forgot to set
 * the names would otherwise let every path through, although the configuration lists names.
 */
let forbidden: readonly string[] | null = null;

/** The names in force. Throws when they have not been set yet. */
function inForce(): readonly string[] {
  if (forbidden === null) {
    throw new Error(
      "The forbidden names have not been set, so no path can be checked. " +
        "Call setForbiddenNames first, with an empty list if nothing is to be excluded (createHandler does this)",
    );
  }
  return forbidden;
}

/** The form in which names are compared: NFC, lower case. The one place this rule is written. */
export const comparable = (name: string): string => name.normalize("NFC").toLowerCase();

/** Whether a name is in a list of names already in the form for comparison. The one place names are compared. */
const isListed = (names: readonly string[], name: string): boolean => names.includes(comparable(name));

/** Sets the names that must not be entered. An empty list excludes nothing. */
export function setForbiddenNames(names: readonly string[]): void {
  forbidden = names.map(comparable);
  // What was found to be allowed was found against the old list
  forgetAllowedFolders();
}

/**
 * The sentence that says why a path was refused, for the messages built around it.
 * Anything that is not a refusal of a path gets a fixed sentence: its own message may hold internal detail.
 */
export function rejectionReason(e: unknown): string {
  return e instanceof PathRejected ? e.message : "it cannot be used as a path";
}

/**
 * Folders (by ID) whose place is known: their path, and that no forbidden name is in it,
 * with the time until which that finding is used.
 *
 * pCloud returns no path when an entry is asked for by ID, so reaching one by ID means asking
 * pCloud about every folder above it, both to check the names and to put the path together.
 * Without this record, the same folders would be asked about on every call.
 * **The finding is kept for a limited time only**: a folder can be moved or renamed on pCloud,
 * into a forbidden folder too, and a finding kept for ever would then be wrong for ever.
 */
const ALLOWED_FOLDER_TTL_MS = 5 * 60 * 1000;
/** Above this many records, the ones that have run out are removed when a new one is added. */
const ALLOWED_FOLDER_PRUNE_ABOVE = 256;

/** What is known about one folder. */
export interface KnownFolder {
  /** The path of the folder, as it was when the finding was made. */
  path: string;
  /** The time until which the finding is used. */
  until: number;
}
const allowedFolders = new Map<number, KnownFolder>();

/** The time until which a finding made now is used. */
export function freshAllowedUntil(now: number = Date.now()): number {
  return now + ALLOWED_FOLDER_TTL_MS;
}

/** What is known about a folder, or undefined when nothing is (any more). */
export function knownFolder(folderId: number, now: number = Date.now()): KnownFolder | undefined {
  const known = allowedFolders.get(folderId);
  if (known === undefined) return undefined;
  if (now > known.until) {
    allowedFolders.delete(folderId);
    return undefined;
  }
  return known;
}

/** The time until which a folder is known to be allowed, or undefined when it is not (any more). */
export function allowedFolderUntil(folderId: number, now: number = Date.now()): number | undefined {
  return knownFolder(folderId, now)?.until;
}

export function isFolderKnownAllowed(folderId: number, now: number = Date.now()): boolean {
  return knownFolder(folderId, now) !== undefined;
}

/**
 * Remembers folders, with their paths, as allowed until the given time.
 *
 * **`until` is the end of the finding these folders rest on, never later.** A folder that passed
 * because a remembered folder above it was still good is given that folder's time
 * ({@link knownFolder}), not a new one. Otherwise one finding would be carried from folder
 * to folder and used for ever.
 */
export function rememberAllowedFolders(
  folders: readonly { id: number; path: string }[],
  until: number,
  now: number = Date.now(),
): void {
  for (const { id, path } of folders) {
    const known = allowedFolders.get(id);
    allowedFolders.set(id, { path, until: known === undefined ? until : Math.min(known.until, until) });
  }
  // Records are otherwise removed only when the same folder is asked about again
  if (allowedFolders.size > ALLOWED_FOLDER_PRUNE_ABOVE) {
    for (const [id, known] of allowedFolders) if (now > known.until) allowedFolders.delete(id);
  }
}

/** How many folders are remembered. For the tests. */
export function allowedFolderCount(): number {
  return allowedFolders.size;
}

export function forgetAllowedFolders(): void {
  allowedFolders.clear();
}

/** A pCloud name is shorter than 1024 bytes in UTF-8. */
const MAX_SEGMENT_BYTES = 1024;

/** Limit on the whole path. Extremely long input is refused at an early stage. */
const MAX_PATH_BYTES = 4096;

export type RejectReason =
  | "not-a-string"
  | "too-long"
  | "control-char"
  | "dot-segment"
  | "segment-too-long"
  | "forbidden-name"
  | "location-unknown";

/** Indicates that the path check rejected a path. The caller maps it to a tool execution error. */
export class PathRejected extends Error {
  reason: RejectReason;

  constructor(reason: RejectReason, message: string) {
    super(message);
    this.name = "PathRejected";
    this.reason = reason;
  }
}

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/** Whether any name is forbidden. When none is, there is nothing to check a name against. */
export function hasForbiddenNames(): boolean {
  return inForce().length > 0;
}

/**
 * Whether a single name is a forbidden name.
 *
 * Also used to remove such entries from a listing result.
 * The name is normalized to NFC before the comparison, which is case-insensitive.
 */
export function isForbiddenName(name: string): boolean {
  return isListed(inForce(), name);
}

/**
 * Normalizes and checks a path. Throws {@link PathRejected} when it fails.
 *
 * Accepted:
 *   `/`, `""` (both are the root), `/My Documents`, `/My Documents/report.pdf`
 *   names that contain spaces, Japanese, symbols or `\`
 *
 * Rejected:
 *   paths that contain `.` or `..`, a control character or a forbidden name, and paths that are too long
 *
 * @returns The normal form, which starts with `/` and has no trailing `/`. The root is `/`
 */
export function normalizePath(input: unknown): string {
  return check(input, inForce());
}

/**
 * The same check against a given list of forbidden names instead of the one in force.
 *
 * For checking a setting while the configuration is being read: the list in force is not touched.
 */
export function normalizePathWith(input: unknown, forbiddenNames: readonly string[]): string {
  return check(input, forbiddenNames.map(comparable));
}

/**
 * The same check **without the forbidden names**: only the shape of the path.
 *
 * For a path inside a git repository. A branch, a tag or an internal file may be called anything;
 * the forbidden names are about folders the user chose, and those are checked where the path of
 * a repository is put together.
 */
export function normalizeStructure(input: unknown): string {
  return check(input, []);
}

function check(input: unknown, forbiddenNames: readonly string[]): string {
  if (typeof input !== "string") {
    throw new PathRejected("not-a-string", "The path must be a string");
  }
  if (byteLength(input) > MAX_PATH_BYTES) {
    throw new PathRejected("too-long", `The path is too long (limit: ${MAX_PATH_BYTES} bytes)`);
  }

  // A control character is invalid in a name and can corrupt logs and responses.
  // Normalization neither adds nor removes control characters, so the original form can be checked
  if (/[\u0000-\u001F\u007F]/.test(input)) {
    throw new PathRejected("control-char", "A path that contains a control character cannot be handled");
  }

  // The only separator is `/`. Empty segments (`//`, leading and trailing slashes) are dropped here.
  // **The original form is split.** `/` is not changed by normalization
  const segments = input.split("/").filter((s) => s.length > 0);

  for (const seg of segments) {
    // So that names that look the same but are encoded differently are not missed, **only the check uses NFC**
    const nfc = seg.normalize("NFC");
    if (nfc === "." || nfc === "..") {
      throw new PathRejected("dot-segment", `A path that contains '${nfc}' cannot be handled`);
    }
    if (byteLength(seg) >= MAX_SEGMENT_BYTES) {
      throw new PathRejected(
        "segment-too-long",
        `A name is too long (each segment must be shorter than ${MAX_SEGMENT_BYTES} bytes)`,
      );
    }
    if (isListed(forbiddenNames, nfc)) {
      throw new PathRejected("forbidden-name", `'${seg}' cannot be handled, by policy`);
    }
  }

  // **The received form is returned, not the normalized one.**
  // It is passed to pCloud as it is (see the design points at the top)
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * Appends one name to a normalized path.
 *
 * Used to build the path of a child from a listing result.
 * The appended name goes through the same checks.
 */
export function childPath(parent: string, name: string): string {
  return normalizePath(parent === "/" ? `/${name}` : `${parent}/${name}`);
}

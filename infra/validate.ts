// © 2026 Yasuhiko Yokote

/**
 * Checks of the settings that the server would otherwise reject only when it starts.
 *
 * **A value that the server refuses must not be deployable.** The server reads `FORBIDDEN_NAMES`
 * and `GIT_ROOT` at startup and fails on a bad value, and that failure stops every tool, not only
 * the git tools. Checking here turns it into a failed `pulumi up` instead of a broken server.
 *
 * The rules repeat those of `server/src/config.ts` and `server/src/guard/path.ts`.
 * They are repeated rather than imported because the two packages are built separately.
 * **The server remains the authority**: when a rule changes there, change it here as well.
 */

const hasControlChar = (s: string): boolean => /[\x00-\x1f\x7f]/.test(s);
const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** The limits of `server/src/guard/path.ts`: the whole path, and one name (which must be shorter). */
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 1024;
const comparable = (name: string): string => name.normalize("NFC").toLowerCase();

/** Parses the list of forbidden names. Throws when an entry is not the name of a single folder. */
export function parseForbiddenNames(raw: string): string[] {
  const names: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name === "") continue;
    if (name.includes("/") || name === "." || name === ".." || hasControlChar(name)) {
      throw new Error(
        `forbiddenNames must list names of single folders, separated by commas (received: ${JSON.stringify(name)})`,
      );
    }
    names.push(name);
  }
  return names;
}

/** Whether a folder is named for the git tools. When none is, the git feature is disabled. */
export function gitEnabled(gitRoot: string): boolean {
  return gitRoot.trim() !== "";
}

/**
 * Throws when the server would not accept `gitRoot` with these forbidden names.
 * An empty value is accepted: it disables the git tools.
 */
export function checkGitRoot(gitRoot: string, forbiddenNames: readonly string[]): void {
  if (!gitEnabled(gitRoot)) return;
  const fail = (why: string): never => {
    throw new Error(`gitRoot is not accepted: ${why} (received: ${JSON.stringify(gitRoot)})`);
  };
  if (!gitRoot.startsWith("/")) fail("it must start with /");
  // The server drops trailing "/" before it measures anything; the same is done here
  const trimmed = gitRoot.replace(/\/+$/, "") || "/";
  if (byteLength(trimmed) > MAX_PATH_BYTES) fail(`it is longer than ${MAX_PATH_BYTES} bytes`);
  if (hasControlChar(trimmed)) fail("it contains a control character");
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) fail("it must be a folder below the root");
  const forbidden = forbiddenNames.map(comparable);
  for (const seg of segments) {
    if (seg === "." || seg === "..") fail(`it contains '${seg}'`);
    if (byteLength(seg) >= MAX_SEGMENT_BYTES) fail(`a name in it is ${MAX_SEGMENT_BYTES} bytes or longer`);
    if (forbidden.includes(comparable(seg))) fail(`'${seg}' is listed in forbiddenNames`);
  }
}

/**
 * Every key this project reads from the stack configuration, without the project prefix.
 *
 * **A key that is not here stops the deployment** (`checkKnownKeys`). Pulumi itself ignores an
 * unknown key without a word, so a misspelled one would otherwise simply not apply. For
 * `forbiddenNames` that would mean nothing is excluded although the file says otherwise.
 *
 * A test checks this list against the keys that `index.ts`, `Pulumi.yaml`, the example file and
 * the scripts in `bin/` actually use. Add a key here when one is added anywhere.
 */
export const KNOWN_KEYS: readonly string[] = [
  // read by index.ts
  "alertEmail",
  "apiLogRetentionDays",
  "callbackUrl",
  "claudeEgressCidr",
  "cognitoDomainPrefix",
  "downloadMaxBytes",
  "forbiddenNames",
  "gitKeySetAt",
  "gitPackMaxBytes",
  "gitRoot",
  "logLevel",
  "logResponseBody",
  "logRetentionDays",
  "pcloudApiHost",
  "throttleBurst",
  "throttleRate",
  "tokenSetAt",
  // read by the scripts in bin/ only
  "gitKeyFile",
  "gitVerifyRepo",
  "oauthToolDir",
  "pcloudTokenFile",
];

/** The number of single-character edits that turn one string into the other. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * Throws when the stack configuration has a key of this project that is not known.
 *
 * `keys` are the full keys of the configuration (`<namespace>:<name>`). Keys of other
 * namespaces, such as `aws:region`, belong to someone else and are not looked at.
 */
export function checkKnownKeys(keys: readonly string[], project: string): void {
  const prefix = `${project}:`;
  const unknown = keys.filter((k) => k.startsWith(prefix) && !KNOWN_KEYS.includes(k.slice(prefix.length)));
  if (unknown.length === 0) return;
  const lines = unknown.map((k) => {
    const name = k.slice(prefix.length);
    // The known key nearest to it, when one is near enough to be what was meant
    const nearest = [...KNOWN_KEYS].sort(
      (x, y) => distance(name.toLowerCase(), x.toLowerCase()) - distance(name.toLowerCase(), y.toLowerCase()),
    )[0]!;
    const near = distance(name.toLowerCase(), nearest.toLowerCase()) <= 3;
    return `  ${k}${near ? ` (did you mean ${prefix}${nearest}?)` : ""}`;
  });
  throw new Error(
    `The stack configuration has ${unknown.length === 1 ? "a key" : "keys"} this project does not know. ` +
      `A misspelled key would be ignored, so the deployment stops here:\n${lines.join("\n")}`,
  );
}

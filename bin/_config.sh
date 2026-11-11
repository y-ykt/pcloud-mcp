# © 2026 Yasuhiko Yokote

# Shared by the scripts in this directory. Source it; do not run it.
#
# All settings live in one file: infra/Pulumi.<stack>.yaml (not tracked;
# copy infra/Pulumi.prod.yaml.example to create it). This reads that file
# directly, so it works without a Pulumi login. The stack is "prod" unless
# PULUMI_STACK names another one.
#
# Expects INFRA (path of the infra directory) to be set by the caller.

command -v python3 >/dev/null || { echo "error: python3 not found" >&2; exit 1; }

readonly STACK="${PULUMI_STACK:-prod}"
readonly STACK_FILE="${INFRA}/Pulumi.${STACK}.yaml"

# cfg <key> [default]
#   Prints the value of pcloud-mcp:<key>, or of <key> itself when it already
#   has a namespace (e.g. aws:region). Prints the default when the key or the
#   file is missing.
cfg() {
  python3 - "$STACK_FILE" "$1" "${2-}" <<'PY'
import pathlib, re, sys
path, key, default = sys.argv[1:4]
full = key if ":" in key else f"pcloud-mcp:{key}"
value = None
p = pathlib.Path(path)
if p.is_file():
    # Only the entries directly under the top-level "config:" are settings. A line elsewhere in
    # the file, or nested under one of them, is not looked at even when its key looks the same
    in_config, level = False, None
    for line in p.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            in_config = re.match(r"^config:\s*(#.*)?$", line) is not None
            level = None
            continue
        if not in_config:
            continue
        indent = len(line) - len(line.lstrip())
        if level is None:
            level = indent
        if indent != level:
            continue
        # The key may be quoted, as YAML allows: "pcloud-mcp:gitRoot": /x
        m = re.match(r"""^\s+(["']?)([^"'\s]+)\1:\s+(.*?)\s*$""", line)
        if m and m.group(2) == full:
            value = m.group(3)
            if value[:1] in ("'", '"'):
                # A quoted value ends at the closing quote; what follows (a comment) is dropped.
                # Inside single quotes '' stands for one quote; inside double quotes \ escapes
                quote, out, i = value[0], [], 1
                while i < len(value):
                    ch = value[i]
                    if quote == "'" and value[i:i + 2] == "''":
                        out.append("'"); i += 2; continue
                    if quote == '"' and ch == "\\" and i + 1 < len(value):
                        out.append(value[i + 1]); i += 2; continue
                    if ch == quote:
                        break
                    out.append(ch); i += 1
                value = "".join(out)
            else:
                # As in YAML, " #" starts a comment. Pulumi reads the same line this way
                value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
            break
print(default if value is None or value == "" else value)
PY
}

# expand_home <path> — turns a leading "~/" (or "~" alone) into the home directory.
expand_home() {
  case "$1" in
    "~") printf '%s\n' "${HOME}" ;;
    "~/"*) printf '%s\n' "${HOME}/${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# stack_region — the region the stack is deployed to.
#   The stack configuration wins over AWS_REGION here, unlike the other settings:
#   `pulumi up` deploys to the region in the file, and the secret must be written to the same one.
stack_region() {
  local r
  r="$(cfg aws:region)"
  printf '%s\n' "${r:-${AWS_REGION:-}}"
}

# repo_head_path <gitRoot> <repository> — the path of the HEAD file of a repository.
#   Built the way the server builds it: a trailing "/" of gitRoot is dropped,
#   and ".git" is added to the repository name when it is missing.
repo_head_path() {
  local root repo="$2"
  # Repeated "/" are one, and a trailing "/" is dropped, as the server does
  root="$(printf '%s' "$1" | sed -e 's#//*#/#g' -e 's#/$##')"
  printf '%s\n' "${root}/${repo%.git}.git/HEAD"
}

# api_host — the pCloud API endpoint, without a trailing "/", as the server reads it.
api_host() {
  local h
  h="$(cfg pcloudApiHost https://api.pcloud.com)"
  while [ "${h%/}" != "$h" ]; do h="${h%/}"; done
  printf '%s\n' "$h"
}

# deploy_stack <what> — applies the stack with `pulumi up`, and does not hide a failure.
#   <what> names the value that was just registered ("token", "key"), for the messages.
#
#   1. Preview first. **If the run would delete or replace a resource, stop before anything is deployed.**
#      Registering a token or a key only changes the Lambda function. A deletion means the stack
#      configuration says something else as well (for example gitRoot was removed, which deletes
#      the secret of the git key), and that must be decided by a person, not carried out with --yes.
#   2. Run `pulumi up`. **If it fails, show its output and return an error.** The value is already
#      registered at that point, but the running Lambda keeps the old one until `pulumi up` succeeds.
#
#   Must be called from the infra directory. Returns 0 only when the stack was applied.
deploy_stack() {
  local what="$1" out
  out="$(mktemp)"

  if ! pulumi preview --stack "$STACK" --non-interactive --json > "$out" 2> "${out}.err"; then
    echo "error: the preview of the deployment failed. Nothing was deployed." >&2
    tail -n 30 "${out}.err" >&2
    [ -s "${out}.err" ] || tail -n 30 "$out" >&2
    echo "The ${what} is registered, but the running Lambda keeps the old one until \"pulumi up\" succeeds." >&2
    rm -f "$out" "${out}.err"
    return 1
  fi

  # Lists what would be deleted or replaced. Empty output means nothing would be
  local removed
  if ! removed="$(python3 - "$out" 2>/dev/null <<'PY'
import json, sys
steps = json.load(open(sys.argv[1], encoding="utf-8")).get("steps", [])
for s in steps:
    op = s.get("op", "")
    # delete, replace, create-replacement, delete-replaced and so on
    if "delete" in op or "replace" in op:
        print(f"  {op}: {s.get('urn', '?').split('::')[-1]}")
PY
)"; then
    echo "error: the preview of the deployment could not be read. Nothing was deployed." >&2
    rm -f "$out" "${out}.err"
    return 1
  fi
  if [ -n "$removed" ]; then
    echo "error: this deployment would delete or replace resources. Nothing was deployed." >&2
    printf '%s\n' "$removed" >&2
    echo "Check the stack configuration (${STACK_FILE}). If this is intended, run \"pulumi up\" yourself." >&2
    echo "The ${what} is registered, but the running Lambda keeps the old one until then." >&2
    rm -f "$out" "${out}.err"
    return 1
  fi

  if ! pulumi up --stack "$STACK" --yes --non-interactive > "$out" 2>&1; then
    echo "error: \"pulumi up\" failed." >&2
    tail -n 30 "$out" >&2
    echo "The ${what} is registered, but the running Lambda keeps the old one until \"pulumi up\" succeeds." >&2
    rm -f "$out" "${out}.err"
    return 1
  fi
  grep -E 'Resources:|updated|unchanged' "$out" || true
  rm -f "$out" "${out}.err"
}

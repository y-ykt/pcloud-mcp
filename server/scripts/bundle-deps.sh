#!/usr/bin/env bash
# © 2026 Yasuhiko Yokote
#
# Bundles the runtime dependencies into dist/.
#
# Only the contents of dist/ are deployed to Lambda, so everything needed at runtime is collected here.
#
# **Development dependencies (TypeScript and type definitions) are left out.**
# To do that, `npm ci --omit=dev` is run in a separate location with the same
# package.json and package-lock.json, and only its result is copied.
# Copying `node_modules` as is would include the development dependencies too.
#
# For mupdf only, the parts that are not read at runtime are removed.
# dist/*.br (pre-compressed copies for browsers) and *.d.ts (type definitions) have been
# **confirmed to be referenced by neither mupdf.js nor mupdf-wasm.js.**

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${here}/.."
stage="${root}/.bundle"
dst="${root}/dist/node_modules"

[ -f "${root}/package-lock.json" ] || { echo "package-lock.json not found" >&2; exit 1; }

# Prepare only the runtime dependencies, in an empty location
rm -rf "$stage"
mkdir -p "$stage"
cp "${root}/package.json" "${root}/package-lock.json" "$stage/"
( cd "$stage" && npm ci --omit=dev --ignore-scripts --silent --no-audit --no-fund )

rm -rf "$dst"
cp -R "${stage}/node_modules" "$dst"
rm -rf "$stage"

# Remove from mupdf what is not read at runtime (14 MB -> 10 MB)
rm -f "${dst}/mupdf/dist"/*.br "${dst}/mupdf/dist"/*.d.ts

count="$(find "$dst" -maxdepth 1 -mindepth 1 -not -name '.*' | wc -l | tr -d ' ')"
echo "Bundled the runtime dependencies (${count} packages / $(du -sh "$dst" | cut -f1 | tr -d ' '))"

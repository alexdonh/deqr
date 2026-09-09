#!/usr/bin/env bash
# Cut a release: verify, bump the version, write a changelog entry, commit, tag.
#
# Stops before pushing and prints the command, so there is a point where you can
# look at what you are about to publish.
#
# The verification matters more than the bookkeeping. `pnpm check` runs in CI
# too, but the browser gates do not: they need a real Chromium, and they are the
# only thing that catches a badge that never appears or a decode that silently
# returns nothing. Skip them with SKIP_BROWSER=1 if you have no Chromium.
#
# Usage: scripts/release.sh <version>     e.g. scripts/release.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"

# Extension manifests only accept 1 to 4 dot-separated integers. A prerelease
# suffix like 0.2.0-beta.1 is valid semver but an invalid manifest version, and
# both stores reject it, so refuse it here rather than at upload time.
if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "error: pass a plain dotted version, e.g. scripts/release.sh 0.2.0" >&2
  echo "       (no -beta / -rc suffixes: extension manifests reject them)" >&2
  exit 1
fi

CURRENT="$(node -p "require('./package.json').version")"
if [[ "$VERSION" == "$CURRENT" ]]; then
  echo "error: already at $CURRENT." >&2
  exit 1
fi
if [[ "$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | head -1)" != "$CURRENT" ]]; then
  echo "error: $VERSION is lower than the current $CURRENT." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "error: tracked files are dirty. Commit or stash first." >&2
  exit 1
fi

TAG="v$VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: tag $TAG already exists." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "warning: on branch $BRANCH, not main." >&2
fi

echo "==> verifying"
pnpm check
pnpm build
pnpm build:firefox
if [[ "${SKIP_BROWSER:-}" == "1" ]]; then
  echo "    skipping browser gates (SKIP_BROWSER=1)"
else
  pnpm verify
  pnpm verify:perf
fi

echo "==> bumping $CURRENT -> $VERSION"
node - "$VERSION" <<'NODE'
const fs = require('node:fs');
const version = process.argv[2];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = version;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
NODE

# Changelog entry, from the commit subjects since the last tag. Housekeeping
# commits are dropped; anything already hand-written for this version is left
# alone so you can describe a release properly when it deserves it.
CHANGELOG=CHANGELOG.md
if ! grep -qF "## $VERSION" "$CHANGELOG" 2>/dev/null; then
  echo "==> writing changelog entry"
  PREV="$(git tag --list 'v*' --sort=-version:refname | head -1)"
  RANGE=""
  [[ -n "$PREV" ]] && RANGE="$PREV..HEAD"
  NOTES="$(git log --no-merges --pretty='- %s' $RANGE | grep -vE '^- (ci|chore|release|docs)(\(.*\))?:' | head -40 || true)"
  [[ -z "$NOTES" ]] && NOTES="- Release $VERSION"
  ENTRY_FILE="$(mktemp)"
  printf '## %s - %s\n\n%s\n\n' "$VERSION" "$(date +%Y-%m-%d)" "$NOTES" > "$ENTRY_FILE"
  # Insert above the newest existing entry, not just after the title: anything
  # between the title and the first `## ` is prose that belongs where it is.
  FIRST="$(grep -n '^## ' "$CHANGELOG" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  if [[ -n "$FIRST" ]]; then
    { head -n "$((FIRST - 1))" "$CHANGELOG"; cat "$ENTRY_FILE"; tail -n +"$FIRST" "$CHANGELOG"; } > "$CHANGELOG.new"
  else
    { cat "$CHANGELOG" 2>/dev/null || true; printf '\n'; cat "$ENTRY_FILE"; } > "$CHANGELOG.new"
  fi
  mv "$CHANGELOG.new" "$CHANGELOG"
  rm -f "$ENTRY_FILE"
  echo "    review CHANGELOG.md before pushing; it is generated from commit subjects"
fi

echo "==> committing and tagging"
git add package.json CHANGELOG.md
git commit -m "release: $TAG"
git tag -a "$TAG" -m "$TAG"

cat <<EOF

$TAG is staged locally. Nothing has been pushed.

Look over the changelog entry, then:

    git push origin $BRANCH "$TAG"

The tag starts .github/workflows/release.yml, which rebuilds, re-runs the unit
suite, and publishes a GitHub Release with the store zips, the unsigned XPI, a
signed CRX if a key is configured, and checksums.
EOF

#!/usr/bin/env bash
#
# publish-if-new — publish one workspace package unless that exact
# name@version is already on the registry.
#
# Used by .github/workflows/release.yml for all three publishable packages, so
# a release job is safe to re-run and a hand-bootstrapped package name does not
# leave a red pipeline on its tag. Lockstep versioning is enforced separately by
# `bun run check:versions`; this script deliberately says nothing about which
# version is correct, only whether it is already published.
#
# Usage: scripts/publish-if-new.sh <package-dir-relative-to-repo-root>
#
# Passes --provenance, which requires a GitHub Actions OIDC id-token — this is a
# CI-only script. Publish by hand with a plain `npm publish` (see RELEASING.md).

set -euo pipefail

DIR="${1:?usage: publish-if-new.sh <package-dir>}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/$DIR"

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"

# `npm view <pkg>@<ver> version` exits non-zero for an unpublished version AND
# for a package that does not exist at all, which is exactly the "go ahead and
# publish" case. Distinguish a genuine registry/network failure from a 404 so a
# transient outage cannot be silently read as "not published yet" — that would
# turn an infrastructure blip into a confusing publish attempt further down.
set +e
VIEW_OUTPUT="$(npm view "$NAME@$VERSION" version 2>&1)"
VIEW_STATUS=$?
set -e

if [ "$VIEW_STATUS" -eq 0 ] && [ -n "$VIEW_OUTPUT" ]; then
  echo "$NAME@$VERSION is already published — skipping"
  exit 0
fi

if ! grep -qiE "E404|404 Not Found|is not in this registry|No match" <<<"$VIEW_OUTPUT"; then
  echo "::error::could not determine whether $NAME@$VERSION is published; refusing to guess"
  echo "$VIEW_OUTPUT"
  exit 1
fi

echo "publishing $NAME@$VERSION"
npm publish --provenance

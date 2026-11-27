#!/usr/bin/env bash
set -euo pipefail

VERSION=""

usage() {
  echo "Usage: $0 -v <version>"
  echo "Example: $0 -v v1.2.3"
}

while getopts ":v:h" opt; do
  case "$opt" in
    v)
      VERSION="$OPTARG"
      ;;
    h)
      usage
      exit 0
      ;;
    :)
      echo "Error: Option -$OPTARG requires an argument." >&2
      usage
      exit 1
      ;;
    \?)
      echo "Error: Invalid option -$OPTARG" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Error: Version is required." >&2
  usage
  exit 1
fi

# Remove the optional v prefix.
VERSION="${VERSION#v}"

# Validate the version format.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: Invalid version format: $VERSION" >&2
  echo "Expected a semantic version, e.g. 1.2.3 or v1.2.3." >&2
  exit 1
fi

echo "Releasing version: $VERSION"

# Ensure jq and all target files exist before making changes.
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but was not found." >&2
  exit 1
fi

FILES=(
  "package.json"
  "packages/protocol/package.json"
  "packages/core/package.json"
)

for file in "${FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Error: Expected $file to exist; aborting." >&2
    exit 1
  fi

  if ! jq -e 'type == "object"' "$file" >/dev/null; then
    echo "Error: $file is not a valid JSON object; aborting." >&2
    exit 1
  fi
done

# Update package versions.
for file in "${FILES[@]}"; do
  tmp_file="${file}.tmp"

  jq --arg version "$VERSION" '.version = $version' "$file" > "$tmp_file"
  mv "$tmp_file" "$file"

  echo "Updated $file:"
  grep '"version"' "$file"
done

echo "Successfully updated all package versions to $VERSION."
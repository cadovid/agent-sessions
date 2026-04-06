#!/bin/bash
set -e

# Bump version across all 3 files: package.json, tauri.conf.json, Cargo.toml
# Usage: ./scripts/bump-version.sh [major|minor|patch] or ./scripts/bump-version.sh 1.2.3

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT=$(grep '"version"' "$PROJECT_ROOT/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "${1:-patch}" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  [0-9]*) # Explicit version provided
    NEW="$1"
    ;;
  *) echo "Usage: $0 [major|minor|patch|X.Y.Z]"; exit 1 ;;
esac

NEW="${NEW:-$MAJOR.$MINOR.$PATCH}"

echo "$CURRENT -> $NEW"

# Update all 3 files
sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$PROJECT_ROOT/package.json"
sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$PROJECT_ROOT/src-tauri/tauri.conf.json"
sed -i "s/^version = \".*\"/version = \"$NEW\"/" "$PROJECT_ROOT/src-tauri/Cargo.toml"

# Update README badge
sed -i "s/version-[0-9]*\.[0-9]*\.[0-9]*/version-$NEW/" "$PROJECT_ROOT/README.md"

echo "Done. Files updated:"
echo "  package.json        -> $NEW"
echo "  tauri.conf.json     -> $NEW"
echo "  Cargo.toml          -> $NEW"
echo "  README.md badge     -> $NEW"

#!/bin/bash

set -euo pipefail

ROOT_DIR="$(dirname "$0")/.."
PACKAGE_DIR="$ROOT_DIR/packages/workstreams"

cd "$ROOT_DIR"

echo "📦 Releasing @agenv/workstreams patch version..."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree is not clean. Commit or stash changes before releasing."
  exit 1
fi

echo "🔎 Verifying package before version bump..."
(
  cd "$PACKAGE_DIR"
  bun run build
  bun run typecheck
)

cd "$PACKAGE_DIR"
VERSION=$(bun pm version patch --no-git-tag-version | tail -1)
VERSION=${VERSION#v}
TAG="workstreams-v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ Tag already exists: $TAG"
  exit 1
fi

echo "✅ Bumped to version: $VERSION"

git add package.json
if ! git diff --cached --quiet; then
  git commit -m "chore(workstreams): release v$VERSION"
else
  echo "ℹ️ No package.json changes to commit."
fi

git tag "$TAG"
echo "✅ Created tag: $TAG"

git push origin main
git push origin "$TAG"

echo ""
echo "🚀 Released $TAG"
echo "   GitHub Actions will now publish to npm"
echo "   Check: https://github.com/AlbertoV5/agenv/actions"

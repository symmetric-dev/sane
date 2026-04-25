#!/bin/bash

set -euo pipefail

ROOT_DIR="$(dirname "$0")/.."
PACKAGE_DIR="$ROOT_DIR/packages/opencode-workstreams"

cd "$ROOT_DIR"

VERSION=$(bun -e 'const pkg = await Bun.file("packages/opencode-workstreams/package.json").json(); console.log(pkg.version)')
TAG="opencode-workstreams-v$VERSION"

echo "📦 Releasing @agenv/opencode-workstreams v$VERSION..."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree is not clean. Commit or stash changes before releasing."
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ Tag already exists: $TAG"
  exit 1
fi

echo "🔎 Verifying package before tagging..."
bun install
(
  cd "$PACKAGE_DIR"
  bun run typecheck
  bun run build
)

git tag "$TAG"
echo "✅ Created tag: $TAG"

git push origin main
git push origin "$TAG"

echo ""
echo "🚀 Released $TAG"
echo "   GitHub Actions will now publish to npm"
echo "   Check: https://github.com/AlbertoV5/agenv/actions"

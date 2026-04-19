#!/bin/bash

set -euo pipefail

ROOT_DIR="$(dirname "$0")/.."
PACKAGE_DIR="$ROOT_DIR/packages/opencode-workstreams"
EXPECTED_VERSION="0.1.0"
TAG="opencode-workstreams-v$EXPECTED_VERSION"

cd "$ROOT_DIR"

echo "📦 Releasing @agenv/opencode-workstreams v$EXPECTED_VERSION..."

VERSION=$(bun -e 'const pkg = await Bun.file("packages/opencode-workstreams/package.json").json(); console.log(pkg.version)')

if [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  echo "❌ package.json version is $VERSION, expected $EXPECTED_VERSION"
  exit 1
fi

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
bun run typecheck --cwd "$PACKAGE_DIR"
bun run build --cwd "$PACKAGE_DIR"

git tag "$TAG"
echo "✅ Created tag: $TAG"

git push origin main
git push origin "$TAG"

echo ""
echo "🚀 Released $TAG"
echo "   GitHub Actions will now publish to npm"
echo "   Check: https://github.com/AlbertoV5/agenv/actions"

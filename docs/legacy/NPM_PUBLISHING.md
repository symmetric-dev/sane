# npm Publishing

`@agenv/workstreams` is published via GitHub Actions using npm trusted publishing (OIDC).

## Trigger

Push a tag matching `workstreams-v*`.

## Release Commands

```bash
bun run release:workstreams:patch
bun run release:workstreams:minor
```

These scripts bump version, commit, tag, and push.

## What to do to bump the package version

For `@agenv/workstreams`, the normal version bump path is:

### Patch release

```bash
bun run release:workstreams:patch
```

### Minor release

```bash
bun run release:workstreams:minor
```

These scripts currently:

1. bump `packages/workstreams/package.json`
2. create a commit like:
   - `chore(workstreams): release vX.Y.Z`
3. create a tag:
   - `workstreams-vX.Y.Z`
4. push `main`
5. push the tag

After that, GitHub Actions publishes the package.

## Before bumping

Recommended quick checklist:

```bash
bun run typecheck
cd packages/workstreams && bun run test
```

And make sure any relevant docs/changelog updates are included in the same release branch/commit.

## Workflow

See `.github/workflows/publish-workstreams.yml`.

Key points:
- `id-token: write` permission is required
- Node 24 is used for modern npm
- `NPM_CONFIG_PROVENANCE=false` is set for private-repo publishing compatibility

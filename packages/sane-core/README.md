# SANE Core

Private Bun package providing the repository domain used by SANE App.
The primary Git checkout owns `.sane/sane.db`; linked worktrees share that store.

## Interfaces

- [package.json](package.json) — exported module paths.
- [src/server.ts](src/server.ts) — backend domain operations and repository lifecycle exports.
- [src/contracts.ts](src/contracts.ts) — browser-safe domain types.
- [src/repository.ts](src/repository.ts) — discovery, inspection, explicit initialization and upgrades.
- [src/agent-catalog.ts](src/agent-catalog.ts) — supported agent identities.
- [src/sane-context.ts](src/sane-context.ts) — framework, session, and assignment composition.

Discover a repository and inspect its store before opening it. Inspection does not
initialize or upgrade; those are explicit operations. Open ready stores with
`openRepositoryDomain(context)` from `sane-core/server` and close the returned
handle in `finally`. Do not fabricate repository identities from paths.

Mutations require explicit actor/correlation context. Artifact publication uses
cooperative cross-process locks; partial publication is retained for diagnosis,
not silently adopted or removed. Do not manually steal locks or treat these
filesystem guarantees as an OS sandbox.

For user setup and recovery, use the [App operator guide](../sane-app/HUMAN-OPERATOR-GUIDE.md).

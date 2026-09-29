# Shared repository domain

Private Bun source package. `sane-core/server` owns the fresh relational
`<primary-checkout>/.sane/sane.db`; linked worktrees share it. `sane-core/contracts`
is browser-safe. No candidate store, compatibility loader, migration or ambient
repository/session selection exists here.

```ts
import {
  discoverRepository, inspectRepositoryStore,
  initializeRepository, openRepositoryDomain,
} from "sane-core/server"

const discovery = discoverRepository(absoluteGitPath)
const availability = inspectRepositoryStore(discovery) // never initializes
// Only an explicit user initialization action may call initializeRepository.
const context = initializeRepository(discovery)
const domain = openRepositoryDomain(context) // never initializes/migrates
try {
  domain.createWorkstream({ id: "example", title: "Example", type: "feature" }, {
    actor: { kind: "local" }, correlationId: crypto.randomUUID(),
  })
} finally { domain.close() }
```

Full API handoff, actor/source contracts, sync/async signatures and verification:
[`C7-CORE-REPORT.md`](../../docs/sane-app/archive/c7/C7-CORE-REPORT.md).

Mutations use immediate SQLite transactions and atomic audit evidence. Artifact
publication and approval capture hold per-workstream cross-process locks. These
are cooperative filesystem guarantees, not external-process snapshot isolation:
partial publication is diagnosed and retained, never silently adopted/deleted.
Stale locks are never automatically stolen. Close repository handles explicitly.

```sh
bun test packages/sane-core/tests --timeout 30000
```

Tests use disposable Git repositories and fresh databases; no native services,
installed configuration or live domain state are accessed.

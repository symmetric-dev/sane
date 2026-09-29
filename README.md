# SANE

SANE is a CLI and agent workflow for managing bounded software workstreams.
It helps users and AI assistants turn an idea or problem into a design,
technical solutions, an execution plan, and verified implementation.

**Design → Engineering → Planning → Execution**, with Research available
throughout. Users approve each phase; assistants coordinate the work and
delegate bounded tasks to workers.

Each implementation repository keeps its workstream documents in
`.sane/workstreams/` and workflow state in `.sane/sane.db`. SANE is currently
an Alpha, using Bun and OpenCode.

## Start here

**[Workflow Playbook](docs/SANE_WORKFLOW.md)** — installation, your first
workstream, and everyday operation.

[Documentation map](docs/README.md) · [Historical archive](docs/_legacy/README.md)

[SANE App](docs/sane-app/README.md) · [Ongoing App work](docs/sane-app/ongoing/README.md)

## Development

Requires [Bun](https://bun.sh/). From this checkout:

```bash
bun install
bun run typecheck
bun run test
```

- `bin/sane.ts` — CLI entry point.
- `packages/sane-cli/` — implementation and tests.
- `packages/sane-app/` — browser App and server.
- `packages/sane-core/` — shared domain operations.
- `docs/sane-app/` — App documentation and ongoing checkpoint work.
- `poc/` — historical proof-of-concept implementations.
- `opencode/` — agents and SANE integration plugin.
- `skills/` — assistant role contracts.
- `templates/` — workstream document templates.

The package is private to prevent accidental package publication.
## Run SANE App from this repository

Use `bun run start:app --port 6700` (`bun run start` is an alias). It builds the
App assets and starts a foreground server with the repository root as the default
execution cwd. `bun run start:app --help` lists options without building or starting.
The short launch is App-only: regular `.sane` workstreams are not loaded.
See the [operator guide](packages/sane-app/HUMAN-OPERATOR-GUIDE.md#root-launch-and-current-storage-model)
for App initialization, existing-store restart and Tailscale origin setup.

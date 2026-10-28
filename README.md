# SANE

SANE is a browser app for working with Claude Code and OpenCode conversations,
software workstreams, files, Git, terminals, and Python notebooks.

Work through SANE App. It supplies SANE agents with their role instructions and
workflow guidance directly; no separate CLI playbook is required.

## Start

Requires [Bun](https://bun.sh/) and an installed, authenticated Claude Code and/or
managed-local OpenCode service for the conversations you want to use.

From this checkout:

```sh
bun install
bun run setup:app --cwd /absolute/path/to/project --port 6700
bun run start:app
```

Open `http://127.0.0.1:6700`. For native runtime installation, configuration,
updates, and recovery, use the [operator guide](packages/sane-app/HUMAN-OPERATOR-GUIDE.md).

## Development

- [App](packages/sane-app/README.md) — frontend, server, and integration entry points.
- [Core](packages/sane-core/README.md) — repository-domain interfaces.
- [Science](packages/sane-science/README.md) — Python environment and notebook interfaces.
- [Profiling](packages/sane-app/PROFILING.md) — opt-in performance capture.

```sh
bun run typecheck
bun run build:app
```

`context/` and `templates/` are runtime inputs, not explanatory documentation.
Keep documentation limited to entry points, interfaces, and operational guides;
implementation details belong in code. Historical designs and plans remain in Git.

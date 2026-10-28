# SANE Science

Private Bun package for SANE App's managed Python environments and Marimo notebooks.
For normal use, provision notebooks through the App; see the
[operator guide](../sane-app/HUMAN-OPERATOR-GUIDE.md#browser-and-python).

## Development environment

Install [uv](https://docs.astral.sh/uv/) satisfying [pyproject.toml](pyproject.toml),
then run from the repository root:

```sh
bun run --cwd packages/sane-science setup:python
```

This creates the ignored package-local `.venv` from the committed lockfile. uv may
download the pinned interpreter during explicit setup. Project notebook
environments are provisioned separately under the primary checkout's `.sane/science`.

Commit `pyproject.toml`, `.python-version`, and `uv.lock`, not environments or
credentials. For deliberate dependency updates, edit the manifest, run `uv lock`
in this directory, review the diff, and run `uv sync --locked`. The manifest owns
the version, registry, wheel-only, and upload-age policies; normal setup does not
upgrade dependencies. Keep the Python template files alongside the package source.

## Interfaces

See [package.json](package.json) for exported module paths:

- [src/contracts.ts](src/contracts.ts) and [src/environments.ts](src/environments.ts)
  — canonical workspace input, environment status, scaffolding, explicit provisioning.
- [src/science-workspace.ts](src/science-workspace.ts) and
  [its contracts](src/science-workspace-contracts.ts) — notebook lifecycle and cell operations.
- [src/marimo-runtime.ts](src/marimo-runtime.ts) and
  [its contracts](src/marimo-runtime-contracts.ts) — owned server processes and connection lifecycle.
- [src/marimo-session.ts](src/marimo-session.ts) — backend-owned notebook sessions.
- [src/marimo-pair.ts](src/marimo-pair.ts) and
  [its contracts](src/marimo-contracts.ts) — authenticated HTTP cell inspection, edits, and execution.

The App-facing request/response interfaces live in
[../sane-app/shared/science-contract.ts](../sane-app/shared/science-contract.ts) and
[../sane-app/shared/science-chat-contract.ts](../sane-app/shared/science-chat-contract.ts).

## Ownership and recovery

Use an initialized canonical repository identity, not a fabricated path context.
Provisioning and notebook launch are explicit; construction/status do not install
dependencies. Differing managed environment templates are preserved and rejected,
not overwritten. Inspect a provisioner's ownership before manually removing a
crashed provisioning lock.

Use one workspace service per canonical workspace in the supervising process and
call `shutdown()` when finished. Keep exact notebook/session/generation references;
restart or disconnection does not authorize silently rebinding a mutation. Inspect
unknown outcomes before taking another action. Source hashes detect conflicts but
are not atomic compare-and-swap against concurrent browser edits. Mutation
acceptance, execution, and Marimo autosave durability are separate observations.

Runtime tokens and connection URLs are backend-only credentials. Do not expose
them in ordinary responses, logs, or reports. The adapter targets the pinned
Marimo version's private interfaces; dependency changes require integration review.
Python can access the host, and child processes can outlive a notebook server.
Neither a virtual environment nor process-local ownership is a security sandbox.

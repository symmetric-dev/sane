# App-owned native context injection

SANE now supplies role instructions and procedures to exact native sessions through the App. Canonical sessions no longer require SANE agent and skill Markdown to be installed in OpenCode or Claude Code.

This document describes the implemented migration, including its compatibility boundaries.

## Before and after

Previously, installation published SANE agent definitions and lifecycle skills into each harness's discovery directories. The App selected those installed agents and supplied framework/startup context separately. Resuming a legacy conversation could still require its installed agent file.

With canonical delivery, the App:

1. Reads authored role, framework, procedure, and execution-policy sources.
2. Builds immutable, content-addressed context and execution packages.
3. Pins those package revisions to the session.
4. Configures native execution separately from instruction text.
5. Delivers context to the exact native session and records delivery evidence.

The harness still executes models and tools. Runtime plugins, hooks, and MCP integrations remain necessary; removing installed Markdown does not mean removing those integrations.

## Where context lives

| Purpose | Location |
| --- | --- |
| Authored role instructions and execution settings | `opencode/agents/sane/{assistant,worker}/*.md` |
| Authored assistant procedures and resources | `skills/sane-assistant-<role>-<phase>/` |
| Framework source | `packages/sane-core/src/sane-context.ts` |
| Immutable session procedure copies | `<App dataDir>/context-packages/<revision>/` |
| Workstream documents/state | Target repository's `.sane/` |

The authored source has **not** been reorganized into `context/skills/`. The existing filenames are source inputs, not a requirement to install those files into a harness.

In the development installation, the source checkout is `/Users/beto/sane` and the configured App data directory is `packages/sane-app/.data-fresh`. Those are installation-specific paths, not required names.

## Instruction composition

For assistants, standing context is composed in this order:

1. Agent body, beginning with “You are a …”.
2. SANE framework and applicable coordination guidance.
3. Private procedure index with pinned file paths.
4. Initial Pickup procedure text.

Assistance and Delivery are referenced for selective reading with ordinary file tools. They are not all eagerly inlined. Dynamic Session context supplies the current workstream, workstream root, and implementation root. Workers receive their applicable role, procedure, and assignment; native children do not inherit the parent's App procedures and assignments wholesale.

Role Markdown frontmatter is interpreted as execution configuration, not injected as prose. Models, effort, permissions, and delegation are separate from context composition. Temperature is omitted from canonical root and child launch configuration, even when present in authored snapshots.

## Harness-specific delivery

### OpenCode

The installed SANE plugin exposes the `sane-execution/configure` RPC. The App uses it to prepare generated execution agents with empty system text, select execution settings, and verify readback. Generated definitions are location-scoped and hidden; they are not a session-private agent catalog.

Canonical instructions use an exact-session `sane.context` instruction entry. The App verifies the stored entry before dispatch. Generated policy handling preserves the intended worker restrictions despite native global permission defaults, while preserving session overrides and ordinary-session behavior.

An updated App requires an updated installed plugin. Restarting OpenCode alone cannot add missing runtime files or RPCs.

### Claude Code

The App supplies launch-local agent definitions through `--agents`, pinned standing text through `--append-system-prompt-file`, and dynamic context through a `UserPromptSubmit` hook. Canonical launches request `--include-hook-events` so the App can observe the hook acknowledgement.

Upgraded sessions use `--system-prompt-snapshot off` on subsequent resumes as well, preventing stale legacy snapshots from restoring the old role context.

SANE MCP tool calls use single-use caller bindings issued by a pre-tool hook. Hook and MCP processes must use the same binding directory. Duplicate token issuers with different roots are invalid deployment configuration; runtime installation now handles owned-hook replacement and explicit root alignment.

Claude execution-policy translation is bounded rather than full OpenCode parity. Supported model/effort and whole-tool restrictions are translated, with omissions and conservative restrictions recorded where applicable.

## Updates, branches, and migration

Canonical delivery is the default for normal App startup. `--context-delivery startup` remains an explicit compatibility mode. Existing sessions retain their recorded delivery configuration.

To change a procedure, edit its authored source under `skills/`. The App packages updated content for new SANE activations; no manual copy into the package store is needed. Existing sessions retain their pinned revisions. Restarting or compacting does not refresh their authored context.

Branching supports migration:

- A legacy SANE branch under canonical mode reserves paired canonical context/execution before native fork.
- A canonical branch preserves its existing revisions. It does not serve as a context-refresh operation.
- Base branches remain Base.
- Model/effort settings and history through the selected branch boundary are preserved.
- Replacement uses existing assignment-transfer behavior and retains the original as history.

Canonical-to-canonical branching preserves inherited context bytes rather than appending an entire new instruction entry merely to add continuation guidance. Legacy migrations retain continuation guidance so the assistant continues its current work instead of treating the branch as fresh Pickup. Existing duplicated historical text is not deleted.

There is no general in-place procedure-refresh mechanism. Do not modify files inside a pinned revision directory: hashes and provenance are validated.

## Workers and Scout Crew

App-managed workers are launched through `sane_worker_start`; their context and execution policies are pinned independently of the parent's delivery mode. A legacy parent can therefore launch canonical workers, but the parent still needs its legacy assets until migrated.

New Scout Crews explicitly launch App-managed `scout` workers instead of native subagents. Their idle turns remain nonterminal while required child outcomes are outstanding. Once child outcomes are ready, the crew resumes in its exact session to synthesize findings before its final result reaches its own parent. Existing pinned crews retain their earlier delegation behavior.

Other roles can still use configured native delegation where supported. Native delegation and App-managed worker tracking are distinct mechanisms.

## Installation and asset retirement

`sane install context-packages` defaults to runtime-only provisioning for both CLI and ordinary API calls. Explicit legacy asset/model/skill installation options remain available. Runtime reinstall preserves recognized custom connection paths and unrelated configuration.

Runtime-only provisioning does not itself remove existing Markdown. Retirement is a separate operation: identify SANE-owned installed files, back them up, and remove those copies while retaining runtime integrations and App-owned sources/packages.

Before retirement, migrate or finish active legacy sessions. Removing their installed definitions can prevent resume even though prior instructions remain in conversation history. A new canonical branch is the supported continuation route; removing assets is not an automatic session migration.

## Verification and lessons from rollout

The rollout exposed integration gaps that isolated tests had not covered:

- Missing Claude hook-event visibility caused the App to reject a delivered context as unacknowledged.
- Pending-input codecs initially rejected the new canonical configuration fields.
- Outdated installed OpenCode plugins lacked the required execution RPC.
- Missing packaged repository-reader modules prevented Claude MCP startup.
- Global OpenCode permission ordering conflicted with generated worker policies.
- Forwarded temperature was rejected by a selected provider/model.
- Canonical branch continuation text caused a full instruction entry to be appended again.

These received bounded fixes and focused regression coverage. A real canonical Claude Planning session resumed successfully; a real OpenCode Critic completed and its exact result reached the resumed Engineering parent.

Prepared context, configured execution, stored readback, hook acknowledgement, native model output, and final result delivery are different evidence stages. Mock-provider captures establish request assembly, not semantic model compliance. Passing a broad suite is not a substitute for a small installed-path check.

At the time of writing, the final installed first-call/compaction smoke checks were cancelled before completion. The new App-managed Scout Crew lifecycle and temperature omission have focused/native-fixture coverage but still require evaluation on the updated installed stack. Source commits do not imply installed runtime deployment.

## Implementation entry points

- `packages/sane-app/src/context-package.ts`: composition and package contracts.
- `packages/sane-app/src/context-package-store.ts`: authored sources, publication, and integrity.
- `packages/sane-app/src/context-delivery.ts`: exact bindings and delivery receipts.
- `packages/sane-app/src/canonical-execution-store.ts`: immutable execution snapshots.
- `packages/sane-app/src/canonical-agent-operations.ts`: harness execution translation.
- `packages/sane-app/src/branch-context.ts`: branch continuation composition.
- `packages/sane-app/src/scout-crew-lifecycle.ts`: nested Scout coordination.
- `packages/sane-app/src/{bridge,claude-run-service,opencode-run-service}.ts`: lifecycle and dispatch.
- `opencode/plugins/sane/execution.ts`: OpenCode runtime execution configuration.
- `packages/sane-cli/src/install-sane-agent-context-packages.ts`: provisioning.

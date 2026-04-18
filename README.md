# AgEnv


AgEnv is a developer toolkit for planning, running, and reviewing agent-driven work efficiently. It provides structured workstreams for breaking work into stages/batches/threads, plus CLI workflows that integrate with Opencode so humans and agents can collaborate with clear progress and handoffs.

<p align="center">
  <img src=".github/assets/Web.JPG" alt="AgEnv workflow preview" width="900" />
</p>

## External Dependencies

Required:

- Bun
- Git

Feature-dependent:

- `opencode` CLI: required for `work execute`, `work multi`, and agent-run execution flows
- `tmux`: required for `work multi` session orchestration
- `ttyd`: required for local browser-embedded dashboard terminal views
- GitHub CLI (`gh`): required for GitHub integration flows (`work github`, issue/branch sync)
- macOS notification tools (`terminal-notifier`, `say`): optional, used by notification providers

## Packages

- `@agenv/workstreams`: workstream library + `work` CLI
- `@agenv/cli`: `ag` CLI wrapper
- `@agenv/workstream-dashboard`: local-only current-workstream dashboard server

## Repo Layout

```text
packages/        # TypeScript packages
agent/           # Skills, commands, tools, hooks
docs/            # Minimal operational docs
work/            # Workstream data in this repo
```

## Install (local development)

```bash
bun install
./install.sh
```

Optional skill install:

```bash
./install.sh --with-skills
./install.sh --skills-all
```

## Human Workflow (With Agent)

The day-to-day workflow is:

1. Discuss the feature and let the agent research the repo.
2. The agent uses `planning-workstreams` to create the workstream and prepare `REQUIREMENTS.md`, `PLAN.md`, and draft tasks.
3. You approve the plan first, then approve tasks after the plan/task back-and-forth is complete.
4. The Root Agent uses `managing-workstreams` to launch a supervision branch.
5. The supervision branch uses `supervising-workstreams` to run `work supervise`, inspect persisted state, and drive the review/fix/escalation loop.
6. Implementation agents spawned within that loop use `implementing-workstreams` to inspect batch/task scope and update task state while they work.
7. The Root Agent reports back; you approve the completed stage with `work approve stage N`.
8. Repeat the supervision loop for the next stage.
9. If more work is needed after the original stages, use the revision flow.
10. When the workstream is done, use `evaluating-workstreams` to finalize `REPORT.md` and validate the report.

Draft-first planning usually starts like:

```bash
work create --name my-feature
work current --set "001-my-feature"
work validate requirements
work plan create --stages 2
work validate plan
work approve plan
```

Human approval / inspection commands typically look like:

```bash
work tree
work status
work approve plan
work approve tasks
work approve stage 1
work report validate
```

Notes:

- Use `!work ...` when invoking from chat-driven Opencode commands.
- Agents handle most planning and execution details; humans control approvals, stage gates, and final evaluation.
- `work supervise` is the normal execution primitive; `work start` is no longer the main workflow entrypoint.
- The implementation agents running inside supervision commonly inspect scope with `work status`, `work tree --batch`, and `work list --tasks --thread` before updating task state.

For supervised headless automation with review/fix/escalation policy, start with `docs/SUPERVISOR.md`; for quick validation drills and the optional tmux/tool E2E smoke test, use `docs/supervision-manual-verification-checklist.md`.

Example output from `work tree`:

```text
[ ] Workstream: 016-reference-resource (47)
├── [x] Stage 01: Foundation - Database, API & Types (8)
│   └── [x] Batch 01: Core Backend + Types (8)
│       ├── [x] Thread 01: Database Schema (3) @systems-engineer
│       ├── [x] Thread 02: CRUD API (3) @systems-engineer
│       └── [x] Thread 03: Shared Types (2) @default
├── [ ] Stage 02: Embedding Infrastructure (11)
│   ├── [ ] Batch 01: Python Embedding Service (6)
│   │   ├── [ ] Thread 01: Multimodal Embedding Service (3) @systems-engineer
│   │   └── [ ] Thread 02: Embedding API Endpoints (3) @systems-engineer
│   └── [ ] Batch 02: Re-indexing & Integration (5)
│       ├── [ ] Thread 01: Re-index Background Task (3) @systems-engineer
│       └── [ ] Thread 02: Upload-Triggered Embedding (2) @default
└── [ ] Stage 03: Frontend - Resource Management (8)
    └── [ ] Batch 01: API & Resource Definition (8)
        ├── [ ] Thread 01: Frontend API Client (2) @frontend-speedster
        ├── [ ] Thread 02: Resource Definition & Manager (3) @frontend-speedster
        └── [ ] Thread 03: Embedding Settings UI (3) @frontend-speedster
```

Example output from `work status`:

```text
+--------------------------------------------------+
| 016-npm-publish-cleanup                          |
| Status: [x] completed                            |
+--------------------------------------------------+
| Progress: [##############################] 100%  |
| Tasks: 22/22 complete, 0 in-progress, 0 blocked  |
+--------------------------------------------------+
| [x] Stage 01: Build System & Cleanup (15/15) ✓   |
| [x] Stage 02: Testing & Documentation (7/7) ✓    |
+--------------------------------------------------+
```


## Skills and Agent Roles

AgEnv uses skill files under `agent/skills/*` to guide agent behavior through each phase.

- `planning-workstreams`: used first to create the stream, fill `REQUIREMENTS.md`, shape `PLAN.md`, validate/check, and prepare tasks for approval.
- `managing-workstreams`: used by the Root Agent after task approval to launch and monitor a supervision branch.
- `supervising-workstreams`: used by the supervision branch to run `work supervise`, inspect persisted state, and drive the review/fix/escalation loop.
- `implementing-workstreams`: used by worker agents that execute thread tasks within supervised batches; these workers inspect their scope and keep task state current.
- `evaluating-workstreams`: used near completion to assess delivered work and finalize report quality (`REPORT.md`).

In practice:

1. Planning agent uses planning skill to prepare requirements/plan/tasks.
2. Human approves (`work approve plan`, `work approve tasks`).
3. Root Agent uses the managing skill to launch a supervision branch.
4. Supervision branch uses the supervising skill to run `work supervise` and make review/fix/escalation decisions.
5. Implementation agents use the implementation skill to work assigned threads and update task state.
6. Human approves each completed stage, and evaluation/reporting happens at the end.

## Custom Workstream Tools

Opencode custom tools support parts of the workstream workflow that need access to live session context.

- `workstream_link_planning_session`: links the current opencode session to a workstream as its planning session.
- `workstream_launch_supervision_branch`: launches the supervision branch from the Root Agent session.
- `finalize_workstream_supervision`: persists the terminal supervision result before reporting back.
- `reconcile_workstream_supervision`: reconciles stale ended-but-nonterminal supervision sessions.
- `link_thread_session`: used by implementation agents to link the current opencode session to their assigned thread before substantive implementation work begins.

## Test and Typecheck

```bash
bun run typecheck
bun run test
```

For package-local checks:

```bash
cd packages/workstreams
bun run typecheck
bun run test
```

## Docs

- `docs/INSTALL.md`
- `docs/WORKSTREAM.md`
- `docs/HOW_TO_USE_MULTI.md`
- `docs/SUPERVISOR.md`
- `docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`
- `packages/dashboard-server/README.md`
- `docs/supervision-manual-verification-checklist.md`
- `docs/NOTIFICATIONS.md`
- `docs/workstream-reports.md`
- `docs/NPM_PUBLISHING.md`

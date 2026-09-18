# SANE Workflow Playbook (0.2.0)

> Operator runbook for single-scope workstreams. The data model reference is
> `docs/SANE_0_2_0.md`; repository setup is `docs/SANE_REPOSITORY_SETUP.md`.
> This playbook is the normative phase-by-phase narrative: what each session
> does, which commands it runs, and where the user gates are.

## Lifecycle

One workstream, one scope, four phases in order — Design → Engineering →
Planning → Execution — plus Research as a support track from any phase. Each
phase is one long-lived top-level assistant session (never a subagent). The
user moves the workstream forward: sessions do Pickup, Assistance, and
Delivery; approvals happen outside sessions via the user's own `sane approve`
invocation.

```
create → design → engineering → planning → execution → done
              ↘ research (any point, never blocking) ↗
```

## Start a workstream

```bash
sane init                                    # once per implementation repo
sane create --name <name> --type <feature|foundation|issue|maintenance>
sane select --name <name>                    # resume an existing one
```

`--type` is required at create and fixes the root doc. Type lives in sqlite
only; there is no `type` file and no selection file. Every later command
auto-detects the workstream from the current directory — run bare.

## Phase sessions

| Phase       | Agent / skill              | Owns                                              | Reads                        | Provide → Validate → Approve              |
|-------------|----------------------------|---------------------------------------------------|------------------------------|-------------------------------------------|
| Design      | assistant/design           | root doc + `design/SDD.md`                        | research index               | `provide design` → `validate design` → `approve design --ref <ref>` |
| Engineering | assistant/engineering      | `design/solutions/<name>.md`                      | root doc, SDD                | `provide engineering` → `validate engineering` → `approve engineering --ref <ref>` |
| Planning    | assistant/planning         | `execution/PLAN.md` + `execution/jobs/*.md`       | SDD, solutions               | `provide planning` → `validate planning` → `approve planning --ref <ref>` (registers jobs as `planned`) |
| Execution   | assistant/execution        | `execution/reports/*.md` + `execution/FINAL_REPORT.md` | PLAN, jobs, SDD, solutions | `provide execution` → `validate execution` → `approve execution --ref <ref>` (batch-completes stragglers) |

Every phase session follows the same rhythm:

1. **Pickup** — read `README.md`, run `sane provide <phase>` (never
   overwrites), read the inputs above, run `sane view`, report readiness,
   wait for the user.
2. **Assistance** — draft with the user, iterate. Planning confirms the plan
   before writing Job Specs, then grounds them via `sane/worker/grounder`.
   Execution confirms run order and checkpointed/delegated preference, then
   dispatches workers.
3. **Delivery** — `sane validate <phase>`, user-requested updates, then the
   user approves the phase outside the session.

<!-- USER PROSE: phase-entry criteria, what "good" looks like per artifact,
     when to send work back a phase. -->

## Research track

Support track, no approval semantics. The Research Assistant (or any phase
assistant via a bounded Researcher worker) writes append-only evidence to
`research/<topic>/REPORT.md` and registers it:

```bash
sane research --index                        # presence/status + unregistered files
sane research --register --topic <topic>
sane research --unregister --topic <topic>   # index repair only
```

Never update a registered report — write a new topic. Only the Research
Assistant reconciles the index; workers register their own report only when
asked. A material conflict with approved Design/Engineering routes to a
Design/Engineering update plus re-approval; research never blocks.

<!-- USER PROSE: when to spin up research vs scouting, topic scoping. -->

## Execution dispatch

Jobs are progress tracking (`planned` → `running` → `completed`), not
per-job gates. `planned` means authorized by planning approval. The
Execution Assistant marks progress itself and gives workers context via the
serialized bundle — no pasted absolute paths:

```bash
sane job <id> --json             # worker context bundle (spec/report paths,
                                 # template, design docs, planning approval)
sane job <id> running|completed  # progress marks (forward-only)
```

Implementer writes its report to the bundle's `report_path` (copy
`report_template` first, never overwrite). One read-only Reviewer per
completed batch; fixes go through a Fixer per the skill's Fixes Procedure
(max twice, then escalate to Planning via the user). Workers inherit the
session working directory and are launch-generic: the same implementer,
reviewer, fixer, scout, and researcher serve execution batches and
research follow-ups.

<!-- USER PROSE: checkpointed vs delegated guidance, batch sizing. -->

## User gates

- The user approves each phase outside its session (`sane approve <phase>
  --ref <ref>`); assistants never self-approve and never run `approve`.
- Only the user stops/continues execution, accepts outcomes, expands scope,
  or merges.
- Handoffs between sessions are compact references (From/To, approvals,
  revisions, paths, next action) via `sane handoff`; queue delivery is the
  default. Nothing auto-advances.

## Worktrees (pilot rule)

SANE-managed worktrees are quarantined. The user selects/creates the
worktree in the client; SANE only records the foreign path (`sane handoff
--worktree-path/--branch`) so CWD auto-detection resolves it. Execution
never creates worktrees. Worktrees run isolated checks only (typecheck,
unit tests, lint) — no shared dev servers, migrations, or deploys.

## Command cheat sheet

```bash
sane view                            # resolved workstream + phase state
sane status                          # focused status report
sane provide <phase>                 # phase starter (never overwrites)
sane validate <phase>                # exists / non-empty / no template comments
sane approve <phase> --ref <ref>     # validates first, refuses on problems
sane job <id> [--json]               # worker context bundle
sane job <id> <running|completed>    # progress mark
sane research [--index|--register|--unregister] [--topic <t>]
sane handoff                         # compose/send session handoff
```

## Document map

- This playbook — operator narrative (you are here).
- `docs/SANE_0_2_0.md` — workflow + data model reference (sqlite is source
  of truth, files are render).
- `docs/SANE_REPOSITORY_SETUP.md` — layout, init/create/select, helper
  semantics.
- Role skills (`skills/*/SKILL.md`) — per-session contracts.
- Agents (`opencode/agents/sane/`) — session entrypoints (assistants) and
  self-contained assignments (workers).

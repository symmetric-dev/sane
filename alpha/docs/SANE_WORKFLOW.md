# SANE Workflow Playbook

SANE organizes a bounded software effort as a **workstream**. Each workstream
moves through **Design → Engineering → Planning → Execution**. Research can
support any phase. Users approve phases and accept outcomes.

## 1. Install

Requires [Bun](https://bun.sh/) and OpenCode for assistant sessions.
From the root of this SANE checkout (`alpha/`):

```bash
bun install
bun packages/sane-cli/src/install-sane.ts
```

The installer places `sane` in `~/.local/bin` and prints a PATH instruction
if needed. Follow that instruction, then install the agents, role skills,
and SANE plugin:

```bash
sane install context-packages
```

Restart OpenCode after installation. Both installers support `--dry-run`
and `--overwrite`; use `--overwrite` to refresh an existing installation
after pulling changes. If this checkout moves, rerun the CLI installer.

## 2. Start or resume a workstream

Run these commands from the repository where the implementation will happen:

```bash
sane init
sane create --name my-change --type feature
sane view
```

Choose the type that fits the work:

| Type | Root document | Use for |
| --- | --- | --- |
| `feature` | `PRD.md` | A product capability |
| `foundation` | `FOUNDATION.md` | Shared technical foundations |
| `issue` | `ISSUE.md` | A problem to investigate and fix |
| `maintenance` | `MAINTENANCE.md` | Upkeep or bounded improvements |

Creation selects the new workstream. To resume another:

```bash
sane select --name my-change
```

Workstream documents live in `.sane/workstreams/<name>/`. Selection, phase
state, approvals, and session links live in `.sane/sane.db`. `sane init`
adds `/.sane/` to the repository's `.gitignore`. Run subsequent commands
from the implementation repository; SANE resolves the workstream from the
current directory and selection. Use `sane view` to confirm the target.

## 3. Work through the phases

Start the SANE Design Assistant in OpenCode in the implementation repository.
Each phase uses a top-level assistant session; workers handle bounded delegated
tasks. The assistant reads the workstream context, links its session, and
works with you on the phase's documents.

| Phase | Main output |
| --- | --- |
| Design | Root document and `design/SDD.md` |
| Engineering | Solution specs in `design/solutions/` |
| Planning | `execution/PLAN.md` and `execution/jobs/` |
| Execution | Implementation, `execution/reports/`, and `execution/FINAL_REPORT.md` |

Planning confirms the plan with you before drafting and grounding Job Specs.
Execution confirms run order and checkpoints, dispatches implementers, and
coordinates review and fixes.

At each phase's delivery, review the output, request changes if needed, and
approve it yourself in the terminal:

```bash
sane validate design
sane approve design --ref "Reviewed design"
```

Replace `design` with `engineering`, `planning`, or `execution` as you
progress. Approval validates the phase first. Assistants never run approval
commands. Planning approval authorizes the jobs; Execution tracks their
progress. You control scope changes, acceptance, and merges.

During execution, Planning can register added Job Specs within the existing
authorization by running `sane job --register` (optionally `--json`). The command
requires Planning approval, validates `execution/PLAN.md` and all Job Specs,
and registers missing jobs as `planned`. IDs come from the filename prefix
before the first dash (or the whole basename without `.md` if there is no dash).
Duplicate IDs and changes to an existing ID's spec path are rejected atomically.
Repeated registration preserves job progress and the original approval record;
it does not reorder, renumber, or remove jobs.

A Planning hash-drift warning means the documents differ from the approved
snapshot. Routine authorized amendments can continue without deapproval or
another `sane approve planning`. Planning escalates decisions exceeding that
authorization directly to you. Registration records the actor as `planning`
for audit purposes; this label is not authenticated role-based access control.

### Sessions and handoffs

Assistants use the installed `sane_link` and `sane_handoff` tools to register
themselves and send work to another session. A handoff creates a target
session if none is linked, or queues a message to an existing one. Open a
newly created `[ready]` session from the OpenCode session list.

```bash
sane sessions
sane sessions --slot engineering
```

Design, Planning, and Execution each have one linked session. Engineering
and Research can have several; assistants ask which target to use when
needed. Replies target the original sender. Prefer a fresh Research session
for a new investigation. A handoff does not approve a phase.

### Research

Ask for Research whenever evidence is needed. Reports live at
`research/<topic>/REPORT.md` and are registered in the research index:

```bash
sane research --index
```

Registered reports are append-only: new findings go into a new topic.
Research has no approval gate. Findings that change an approved design or
solution require updating that work and obtaining approval again.

### Worktrees

If using a worktree, create/select it in OpenCode and have the assistant
record its path when linking the session. SANE-managed worktree and merge
commands are disabled for the pilot. Use worktrees for isolated checks;
keep shared dev servers, migrations, and deployments out of them.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `sane view` | Show the resolved workstream and phase state |
| `sane status` | Show a focused status report |
| `sane provide <phase>` | Create starter documents without overwriting existing files |
| `sane validate <phase>` | Check phase documents |
| `sane approve <phase> --ref "<note>"` | Record your phase approval |
| `sane sessions` | List linked assistant sessions |
| `sane research --index` | Inspect registered reports and mismatches |
| `sane job <id> --json` | Get a worker's job context |
| `sane job --register [--json]` | Register added specs under existing Planning approval |
| `sane job <id> running` | Mark a job as running |
| `sane job <id> completed` | Mark a job as completed |

Use `sane --help` for the command list. Detailed assistant procedures live
in [role skills](../skills/); document starters come from
[templates](../templates/). Older designs and guides are in the
[archive](_legacy/README.md).

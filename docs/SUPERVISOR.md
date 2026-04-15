# Root Agent Branch Supervision (`work supervise`)

This document covers the v1 Root Agent supervision workflow for headless batch execution, deterministic review input collection, and Root Agent-owned fix/escalation decisions.

> v1 scope: `work supervise` is an execution/recovery primitive over existing `work` + Opencode CLI flows. Branch policy decisions are owned by the Root Agent.

## Intended Flow

The Root Agent runs one batch at a time and loops through this sequence:

1. Pick a starting batch:
   - explicit: `work supervise --batch "SS.BB"`
   - default: next incomplete batch in the current stream
2. Launch headless execution using:
   - `work multi --headless --async ...`
3. Wait for persisted batch status (`work/<stream-id>/batch-status/<batch-id>.json`) to reach a terminal state.
4. Consume deterministic review outputs after the batch finishes, using canonical workstream state (task status/report fields, thread/session metadata, batch status, and persisted artifacts when present).
5. Root Agent decides next action:
   - approve batch and continue,
   - run one automatic fix cycle and re-review,
   - or escalate to the user.
6. Persist all run/review/fix/escalation/stage-stop metadata in:
   - `work/<stream-id>/supervisor-state.json`

Escalation policy: branch runs escalate to the Root Agent; the Root Agent escalates to the user.

## Command Usage

```bash
# supervise from next incomplete batch
work supervise

# supervise from a specific batch
work supervise --batch "03.01"

# dry-run intended actions only
work supervise --dry-run
```

Common flags:

- `--port`: pass OpenCode server port to the headless `work multi` launch
- `--no-server`: do not start `opencode serve` as part of execution
- `--silent`: disable batch notification sounds
- `--timeout-ms`: stop waiting if batch status does not complete in time; supervisor exits without reviewing the incomplete batch, and the interrupted run remains resumable on rerun (default: `1200000` / 20 minutes)
- `--poll-interval-ms`: polling interval while waiting for batch status (default: `1000` ms)

### Long-running Root Agent usage (recommended)

For real Root Agent runs, prefer an intentionally long wait budget so the caller can stay attached while headless work and deterministic review complete:

```bash
# Recommended for production-style runs
work supervise --batch "SS.BB"
```

- `1200000` ms = **20 minutes**.
- Use this as the default when validating end-to-end supervisor behavior under normal load.
- Keep short timeouts for targeted failure/recovery drills, not for primary runs.

## Root Agent Review/Fix Behavior and Default Stop Conditions

Default v1 behavior remains conservative:

- `review_limits.max_fix_cycles_per_batch = 1`
  - one automatic fix cycle is allowed per batch
  - if issues remain after that limit, Root Agent escalates to user
- `stage_completion.stop = true`
- `stage_completion.contact_user = true`
  - when a stage boundary is reached, Root Agent stops and requests user input
  - no automatic stage-level fix cycle is attempted

Root Agent continues automatically only when all of the following are true:

- the batch reached a terminal status,
- review passed (or the one allowed auto-fix cycle succeeded),
- no escalation/contact-user trigger fired,
- no stage-boundary stop trigger fired,
- and another incomplete batch exists.

Root Agent stops when any of the following happens:

- escalation requires user input,
- stage boundary stop/contact-user condition is hit,
- there is no next batch to run,
- or an execution/wait error occurs.

Timeout semantics in v1 are strict but interruption-safe:

- `waitForBatchStatus()` only returns when the batch reaches a terminal state (`completed` or `failed`)
- if `--timeout-ms` elapses first, the wait fails with the latest persisted non-terminal state left in `work/<stream-id>/batch-status/<batch-id>.json`
- `work supervise` skips review/fix follow-up for that incomplete batch, leaves the run resumable, and prefers that interrupted batch again on the next `work supervise` rerun

## Smoke-Test Follow-up Checklist (Post-Fix)

After a supervised batch reports completion, verify this quick checklist to confirm the repaired completion fallback path behaved correctly:

### Successful completion evidence

- `work/<stream-id>/batch-status/<batch-id>.json`
  - `status` is terminal (`completed` or `failed`) and no longer `running`/`queued`.
  - For the repaired fallback case, terminal status can be canonicalized even when tmux artifacts are missing.
- `work/<stream-id>/supervisor-state.json`
  - `reviewed_batches` includes the batch id (proof review ran after terminalization).
  - persisted finalization evidence is present, such as completed run state and/or a matching `stage_stops` record reflecting the supervisor's terminal decision for that batch/run.
  - `stage_stops` or `escalations` reflect the actual stop decision when applicable (for example: stage boundary contact-user, no remaining batches, or escalation trigger).
- Supervisor output includes both terminal and review signals (for example: `batch ... finished: completed` then `review ...`).

### Timeout/failure evidence (not successful completion)

- `work/<stream-id>/batch-status/<batch-id>.json` remains non-terminal when wait times out.
- `work/<stream-id>/supervisor-state.json` does **not** gain a new reviewed entry for that incomplete batch; the interrupted run remains resumable until the batch reaches a terminal state and review can continue.
- Supervisor output shows wait/timeout failure and stops before review/fix follow-up.

## `work/supervisor.json` Config Shape

Supervisor policy is loaded from repo-level config:

- `work/supervisor.json`

If the file is missing, built-in defaults are used.

```json
{
  "issue_taxonomy": {
    "severity": ["high", "medium", "low"],
    "difficulty": ["complex", "regular", "trivial"],
    "ownership": ["product", "engineering"],
    "effort": ["tasks", "revision", "workstream"]
  },
  "review_limits": {
    "max_fix_cycles_per_batch": 1
  },
  "stage_completion": {
    "stop": true,
    "contact_user": true
  },
  "escalation": {
    "contact_user_on": {
      "severity": { "values": [], "min_count": 1 },
      "difficulty": { "values": ["complex"], "min_count": 1 },
      "ownership": { "values": ["product"], "min_count": 1 },
      "effort": { "values": ["revision", "workstream"], "min_count": 1 },
      "review_fix_limit_reached": true,
      "stage_completion": true
    }
  }
}
```

### Naive v1 escalation defaults

The default `contact_user_on` policy triggers escalation when **any configured trigger** is met:

- difficulty includes `complex` (at least 1 matching issue)
- ownership includes `product` (at least 1 matching issue)
- effort includes `revision` or `workstream` (at least 1 matching issue)
- review/fix limit is reached
- stage completion trigger is enabled

`severity.values` defaults to an empty list, so severity alone does not trigger contact-user until configured.

## Root Agent Guidance: Inspect, Interpret, Resume

After every supervised batch run (especially when orchestration stops), run this quick inspection flow before resuming.

### 1) Quick inspection commands

```bash
# 1) task/thread state snapshot for the batch that just ran
work tree --batch "SS.BB"

# 2) persisted batch execution result (terminal vs non-terminal)
work batch-status --batch "SS.BB" --format json

# 3) persisted supervisor decision history for this stream
cat work/<stream-id>/supervisor-state.json
```

What each check tells you:

- `work tree --batch "SS.BB"`: which tasks/threads are complete, failed, or still in progress.
- `work batch-status --batch "SS.BB" --format json`: whether execution is terminal (`completed`/`failed`) or still non-terminal (for timeout/wait failures).
- `work/<stream-id>/supervisor-state.json`: whether the Root Agent reviewed this batch and why it stopped (`reviewed_batches`, `escalations`, `stage_stops`).

### 2) How to read terminal outcomes quickly

Use this mental model to quickly separate success from required Root Agent follow-up:

- **Terminal success (good stop or clean continue point):**
  - `work batch-status` shows `status: "completed"`
  - no failed threads in the batch summary
  - `supervisor-state.json` includes this batch in `reviewed_batches`
- **Timeout while still running (wait failure):**
  - `work supervise` exits with timeout/wait failure
  - `work batch-status` remains non-terminal at last persisted state
  - `supervisor-state.json` keeps the interrupted run resumable on its current batch so a later `work supervise` rerun resumes it before moving on
- **Escalation/contact-user stop (needs Root Agent + user decision):**
  - batch may still be terminal (`completed`)
  - `supervisor-state.json` adds an `escalations` entry and corresponding `stage_stops` record
  - Root Agent waits for user action before continuing
- **Terminal failed run (batch finished as failed):**
  - `work batch-status` shows `status: "failed"`
  - `supervisor-state.json` records a failed stop; inspect failed thread summaries first

If you're deciding whether it is safe to resume with `work supervise`, use this shortcut:

- Resume normally when batch status is terminal and `reviewed_batches` contains the batch.
- Inspect first when batch status is non-terminal, an escalation was recorded, or batch status is `failed`; after inspection, rerunning `work supervise` will prefer the interrupted/resumable batch before any later incomplete batch.

### 3) Resume modes

1. **Continue default progression**
   - run `work supervise`
   - resumes any interrupted/resumable batch first; otherwise starts from the next incomplete batch
2. **Re-run a specific batch after manual fixes/policy adjustments**
   - run `work supervise --batch "SS.BB"`
3. **After stage-boundary stop**
   - review/approve stage outcome
   - run `work supervise` to proceed into next incomplete batch (often next stage)

If you change escalation behavior, edit `work/supervisor.json` and re-run `work supervise`.

### 4) Timeout interruption + default resume checklist

Use this quick drill to verify interruption-safe recovery without forcing `--batch` during resume.

1. Intentionally force a short-timeout interruption:
   - `work supervise --batch "SS.BB" --timeout-ms 100`
   - Expect timeout/wait failure before review/finalization finishes.
2. Inspect persisted state before rerunning:
   - `work batch-status --batch "SS.BB" --format json`
   - `cat work/<stream-id>/supervisor-state.json`
3. Resume using plain progression:
   - `work supervise`
   - Expected behavior: Root Agent orchestration resumes interrupted `SS.BB` first instead of skipping to a later incomplete batch.
4. Distinguish evidence clearly:
   - **Resumed review/finalization success:** `SS.BB` reaches terminal `completed`, `reviewed_batches` includes `SS.BB`, and persisted finalization evidence appears in `supervisor-state.json` (for example completed run state and/or the expected `stage_stops` entry for that resumed batch decision).
   - **Non-terminal interruption (still needs action):** batch status remains non-terminal, no new `reviewed_batches` entry for `SS.BB`, and you should keep waiting or investigate worker/escalation state.

Persisted-state note for same-batch resume verification:

- Do not rely only on resumed console output.
- Confirm the resumed batch by checking that the next persisted `supervisor-state.json` update still references `SS.BB` before any later incomplete batch appears in `reviewed_batches`, `stage_stops`, or other run/finalization metadata.

## Checkpoint Boundary Guidance (Stage 14)

Stage 14 keeps Stage 13 checkpoint pointers, but changes how they are used:

- **Stage 13:** pointers were captured/persisted metadata while branch inheritance still behaved like a plain fork.
- **Stage 14:** the selected pointer boundary (`checkpointMessageId` when available) now drives the native fork boundary itself, so inheritance starts from the chosen transcript breakpoint.

This closes the remaining Stage 13 gap: pointer fields are no longer just observational metadata; they now control branch inheritance.

### Scope guardrail

- Only the real Root Agent may launch a supervision branch.
- If a branch session tries to call `launch_supervision_branch`, the launch path must fail immediately with a clear guardrail error.
- Treat that failure as correct behavior: the branch should **yield back** to the Root Agent instead of building a deeper branch tree.

## Branch Supervision Tmux Sessions and Recovery Tools

When Root-Agent-owned supervision is launched through the workstream tooling, there are now two distinct execution layers to keep in mind:

1. **Supervision branch tmux session**
   - top-level Opencode supervision branch
   - naming pattern like `001-supervision-ffabbc`
2. **Implementation tmux session(s)**
   - work launched by `work supervise` / `work continue`
   - naming pattern like `001-implementation-ab12cd`

This separation is intentional:

- supervision tmux is for observing the branch/root-agent timeline itself
- implementation tmux is for observing the worker execution primitives

### Manual recovery/debugging commands

If a supervision branch session has already ended but persisted state is still nonterminal, use:

```text
reconcile_workstream_supervision({ streamId: "001-my-stream" })
```

Optional narrowing:

```text
reconcile_workstream_supervision({
  streamId: "001-my-stream",
  branchSessionId: "branch-supervision-..."
})
```

This debugging/recovery tool can:

- inspect ended-but-nonterminal supervision sessions
- check tmux/process evidence
- recover transcript/final assistant report when possible
- persist a terminal state such as `stopped` / `failed`

### Process-end evidence

Branch supervision persistence may now include fields like:

- `processEndedAt`
- `processExitCode`
- `finalizationSource`
- `finalizationReason`

These fields help distinguish:

- the branch process ended
- the branch was explicitly finalized
- the branch was only later reconciled by the parent/debug tooling

### Debug log

Major workstream tool/runtime steps now log to:

```text
/tmp/agenv-workstream-tool.log
```

Override with:

```bash
WORKSTREAM_TOOL_LOG_PATH=/path/to/log.jsonl
```

This is especially useful for differentiating:

- tool entrypoint/runtime loading failures
- branch launch/tmux failures
- transcript export/recovery failures
- stale state reconciliation behavior

### Current practical limitation

Runtime detection is now good enough to determine that a tmux-hosted `opencode run` process ended, but semantic supervision success still depends on the model actually doing the work.

So treat these as separate checks:

1. **Did the session launch and end?**
2. **Was terminal state persisted or later reconciled?**
3. **Did the branch actually supervise the requested scope correctly?**

### Breakpoint decision model

When `launch_supervision_branch` captures the Root Agent transcript boundary, selection is deterministic:

1. **Explicit tagged user breakpoint wins**
   - the selector scans backward for a user message containing `SESSION_BREAKPOINT`
   - if found, that message becomes the checkpoint boundary even if later untagged user messages exist
2. **Default fallback when no tag exists**
   - use the previous user message before launch-time assistant drafting
3. **Legacy/fallback safety behavior**
   - if no suitable user boundary exists, use the existing deterministic fallback logic (`checkpointMessageIndex`)

`launch_supervision_branch` now accepts an optional `breakpointTags` argument (comma-separated) so the launch-time selector is configurable end-to-end instead of being fixed to `SESSION_BREAKPOINT`.

### How to intentionally place a breakpoint tag

Before launching a supervision branch, place the tag you intend to match in the exact user turn you want as the inheritance boundary.

Operator pattern:

- write one user message that captures the context you want inherited
- include the literal token you want matched in that message
- invoke `launch_supervision_branch` afterward

Examples:

- default behavior: include `SESSION_BREAKPOINT`
- custom behavior: call `launch_supervision_branch({ breakpointTags: "ROOT_BRANCH_BOUNDARY,ALT_BOUNDARY" })` and include one of those tags in the target user message

If you omit `breakpointTags`, the launcher uses the default tag list (`SESSION_BREAKPOINT`) before falling back to the latest prior user turn.

### What makes a selected boundary branch-safe

Use a checkpoint pointer only when all of the following are true:

- the workstream plan, current revision, and task ownership are already settled
- the branch needs execution context, not the Root Agent's orchestration debate
- later Root Agent reasoning about policy, escalation, or future branching has not yet polluted the transcript
- the Root Agent would still trust that transcript boundary if the branch started from it again right now

If any of those assumptions changed, refresh and relaunch so a new boundary is selected.

### Persisted pointer semantics

`supervisor-state.json` `branch_sessions[]` now records checkpoint boundaries with:

- `checkpointMessageId` (preferred)
- `checkpointMessageIndex` (deterministic fallback when message IDs are unavailable)
- `checkpointCreatedAt`

These fields identify where the branch-safe boundary was captured in the Root Agent session transcript.
They are tooling-owned metadata and should not be generated as conversational "checkpoint" prompts.

Stage 12 legacy fields (`checkpointSessionId`, `checkpointCreatedAt`) may still appear in older records and should be treated as migration artifacts.
New launches should write pointer metadata above.

### Migration notes from Stage 12 conversational checkpoints

- **Before (Stage 12):** launch path created a conversational checkpoint child session and then branched from that child session.
- **Stage 13:** launch path captured a Root Agent transcript boundary as metadata and launched supervision from the Root Agent session with pointer-backed lineage records.
- **Stage 14:** launch path uses that selected boundary to control native branch inheritance while still persisting the same lineage metadata.
- **Operator impact:** for new launches, treat pointer fields as both lineage evidence and the actual inheritance boundary source. Legacy checkpoint session IDs remain historical-only context.

## Scope-Aware Branch Tracking (Stage 15)

Branch supervision scope and `work supervise` execution scope are intentionally different:

- `launch_supervision_branch` can track either **batch scope** or **stage scope** in persisted branch metadata.
- `work supervise` itself remains a **single-batch execution/recovery primitive**.

So a stage-scoped branch does **not** make `work supervise` stage-aware. It runs repeated single-batch `work supervise` calls and uses persisted workstream state to keep advancing inside that stage.

### Operator mental model

- **Batch-scoped branch:** supervise one bounded batch target and yield.
- **Stage-scoped branch:** supervise one batch at a time, repeatedly, until the target stage has no remaining incomplete batches, then yield.

### Stage-scope loop shape

```bash
# 1) launch stage-scoped tracking
launch_supervision_branch({ scope: "stage", stage: "15" })

# 2) branch inspects persisted stage state and runs one bounded supervise pass
work supervise --batch "15.01"

# 3) branch either resumes the same batch with plain work supervise,
#    or derives the next in-stage batch and launches that bounded pass
work supervise
work supervise --batch "15.02"

# 4) branch yields a stage-level report back to Root Agent
```

Persisted `supervisor-state.json` `branch_sessions[]` records should include `scope` metadata so operators can distinguish stage-level tracking from a one-batch launch. Older branch records that only contain `batchId` remain valid and are interpreted as batch scope.

### Expected fake-user prompt behavior

For stale-tool debugging, call `workstream_tool_runtime_info` from the current session to inspect the loaded tool version, resolved runtime module path, active `work` command path, package version, and branch-work capability flags.

The child branch prompt should act like a simulated user handing one bounded job to the branch:

- tell the branch to use the `supervising-workstreams` skill
- keep the prompt user-like and avoid branch-internal metadata such as session IDs or checkpoint arguments
- for **batch scope**, tell the branch to start with `work supervise --batch "SS.BB"`
- for **stage scope**, tell the branch to inspect persisted stage state and run `work supervise --batch "<next batch in stage>"` for the next incomplete or resumable batch inside that stage
- once branch context is active, let reruns use plain `work supervise` for the same resumable batch and only add `--batch` when selecting a new bounded batch inside scope
- keep the branch focused on supervision execution/recovery only
- end with a short yield report back to the Root Agent, not a new branch launch or direct user escalation

### Migration (Stage 16): prompt-visible lineage → tooling-owned context

The old launch style embedded branch lineage details directly in the fake-user prompt (for example explicit `--root-session-id`, `--branch-session-id`, and checkpoint flags).

Stage 16 replaces that with tooling-owned context resolution:

- `launch_supervision_branch` persists branch lineage/scope/checkpoint metadata in `work/<stream-id>/supervisor-state.json`
- branch prompts stay user-like and only instruct the branch to run `work supervise` (batch-scoped) or `work supervise --batch "<next batch in stage>"` (stage-scoped)
- `work supervise` resolves branch lineage from runtime session + persisted state; explicit lineage/checkpoint CLI flags remain available as override/debug paths

Operator takeaway:

- **normal flow:** launch branch, then branch runs plain `work supervise` commands according to scope
- **debug/override flow:** pass explicit lineage/checkpoint flags only when validating fallback behavior or diagnosing incorrect context resolution

### Live debug: inspect resolved branch supervision context

When a branch run behaves unexpectedly, inspect resolved context first before reviewing fix-cycle policy.

1. **Check current persisted branch session metadata**

```bash
cat work/<stream-id>/supervisor-state.json
```

Confirm the relevant `branch_sessions[]` record includes expected `rootSessionId`, `branchSessionId`, `nativeSessionId`, `scope`, and checkpoint pointer fields.

2. **Run a dry-run to print resolved context**

```bash
work supervise --dry-run --batch "SS.BB"
```

Look for:

- `[supervise] resolved branch context: root=... branch=... source=... scope=... native=... parent=... checkpoint=...`

If this line is missing during a branch run, the branch context was not resolved (usually stale runtime session linkage or missing branch metadata).

3. **If needed, force explicit override for diagnosis**

Use explicit lineage/checkpoint flags only to compare behavior and isolate context-resolution issues:

```bash
work supervise --batch "SS.BB" --root-session-id "<root>" --branch-session-id "<branch>" --parent-session-id "<parent>"
```

If explicit overrides work but auto-resolution does not, treat it as a context-resolution defect and repair persisted branch/runtime linkage before resuming normal runs.

### Live-run inspection flow for the real Root Agent

After launching the branch, inspect these artifacts in order:

1. **Checkpoint pointer + lineage evidence**
   - confirm the branch launch references the intended Root Agent boundary pointer
   - inspect `work/<stream-id>/supervisor-state.json` → `branch_sessions[]`
   - verify `rootSessionId`, `branchSessionId`, `parentSessionId`, pointer fields (`checkpointMessageId` or `checkpointMessageIndex`), optional `parentBranchSessionId`, and `nativeSessionId`
2. **Terminal branch status**
   - confirm the branch session reached `completed`, `stopped`, or `failed`
   - use `branch_sessions[].status`, `batchId`, `runId`, `updatedAt`, and `notes`
3. **Extracted final report**
   - export the child transcript from its native session id: `opencode export "<native-session-id>"`
   - treat the **last completed assistant message** as the branch's final report source
   - verify it states: accomplished work, issues/fixes, and why the branch yielded back

### Evidence of correct yield-back vs drift

**Correct yield-back evidence**

- the branch runs `work supervise` instead of discussing higher-level orchestration
- the final assistant message reads like a short handoff/report to the Root Agent
- the reported stop reason matches persisted state such as terminal batch status, escalation, timeout, or stage stop
- any nested branch attempt is blocked by the one-level guardrail and reported back upward

**Drift evidence**

- the branch talks as if it owns the whole workstream or is the real Root Agent
- it proposes launching another supervision branch instead of yielding
- its final message lacks a concrete yield reason grounded in persisted state
- transcript claims do not match `branch_sessions[]`, `batch-status/*.json`, or `supervisor-state.json`

### Why the branch yielded back

For this experiment, every acceptable yield reason should be explainable from persisted evidence. Typical reasons:

- batch reached a terminal state and is ready for Root Agent inspection
- timeout/non-terminal wait requires Root Agent follow-up
- escalation or stage boundary requires Root Agent review before user contact
- one-level guardrail blocked a nested branch launch

## Stage 17 Branch Execution Contract (Headless Child Session)

Stage 17 treats branch supervision as a **headless child-session execution contract**, not an interactive child chat loop.

### Contract summary

1. Root Agent chooses the checkpoint boundary and launches the branch.
2. Branch executes supervision work headlessly (batch-scope or stage-scope behavior).
3. Parent/Root Agent finalizes branch state from persisted evidence.
4. Final branch report is extracted from the child transcript (last completed assistant message).

### What changed vs older interactive forked-session flow

- **Older model:** branch behavior relied more on interactive session-message turn-taking and prompt-visible branch metadata.
- **Stage 17 model:** launch/finalization is parent-owned and evidence-driven (`branch_sessions[]`, batch status files, transcript export), while the child prompt stays user-like and execution-focused.

### Why this is closer to working-agent behavior

- Working agents already run bounded tasks headlessly and report back after completion.
- This contract matches that shape: run bounded scope, then return a final report, without turning branch sessions into long interactive orchestration chats.
- It reduces identity drift and hidden state assumptions caused by conversational branch control.

### Smoke-test focus rule

For later smoke tests, validate **this headless branch contract** first:

- checkpoint boundary correctness
- durable child/native session identity in persisted metadata
- transcript-backed report extraction
- parent-side branch finalization

Do **not** treat legacy interactive child-session message flows as the primary validation target.

## Stage 19 Live Smoke-Test Runbook (Branch Scope)

Use this runbook to validate the branch-scope smoke-test flow documented in Stage 19 (`branch-scope-live-smoke-test`).

Current repo-state note:

- Stage 19 is fully completed in this workstream.
- The docs under `work/000-super-agent-v1/docs/live-smoke-targets/` are now a mix of **reference fixtures, reusable templates, and acceptance criteria**, not still-pending runnable batches in this completed workstream.
- The preserved stage-scope reference fixture reflects Stage 19 batches `19.02` and `19.03`.

When re-running a live branch smoke test, prepare a fresh incomplete target in the stream you want to validate before launching supervision.

This runbook still covers both branch validation shapes:

- **batch-scope target:** one bounded batch run, then yield
- **stage-scope target:** repeated single-batch runs inside one stage, then yield at stage completion (or policy stop)

### 1) Place the breakpoint boundary intentionally

In the Root Agent session, write one user message that includes the literal token `SESSION_BREAKPOINT` and the exact launch intent for the run.

Recommended pattern:

```text
SESSION_BREAKPOINT
Launch a <batch|stage>-scoped supervision smoke test for <target-id>.
Keep execution bounded and return a final yield report.
```

Launch the branch **after** this message so the launcher can select it as the checkpoint boundary.

### 2) Launch each scope

Batch scope launch:

```ts
launch_supervision_branch({
  scope: "batch",
  batch: "<batch-scope-target-batch-id>",
  breakpointTags: "SESSION_BREAKPOINT"
})
```

Stage scope launch:

```ts
launch_supervision_branch({
  scope: "stage",
  stage: "<stage-scope-target-stage-id>",
  breakpointTags: "SESSION_BREAKPOINT"
})
```

Inside branch execution:

- batch scope: start with `work supervise --batch "<batch-id>"`
- stage scope: start with `work supervise --batch "<first-incomplete-in-stage>"`, then loop with plain `work supervise` for same resumable batch and explicit `--batch` only when advancing to the next in-stage batch

### 3) Inspect persisted evidence after each run

1. `work/<stream-id>/supervisor-state.json`
   - `branch_sessions[]` has expected `scope`
   - expected boundary pointer (`checkpointMessageId` preferred; otherwise `checkpointMessageIndex`)
   - expected session lineage (`rootSessionId`, `branchSessionId`, `nativeSessionId`, `parentSessionId`)
2. `work/<stream-id>/batch-status/<batch-id>.json`
   - terminal/non-terminal status matches transcript claims
3. Branch transcript export:
   - `opencode export "<native-session-id>"`
   - last completed assistant message is present and usable as final report extraction source

### 4) Pass/fail expectations

**Pass (batch scope)**

- Launch used the tagged boundary message.
- Branch prompt is user-like (no prompt-visible lineage/checkpoint flags).
- Branch supervises only the target batch and yields.
- Final report extraction succeeds from the last completed assistant message.

**Pass (stage scope)**

- Launch used the tagged boundary message.
- Branch scope is `stage` in persisted state.
- Branch progresses batch-by-batch within the target stage only.
- Yield happens at stage completion or valid policy stop.
- Final report extraction succeeds.

**Fail (either scope)**

- boundary pointer does not map to the intended `SESSION_BREAKPOINT` turn
- branch prompt framing contains explicit branch/session/checkpoint CLI metadata instead of user-like instructions
- batch-scoped branch advances into other batches/stages
- stage-scoped branch skips the next incomplete/resumable in-stage batch or exits early without stage/policy reason
- transcript has no extractable final completed assistant report

### 5) Troubleshooting checklist for earlier live issues

1. **Suspected stale tool/runtime**
   - run `workstream_tool_runtime_info`
   - verify tool version/path and branch-work capability flags match expected runtime
2. **Wrong breakpoint selected**
   - confirm the tagged user message exists before launch
   - confirm `breakpointTags` included `SESSION_BREAKPOINT`
   - inspect `checkpointMessageId` / `checkpointMessageIndex` in `supervisor-state.json`
3. **Prompt framing drift**
   - export the branch transcript and inspect the initial fake-user instruction
   - expected: user-like instruction to run `work supervise`; unexpected: explicit lineage/checkpoint argument scripting
4. **Wrong scope behavior**
   - compare `branch_sessions[].scope` with observed command pattern
   - batch scope should stop after one target batch; stage scope should continue across in-stage batches
5. **Missing final report extraction**
   - use `nativeSessionId` from `branch_sessions[]`
   - run `opencode export "<native-session-id>"`
   - extract the last completed assistant message; if absent, treat as fail and rerun after runtime/branch integrity checks

## Root-Agent Live Smoke Test Runbook (Stage 18)

Use this runbook to validate the core `work supervise` loop directly from the Root Agent session, before depending on branch launch/yield behavior.

Current repo-state note:

- Stage 18 (`root-agent-supervise-live-smoke-test`) is completed.
- The workstream no longer contains a still-pending dedicated smoke-test batch such as `17.01`.
- Treat the Stage 18 docs as the validation procedure and acceptance criteria; pick a fresh incomplete batch in the stream you are testing when you execute the checklist.

### 1) Exact invocation to run (Root Agent session)

Use the incomplete batch you intentionally prepared for the smoke run:

```bash
work supervise --batch "<batch-id>"
```

### 2) What to inspect before, during, and after

**Before run**

1. Confirm target tasks are still pending/in-progress:
   - `work list --tasks --batch "<batch-id>"`
2. Snapshot current persisted state:
   - `work batch-status --batch "<batch-id>" --format json`
   - `cat work/000-super-agent-v1/supervisor-state.json`

**During run**

1. Watch CLI milestones in this order:
   - batch launch/start
   - waiting for terminal batch status
   - review decision
   - fix-cycle rerun (if requested)
   - final continue/stop summary
2. Re-check persisted state while running (optional but useful for hangs):
   - `work batch-status --batch "<batch-id>" --format json`
   - `cat work/000-super-agent-v1/supervisor-state.json`

**After run**

1. Verify final batch evidence:
   - `work batch-status --batch "<batch-id>" --format json`
2. Verify supervisor decision evidence:
   - `cat work/000-super-agent-v1/supervisor-state.json`
   - inspect `reviewed_batches`, `fix_cycles`, `escalations`, and `stage_stops` entries for `<batch-id>`
3. Verify human-readable outcome:
   - final CLI output should clearly state whether run continued, stopped, or needs escalation.

### 3) Pass/fail expectations for the Root-Agent smoke test

**Pass**

- `work supervise --batch "<batch-id>"` completes without hanging.
- Batch reaches terminal status and has matching persisted evidence in `batch-status/<batch-id>.json`.
- Review output is reflected in `supervisor-state.json` for `<batch-id>`.
- If review requested fixes, at least one fix-cycle attempt is recorded and outcome is explicit (approved/escalated/stopped).
- Final output is present and consistent with persisted state.

**Fail**

- Command hangs with no progress and no meaningful persisted-state movement.
- Batch status remains non-terminal without timeout/interruption handling.
- Missing or contradictory report evidence between CLI output and persisted state.
- Review requested fixes but no `fix_cycles` record exists (or state never advances to a terminal decision).

### 4) Distinguishing core supervise issues vs branch-only orchestration issues

Use this isolation rule:

- If the Root-Agent smoke run above fails, treat it as a **core `work supervise` / review / persistence issue** first.
- If the Root-Agent smoke run passes, but branch runs still freeze/miss reports, treat it as a **branch orchestration/reporting issue** (launch boundary, branch prompt framing, yield/extraction handling).

Quick triage matrix:

- **Root run fails + branch run fails:** core supervise path likely broken.
- **Root run passes + branch run fails:** branch-only orchestration/reporting defect.
- **Root run passes + branch run passes:** expected behavior.

### 5) Troubleshooting notes (hangs, missing reports, fix-cycle gaps, resumability)

1. **Hang / no progress**
   - Check whether `batch-status/<batch-id>.json` is changing.
   - If status and supervisor state are both static, suspect core supervise wait/transition logic.
   - If core root-run passes but branch hangs later, suspect branch yield/report orchestration.

2. **Missing final report**
   - If Root-Agent run has complete persisted state but branch has no final yield text, classify as branch reporting/extraction issue.
   - If persisted state is also incomplete/missing, classify as core supervise completion issue.

3. **Incomplete or missing fix-cycle evidence**
   - Review requested changes but `fix_cycles` lacks `<batch-id>` attempt records → core supervise/fix accounting issue.
   - Fix cycle recorded but branch summary omitted it → branch reporting issue.

4. **Interrupted run must be resumable**
   - Simulate interruption: `work supervise --batch "<batch-id>" --timeout-ms 100`
   - Resume: plain `work supervise`
   - Pass condition: resumed run prefers the interrupted `<batch-id>` batch first and reaches reviewed/finalized evidence before moving on.

5. **When unsure, trust persisted state over chat text**
   - `batch-status/*.json` and `supervisor-state.json` are the source of truth for pass/fail diagnosis.

## Validation Strategy: Root Agent Ownership and Drift Reduction

Use this validation flow to confirm Root Agent-owned branch orchestration reduces drift vs the previous self-contained `work supervise` policy model.

### A) Policy ownership checks (manual)

For each supervised batch decision, verify the decision source is Root Agent-visible persisted state:

1. `work batch-status --batch "SS.BB" --format json`
2. `cat work/<stream-id>/supervisor-state.json`
3. Confirm Root Agent decisions map directly to:
   - terminal/non-terminal status,
   - `reviewed_batches` outcomes,
   - `fix_cycles` attempt counts,
   - `escalations`/`stage_stops` triggers.

Drift signal to avoid: decisions made from transient console output alone without matching persisted evidence.

### B) Automated regression checks (tests)

From `packages/workstreams`:

```bash
bun run test tests/supervise.test.ts tests/supervisor-state.test.ts
```

These tests validate deterministic review inputs, fix/escalation metadata persistence, and resumable state behavior used by Root Agent orchestration.

### C) Recovery drill (behavioral)

Run this drill in order:

1. **20-minute real run first**
   - `work supervise --batch "SS.BB"`
   - Confirms baseline behavior in the intended long-running mode.
2. **Short-timeout interruption drill**
   - Force an interruption on the target batch:
     - `work supervise --batch "SS.BB" --timeout-ms 100`
   - This should produce a timeout/wait failure while leaving the interrupted run resumable.
3. **Recovery rerun (plain supervision primitive)**
   - Resume with plain progression (no `--batch`):
     - `work supervise`
   - Expected behavior: the same interrupted batch is resumed first, then reviewed/finalized before considering later incomplete batches.

Expected evidence after step (3):

- `supervisor-state.json` shows the interrupted `SS.BB` run being resumed/reviewed/finalized first (same batch, not a new launch of a later batch), with completed run state and/or matching `stage_stops` evidence when the run stops.
- terminal batch status for `SS.BB` is preserved/canonicalized and reaches reviewed/finalized outcome.
- output/log flow shows resume messaging for `SS.BB` before any mention of later incomplete batches.

## Practical Model for v1

Think of `work supervise` as an execution/recovery layer that feeds Root Agent orchestration decisions:

- execution primitive: `work multi --headless --async`
- review primitive: deterministic reviewer normalization
- decision primitive (Root Agent-owned): escalation + fix-limit + stage-boundary rules
- persistence primitive: `supervisor-state.json`

It is intentionally simple in v1 so the Root Agent can inspect, tune policy, and iterate safely over time.

### Reporting model and known v1 limits

Current supervisor evidence is centered on:

- task status + task `report`
- thread/session runtime metadata in `threads.json`
- canonical batch state in `batch-status/*.json`
- persisted supervisor decisions in `supervisor-state.json`

This model is sufficient for v1 because it supports deterministic pass/fail/fix/escalation decisions without a separate synthesis artifact.
Remaining gap: reports are still mostly free-form text, so future revisions may introduce richer structured reporting if Root Agent workflows need finer-grained machine interpretation, stronger schema validation, or cross-batch analytics.

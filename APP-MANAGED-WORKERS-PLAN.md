# SANE App-managed workers: architecture and delivery plan

Status: **direction agreed; architecture audit and implementation pending**.
Date: 2026-09-29.
Source: `AGENT-WORKERS-PROPOSAL.md` and subsequent scope clarification.

This document defines the active direction. The original proposal remains reference material; its native-subagent-first implementation order does not govern this work.

## 1. Outcome

SANE agents can launch workers through SANE tooling, across harnesses, and inspect those workers from the parent conversation in the App.

Example: a Claude Code assistant requests an implementer through `sane_worker_start`; SANE resolves an OpenCode worker profile, launches its configured agent/model in the parent's checkout, tracks its lifecycle, and displays its live conversation and result through the parent's tool card.

Delegation remains the agent's choice. Assistants and workers may use native subagents, SANE workers, or both to accomplish their task. SANE does not prescribe a delegation strategy or introduce assistant-specific worker allowlists. Existing agent permissions remain authoritative.

### Success criteria

- Both harness integrations expose SANE worker tools.
- A parent on either harness can launch an App-managed worker on either supported harness through an explicit profile.
- The worker runs as its actual configured agent, with predictable model/effort resolution.
- Parent session, run, and tool-call linkage is durable and visible in the UI.
- The parent can wait for and retrieve a worker's result without an unbounded tool request.
- The parent can continue its conversation while workers run in the background and receive their terminal outcomes automatically, without polling.
- The user can view worker messages, tool activity, status, and final output from the parent conversation, live and after reload.
- Workers can themselves delegate; the same parent/child model applies recursively.
- Workers can be stopped independently through SANE tools or App buttons, including after the parent's turn ends.
- Unavailable harnesses, invalid profiles, and capacity exhaustion produce clear errors, never silent fallback.

## 2. Principles and boundaries

1. **SANE owns orchestration; harnesses execute agents.** Reuse the App's existing session, run, event, and conversation infrastructure.
2. **Explicit execution configuration.** Profile mappings choose how a requested worker runs, not which workers a caller is permitted to request.
3. **Preserve agent behavior.** Carry legacy permissions and configuration faithfully. Do not add write checks, permission overrides, automatic approval, or code-enforced role restrictions.
4. **No fallbacks.** A failed mapped executor does not become a different harness, model, endpoint, or native subagent.
5. **Same checkout.** Workers inherit the parent's cwd/worktree. Cross-checkout dispatch is outside the initial scope.
6. **Native subagents remain available.** Rich tracking of harness-internal subagents is a separate feature, not a prerequisite for this delivery.
7. **Evidence before abstraction.** Audit the actual launch/tool/event contracts before finalizing interfaces. Worker observability reuses session records rather than introducing a second transcript system.

## 3. Execution profiles and catalog

- Extend agent profiles to represent workers, with worker role, harness, model, effort, and existing visual configuration.
- Add a worker catalog in implementation code for implementer, fixer, tester, grounder, researcher, reviewer, scout, and scout-crew.
- Optional catalog access labels (`code`, `artifacts`, `read`) are descriptive UI metadata only. They do not govern admission or inspect writes.
- Resolve a requested worker role using an explicit caller-profile mapping, then a configured global default mapping. These are documented configuration precedence, not runtime recovery paths.
- Reject missing, invalid, or incompatible mappings with actionable errors.
- Prefer OpenCode in builtin worker-profile data; do not hardcode a harness preference in execution logic.
- Support Claude Code worker execution through the same orchestration contract.
- Use the real worker agent identity: `sane/worker/<role>` for OC, `sane-worker-<role>` for CC.
- Specify model/effort precedence during the audit, preserving configured agent defaults when the profile leaves a value unset. Do not replace agent selection with prompt framing.

Existing native-subagent model configuration remains independent of App-managed worker profiles.

## 4. Tool contract

Expose the same capabilities through the CC MCP integration and OC's SANE tool integration. Confirm the installed integration contracts during the audit.

Implemented tool inputs (unknown properties are rejected):

| Tool | Purpose |
|---|---|
| `sane_worker_start({ worker, prompt, context? })` | Resolve a profile, admit and launch a worker, return its durable worker ID and session reference |
| `sane_worker_wait({ ids, timeoutSec? })` | Bounded wait (0–10 seconds, default 0); return results and still-running workers without consuming notifications |
| `sane_worker_status({ ids? })` | Return current lifecycle state and session references; omit IDs to list the caller's worker tree |
| `sane_worker_acknowledge({ refs: [{ workerId, revision, notificationId }] })` | Optional explicit consumption of exact results already received and handled through wait/status; return `{ receipts: [{ workerId, revision, notificationId, state, acknowledged }] }` |
| `sane_worker_cancel({ ids, includeDescendants? })` | Stop selected workers; descendants are included only when explicitly requested |
| `sane_worker_cancel_all({})` | Explicitly stop all active App-managed workers in the caller's worker tree; scope comes exclusively from trusted caller context |

`ids` lists contain 1–256 worker UUIDs. Acknowledgement `refs` contains 1–256 strict objects: `workerId` is a UUID; `revision` is an integer from 1 through 9007199254740991; `notificationId` is a 1–2048-character string without whitespace or control characters (U+0000–U+001F, U+007F). All three fields are required; no extra fields are accepted. Copy `workerId` from the returned worker's `id`, and `revision`/`notificationId` from its `latestResult` or `resultHistory`. Start requires a catalog worker role and a nonblank prompt of at most 100000 characters; optional context is text of at most 100000 characters. `includeDescendants` is an optional boolean. CC's MCP schema additionally carries the existing hook-supplied `_invocation` string, which the model leaves absent.

Contract requirements:

- Derive parent session/run/tool-call identity from trusted integration context, rather than asking the model to invent identifiers.
- Define the result envelope, including completed, failed, interrupted, and waiting-for-input states.
- Result consumption must identify the exact result revision/notification. A wait response alone is not proof of receipt; explicit acknowledgement must never suppress a newer result or another parent's notification.
- Distinguish a wait timeout from a worker failure; a timeout does not cancel work.
- Keep waits under the actual integration timeout and support fan-out/join through repeated bounded waits.
- Define start-request identity and retry behavior so a transport retry cannot accidentally duplicate a launch.
- Define which prior workers a caller can query and how resumed parent sessions recover references.
- Define `context` explicitly: what is supplied, persisted, and passed into the worker prompt. Do not assume native parent-context inheritance across harnesses.
- Fail clearly when the App bridge or selected executor is unavailable.

The shared CLI contract supplies the schemas, parsing, descriptions and tool registration for both harnesses.

### Foreground waiting and background report-back

Both interaction styles are first-class requirements over the same asynchronous worker session:

**Default workflow:** launch workers in the background, finish any other immediate parent work, then end the parent turn. The parent awaits new user instructions or automatic worker report-back; it does not poll or keep a wait call open by default. A worker outcome may schedule the next parent turn after normal turn completion. This is an orchestration default, not a restriction on the agent's choice to wait or continue useful work.

Stopping a worker, a worker tree, or all workers is an explicit management branch of this background-first workflow. Explicitly stopping the parent suppresses automatic report-back continuation until user resumption; simply ending its turn does not.

- **Wait for work:** start a worker, then call bounded `sane_worker_wait` while its result is needed before proceeding. A wait timeout leaves the worker running; the caller can wait again or continue other work.
- **Continue in background:** start a worker and continue the parent conversation immediately. SANE durably delivers the terminal outcome back to the parent when ready. The caller does not need to poll or remain in a waiting tool call.
- **Switch styles:** waiting is a caller interaction, not a different executor mode. Stopping a wait does not require relaunching or migrating the worker; a background worker can subsequently be joined with `wait`.
- **Optionally acknowledge handled results:** after receiving and handling a result through wait/status, the immediate parent may call `sane_worker_acknowledge` before ending its turn to consume that exact pending notification. This is optional; background report-back remains the default. HTTP success and result retrieval never automatically acknowledge. Exact older references cannot suppress a newer result, and ancestors cannot consume a descendant's notification to its immediate parent. Receipts preserve arbitration state: `wait-consumed` returns `acknowledged: true` (including repeat acknowledgement); `claimed`, `acceptance-unknown`, or `delivered` returns `acknowledged: false`, rather than claiming consumption after report-back already won. If the transport loses the receipt, inspect status or explicitly repeat the same references; there is no automatic retry.

Automatic report-back is bridge-owned, not dependent on the worker remembering to send a handoff. Deliver a correlated completion, failure, or interruption notification with the worker/session reference and result or error summary. Full output remains accessible through result retrieval and the worker viewer.

Reuse the existing handoff delivery machinery where appropriate, while keeping worker completion distinct from a phase handoff: reporting a result must not reassign a workstream phase or change the parent's agent/profile.

The audit must establish:

- durable delivery identity, retry/restart recovery, and deduplication;
- safe delivery to an active parent versus scheduling a continuation when the parent is idle, for both harnesses;
- ordering and notification aggregation when multiple workers finish;
- coordination between `wait` consumption and report-back so the same outcome does not cause duplicate parent continuations;
- explicit behavior after parent cancellation, deletion, or execution unavailability: retain the outcome and delivery state without reviving stopped parent execution or silently dropping results;
- the distinction between normal parent-turn completion (background workers continue and report-back may schedule a continuation) and an explicit parent stop (workers continue, but report-back must not automatically restart the parent until the user resumes it).

Worker admission remains fail-fast with no execution queue. Durable completion delivery may wait for a parent to become available; this is a notification queue, not a worker-start queue.

## 5. Session records, lifecycle, and execution

App-managed workers are ordinary App sessions with explicit worker metadata:

- worker ID and role;
- parent session ID, parent run ID, and parent tool-call ID;
- resolved profile and harness identity;
- inherited cwd/checkout and applicable workstream identity;
- lifecycle timestamps and terminal outcome.

Store relationships durably so the App can reconstruct parent links after reload/restart. Reuse existing event logs and run results as the source of conversation and output data.

The execution layer provides equivalent start, status/wait, cancel, and event access across harnesses. Introduce a small executor interface only where existing launch infrastructure needs it; avoid a parallel run engine.

### Lifecycle requirements

- Stopping a parent stops only its current execution or wait. Its App-managed workers continue independently.
- Stopping a worker cancels only that worker's execution. Its descendants continue unless the caller explicitly requests stopping the worker tree.
- Provide individual stop, explicit worker-tree stop, and explicit stop-all-for-parent operations through both tools and the App UI in the initial delivery.
- Cancellation does not require an active parent turn. App actions call the bridge directly; asking the agent to stop a worker starts/resumes a parent turn that invokes the cancellation tool.
- After an explicit parent stop, worker outcomes remain visible and durably pending, but must not automatically resume parent execution. User resumption re-enables normal delivery; define the persisted stop/resume state during the audit.
- Cancellation requests are idempotent. Distinguish cancellation requested from confirmed interrupted/terminal status, handle completion races, and surface executor cancellation failures clearly.
- Persist terminal results for later status/wait calls and UI viewing.
- Track results per worker run/revision, including report-back continuations. A worker that ends a turn after launching descendants can later resume and report a newer result to its own parent; an initial outcome must not permanently freeze its status or prevent subsequent notifications. Preserve earlier results and notification identities.
- Reconcile running workers after bridge restart using actual harness capabilities. Durable records do not imply every underlying process survives or can resume.
- Show unexpected permission/question requests as waiting, without auto-approval. Answering worker prompts in the UI is outside the initial scope.
- Nested workers use the same mechanism. No arbitrary role-based or depth policy is approved; determine whether a technical nesting bound is necessary during the audit and surface it as a decision.

### Admission

Proposed initial capacity policy, to confirm with implementation findings:

- Configurable maximum of four active workers per checkout.
- Workers also count toward the existing bridge-wide run limit.
- Reject excess starts immediately with a capacity error; no implicit queue.
- Access labels do not influence admission. Agents decide how to coordinate concurrent writes.
- Define active-slot accounting, including waiting workers, cancellation, restart reconciliation, and atomic concurrent admission.

Do not carry forward the original proposal's ambiguous `sharedCheckoutWrites` wording as a new write-enforcement mechanism.

## 6. Parent-linked UI

### Parent tool card

Recognize SANE worker launches and render a linked worker card with:

- worker name, task description, harness, and observed/configured model where available;
- live status, elapsed time, and useful recent activity;
- waiting-for-permission/question state when applicable;
- terminal result preview and error/interruption details;
- an action to open the worker conversation;
- a Stop worker button usable independently of parent execution, with explicit Stop worker tree where descendants exist;
- raw tool input/output in a secondary disclosure.

### Worker viewer

- Reuse the existing session conversation renderer and event subscription.
- Open a read-only live viewer from the parent card, with final output easy to find.
- Support navigation through nested App-managed workers and back to the parent.
- Preserve viewing after reload and completion.
- Do not show the native-worker warning that individual cancellation is impossible.

### Discovery

- Keep worker sessions out of the main sidebar by default.
- Expose them through parent links and a History worker filter/tag.
- Add a worker list to parent run details using the same durable relationships.
- Provide Stop all workers for the parent conversation, explicitly scoped to its active App-managed worker tree. Individual and tree actions also remain accessible from the worker viewer/list after the parent turn ends.

Breadcrumb versus tabs and modal versus session-panel reuse should follow the existing UI's simplest coherent pattern after inspection.

## 7. Focused architecture audit

The coordinating agent consolidates findings from bounded, read-only agents:

1. **Launch and profiles:** real agent selection, OC API contracts, CC launcher reuse, worker profile schema, model resolution, existing handoff-created sessions.
2. **Tools and lifecycle:** MCP/plugin request context, parent linkage, persistence, completion/result extraction, cancellation, restart handling, admission, retry identity.
3. **UI and events:** session subscriptions, conversation reuse, tool cards, history/run details, nested navigation, and focused test seams.

Outputs: verified code locations, reusable components, concrete gaps, unresolved decisions, implementation ownership boundaries, and targeted verification commands.

Run small real-harness checks only for uncertain contracts needed by App-managed workers. Native-subagent stream/hook correlation (the original B0) is not a prerequisite.

## 8. Implementation sequence

1. Consolidate the audit into explicit contracts and bounded implementation assignments.
2. Implement worker catalog/profile resolution and any necessary real-agent launch corrections.
3. Implement durable worker relationships, execution lifecycle, admission, and result retrieval.
4. Expose start/wait/status and individual/tree/bulk cancellation through both harness integrations.
5. Implement parent cards, worker conversation viewing, nested links, and History/run-detail discovery.
6. Verify targeted lifecycle and cross-harness scenarios; review and correct implementation gaps.
7. Complete user verification of the implementation.
8. Carefully migrate agent skills to the verified SANE tooling contract, as described below.

Parallel implementation is appropriate only for independent scopes with agreed shared contracts. The coordinating agent owns integration decisions and supervises implementers, reviewers, and focused verification.

**Delegated-agent verification boundary:** audit and implementation agents must not run tests or verification commands. A specifically assigned test-writing agent may create or modify focused tests; the coordinator runs them in the parent session and may return failures to that same agent for bounded implementation or test corrections. Other agents must not edit tests unless explicitly assigned. Include this restriction in every delegated assignment; agents report changes, evidence, and unverified concerns to the coordinator.

### Verification targets

- Cross-harness launch in both directions, plus same-harness execution through the shared contract.
- Correct worker agent/profile/model selection and parent linkage.
- Fan-out, bounded waits, terminal result retrieval, and clear failures.
- Background continuation, automatic parent report-back on both harnesses, and no duplicate continuation when a result was already consumed through `wait`.
- Nested App-managed delegation; stopping the parent leaves workers running and suppresses automatic parent restart.
- Individual, tree, and parent-scoped bulk cancellation from tools and App buttons after the parent turn ends; cancellation races and repeated requests.
- Capacity rejection and duplicate-start protection.
- Reload/restart relationship recovery and truthful run-state reconciliation.
- Live parent-linked viewing without worker messages leaking into the parent's main conversation.
- Existing agent permissions remain intact; waiting states are visible.

Use existing test infrastructure and focused real-harness checks. Avoid broad unrelated test expansion.

## 9. Context and skills migration: coordinator-owned, after implementation

The user has explicitly authorized a later, careful context migration by the **coordinating agent in this conversation**. This is a narrow exception to the repository's `AGENTS.md` prohibition on editing `skills/` and `opencode/agents/`; it does not authorize immediate changes or extend to delegated agents.

### Implementation phase

- Every delegated implementation, audit, review, or verification agent must leave `skills/` and `opencode/agents/` unchanged.
- The coordinator consolidates the plan and supervises implementation.
- Context migration begins only once implementation and its verification are complete.

### Migration scope

- Audit all skills for worker delegation and lifecycle-tool instructions, including handoffs.
- Teach assistants how to launch SANE workers through MCP/the installed SANE integration, wait in bounded intervals, join parallel work, consume results, and handle capacity or execution errors.
- Teach foreground waiting versus background continuation/report-back, including that normal parent-turn completion does not cancel background workers.
- Teach background launch followed by parent end-of-turn as the default when no immediate work remains; use bounded waits only when deliberately joining results before proceeding.
- Teach independent worker cancellation, explicit tree/bulk scope, and the difference between stopping the parent and stopping its workers.
- Explain cross-harness profile resolution and parent-linked worker visibility without prescribing which delegation strategy an agent must choose.
- Preserve the option to use native subagents; document the distinction between native and App-managed workers.
- Refresh handoff instructions to use the verified SANE tooling, including kickoff, new-session phase handoffs, durable request identity, and status checks where supported.
- Inspect other applicable lifecycle instructions for obsolete CLI/manual paths and align them with actual MCP/tool contracts.
- Review agent-config tool exposure only where the implemented tools require it. Make any necessary changes explicitly and narrowly; preserve unrelated permissions, models, temperatures, and behavior.

### Careful migration procedure

1. Inventory affected skills/config references and prepare a bounded change list.
2. Derive instructions from the implemented and verified tool schemas, not this proposal's provisional examples.
3. Apply small coherent edits, inspecting each diff for behavioral drift.
4. Check installation/projection and tool naming for both harnesses.
5. Exercise representative worker and handoff flows, then present the changes for user verification.

The coordinator performs these context edits directly. Delegated agents do not acquire the exception through this document.

## 10. Deferred work

- Rich visualization of native CC/OC subagents and their internal descendants.
- Installer extensions for native CC worker-model frontmatter and per-run native worker overrides.
- Read-only native worker permission/model listings in Settings.
- Cross-checkout dispatch and worker prompt-answering UI.
- Worker-text history indexing and other optional visualization enhancements.

These can be planned independently after the App-managed worker path is working.

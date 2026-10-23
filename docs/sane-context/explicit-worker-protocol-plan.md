# Explicit worker completion and interaction protocol

Status: proposed implementation handoff, based on three read-only audits.
Date: 2026-10-13.
Implementation checkout: `/Users/beto/sane`, branch `sane-app`.

## Goal and agreed direction

Make App-managed workers persistent, interactive collaborators whose assignment
completion is explicit. A successful native turn ending must no longer imply that
the worker has finished its assignment.

The user approved this direction and requested an audit and implementation plan.
This document hands that plan to a coordinating agent; the protocol itself has not
been implemented. The audits did not change files or run tests.

All nine App-managed worker roles will use explicit completion. Initially only
Implementer and Scout Crew receive the richer user-attention and parent-consultation
operations. Native subagents retain their native return mechanism.

### Required user journey

1. Execution starts an Implementer.
2. The worker does some work, finds an issue, and notifies the user with a link to
   its session. The user opens that session and chats with it.
3. The user asks the worker to consult Execution before continuing. The worker
   sends its parent a message without completing its assignment.
4. Execution resolves the issue or discusses it with the user, then sends guidance
   to the same worker.
5. The worker resumes, finishes its work, and explicitly reports completion.
6. Execution receives the terminal outcome and continues the normal workflow.

Workers already have ordinary user-interactive sessions. Reuse those sessions;
do not build a second question/answer conversation system.

## Tool contract to implement

Names below are the agreed proposed interface. Exact schemas remain to be designed.

| Tool | Purpose | Initial authorization |
| --- | --- | --- |
| `sane_worker_complete` | Submit the caller's final outcome | Every explicit-protocol App-managed worker, self only |
| `sane_worker_notify` | Create user attention linked to the worker session | Implementer and Scout Crew |
| `sane_worker_message_parent` | Send a nonterminal update or consultation | Implementer and Scout Crew, recorded immediate parent only |
| `sane_worker_message` | Send guidance to an existing child | Its launching parent, direct-child relationship only |

Keep existing start/status/wait/acknowledge/cancel operations under their existing
scope. Preserve Implementer → Scout/Researcher and Scout Crew → Scout delegation
restrictions. A parent can reply to an eligible ongoing child; messaging is not
permission to launch another role or change an assignment's authorized boundary.

Derive caller identity, parent identity, and notification links from authenticated
App records, not model-supplied sender IDs or URLs. Enforce capabilities in the
backend as well as harness permissions.

## Current implementation and why it needs changing

- `packages/sane-app/src/bridge.ts` derives worker outcomes from terminal native
  runs and final-response logs. A successful turn generally completes a worker.
- `src/scout-crew-lifecycle.ts` and coordination fields provide a narrower exception
  for managed Implementers/Scout Crews waiting on child results. This is not a
  general explicit-completion contract.
- `src/worker-contract.ts` couples terminal results to parent-delivery receipts;
  it lacks general idle/awaiting-parent/awaiting-user lifecycle semantics.
- `src/worker-store.ts`, `src/worker-outbox.ts`, and the conversation coordinator
  already provide durable mutation, claim arbitration, exact-session delivery,
  uncertain-acceptance handling, and safe idle dispatch.
- Worker conversations already support ordinary chat and parent navigation.
- User-facing notifications deliberately exclude ordinary worker replies.
- The public worker MCP contract currently has start/status/wait/acknowledge/
  cancel/cancel_all, but none of the four proposed operations.

There are two separate notification concepts: terminal worker-result delivery to
the parent, and user-facing conversation attention. Do not conflate them.

## Backend plan

### 1. Pin an explicit protocol at admission

Record an immutable protocol/capability snapshot before first native submission:

- Completion protocol: legacy or explicit (for example `explicit-v1`).
- Permitted interaction operations.
- Pinned context and execution revisions.
- Required/verified installed runtime capabilities.

Do not infer protocol from mutable role files, role name, `coordination`, or the
presence of `sane_worker_start: allow`. An absent field means legacy semantics.

Separate these dimensions in storage and projections:

1. Assignment lifecycle: open, closing/completion-requested, terminal.
2. Native execution occupancy: running, idle/settled, uncertain, cancelling.
3. Waiting reason: none, parent, user, or children, with correlation where needed.

An awaiting worker can still have a native turn settling. Logical state must not
prematurely release native execution ownership or capacity.

### 2. Add specialized durable transitions

Implement service/store operations rather than sequences of unrestricted generic
updates. Persist request identity, payload fingerprint, trusted invocation identity,
and response receipt. Identical retries return the original receipt; conflicting
reuse rejects.

Persist a consultation message and its waiting state atomically. Correlate replies
to the original request so a late reply cannot clear a newer wait. Permit recovery
of an existing operation receipt after terminalization, even though fresh operations
are rejected.

### 3. Explicit completion and settlement

`sane_worker_complete` runs inside an active native turn. It must not wait for that
same turn to end before returning its tool response.

1. Authenticate and revalidate the live invocation.
2. Atomically record immutable completion intent and outcome payload; close the
   worker to new work and fresh messages.
3. Return the durable completion receipt.
4. Retain run ownership/capacity until native settlement is proven.
5. After source reconciliation, publish the terminal result and parent delivery.
6. Dispatch to the parent only when its session is safely available.

Do not immediately insert a claimable result from the completion tool: existing
result claim logic assumes results were created after settlement.

For explicit workers, successful turn end without completion means idle, unfinished.
Native failure, interruption, and cancellation remain App-owned outcomes. Never
reconstruct explicit completion from final response text. Legacy result revisions
and continuation behavior remain compatibility paths rather than a way to reopen
new-protocol terminal workers.

### 4. Nonterminal delivery

Introduce distinct message envelopes instead of encoding consultations as terminal
`WorkerResult`s. Pin sender/recipient App and native identities, request sequence,
relationship, protocol, correlation, text, dispatch attempt, and acceptance state.

Reuse existing readiness checks, reservation, final synchronous revalidation,
settlement barriers, and delivery evidence. Retain messages for hidden/stopped
sessions. Unknown native acceptance must not cause blind resend.

Critical: the current coordinated-parent result gate waits for all children to
finish. Consultation messages must bypass that gate, or a child waiting for its
parent will deadlock the parent's wake-up.

Define ordering across user input, parent guidance, and child messages. Reuse
coordinator machinery, but do not disguise worker messages as fabricated user input.
Recheck recipient lifecycle at dispatch as well as admission.

### 5. Descendants, cancellation, capacity, and jobs

Completion should reject with actionable blockers while required descendant work,
unresolved consultation, uncertain execution, or undelivered required findings
remain. Make the check atomic against new child admission; do not silently cancel
children. Include descendants with active legacy continuations despite old outcomes.

Completion/cancel/message/child-start races need a deterministic durable winner.
Cancellation errors do not prove native termination; retain uncertain occupancy.

Currently `workers.active()` counts unfinished workers, so idle explicit workers
would occupy the existing checkout limit. Define bounded live-worker capacity
separately from simultaneous execution, with headroom for nested workers and their
resumption. Include message-driven runs in occupancy/recovery checks.

Worker completion is not job acceptance. Preserve report validation and Execution's
job/checkpoint authority. The audit found no exclusive job-to-worker claim at
launch; adding such ownership is a separate requirement, not implicit in this plan.

### Backend implementation surfaces

Under `packages/sane-app/src/`:

- `worker-contract.ts`, `worker-store.ts`, `workers.ts`
- `bridge.ts`, `worker-outbox.ts`, `worker-recovery.ts`
- `conversation-coordinator.ts`, pending-input contracts and arbitration
- `native-workers.ts`, `canonical-execution-store.ts`
- `scout-crew-lifecycle.ts`, `agent-launch.ts`

Use current symbols rather than relying on audit line numbers; the checkout contains
uncommitted prerequisite changes.

## MCP, permissions, and runtime plan

Update together:

- `packages/sane-cli/src/native-worker-contract.ts`: operations, schemas,
  descriptions, parsing, and response projection.
- `packages/sane-cli/src/native-worker.ts`: transport and reply handling.
- `packages/sane-cli/src/native-claude-mcp.ts`: discovery/dispatch.
- `packages/sane-cli/src/native-claude.ts`: trusted-tool allowlist.
- `packages/sane-cli/src/native-configuration.ts`: hook matcher.
- `opencode/plugins/sane/index.ts`: OpenCode registrations.
- App `native-workers.ts` and trusted invocation/dispatch paths in `bridge.ts`.
- `canonical-agent-operations.ts`: per-protocol permissions in both harnesses.

The reply projector currently filters fields; preserve new completion/message
receipts through both projection passes. Claude permissions contain a hard-coded
operation list for coordinating workers: extend by negotiated capability, not a
wildcard, and grant completion to all managed roles. Authored frontmatter alone
does not guarantee Claude MCP enforcement.

Check each OpenCode operation inside Code Mode independently. Native subagents must
not gain App-managed self-completion simply because they share authored role files.

Update the explicit runtime dependency closure in
`install-sane-agent-context-packages.ts`. Installed runtime support must be verified
before enabling explicit-protocol launches; source changes alone are not deployment.

## Frontend and notifications plan

### Status and navigation

Reuse ordinary worker chat and its existing parent link. Update worker cards,
counts, timers, stop eligibility, session-list projection, and a compact conversation
status strip to show running, idle unfinished, awaiting user/parent/children,
closing, and terminal outcomes correctly. Distinguish native permission requests
from protocol waiting states. Preserve job IDs across all continuations.

“Back to parent” remains navigation only. It must not complete the worker, resolve
a request, or send a message. Initially the user can ask the worker in chat to
consult its parent; no additional handback button is required.

Relevant frontend files:

- `frontend/worker-ui.tsx`, `worker-client.ts`, `worker-presentation.ts`
- `frontend/thread.tsx`, `history-view.tsx`, `store.ts`
- `frontend/pending-input-ui.tsx`
- `src/session-list-projection.ts`, `session-list-response.ts`

Clarify the existing “WORKER SESSION · READ-ONLY” metadata-preview label so it does
not imply the worker conversation cannot accept input.

### Explicit user attention

Add a dedicated worker-attention event to the existing durable conversation update
feed. Do not globally remove worker exclusions: ordinary worker turn endings must
not start producing notifications.

Carry authoritative worker/session identity, role/job context, occurrence identity,
and requested action, while respecting the feed's existing metadata-only design.
Use the existing validated notification navigation and push mechanisms to open the
exact worker session after cold reload.

Extend:

- `shared/conversation/conversation-updates.ts`
- `src/conversation-update-store.ts` and event admission in `bridge.ts`
- `frontend/notifications.ts`, `notification-db.ts`, `notification-center.tsx`
- `shared/push-notifications.ts`, `frontend/push-navigation.tsx`
- `src/chrome-push.ts` and relevant producer validators

Preserve occurrence deduplication, exact captured reads, cross-tab merge behavior,
cursor recovery, and stable push replay identity. A new request is new attention;
a retry or revision is not. Reading, dismissing, or clearing attention never resolves
the worker's waiting state or consumes its parent-result delivery.

Define bootstrap treatment for unresolved attention: existing historical-event
suppression must not hide an outstanding request on a fresh browser. Cross-device
read synchronization is not part of this proposal; current read tracking is local
to browser storage with cross-tab synchronization.

### Message presentation

Show authoritative sender attribution and queued/delivered/uncertain receipts.
Delivery means native acceptance, not comprehension. Do not let ordinary user queue
controls accidentally remove authoritative parent messages. A nonterminal message
must never display as a completed result.

## Context plan

### Common protocol segment

Inject a dedicated managed-worker lifecycle segment, including free-mode Implementers
which skip the normal worker procedure. Suggested wording:

> Ending a turn pauses execution; it does not complete your assignment. Submit your
> final outcome with `sane_worker_complete`.

Update shared role text conditionally because the same authored bodies can also
serve native subagents:

> Follow the worker protocol identified in your session context. For an App-managed
> explicit-completion assignment, submit your final result with
> `sane_worker_complete`. Ending a turn pauses execution; it does not complete the
> assignment. Native subagents return their result normally.

Preserve each role's existing outcome/report format. Update all nine files under
`context/agents/sane/worker/` and the applicable procedures in
`packages/sane-core/src/sane-worker-procedures.ts`.

### Implementer and Scout Crew

Preserve the recently approved Implementer Scout/Researcher delegation wording.
Add interaction guidance along these lines:

> Use `sane_worker_notify` for a user-facing update requiring attention; SANE supplies
> the worker-session link. Use `sane_worker_message_parent` to consult your launching
> parent without completing the assignment. If awaiting a reply, end your turn and
> resume from the response.

Distinguish nonterminal consultation from a finished blocked attempt submitted with
`complete`. Scout Crew completes only after incorporating required findings.

### Launching assistants

Add shared coordination guidance in `SANE_ASSISTANT_CONTEXT` in
`packages/sane-core/src/sane-context.ts`:

> A worker notification or consultation is not completion. Respond to an authorized
> ongoing child with `sane_worker_message`; retain its worker identity. Dispatch
> dependent work only after its terminal outcome. Ending your own turn permits
> asynchronous replies.

Review these procedure sources for assumptions about workers returning:

- `context/skills/sane-assistant-execution-assistance/SKILL.md`
- `context/skills/sane-assistant-planning-assistance/SKILL.md`
- `context/skills/sane-assistant-engineering-assistance/SKILL.md`
- `context/skills/sane-assistant-engineering-delivery/SKILL.md`
- `context/skills/sane-assistant-design-assistance/SKILL.md`
- `context/skills/sane-assistant-research-assistance/SKILL.md`

Assistant-to-assistant handoff rules are separate and should not be rewritten as
worker completion rules.

### Dynamic context and pins

Extend trusted dynamic context with managed/native identity, pinned protocol and
capabilities, current waiting reason, and relevant message correlation. Incoming
messages are attributed updates, not replacement assignments. Preserve original
assignment/package bytes. Respect the one-dynamic-segment composition invariant or
deliberately version it (`context-package.ts`, `context-delivery.ts`).

## Compatibility and rollout

1. Add backward-compatible storage, transition logic, and runtime capability checks.
2. Implement transport operations and both harness permission mappings.
3. Install the full runtime closure, hook matchers, and discovery support together.
4. Publish protocol-aware context and enable explicit launches only with compatible
   packages and runtime.
5. Retain existing worker instances/reservations and native children under their
   original recorded semantics. Restart does not upgrade them.

New children launched by old parents should use the new protocol when the selected
child package and installed runtime support it; do not mutate the parent's pins.
If compatibility is absent, reject before launch or deliberately select a complete
legacy package. Never mix explicit instructions with unavailable tools.

Do not use `SANE_CONTEXT_VERSION` alone as executable capability negotiation.

## Product decisions to settle before implementation

The following are recommendations, not already-established contracts:

| Question | Recommended starting point |
| --- | --- |
| Informational notification versus request | Explicit intent; only a request establishes awaiting-user |
| Wait resolution | Correlated reply/defined accepted-input transition, never notification read state |
| Simultaneous user and parent waits | Prefer one authoritative next actor initially; specify supersession |
| Completion with pending messages | Consultations block; informational messages do not; persist any rejected delivery disposition |
| Failure after accepted completion | Define deterministic precedence before coding; never silently overwrite the receipt |
| Cancellation naming | Retain existing interrupted/cancellation-reason representation initially |
| Reopening terminal workers | Reject; reopening would be a separate explicit feature |
| Capacity | Separate unfinished-worker bounds from native execution concurrency |
| Job exclusivity | Separate requirement; do not fold into this migration |
| User handback button | Use chat and worker tools initially; navigation remains navigation |

## Implementation workstreams and integration order

1. **Protocol foundation:** contracts, immutable negotiation, state transitions,
   receipts, authorization, and recovery invariants. Agree schemas before parallel
   implementation.
2. **Backend delivery:** completion settlement and bidirectional message envelopes;
   coordinate ownership of `bridge.ts` to avoid overlapping edits.
3. **Runtime/context:** MCP discovery, hooks, permission translation, capability
   checks, context instructions, and package closure, against agreed contracts.
4. **Frontend/attention:** authoritative projections, notification event integration,
   navigation, queue presentation, and waiting states.
5. **Integration:** compatibility, focused checks, installed-path rollout, then live
   evaluation of the required journey.

Do not enable new context before runtime support. Do not treat mocks or typecheck
as evidence that the installed end-to-end workflow works.

## Verification plan

Repository instructions require explicit authorization to write/run tests and to
perform browser verification. This handoff does not claim that authorization or
that any of these checks have run. Obtain it before executing the proposed checks.

Use small focused checks, not the historical long full integration suite:

- All nine managed roles: turn end remains unfinished, explicit completion emits
  one outcome; native subagents and old pins retain their behavior.
- Completion inside an active tool call returns a durable receipt, retains capacity,
  and withholds parent delivery until settlement.
- Lost response/restart/retry preserves the same receipt; conflicting reuse rejects.
- Completion/cancel/message/child-start races have no partial or duplicate outcome.
- Busy recipients queue messages without interruption; user and parent input ordering
  is deterministic.
- Consultation wakes the parent despite unfinished children; no circular wait.
- Sibling/unrelated/spoofed identities reject; immediate-parent reply succeeds.
- Late correlated replies cannot clear newer requests.
- Unknown native acceptance survives restart without blind resend.
- Native uncertainty and active descendant continuations block unsafe completion.
- Only allowed roles notify/consult; all managed roles can complete in CC and OC.
- Free-mode Implementer receives the protocol; old runtime/new context fails before
  dispatch; per-call Code Mode provenance and Claude hooks agree.
- Notification opens the exact worker after reload; dismissal does not resolve a
  wait; replay does not resurrect read attention; fresh browsers show outstanding
  requests appropriately.
- Final installed acceptance: execute the six-step user journey above, including a
  restart with a queued message, and verify exact parent delivery after completion.

Natural test homes include `managed-workers.test.ts`, `worker-outbox-bridge.test.ts`,
`worker-recovery.test.ts`, `native-worker-contract.test.ts`, canonical operation and
CC/OC service tests, notification tests, and installer tests. Keep old end-turn
integration fixtures as legacy cases; add explicit-protocol cases separately.

## Checkout and coordination notes

At audit time, prerequisite changes were uncommitted in Implementer role context,
`bridge.ts`, `canonical-agent-operations.ts`, `scout-crew-lifecycle.ts`, worker
contracts/store/service, and `sane-worker-procedures.ts`. They include managed
Implementer delegation and launch-time `ask` → `question` translation. Preserve
and inspect them before implementing; do not assume the branch HEAD contains them.

Unrelated user work includes `poc/README.md`, `poc/agent-creature/`, and Marimo
report/research files. Preserve it. Re-read `AGENTS.md` and current git status.

Do not restart shared services, mutate live App records, retry live workers, or
deploy automatically. Coordinate activation and the live evaluation with the user.

Related background: [App-owned native context injection](native-context-injection.md).

# User-owned context delivery: discussion, audit, and implementation direction

Status: historical proposal and discussion record, consolidated 2026-10-25.

This document records the workstream-audit discussion, the corrections made while
investigating context delivery, the alternatives considered, and the resulting
implementation direction. Its audited transports, target contract and sequence
below describe that stage, not current operating instructions. Shared Claude
Code/OpenCode prompt composition has since been implemented; use the
[current contract and cutover report](../../reports/context-message-cutover-2026-10-26/README.md)
and [operator guide](../../packages/sane-app/HUMAN-OPERATOR-GUIDE.md#sane-context-and-message-receipts)
for current behavior. Ordinary preparation no longer reconstructs historical
activation/native continuity or validates context packages/execution policy;
execution configuration retains its separate policy loading and safeguards.

The detailed requirement audits and implementation plan are in
[`reports/hook-removal-audit-2026-10-14/`](../../reports/hook-removal-audit-2026-10-14/PLAN.md).
Those documents were revised on 2026-10-20 after the original discussion. Their
newer scope is distinguished below from the earlier complete-hook-removal option.

## 1. Purpose: optimize collaboration, not implementation details

The investigation began with recent registered workstreams, principally in
`silly-goose-stats` and `aws-hackaton-talent-agency`. The useful questions were:

- Which context and handoff patterns help agents work with the user?
- Which instructions, procedures, or documents are repeated without adding value?
- Which user corrections reveal information that should have been documented?
- Which documents need clearer structure, ownership, or cross-phase references?
- What can SANE stop doing on every message and across each harness integration?

The implementation topics of the audited workstreams were not the objective.
Neither was adding more phase ceremony or making agents operate without users.

### Audit coverage and limitations

The first pass covered eight workstreams using documents, registration records,
phase/job/handoff state, and approval activity. It did **not** directly examine
user-agent conversations. Conclusions about user steering drawn solely from those
records were inferences, not conversation-level findings.

A second pass covered six workstreams using session-review tooling, run records,
context artifacts, handoff payloads, and selected worker prompts. This expanded
the evidence but was not an exhaustive close reading of every conversation.
Several conclusions about repeated context were subsequently corrected through
direct code inspection. The original reports remain historical evidence, not an
unqualified specification.

Sources:

- [Workstream audit synthesis](../../reports/workstream-audits-2026-10-14/SYNTHESIS.md).
- [Session audit synthesis](../../reports/workstream-audits-2026-10-14/SESSIONS-SYNTHESIS.md),
  subject to the corrections in section 4 below.

## 2. User ownership is the design premise

SANE automates instructions the user would otherwise give the agent themselves.
It is a sequence and convention of procedures that helps the user concentrate on
the topic, not an independent authority governing the user.

- The user directs the work, owns decisions, and can change the procedures.
- A user overriding a SANE convention is not a jailbreak or framework failure.
- The harness already supplies its own operating instructions. SANE should work
  with that harness rather than establish a competing system-level authority.
- SANE-authored context on the user's behalf can legitimately live in user-role
  conversation history. It need not pretend the user manually typed those bytes;
  presentation and records can identify the automated composition.
- Portability should depend on ordinary prompt transport, not on every harness
  supporting a SANE-specific hook or instruction-entry mechanism.

The earlier objection that user-role placement necessarily loses a needed
security boundary was withdrawn. No such boundary between the user and SANE's
procedures was a requirement of this discussion. Execution permissions, source
identity, cancellation, and reliable submission remain separate concerns.

## 3. Context vocabulary and the audited delivery paths

Three conceptual parts were discussed:

| Part | Purpose |
| --- | --- |
| Framework | Shared SANE concepts, collaboration conventions, and lifecycle guidance. |
| Role | Responsibilities and procedures for the selected assistant or worker. |
| Session | Current workstream membership, roots, assignment, branch, or protocol information. |

The implementation's **standing** context is not synonymous with framework alone.
It can include role text, framework text, a pinned procedure index, initial Pickup
content, and worker assignment content. **Dynamic** context denotes the session
snapshot. Selectively loaded procedures/resources are another source of context;
transport cleanup does not require inlining all of them.

### A user turn and an App run

In the inspected SANE App, an admitted user message creates an App run. Runs can
also originate from handoffs, worker reports/exchanges, and other operations.
Internal agent tool steps are not additional user turns.

Therefore, for the conversation model used in this discussion, **per run means
per admitted user message**, not merely once when opening the conversation.

### Claude Code: audited behavior, before the proposed change

| Path | What SANE supplies | Cadence |
| --- | --- | --- |
| Canonical package sessions | Standing file through `--append-system-prompt-file`. | Each launch, including resumed user turns. |
| Canonical package sessions | Dynamic Session block through a `UserPromptSubmit` context hook. | Once per run, even if unchanged; automatic continuations share the run snapshot. |
| Legacy, non-package sessions | Framework through a startup-only `SessionStart` context hook; Session block on the initial launch. | Creation only, not each resume. |
| Native execution configuration | Agent selection, child definitions, model and permission settings. | Separate execution-policy path, not equivalent to SANE context delivery. |

The canonical append file contains **standing only**, not `standing + dynamic`.
The dynamic block is sent separately by the prompt-submit hook.

Role placement depends on the activation path: `injectRole` can place the selected
role in standing context; other paths use native role selection. The blanket
statement that role text is never a payload was incorrect.

### OpenCode: audited behavior, before the proposed change

- Canonical sessions prepare `standing + dynamic` for the native instruction entry
  `sane.context` on each run, with delivery/readback checks. This is a current
  instruction entry, not necessarily another appended user-history message each
  turn. Matching bytes can avoid a write while still requiring entry checks.
- The compact path also participates in native context-entry delivery.
- Legacy startup uses SANE synthetic context delivery rather than Claude hooks.
- Native execution configuration has separate policy/model/child/permission duties.

Source symbols: `renderContextDelivery`, `canonicalComposition`,
`prepareContextDelivery`, `assertContextCurrent`, Claude run-service `execute`,
OpenCode run-service `executeNative` / `executeNativeCompact`, and
`hooks/session-start.ts` / `hooks/session-context.ts`.

## 4. Corrections to the audit and earlier explanations

These corrections matter when interpreting the older reports:

1. **Identical files are not proof of repeated model-history injection.** Thirteen
   identical `session-start.md` files belonged to thirteen different sessions,
   not thirteen injections into one session.
2. **Canonical context and legacy startup framework use different paths.** The
   framework can be part of canonical standing context supplied each launch even
   though the legacy framework hook runs once at native-session creation.
3. **The Claude append file is standing-only.** Earlier examples incorrectly put
   Session context in that file as well as in the hook.
4. **Role text can be included.** Reference-only behavior is conditional, not a
   universal property of roles.
5. **Preparation is not consumption.** A file, prepared event, pipe write, HTTP
   response, and native admission acknowledgment establish different things.
   None alone proves that the model read or followed the instructions.
6. **A zero-byte marker can have real semantics.** `.delivered` enforces once-per-run
   hook emission; it is not useless merely because it contains no text.
7. **Missing evidence is not proof of useless context.** Old sessions, different
   delivery eras, and incomplete evidence can produce missing-framework flags.
   Completed work does not establish that a context channel is unnecessary.
8. **Stored bytes are not token-spend measurements.** Claims of megabytes saved
   or guaranteed prompt-cache/model-speed benefits were not established. Count
   eliminated preparation, I/O, and native requests separately from model costs.
9. **System context and history are different.** Reattaching current system
   instructions is not the same as appending duplicate user messages. Claude's
   prompt-submit hook adds context to history; updating OpenCode's instruction
   entry has different semantics.

## 5. Workflow and document opportunities

The audit raised useful candidates, but not all are settled requirements:

| Pattern observed or suspected | Direction worth exploring |
| --- | --- |
| Fixed owner-authority prose repeated in handoffs | Establish attribution/authority once; reserve the message for the request, boundaries, and selected references. |
| Corrections and superseded decisions live only in chat or bespoke handoffs | Give current decisions, supersession, and unresolved questions an explicit home in the relevant artifact. |
| Verification misses a constraint until late feedback | Carry explicit constraints, negative requirements, and unresolved assumptions into verification. |
| Many evidence fragments registered as independent research reports | Distinguish decision-bearing reports from supporting evidence attachments. |
| Template copies, identical evidence pairs, and large evidence directories | Prefer shared template sources, clear evidence ownership, and navigable manifests over indiscriminate copying. |
| Progress appears differently in documents, registrations, and phase state | Distinguish draft work, requested action, actual output, and owner-waiting state. |
| Repeated approvals or scope changes lack a clear explanation | Preserve the user's decision and changed scope without assuming that more gates are the answer. |

Path-based handoffs and bounded assignment prompts often avoided copying full
documents; preserve that advantage. A short reference is not inherently bad, and
a longer handoff is not inherently better. The recipient needs enough intent,
constraints, and pointers to act without reconstructing the whole conversation.

The separate [structured document model proposal](STRUCTURED_DOCUMENT_MODEL.md)
addresses artifact structure and handoff authorization. This proposal does not
reinstate the original audit's suggested approval-hash/revision machinery or make
that artifact migration a prerequisite for context transport cleanup.

## 6. Alternatives discussed

### Option A: user-role context composition

Original scope: remove all hooks and system-level SANE context injection. Compose
role/framework/procedures/assignment/session into ordinary prompt text at the
appropriate points. Native history then carries that context forward.

Benefits: one shared composition model, no context-specific hook requirement for
new harnesses, and no repeated standing payload just to send an ordinary message.

**Selected direction:** prompt-based SANE context. Subsequent audit refinement
separates removal of context injectors from removal of operational hooks.

### Option B: one-shot standing, per-turn session channel

Put standing context in initial user-role history, but retain a minimal
harness-specific mechanism for Session context on each user turn.

This was potentially a smaller immediate change but retained the portability
question: what if a new harness has no compatible hook or instruction channel?
Using a prompt fallback would introduce Option A behavior for that harness anyway.

Grok Build, Antigravity CLI, and a DeepSeek harness were examples of future
integrations. Their actual APIs were not inspected. The earlier line-count
estimates mixed unavoidable adapter work with the marginal cost of Option B and
are not a dependable implementation estimate. The defensible distinction is that
A removes **context-specific** per-harness integration work, not all adapter work.

## 7. Target contract at proposal time

The revised [shared context contract](../../reports/hook-removal-audit-2026-10-14/shared-context.md)
is the implementation-facing source. It is more selective than the first draft:

| Operation | What SANE composes |
| --- | --- |
| New activation | Selected role, framework, initial procedure references/content, assignment if applicable, and current Session context, once. |
| Ordinary user follow-up or resume | The authored message body; no automatic standing **or Session** prefix. |
| Explicit context update | Changed/relevant context, with its meaning and provenance. |
| Worker launch | Worker activation and structured assignment. |
| Handoff, report, exchange | Attributed message and selected shared context; activation only if the recipient needs it. |
| Branch | Respect inherited history; add branch-specific context or activation/update as needed. |

Membership, roots, assignment, branch, and protocol changes can call for a context
update. A new message, process restart, or package revision alone does not mandate
a full resend. Compaction preservation/recovery is separate work, not an automatic
reinjection rule hidden in this change.

### Example: ordinary messages do not carry context again

Illustrative grouping inside a user-role prompt; exact encoding remains to be
specified. This does not require a separate synthetic user turn or agent response
between activation and the user's topic.

```text
[user-role message:
  SANE procedures: selected role + framework + initial guidance
  Session: workstream 123, roots, relevant assignment
  User topic: do X]
[agent message]
[user message: do Y]
[agent message]
[user-role message:
  SANE context update: membership is now workstream 234; relevant new roots
  User topic: do Z]
[agent message]
[user message: continue]
```

The old Session context remains in history; the explicit update supersedes it
going forward. SANE is not retroactively rewriting earlier user messages.

### Why some hooks remain in the revised scope

The original phrase "remove all hooks" included code that was later found to
serve more than context delivery. The October 20 plan retains:

- `hooks/forward.ts`, authenticated hook ingestion, and operational settings.
- Turn-stop, background-task, waiting-state, and queued-follow-up observations.
- Native-child observation, worker invocation evidence, and native worker/handoff routes.
- Execution-policy configuration, permissions, source identity, cancellation,
  submission uncertainty, and no-automatic-replay guarantees.

It removes the **context-returning** SessionStart/UserPromptSubmit commands,
append-system-prompt context files, SANE synthetic context messages, native
instruction-entry context writes, and their context-only acknowledgment gates.
An operational observation of SessionStart is not itself context injection.

Complete operational-hook removal would require a separate inventory and
replacement of those behaviors; it must not be silently bundled into this plan.

## 8. Implementation sequence

The [detailed plan](../../reports/hook-removal-audit-2026-10-14/PLAN.md) and
[requirement inventory](../../reports/hook-removal-audit-2026-10-14/consumers.md)
own the source-level breakdown.

1. **Specify message boundaries and placement.** Define activation, ordinary
   input, update, and sharing behavior; distinguish the authored body from exact
   outgoing transport text. Titles and classification must use the body, not
   context headings. Do not infer delivery solely from user-reproducible markers.
2. **Implement shared selective composition.** Reuse package assets, pinned
   procedure references, pure Session/assignment producers, and integrity checks.
   Callers select context once; adapters transport final bytes without prefixing
   independently. Resolve selected main-role ownership so it appears once.
3. **Preserve dispatch guarantees and durable evidence.** Context-bearing
   messages validate selected content and dependencies before send. Ordinary
   messages retain identity, ownership, cancellation, and execution checks without
   repeatedly loading the full context package. Reuse admission/submission records
   to distinguish activation from ordinary input across restart.
4. **Remove Claude's context-only paths.** Replace context hooks and append-file
   delivery with composed prompts. Remove associated missing-context-ack rejection
   gates jointly, so successful runs are not rejected for retired evidence.
   Keep operational hook and process handling.
5. **Remove OpenCode's context channels.** Send composed text through normal
   prompt/queued-prompt transport. Remove instruction-entry and synthetic-context
   sinks, including compact-path context writes; preserve queue, ownership,
   uncertain-submission reconciliation, and execution configuration.
6. **Update consumers and delete obsolete modes.** Cover initial messages,
   handoffs, workers, reports/exchanges, and branches. Update titles, display,
   classification, journals, review tooling, and context reports. Remove retired
   delivery modes, sidecar readers, and upgrade workarounds instead of adding a
   parallel delivery state machine.
7. **Validate the new contract when implementation is authorized.** Replace
   injection-specific coverage, retain binding/result/queue/operational-hook
   coverage, and check the complete ordinary-message path for repeated context
   work. Update operating documentation when the implementation lands; edits to
   skills/context and test execution remain separately authorized.

Claude and OpenCode adapter work can proceed independently after the shared
contract is fixed. Consumer changes depend on the same body/exact-bytes contract.

### Deployment and migration scope

The initial draft proposed dual modes, old-session compatibility, parity tooling,
and a version-gated rollout. The revised plan **supersedes that approach**:

- Use fresh SANE data and fresh native sessions, with no active old runs.
- Do not adopt old hook/system/instruction-entry context by reattaching sessions.
- Allow breaking context schema/API/config changes; do not build legacy readers,
  migration modes, historical imports, or context-adoption utilities.
- Preserve resume, restart, branch, queue-uncertainty, and no-replay behavior for
  sessions created under the new model.
- A real reset still requires explicit target directories/native-session scope;
  this document does not authorize deleting data.

### Principal risks

- Removing injectors but retaining their acknowledgment gates rejects valid runs.
- Removing context checks indiscriminately weakens source/binding or queue safety.
- Keeping full package validation on every ordinary send preserves much of the
  repeated work despite removing hooks. Check indirect execution-validation paths.
- Confusing operational hooks with context hooks breaks background/turn handling.
- Prefixing at both bridge and adapter layers duplicates activation.
- Restart, branch, or uncertain acknowledgment can duplicate or omit activation
  without durable evidence tied to the actual submitted message.

## 9. Performance goals and non-goals

The [performance inventory](../../reports/hook-removal-audit-2026-10-14/performance.md)
identifies work to eliminate, not measured speedups.

For an already-active recipient receiving ordinary input with no selected update,
the target is:

- Zero context-asset reads, including indirect paired context/execution loads.
- Zero context sidecar/marker writes or context-injector subprocesses.
- Zero native instruction-entry or SANE synthetic-context requests.
- No automatic standing/Session reinsertion or full prepared-context event.
- Retained execution safeguards, operational hooks, and necessary durable writes.

Measure bootstrap, ordinary continuation, and explicit updates separately, by
harness and at representative worker fan-out. Separate SANE preparation from
native startup, queueing, inference, and operational forwarding. No percentage
speedup, token-cache saving, or total adapter-size reduction is promised.

## 10. Boundaries and remaining decisions

- Exact prompt encoding, boundaries, and authored-body extraction contract.
- Durable activation/update evidence using existing admission/submission state.
- Which context a particular handoff/update needs, without unconditional resend.
- Main-role ownership versus native-child definitions and execution configuration.
- Separate compaction-preservation policy; no assumed recovery through repeated
  prefixes or automatic package-revision reinjection.
- Follow-on document-structure and operational-hook performance work, neither
  of which should expand this transport cleanup by default.

This consolidation changes documentation only. It does not authorize runtime
implementation, data resets, skill/context edits, tests, benchmarks, or browser
verification.

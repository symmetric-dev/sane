# Assistant Lifecycle and Handoff Definitions

Status: initial proposal for discussion. This document establishes vocabulary
and identifies decisions needed before changing assistant agents and skills.
It does not change their current instructions or tool behavior.

Subsequent Execution clarification: batches block coordination until all workers
return, and a Planning request blocks further execution until its reply or user
instruction. Execution recovers a missing Planning session with the user rather
than creating a new one. These rules supersede the independent-work and new-
Planning-session variants in the initial examples below.

Related: [Execution feedback loop](EXECUTION_FEEDBACK_LOOP.md).

## 1. Participants and phase order

The primary phase order is:

**Design → Engineering → Planning → Execution**

Research is a **Support Track**, available alongside any phase. It has no
forward or backward position in that order.

The five top-level Assistant Agents collaborate with the user and other
assistant sessions. Workers such as Grounder, Implementer, Reviewer, Fixer,
Scout, and Researcher perform bounded delegated assignments. Worker dispatch
is not an assistant handoff.

## 2. Assistant lifecycle

Each assistant has three skills, using names such as
`sane-assistant-design-pickup`, `sane-assistant-design-assistance`, and
`sane-assistant-design-delivery`.

### Pickup

Pickup runs exclusively at new session start and involves the user.

1. Resolve the workstream, read required inputs, inspect state, and link the session.
2. If the initial message is a handoff, identify its request and originating session.
3. Confirm readiness, report missing inputs, and wait for the user to proceed.

A session created by a handoff still performs Pickup and waits for the user.
The initial message supplies context; it does not bypass this checkpoint.
Returning to an existing session or receiving a later message does not repeat
Pickup. Refresh relevant state within Assistance when necessary.

### Assistance

Assistance begins after the user proceeds. It contains:

- The role's user collaboration and working procedures.
- Receiving and responding to handoffs in an existing session.
- Sending live requests to other phase assistants.
- Asking the user to initiate a Support Handoff, such as research.
- Worker delegation, where permitted by the role.
- Escalation to the user when a required decision exceeds existing authority.

An incoming request does not expand the recipient's authority. In particular,
Planning escalates decisions directly to the user; Engineering is not an
alternative approval authority.

### Delivery

Delivery contains output checks, presentation for user review, the applicable
approval procedure, and a user-requested Delivery Handoff where a next phase
exists. If the user requests substantive changes, return to Assistance.

Approval and requesting a handoff are distinct decisions, although the user
can express both together. Approval alone does not request a new session.

Execution ends the primary phase sequence. Research returns evidence to its
consumer rather than advancing to a next phase.

### Agent file responsibility

The agent `.md` orchestrates skill loading and retains role identity, ownership,
essential boundaries, and worker permissions:

1. At session start, load Pickup, complete it, and wait for user confirmation.
2. When the user proceeds, load Assistance.
3. Handle subsequent user requests and handoff updates through Assistance.
4. When ready to deliver, load Delivery. Return to Assistance if revisions are needed.

Loading a skill does not grant approval. Skills loaded earlier remain in the
conversation; the split defers instructions until relevant rather than unloading them.

## 3. Handoff vocabulary

### Delivery Handoff

A handoff made during Delivery, after the agent's work is approved and the user
requests transition to a **new session in the next primary phase**.

Examples: Design → Engineering, Engineering → Planning, Planning → Execution.

The receiving session performs Pickup. Delivery Handoff always starts a new
session; it does not select or reuse an existing next-phase session.

### Live Handoff / Active Handoff

A handoff used during ongoing Assistance to request work or return its outcome.
It coordinates work rather than advancing the normal phase delivery sequence.

Use **Live Handoff** as the category. **Sending Active Handoff** and
**Receiving Active Handoff** describe the participating agent's activity.
These are perspectives on the exchange, not additional routing categories.
Whether to standardize on only “Live” or “Active” remains an editorial decision.

“Live” describes the purpose of the exchange, not a guarantee that the target
session already exists or runs immediately. If a new target session is needed,
it still follows Pickup and requires the user to proceed.

### Live Backward Handoff

A live request from a later primary phase to an earlier primary phase for work,
such as a document correction or plan amendment.

Examples: Engineering → Design, Execution → Planning.

Direction alone does not authorize the request. Each role's authority and user
escalation rules still apply. Whether non-adjacent backward requests are allowed
needs an explicit decision.

### Live Backward Reply

The response to a specific Live Backward Handoff, returning results to the exact
session that requested the work. “Backward” identifies the request being answered,
not the reply's direction through the phases.

Example: Execution requests a Planning amendment; Planning updates the plan
and replies to that Execution session. This is not a fresh Planning delivery
or a request to start another Execution session.

The reply can report completed work, a blocker, or a decision still needed;
“Reply” does not imply success or renewed phase approval.

### Live Forward Handoff — not a supported workflow

A new request from an earlier phase to an existing later-phase session would
fit this directional description, but is not an established workflow. Design
does not send Engineering live requests for solution rework.

The supported forward-moving exchanges are a **Delivery Handoff**, which starts
a new next-phase session, and a **Live Backward Reply**, which answers a specific
earlier request. Neither is named Live Forward Handoff.

### Support Handoff

A request to a parallel Support Track, currently Research.

Example: “Perform a Support Handoff to Research to investigate this question.”

During Assistance, ask the user for the Support Handoff with its question and
scope. Research then follows its own Pickup, Assistance, and Delivery lifecycle.

### Support Reply

The response to a specific Support Handoff. Research returns findings or status
to the exact originating session; this is neither forward nor backward in
primary phase order. Follow-up questions remain part of the support exchange.

A Support Handoff can originate during live Assistance, but its destination
distinguishes it from Live Backward Handoffs. Research may send its reply
during its own Delivery; that does not make the reply a Delivery Handoff as
defined above.

## 4. Top-level workflow map

All five assistants begin with Pickup and user confirmation. The following
table combines current responsibilities with the proposed handoff vocabulary;
it does not authorize new routes.

| Assistant | User Assistance | Delivery | Mid-session exchanges |
| --- | --- | --- | --- |
| Design | Refine intent and the typed root document, then the SDD | Validate, obtain approval, offer Delivery Handoff to Engineering | Receive Engineering corrections and send Live Backward Replies; request Research support |
| Engineering | Investigate repository facts, discuss implementation decisions, write solution specs | Validate; account for remaining solution areas; obtain phase approval; offer Delivery Handoff to Planning | Request Design corrections and receive Live Backward Replies; handle authorized backward requests; request Research support |
| Planning | Agree plan, author and ground Job Specs, amend authorized upcoming work | Validate; obtain initial phase approval; offer Delivery Handoff to Execution | Receive Execution findings; amend/register in-scope jobs and send Live Backward Replies; escalate decisions to user; request Research support |
| Execution | Agree run order and coordination mode; coordinate implementation, review, fixes, and progress | Aggregate evidence, validate final report, obtain acceptance; no next primary phase | Request Planning corrections and receive replies; request Research support; proposed bounded Grounder delegation is worker dispatch |
| Research | Investigate scoped questions, coordinate researchers, discuss findings, maintain reports/index | Check reports/index, present findings, offer Support Reply; delivery without an originating request remains to be defined | Receive follow-up questions and return findings; no primary-phase direction |

### Representative exchanges

**Initial phase transition**

1. Design completes its outputs and asks for approval.
2. User approves and requests a handoff to Engineering.
3. Design sends a Delivery Handoff to a new Engineering session.
4. Engineering performs Pickup and waits for the user to proceed.

**Live correction loop**

1. Execution identifies a needed plan change during Assistance.
2. Under the applicable authorization, it sends a Live Backward Handoff to Planning.
3. An existing Planning session handles the request through Assistance; a new
   Planning session first performs Pickup and waits for the user.
4. Planning makes an authorized amendment, or asks the user for a required decision.
5. Planning validates and sends a Live Backward Reply to the requesting Execution session.
6. Execution checks the result and continues affected work when ready. Independent
   authorized work need not stop while the request is pending.

**Support exchange**

1. An assistant proposes a research question and asks the user for a Support Handoff.
2. Once requested, it sends the question to Research.
3. A new Research session performs Pickup and waits for the user to proceed.
4. Research investigates, presents its findings, and follows the applicable user
   delivery instruction to send a Support Reply.
5. The original assistant incorporates the evidence through Assistance; evidence
   does not itself approve a change in requirements or scope.

## 5. Common handoff information

Regardless of category, an exchange needs:

- The workstream and originating session identity.
- The requested work or returned outcome, with relevant artifact/evidence paths.
- Any decision still needed from the user and any work waiting on the result.

Replies target the exact originating session rather than whichever session is
latest. A recipient reports unresolved work explicitly rather than implying
that sending a reply means the request succeeded.

These are communication conventions, not a proposed new CLI message schema.

## 6. Definition gaps and decisions

### Authorization for live exchanges

Decide when an assistant can send a Live Backward Handoff without asking the
user each time. Current Execution instructions send corrections through the
user; the feedback-loop proposal contemplates delegated in-scope coordination.
Define whether that delegation also covers replies and further clarification.
Keep this separate from the mandatory human checkpoint for a new session.

### Reconcile current instructions with the definitions

Delivery Handoff only starts new sessions. Remove existing-target selection
from Delivery instructions and reconcile session creation/replacement/linking
behavior with that rule. Replies continue targeting the exact requesting session.

Remove the current Engineering instructions for Design-initiated solution rework
and other unsolicited live forward requests. They do not represent supported
workflows. These are required alignment changes, not open terminology decisions.

### Phase skipping

Decide whether Live Backward Handoffs may skip phases; do not infer permission
solely from direction. Planning still escalates required decisions directly to
the user rather than treating an earlier phase as a decision authority.

### Support returns and unsolicited delivery

Decide whether an initial user request can authorize a Support Reply in advance.
Current Research instructions also allow sending
findings to any user-selected phase, without an originating request. That needs
a name or explicit inclusion in the Support Handoff definition.

### Completion of live work versus phase delivery

A live correction needs verification and a reply, but should not automatically
restart full phase approval or create a next-phase session. Decide whether the
Assistance skill contains the bounded completion checks or references reusable
checks from Delivery. In-scope Planning amendments retain existing approval;
decisions exceeding authorization go directly to the user.

### Partial delivery, same-phase sessions, and reopened work

Engineering can deliver one solution area while other areas remain open; current
skills also suggest additional same-phase sessions. Define how partial acceptance
differs from whole-phase approval, who starts same-phase continuations, and how
an existing session handles requests after its earlier Delivery has finished.
Such requests should not accidentally trigger a new-session Pickup.

### Waiting, failure, and cancellation

Define how senders learn that work is waiting for the user, blocked, declined,
or cancelled, and how to handle overlapping requests affecting the same output.
A handoff neither guarantees immediate execution nor inherently blocks every
other task. Research's current “never blocks” wording needs qualification when
a particular decision genuinely depends on its evidence.

## 7. Source context reviewed

- `skills/sane-{design,engineering,planning,execution,research}-assistant-role/SKILL.md`
- `opencode/agents/sane/assistant/{design,engineering,planning,execution,research}.md`
- [Execution feedback loop proposal](EXECUTION_FEEDBACK_LOOP.md)

All five current agent files already require user confirmation after Pickup.
Current skills mix initial transitions, live updates, and support exchanges in
one Handoff section. The proposed split makes those responsibilities explicit;
agent and skill edits will follow separately after agreement on these definitions.

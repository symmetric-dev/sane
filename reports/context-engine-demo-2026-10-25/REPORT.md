# MOCK ONLY — engine-path demonstration

**PASS — simulated harness acceptance, not native/model proof.**

Not App end-to-end and not model consumption. All accepted labels mean simulated harness acceptance only. No synthetic recipient response establishes memory or retention.

Counters, trace and original scenario assertions are recorded instrumentation, not independently recovered native effects. Replay independently decodes exact recorded bytes and projects protected journal coverage/facts; a manifest expectation is not execution proof.

Fixture root: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified

## Acceptance and recorded counters

| Scenario | Replay checks | Recovered fact | Coverage | Mock sends / expected | Context loads | Execution loads | Pairing checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| activation | PASS | accepted \(simulated only\) | complete | 1 / 1 | 11 | 4 | 4 |
| ordinary | PASS | accepted \(simulated only\) | complete | 1 / 1 | 0 | 2 | 4 |
| update | PASS | accepted \(simulated only\) | complete | 1 / 1 | 4 | 4 | 8 |
| stale\-source | PASS | no\-evidence | complete | 0 / 0 | 6 | 2 | 2 |
| owner\-refusal | PASS | withheld | complete | 0 / 0 | 11 | 4 | 4 |
| persistence\-failure | PASS | unknown | partial | 0 / 0 | 11 | 4 | 4 |
| attempt\-unresolved | PASS | attempt\-unresolved | complete | 1 / 1 | 11 | 4 | 4 |

## Scope and limitations

Real composition/evidence engine, pinned stores, dispatch lifecycle and experiment journal; scripted transport/recipient and binding/settlement are simulated. The journal is not a production writer. This is not power-loss or native-crash proof. Replay is read-only: no native App/harness calls, transport, repair, retry or resend.

## activation — Activation bootstrap / simulated harness acceptance

**PASS** · Recovered fact: **accepted \(simulated only\)** · Expected: accepted \(simulated only\)

Coverage: **complete** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/activation/events\.jsonl

Coverage reason: No additional coverage reason\.

Projection: Exact per\-message native acceptance, not model consumption

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "c664b96d-bc48-4cc0-9135-876a15c89469",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-51a3201e-7be3-4ba7-afcf-ed475e0d5daa",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "08c8854e-01ad-47fc-9e90-901f23fcb37e",
    "nativeCommandId": "fixture-message-53f142c4-c29d-4dba-a83d-6d4ef6c32829"
  },
  "messageId": "fixture-message-53f142c4-c29d-4dba-a83d-6d4ef6c32829"
}
```

### Authored body (structured byte-range extraction)

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 body: 143 bytes at offset 9049 · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

### Exact recorded outgoing transport

```text
[SANE CONTEXT MESSAGE v1]
SANE activation: these selected procedures and session details are composed on the user's behalf. The user directs the work and may change these conventions.
[SANE CONTEXT SEGMENT {"id":"role.assistant.engineering","category":"role","source":"context/agents/sane/assistant/engineering.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selected main role activation","bytes":1577}]

You are a SANE Engineering Assistant Agent.

SANE is a structured, reasonable way for people and agents to acquire and apply knowledge in service of deliberate change.

You write and update one document per solution area in `design/solutions/<name>.md`.
Start from the approved `design/SDD.md` and follow the supplied solution template.
Work with the user to make technical implementation decisions.

Perform the following setup steps:

1. Use the workstream, workstream root, and implementation root from your SANE Session context. If no workstream is listed, use `sane_link` with your phase slot and the agreed `workstream` to establish membership.
2. Run commands in the implementation root and resolve workstream documents from the workstream root.
3. Read `sane-assistant-engineering-pickup`, complete its steps, and report readiness. Wait for user confirmation before proceeding, including when the initial message is a handoff.

Once done, perform your role steps:

1. When the user confirms, read `sane-assistant-engineering-assistance` and follow it for the work and discussion with the user.
2. For later handoffs, follow Assistance. Give each outgoing `sane_handoff` a distinct `requestId`; recover delivery with `sane_handoff_status` using that ID. Finish independent work and end your turn; replies arrive as separate handoffs.
3. When ready for delivery, read `sane-assistant-engineering-delivery` and follow its steps.
4. If further changes are requested, return to Assistance.

If you get blocked in any of those steps stop and report to the user immediately.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.core","category":"framework","source":"context/framework/core.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1946}]
# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable, and agile way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** groups the documents and state for an undertaking. Its documents describe current requirements, solutions, and outcomes; the CLI and sessions hold progress and collaboration history. Implementation happens in the target repository, not in a separate duplicate tree.

The user directs the work and makes decisions with the assistant.

There are 2 types of agents: **Assistants**, and **Workers**. Assistants work directly with the user while workers can be run by assistants to perform tasks.

You shall never talk about or reference workstream specific language or workflow in the implementation repository contents. Keep the meta-language separate from the implementation repository.

## Context

**Knowledge Gaps** are missing understanding needed to make a product,
design, or implementation decision—for example, how a feature should
behave or how a dependency integrates with the solution. They are often
visible in Design and Engineering documents.

**Operational Gaps** are missing procedures, tooling, or repository
context needed for agents to carry out assigned work—for example, how a
worker locates relevant code, prepares the environment, runs verification,
or updates artifacts. They are often visible in Planning and Execution
documents.

**Context Artifacts** preserve reusable knowledge and operational guidance
for future work. Skills and documentation are examples; the term is
independent of how that context is represented or stored.

## Lifecycle

Workstreams have a Main Track and Support Tracks.

The Main Track follows four phases: Design → Engineering → Planning → Execution.

Support Tracks may run alongside the Main Track to help resolve Knowledge Gaps and Operational Gaps along the way.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.assistant","category":"framework","source":"context/framework/assistant.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1156}]
## State

Follow your role's skills for the assigned work and coordination with other sessions.

View current status with `sane view` and use the CLI to record state.

1. **Pickup:** at new session start, read the assigned context and check required
   inputs. Confirm readiness and wait for the user to proceed, including when
   the session starts from a handoff.
2. **Assistance:** work with the user within the agreed scope. This may include
   handoff or handling updates from other sessions, following your role's skill.
3. **Delivery:** validate outputs with `sane validate <phase>` and present them
   for user review. Delivery may include handoff when the user requests it.
   If revisions are requested, return to Assistance and then Delivery.

## State Statuses

- `pending` — Not started.
- `in_progress` — Session is in progress.
- `delivered` — Phase work has been delivered.

A worker notification or consultation is not completion. Respond to an authorized ongoing child with `sane_worker_message`; retain its worker identity. Dispatch dependent work only after its terminal outcome. Ending your own turn permits asynchronous replies.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"procedure-index","category":"procedure-index","source":"Pinned procedure index","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selective loading from pinned files","bytes":1511}]
# SANE private procedures

Resolve the SANE lifecycle procedure names in your role instructions using this index and the ordinary file-reading tool, rather than native Skill discovery. Other repository skills retain their normal loading mechanism.

Load only the procedure needed for the current lifecycle step. Assistant activation includes the initial Pickup procedure; this index alone does not select or repeat Pickup on update or resume.

- sane-assistant-engineering-assistance: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md — Use after Engineering Pickup confirmation for solution work and mid-session requests.

- sane-assistant-engineering-delivery: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md — Use when preparing Engineering solution specs for review and delivery.

- sane-assistant-engineering-pickup: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md — Use when starting a new SANE Engineering Assistant session.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"sane-assistant-engineering-pickup","category":"procedure","source":"context/skills/sane-assistant-engineering-pickup/SKILL.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Initial lifecycle procedure","bytes":687}]

# SANE Engineering Assistant — Pickup

## Workstream Setup

1. Run `sane provide engineering` to supply missing starters.
2. Run `sane view` and link this session with `sane_link` (`slot: "engineering"`).

## Required Inputs

Read `design/SDD.md`, `<workstream>/resources/SOLUTION_SPEC_TEMPLATE.md`, and any existing solution specs relevant to the assignment. Ask the user about missing or unclear inputs.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced documents, and qualified sender identity from `From:`.

## Readiness and User Confirmation

Summarize the current state and solution areas to work on. Wait for the user to proceed.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"session","category":"session","source":"fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session","revision":"fixture-root-A","reason":"Explicit synthetic activation state","bytes":225}]
# Session
Synthetic experiment-owned session only.
root: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout/roots/A
No App project or workstream records exist.
[/SANE CONTEXT SEGMENT]
[SANE AUTHORED BODY {"bytes":143}]
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 transport: 9192 bytes · SHA-256: 9001549bc5f1f15455d3f3f8053cff208d78fe0dc022eb59d85c95b4e0124ef8

Placement: \{"kind":"bootstrap"\} · Origin: activation · Package revision: 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412

Ordered selection SHA-256: 20f39fb8ff323c9b63b30a584fc8a5ccbca417729cfc09972b9e17a3669a028f

### Selected segments

| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |
| --- | --- | --- | --- | --- |
| role\.assistant\.engineering / role | context/agents/sane/assistant/engineering\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selected main role activation | 449 + 1577 bytes | 84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0 |
| framework\.core / framework | context/framework/core\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 2288 + 1946 bytes | 0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421 |
| framework\.assistant / framework | context/framework/assistant\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 4506 + 1156 bytes | 6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43 |
| procedure\-index / procedure\-index | Pinned procedure index / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selective loading from pinned files | 5936 + 1511 bytes | 807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436 |
| sane\-assistant\-engineering\-pickup / procedure | context/skills/sane\-assistant\-engineering\-pickup/SKILL\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Initial lifecycle procedure | 7759 + 687 bytes | 0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59 |
| session / session | fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/synthetic\-session / fixture\-root\-A | Explicit synthetic activation state | 8764 + 225 bytes | 10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609 |

### Segment provenance (structured, not marker inference)

```text
[
  {
    "id": "role.assistant.engineering",
    "category": "role",
    "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
    "reason": "Selected main role activation",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "role.assistant.engineering",
        "source": "context/agents/sane/assistant/engineering.md",
        "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/role.assistant.engineering.md"
      }
    },
    "range": {
      "offset": 449,
      "length": 1577
    }
  },
  {
    "id": "framework.core",
    "category": "framework",
    "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.core",
        "source": "context/framework/core.md",
        "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.core.md"
      }
    },
    "range": {
      "offset": 2288,
      "length": 1946
    }
  },
  {
    "id": "framework.assistant",
    "category": "framework",
    "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.assistant",
        "source": "context/framework/assistant.md",
        "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.assistant.md"
      }
    },
    "range": {
      "offset": 4506,
      "length": 1156
    }
  },
  {
    "id": "procedure-index",
    "category": "procedure-index",
    "sha256": "807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436",
    "reason": "Selective loading from pinned files",
    "provenance": {
      "kind": "procedure-index",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "assets": [
        {
          "id": "sane-assistant-engineering-assistance",
          "source": "context/skills/sane-assistant-engineering-assistance/SKILL.md",
          "sha256": "a122256ecab01a9ecb487d3352ac69bea736668bb4112e35dfb392dbd7b5dbb6",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-delivery",
          "source": "context/skills/sane-assistant-engineering-delivery/SKILL.md",
          "sha256": "689edd20ee8d920f45a15d9849d2d3f3145a0ceede1d88f9be084895e50addac",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-pickup",
          "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
          "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
        }
      ]
    },
    "range": {
      "offset": 5936,
      "length": 1511
    }
  },
  {
    "id": "sane-assistant-engineering-pickup",
    "category": "procedure",
    "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
    "reason": "Initial lifecycle procedure",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "sane-assistant-engineering-pickup",
        "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
        "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
      }
    },
    "range": {
      "offset": 7759,
      "length": 687
    }
  },
  {
    "id": "session",
    "category": "session",
    "sha256": "10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609",
    "reason": "Explicit synthetic activation state",
    "provenance": {
      "kind": "fragment",
      "source": "fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session",
      "revision": "fixture-root-A"
    },
    "range": {
      "offset": 8764,
      "length": 225
    }
  }
]
```

### Recorded instrumentation trace

```text
load:context
prepare:start
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
revalidate:after-await
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
adapter:read-actual-pending
original:beforeNative
gate:sync-source-ownership-cancel
original:intent-durable
persist:before-native:attempted
mock:effect
adapter:read-actual-pending
original:outcome:submitted
persist:outcome:submitted
mock:simulated-acceptance
owner:settled
owner:released
settlement:mocked
lifecycle:admission-admitted
lifecycle:settlement-mocked-ready
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered accepted; manifest expectation accepted is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 1 sends; expected 1\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** durable attempt precedes mock effect: The same owner journal orders the fsynced attempt before each scripted mock effect\.
- **PASS** successful scenario simulated acceptance: Successful mock scenario must independently recover exact correlated simulated acceptance; a changed manifest expectation cannot replace this fact\.
- **PASS** exact recorded bytes and ranges: Production submission decoder validated UTF\-8 ranges, framing, hashes and exact transport; this alone is not source trust\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** independent bootstrap selection: Main role once, required standing frameworks, pinned index, correct role Pickup and Session in independent owner\-role order\.
- **PASS** recorded activation effect count: Recorded mock instrumentation must show exactly one send\.
- **PASS** scenario coverage boundary: complete: Exact per\-message native acceptance, not model consumption

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: accepted; expected accepted; Exact per\-message native acceptance, not model consumption
- **PASS** mock\-send\-count: 1; expected 1; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=11; execution=4; pairing=4
- **PASS** durable\-before\-effect: Original owner intent → synchronous composition persistence → single mock effect
- **PASS** bootstrap\-required\-segments: Authored engineering role once, required framework, pinned index, Pickup and explicit synthetic Session

### Projection provenance

```text
[
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/activation/events.jsonl",
    "sequence": 6,
    "kind": "submission"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/activation/events.jsonl",
    "sequence": 7,
    "kind": "dispatch"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/activation/events.jsonl",
    "sequence": 10,
    "kind": "dispatch"
  }
]
```

## ordinary — Ordinary continuation / exact authored bytes

**PASS** · Recovered fact: **accepted \(simulated only\)** · Expected: accepted \(simulated only\)

Coverage: **complete** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/ordinary/events\.jsonl

Coverage reason: No additional coverage reason\.

Projection: Exact per\-message native acceptance, not model consumption

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "c664b96d-bc48-4cc0-9135-876a15c89469",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-51a3201e-7be3-4ba7-afcf-ed475e0d5daa",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "70940a49-4ff2-435b-a212-8d97b8a66a3a",
    "nativeCommandId": "fixture-message-e3ba708e-f56f-4719-a548-ddd51e8b08ad"
  },
  "messageId": "fixture-message-e3ba708e-f56f-4719-a548-ddd51e8b08ad"
}
```

### Authored body (structured byte-range extraction)

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 body: 143 bytes at offset 0 · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

### Exact recorded outgoing transport

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 transport: 143 bytes · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

Placement: \{"kind":"body\-only"\} · Origin: user · Package revision: none

Ordered selection SHA-256: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945

### Selected segments

| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |
| --- | --- | --- | --- | --- |
| No context segments | — | Body-only | — | — |

### Segment provenance (structured, not marker inference)

```text
[]
```

### Recorded instrumentation trace

```text
prepare:start
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
load:execution
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
revalidate:after-await
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
load:execution
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
adapter:read-actual-pending
original:beforeNative
gate:sync-source-ownership-cancel
original:intent-durable
persist:before-native:attempted
mock:effect
adapter:read-actual-pending
original:outcome:submitted
persist:outcome:submitted
mock:simulated-acceptance
owner:settled
owner:released
settlement:mocked
lifecycle:admission-admitted
lifecycle:settlement-mocked-ready
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered accepted; manifest expectation accepted is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 1 sends; expected 1\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** durable attempt precedes mock effect: The same owner journal orders the fsynced attempt before each scripted mock effect\.
- **PASS** successful scenario simulated acceptance: Successful mock scenario must independently recover exact correlated simulated acceptance; a changed manifest expectation cannot replace this fact\.
- **PASS** exact recorded bytes and ranges: Production submission decoder validated UTF\-8 ranges, framing, hashes and exact transport; this alone is not source trust\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** ordinary is exact authored body: No marker stripping or implicit context; exact decoded authored bytes equal recorded transport\.
- **PASS** recorded ordinary loader boundaries: Recorded instrumentation only: zero context loads; execution and pairing checks present; exactly one mock send\.
- **PASS** ordinary durable bootstrap pairing: Protected bootstrap owner's role, context/execution pins and exact finalized native binding must pair; simulated acceptance is not retained model memory\.
- **PASS** scenario coverage boundary: complete: Exact per\-message native acceptance, not model consumption

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: accepted; expected accepted; Exact per\-message native acceptance, not model consumption
- **PASS** mock\-send\-count: 1; expected 1; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=0; execution=2; pairing=4
- **PASS** durable\-before\-effect: Original owner intent → synchronous composition persistence → single mock effect
- **PASS** exact\-body\-only: No context prefix, role, framework, index, Pickup or Session selected
- **PASS** real\-execution\-and\-durable\-pairing: Execution\-only real validator plus accepted exact owner\-journal source/role/context/execution pairing; zero context loads including callbacks

### Projection provenance

```text
[
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/ordinary/events.jsonl",
    "sequence": 6,
    "kind": "submission"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/ordinary/events.jsonl",
    "sequence": 7,
    "kind": "dispatch"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/ordinary/events.jsonl",
    "sequence": 10,
    "kind": "dispatch"
  }
]
```

## update — Explicit fixture Session root A → B update

**PASS** · Recovered fact: **accepted \(simulated only\)** · Expected: accepted \(simulated only\)

Coverage: **complete** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/update/events\.jsonl

Coverage reason: No additional coverage reason\.

Projection: Exact per\-message native acceptance, not model consumption

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "c664b96d-bc48-4cc0-9135-876a15c89469",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-51a3201e-7be3-4ba7-afcf-ed475e0d5daa",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "4418721c-9918-4bd7-856c-21a2f0bc2867",
    "nativeCommandId": "fixture-message-25ef46d3-b765-4335-8133-d44d06cc9874"
  },
  "messageId": "fixture-message-25ef46d3-b765-4335-8133-d44d06cc9874"
}
```

### Authored body (structured byte-range extraction)

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 body: 143 bytes at offset 767 · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

### Exact recorded outgoing transport

```text
[SANE CONTEXT MESSAGE v1]
SANE context update: the selected changed details supersede corresponding earlier details. Other context remains unchanged unless explicitly stated.
[SANE CONTEXT SEGMENT {"id":"session","category":"session","source":"fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session","revision":"fixture-root-B","reason":"Explicit synthetic root selection changed A → B","bytes":225}]
# Session
Synthetic experiment-owned session only.
root: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout/roots/B
No App project or workstream records exist.
[/SANE CONTEXT SEGMENT]
[SANE AUTHORED BODY {"bytes":143}]
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 transport: 910 bytes · SHA-256: 4c5ccd9d383ba2d2b1f58cd0b8b863b664a9e4d101f3f6bde35fd0eaefc4efe0

Placement: \{"kind":"selected","purpose":"update"\} · Origin: context\-update · Package revision: none

Ordered selection SHA-256: 81bd0f2cde6f591d7c3a141275ebf9dcbe9ff61a85cab091ab12b8e3185e19fb

### Selected segments

| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |
| --- | --- | --- | --- | --- |
| session / session | fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/synthetic\-session / fixture\-root\-B | Explicit synthetic root selection changed A → B | 482 + 225 bytes | 9b1bac0c959c3e1b28c651a738b67364eaceaef849676a7da168b992c96810af |

### Segment provenance (structured, not marker inference)

```text
[
  {
    "id": "session",
    "category": "session",
    "sha256": "9b1bac0c959c3e1b28c651a738b67364eaceaef849676a7da168b992c96810af",
    "reason": "Explicit synthetic root selection changed A → B",
    "provenance": {
      "kind": "fragment",
      "source": "fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session",
      "revision": "fixture-root-B"
    },
    "range": {
      "offset": 482,
      "length": 225
    }
  }
]
```

### Recorded instrumentation trace

```text
prepare:start
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
revalidate:after-await
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
pairing:read-same-owner-journal
gate:sync-source-ownership-cancel
adapter:read-actual-pending
original:beforeNative
gate:sync-source-ownership-cancel
original:intent-durable
persist:before-native:attempted
mock:effect
adapter:read-actual-pending
original:outcome:submitted
persist:outcome:submitted
mock:simulated-acceptance
owner:settled
owner:released
settlement:mocked
lifecycle:admission-admitted
lifecycle:settlement-mocked-ready
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered accepted; manifest expectation accepted is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 1 sends; expected 1\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** durable attempt precedes mock effect: The same owner journal orders the fsynced attempt before each scripted mock effect\.
- **PASS** successful scenario simulated acceptance: Successful mock scenario must independently recover exact correlated simulated acceptance; a changed manifest expectation cannot replace this fact\.
- **PASS** exact recorded bytes and ranges: Production submission decoder validated UTF\-8 ranges, framing, hashes and exact transport; this alone is not source trust\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** Session\-only explicit update: Exactly selected Session fragment; no role, framework or Pickup resend\. Fragment semantics and loader counters remain recorded scenario instrumentation\.
- **PASS** scenario coverage boundary: complete: Exact per\-message native acceptance, not model consumption

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: accepted; expected accepted; Exact per\-message native acceptance, not model consumption
- **PASS** mock\-send\-count: 1; expected 1; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=4; execution=4; pairing=8
- **PASS** durable\-before\-effect: Original owner intent → synchronous composition persistence → single mock effect
- **PASS** only\-selected\-session: Only fixture Session root B; no role/framework/index/Pickup resend

### Projection provenance

```text
[
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/update/events.jsonl",
    "sequence": 6,
    "kind": "submission"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/update/events.jsonl",
    "sequence": 7,
    "kind": "dispatch"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/update/events.jsonl",
    "sequence": 10,
    "kind": "dispatch"
  }
]
```

## stale\-source — Source drift across a controlled await / preparation rejection

**PASS** · Recovered fact: **no\-evidence** · Expected: no\-evidence

Coverage: **complete** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/stale\-source/events\.jsonl

Coverage reason: No additional coverage reason\.

Projection: No exact per\-message submission or boundary evidence; this is not a fresh\-session claim

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "eea33de4-0f56-4e03-91f2-93e20193e643",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-774e7fc7-1a3e-4737-8c43-4eece191b439",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "54afa272-483d-4c64-84a1-7029994d1ee0",
    "nativeCommandId": "fixture-message-5b423021-b7b9-4fa0-82b4-affffc6cff09"
  },
  "messageId": "fixture-message-5b423021-b7b9-4fa0-82b4-affffc6cff09"
}
```

### Authored body / transport

Unavailable: no valid exact submission was recovered. No message bytes are synthesized from expectations or errors.

### Recorded instrumentation trace

```text
load:context
prepare:start
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
source:drifted
revalidate:after-await
preparation:rejection-durable
original:outcome:unknown
owner:settled
owner:released
lifecycle:admission-unconfirmed
lifecycle:settlement-denied
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered no\-evidence; manifest expectation no\-evidence is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 0 sends; expected 0\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** exact recorded bytes and ranges: No exact submission recorded; no transport body is invented\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** recorded failure has no mock effects: Zero sends is recorded mock instrumentation; durable projection independently must not establish submission/acceptance\.
- **PASS** scenario coverage boundary: complete: No exact per\-message submission or boundary evidence; this is not a fresh\-session claim

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: no\-evidence; expected no\-evidence; No exact per\-message submission or boundary evidence; this is not a fresh\-session claim
- **PASS** mock\-send\-count: 0; expected 0; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=6; execution=2; pairing=2
- **PASS** uncertified\-preparation\-rejection: Controlled await changed live source; rejection journaled, no local\-refusal or freshness claim

### Projection provenance

```text
[]
```

### Recorded scenario error

```text
Error: Fixture source changed during controlled await
```

## owner\-refusal — Original synchronous owner pause / certified withholding

**PASS** · Recovered fact: **withheld** · Expected: withheld

Coverage: **complete** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/owner\-refusal/events\.jsonl

Coverage reason: No additional coverage reason\.

Projection: Explicit correlated non\-submission; no activation established

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "0e5cf77a-4482-4bf2-ba6f-63a8356d23fa",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-263ac6d8-5405-4998-ab75-9a4d31b10d1f",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "8dc7dd58-37ca-4583-8534-b2297ab02671",
    "nativeCommandId": "fixture-message-2e5d32e1-813a-4781-857c-5ba42affd2d9"
  },
  "messageId": "fixture-message-2e5d32e1-813a-4781-857c-5ba42affd2d9"
}
```

### Authored body (structured byte-range extraction)

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 body: 143 bytes at offset 9049 · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

### Exact recorded outgoing transport

```text
[SANE CONTEXT MESSAGE v1]
SANE activation: these selected procedures and session details are composed on the user's behalf. The user directs the work and may change these conventions.
[SANE CONTEXT SEGMENT {"id":"role.assistant.engineering","category":"role","source":"context/agents/sane/assistant/engineering.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selected main role activation","bytes":1577}]

You are a SANE Engineering Assistant Agent.

SANE is a structured, reasonable way for people and agents to acquire and apply knowledge in service of deliberate change.

You write and update one document per solution area in `design/solutions/<name>.md`.
Start from the approved `design/SDD.md` and follow the supplied solution template.
Work with the user to make technical implementation decisions.

Perform the following setup steps:

1. Use the workstream, workstream root, and implementation root from your SANE Session context. If no workstream is listed, use `sane_link` with your phase slot and the agreed `workstream` to establish membership.
2. Run commands in the implementation root and resolve workstream documents from the workstream root.
3. Read `sane-assistant-engineering-pickup`, complete its steps, and report readiness. Wait for user confirmation before proceeding, including when the initial message is a handoff.

Once done, perform your role steps:

1. When the user confirms, read `sane-assistant-engineering-assistance` and follow it for the work and discussion with the user.
2. For later handoffs, follow Assistance. Give each outgoing `sane_handoff` a distinct `requestId`; recover delivery with `sane_handoff_status` using that ID. Finish independent work and end your turn; replies arrive as separate handoffs.
3. When ready for delivery, read `sane-assistant-engineering-delivery` and follow its steps.
4. If further changes are requested, return to Assistance.

If you get blocked in any of those steps stop and report to the user immediately.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.core","category":"framework","source":"context/framework/core.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1946}]
# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable, and agile way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** groups the documents and state for an undertaking. Its documents describe current requirements, solutions, and outcomes; the CLI and sessions hold progress and collaboration history. Implementation happens in the target repository, not in a separate duplicate tree.

The user directs the work and makes decisions with the assistant.

There are 2 types of agents: **Assistants**, and **Workers**. Assistants work directly with the user while workers can be run by assistants to perform tasks.

You shall never talk about or reference workstream specific language or workflow in the implementation repository contents. Keep the meta-language separate from the implementation repository.

## Context

**Knowledge Gaps** are missing understanding needed to make a product,
design, or implementation decision—for example, how a feature should
behave or how a dependency integrates with the solution. They are often
visible in Design and Engineering documents.

**Operational Gaps** are missing procedures, tooling, or repository
context needed for agents to carry out assigned work—for example, how a
worker locates relevant code, prepares the environment, runs verification,
or updates artifacts. They are often visible in Planning and Execution
documents.

**Context Artifacts** preserve reusable knowledge and operational guidance
for future work. Skills and documentation are examples; the term is
independent of how that context is represented or stored.

## Lifecycle

Workstreams have a Main Track and Support Tracks.

The Main Track follows four phases: Design → Engineering → Planning → Execution.

Support Tracks may run alongside the Main Track to help resolve Knowledge Gaps and Operational Gaps along the way.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.assistant","category":"framework","source":"context/framework/assistant.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1156}]
## State

Follow your role's skills for the assigned work and coordination with other sessions.

View current status with `sane view` and use the CLI to record state.

1. **Pickup:** at new session start, read the assigned context and check required
   inputs. Confirm readiness and wait for the user to proceed, including when
   the session starts from a handoff.
2. **Assistance:** work with the user within the agreed scope. This may include
   handoff or handling updates from other sessions, following your role's skill.
3. **Delivery:** validate outputs with `sane validate <phase>` and present them
   for user review. Delivery may include handoff when the user requests it.
   If revisions are requested, return to Assistance and then Delivery.

## State Statuses

- `pending` — Not started.
- `in_progress` — Session is in progress.
- `delivered` — Phase work has been delivered.

A worker notification or consultation is not completion. Respond to an authorized ongoing child with `sane_worker_message`; retain its worker identity. Dispatch dependent work only after its terminal outcome. Ending your own turn permits asynchronous replies.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"procedure-index","category":"procedure-index","source":"Pinned procedure index","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selective loading from pinned files","bytes":1511}]
# SANE private procedures

Resolve the SANE lifecycle procedure names in your role instructions using this index and the ordinary file-reading tool, rather than native Skill discovery. Other repository skills retain their normal loading mechanism.

Load only the procedure needed for the current lifecycle step. Assistant activation includes the initial Pickup procedure; this index alone does not select or repeat Pickup on update or resume.

- sane-assistant-engineering-assistance: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md — Use after Engineering Pickup confirmation for solution work and mid-session requests.

- sane-assistant-engineering-delivery: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md — Use when preparing Engineering solution specs for review and delivery.

- sane-assistant-engineering-pickup: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md — Use when starting a new SANE Engineering Assistant session.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"sane-assistant-engineering-pickup","category":"procedure","source":"context/skills/sane-assistant-engineering-pickup/SKILL.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Initial lifecycle procedure","bytes":687}]

# SANE Engineering Assistant — Pickup

## Workstream Setup

1. Run `sane provide engineering` to supply missing starters.
2. Run `sane view` and link this session with `sane_link` (`slot: "engineering"`).

## Required Inputs

Read `design/SDD.md`, `<workstream>/resources/SOLUTION_SPEC_TEMPLATE.md`, and any existing solution specs relevant to the assignment. Ask the user about missing or unclear inputs.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced documents, and qualified sender identity from `From:`.

## Readiness and User Confirmation

Summarize the current state and solution areas to work on. Wait for the user to proceed.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"session","category":"session","source":"fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session","revision":"fixture-root-A","reason":"Explicit synthetic activation state","bytes":225}]
# Session
Synthetic experiment-owned session only.
root: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout/roots/A
No App project or workstream records exist.
[/SANE CONTEXT SEGMENT]
[SANE AUTHORED BODY {"bytes":143}]
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 transport: 9192 bytes · SHA-256: 9001549bc5f1f15455d3f3f8053cff208d78fe0dc022eb59d85c95b4e0124ef8

Placement: \{"kind":"bootstrap"\} · Origin: activation · Package revision: 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412

Ordered selection SHA-256: 20f39fb8ff323c9b63b30a584fc8a5ccbca417729cfc09972b9e17a3669a028f

### Selected segments

| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |
| --- | --- | --- | --- | --- |
| role\.assistant\.engineering / role | context/agents/sane/assistant/engineering\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selected main role activation | 449 + 1577 bytes | 84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0 |
| framework\.core / framework | context/framework/core\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 2288 + 1946 bytes | 0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421 |
| framework\.assistant / framework | context/framework/assistant\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 4506 + 1156 bytes | 6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43 |
| procedure\-index / procedure\-index | Pinned procedure index / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selective loading from pinned files | 5936 + 1511 bytes | 807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436 |
| sane\-assistant\-engineering\-pickup / procedure | context/skills/sane\-assistant\-engineering\-pickup/SKILL\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Initial lifecycle procedure | 7759 + 687 bytes | 0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59 |
| session / session | fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/synthetic\-session / fixture\-root\-A | Explicit synthetic activation state | 8764 + 225 bytes | 10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609 |

### Segment provenance (structured, not marker inference)

```text
[
  {
    "id": "role.assistant.engineering",
    "category": "role",
    "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
    "reason": "Selected main role activation",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "role.assistant.engineering",
        "source": "context/agents/sane/assistant/engineering.md",
        "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/role.assistant.engineering.md"
      }
    },
    "range": {
      "offset": 449,
      "length": 1577
    }
  },
  {
    "id": "framework.core",
    "category": "framework",
    "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.core",
        "source": "context/framework/core.md",
        "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.core.md"
      }
    },
    "range": {
      "offset": 2288,
      "length": 1946
    }
  },
  {
    "id": "framework.assistant",
    "category": "framework",
    "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.assistant",
        "source": "context/framework/assistant.md",
        "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.assistant.md"
      }
    },
    "range": {
      "offset": 4506,
      "length": 1156
    }
  },
  {
    "id": "procedure-index",
    "category": "procedure-index",
    "sha256": "807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436",
    "reason": "Selective loading from pinned files",
    "provenance": {
      "kind": "procedure-index",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "assets": [
        {
          "id": "sane-assistant-engineering-assistance",
          "source": "context/skills/sane-assistant-engineering-assistance/SKILL.md",
          "sha256": "a122256ecab01a9ecb487d3352ac69bea736668bb4112e35dfb392dbd7b5dbb6",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-delivery",
          "source": "context/skills/sane-assistant-engineering-delivery/SKILL.md",
          "sha256": "689edd20ee8d920f45a15d9849d2d3f3145a0ceede1d88f9be084895e50addac",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-pickup",
          "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
          "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
        }
      ]
    },
    "range": {
      "offset": 5936,
      "length": 1511
    }
  },
  {
    "id": "sane-assistant-engineering-pickup",
    "category": "procedure",
    "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
    "reason": "Initial lifecycle procedure",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "sane-assistant-engineering-pickup",
        "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
        "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
      }
    },
    "range": {
      "offset": 7759,
      "length": 687
    }
  },
  {
    "id": "session",
    "category": "session",
    "sha256": "10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609",
    "reason": "Explicit synthetic activation state",
    "provenance": {
      "kind": "fragment",
      "source": "fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session",
      "revision": "fixture-root-A"
    },
    "range": {
      "offset": 8764,
      "length": 225
    }
  }
]
```

### Recorded instrumentation trace

```text
load:context
prepare:start
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
revalidate:after-await
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
adapter:read-actual-pending
original:beforeNative
gate:sync-source-ownership-cancel
original:pause-durable
original:certified-refusal:Error: Fixture owner paused before native intent; cause: Error: Fixture owner paused before native intent
adapter:read-actual-pending
original:outcome:not-submitted
persist:outcome:not-submitted
owner:settled
owner:released
lifecycle:admission-unconfirmed
lifecycle:settlement-denied
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered withheld; manifest expectation withheld is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 0 sends; expected 0\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** exact recorded bytes and ranges: Production submission decoder validated UTF\-8 ranges, framing, hashes and exact transport; this alone is not source trust\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** recorded failure has no mock effects: Zero sends is recorded mock instrumentation; durable projection independently must not establish submission/acceptance\.
- **PASS** genuine owner withholding recovered: Only exact correlated owner non\-submission establishes withholding; errors or an edited expectation cannot certify refusal\.
- **PASS** scenario coverage boundary: complete: Explicit correlated non\-submission; no activation established

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: withheld; expected withheld; Explicit correlated non\-submission; no activation established
- **PASS** mock\-send\-count: 0; expected 0; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=11; execution=4; pairing=4
- **PASS** genuine\-owner\-refusal\-nonfatal: Original synchronous pause certifies refusal; registry finish durably records withholding, without termination

### Projection provenance

```text
[
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/owner-refusal/events.jsonl",
    "sequence": 7,
    "kind": "submission"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/owner-refusal/events.jsonl",
    "sequence": 8,
    "kind": "dispatch"
  }
]
```

### Recorded scenario error

```text
Error: Fixture owner paused before native intent; cause: Error: Fixture owner paused before native intent
```

## persistence\-failure — Uncertified refusal\-class persistence fault / fail closed

**PASS** · Recovered fact: **unknown** · Expected: unknown

Coverage: **partial** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/persistence\-failure/events\.jsonl

Coverage reason: Owner closed this journal with partial coverage; Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; Owner health failure: Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; Owner health failure: Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; Owner health failure: Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal

Projection: Evidence coverage is not complete; missing history cannot establish freshness or admission

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "c624d057-5da7-4736-a86c-49b0aa1935d8",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-e5439bf8-f3e1-4916-adcc-fce01f275b68",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "74e37eb5-3a8f-482b-b678-1f312e09b61e",
    "nativeCommandId": "fixture-message-7c6ff948-0cee-4a75-8e8b-6d6586ae0933"
  },
  "messageId": "fixture-message-7c6ff948-0cee-4a75-8e8b-6d6586ae0933"
}
```

### Authored body (structured byte-range extraction)

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 body: 143 bytes at offset 9049 · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

### Exact recorded outgoing transport

```text
[SANE CONTEXT MESSAGE v1]
SANE activation: these selected procedures and session details are composed on the user's behalf. The user directs the work and may change these conventions.
[SANE CONTEXT SEGMENT {"id":"role.assistant.engineering","category":"role","source":"context/agents/sane/assistant/engineering.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selected main role activation","bytes":1577}]

You are a SANE Engineering Assistant Agent.

SANE is a structured, reasonable way for people and agents to acquire and apply knowledge in service of deliberate change.

You write and update one document per solution area in `design/solutions/<name>.md`.
Start from the approved `design/SDD.md` and follow the supplied solution template.
Work with the user to make technical implementation decisions.

Perform the following setup steps:

1. Use the workstream, workstream root, and implementation root from your SANE Session context. If no workstream is listed, use `sane_link` with your phase slot and the agreed `workstream` to establish membership.
2. Run commands in the implementation root and resolve workstream documents from the workstream root.
3. Read `sane-assistant-engineering-pickup`, complete its steps, and report readiness. Wait for user confirmation before proceeding, including when the initial message is a handoff.

Once done, perform your role steps:

1. When the user confirms, read `sane-assistant-engineering-assistance` and follow it for the work and discussion with the user.
2. For later handoffs, follow Assistance. Give each outgoing `sane_handoff` a distinct `requestId`; recover delivery with `sane_handoff_status` using that ID. Finish independent work and end your turn; replies arrive as separate handoffs.
3. When ready for delivery, read `sane-assistant-engineering-delivery` and follow its steps.
4. If further changes are requested, return to Assistance.

If you get blocked in any of those steps stop and report to the user immediately.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.core","category":"framework","source":"context/framework/core.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1946}]
# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable, and agile way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** groups the documents and state for an undertaking. Its documents describe current requirements, solutions, and outcomes; the CLI and sessions hold progress and collaboration history. Implementation happens in the target repository, not in a separate duplicate tree.

The user directs the work and makes decisions with the assistant.

There are 2 types of agents: **Assistants**, and **Workers**. Assistants work directly with the user while workers can be run by assistants to perform tasks.

You shall never talk about or reference workstream specific language or workflow in the implementation repository contents. Keep the meta-language separate from the implementation repository.

## Context

**Knowledge Gaps** are missing understanding needed to make a product,
design, or implementation decision—for example, how a feature should
behave or how a dependency integrates with the solution. They are often
visible in Design and Engineering documents.

**Operational Gaps** are missing procedures, tooling, or repository
context needed for agents to carry out assigned work—for example, how a
worker locates relevant code, prepares the environment, runs verification,
or updates artifacts. They are often visible in Planning and Execution
documents.

**Context Artifacts** preserve reusable knowledge and operational guidance
for future work. Skills and documentation are examples; the term is
independent of how that context is represented or stored.

## Lifecycle

Workstreams have a Main Track and Support Tracks.

The Main Track follows four phases: Design → Engineering → Planning → Execution.

Support Tracks may run alongside the Main Track to help resolve Knowledge Gaps and Operational Gaps along the way.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.assistant","category":"framework","source":"context/framework/assistant.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1156}]
## State

Follow your role's skills for the assigned work and coordination with other sessions.

View current status with `sane view` and use the CLI to record state.

1. **Pickup:** at new session start, read the assigned context and check required
   inputs. Confirm readiness and wait for the user to proceed, including when
   the session starts from a handoff.
2. **Assistance:** work with the user within the agreed scope. This may include
   handoff or handling updates from other sessions, following your role's skill.
3. **Delivery:** validate outputs with `sane validate <phase>` and present them
   for user review. Delivery may include handoff when the user requests it.
   If revisions are requested, return to Assistance and then Delivery.

## State Statuses

- `pending` — Not started.
- `in_progress` — Session is in progress.
- `delivered` — Phase work has been delivered.

A worker notification or consultation is not completion. Respond to an authorized ongoing child with `sane_worker_message`; retain its worker identity. Dispatch dependent work only after its terminal outcome. Ending your own turn permits asynchronous replies.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"procedure-index","category":"procedure-index","source":"Pinned procedure index","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selective loading from pinned files","bytes":1511}]
# SANE private procedures

Resolve the SANE lifecycle procedure names in your role instructions using this index and the ordinary file-reading tool, rather than native Skill discovery. Other repository skills retain their normal loading mechanism.

Load only the procedure needed for the current lifecycle step. Assistant activation includes the initial Pickup procedure; this index alone does not select or repeat Pickup on update or resume.

- sane-assistant-engineering-assistance: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md — Use after Engineering Pickup confirmation for solution work and mid-session requests.

- sane-assistant-engineering-delivery: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md — Use when preparing Engineering solution specs for review and delivery.

- sane-assistant-engineering-pickup: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md — Use when starting a new SANE Engineering Assistant session.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"sane-assistant-engineering-pickup","category":"procedure","source":"context/skills/sane-assistant-engineering-pickup/SKILL.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Initial lifecycle procedure","bytes":687}]

# SANE Engineering Assistant — Pickup

## Workstream Setup

1. Run `sane provide engineering` to supply missing starters.
2. Run `sane view` and link this session with `sane_link` (`slot: "engineering"`).

## Required Inputs

Read `design/SDD.md`, `<workstream>/resources/SOLUTION_SPEC_TEMPLATE.md`, and any existing solution specs relevant to the assignment. Ask the user about missing or unclear inputs.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced documents, and qualified sender identity from `From:`.

## Readiness and User Confirmation

Summarize the current state and solution areas to work on. Wait for the user to proceed.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"session","category":"session","source":"fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session","revision":"fixture-root-A","reason":"Explicit synthetic activation state","bytes":225}]
# Session
Synthetic experiment-owned session only.
root: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout/roots/A
No App project or workstream records exist.
[/SANE CONTEXT SEGMENT]
[SANE AUTHORED BODY {"bytes":143}]
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 transport: 9192 bytes · SHA-256: 9001549bc5f1f15455d3f3f8053cff208d78fe0dc022eb59d85c95b4e0124ef8

Placement: \{"kind":"bootstrap"\} · Origin: activation · Package revision: 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412

Ordered selection SHA-256: 20f39fb8ff323c9b63b30a584fc8a5ccbca417729cfc09972b9e17a3669a028f

### Selected segments

| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |
| --- | --- | --- | --- | --- |
| role\.assistant\.engineering / role | context/agents/sane/assistant/engineering\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selected main role activation | 449 + 1577 bytes | 84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0 |
| framework\.core / framework | context/framework/core\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 2288 + 1946 bytes | 0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421 |
| framework\.assistant / framework | context/framework/assistant\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 4506 + 1156 bytes | 6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43 |
| procedure\-index / procedure\-index | Pinned procedure index / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selective loading from pinned files | 5936 + 1511 bytes | 807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436 |
| sane\-assistant\-engineering\-pickup / procedure | context/skills/sane\-assistant\-engineering\-pickup/SKILL\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Initial lifecycle procedure | 7759 + 687 bytes | 0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59 |
| session / session | fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/synthetic\-session / fixture\-root\-A | Explicit synthetic activation state | 8764 + 225 bytes | 10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609 |

### Segment provenance (structured, not marker inference)

```text
[
  {
    "id": "role.assistant.engineering",
    "category": "role",
    "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
    "reason": "Selected main role activation",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "role.assistant.engineering",
        "source": "context/agents/sane/assistant/engineering.md",
        "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/role.assistant.engineering.md"
      }
    },
    "range": {
      "offset": 449,
      "length": 1577
    }
  },
  {
    "id": "framework.core",
    "category": "framework",
    "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.core",
        "source": "context/framework/core.md",
        "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.core.md"
      }
    },
    "range": {
      "offset": 2288,
      "length": 1946
    }
  },
  {
    "id": "framework.assistant",
    "category": "framework",
    "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.assistant",
        "source": "context/framework/assistant.md",
        "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.assistant.md"
      }
    },
    "range": {
      "offset": 4506,
      "length": 1156
    }
  },
  {
    "id": "procedure-index",
    "category": "procedure-index",
    "sha256": "807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436",
    "reason": "Selective loading from pinned files",
    "provenance": {
      "kind": "procedure-index",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "assets": [
        {
          "id": "sane-assistant-engineering-assistance",
          "source": "context/skills/sane-assistant-engineering-assistance/SKILL.md",
          "sha256": "a122256ecab01a9ecb487d3352ac69bea736668bb4112e35dfb392dbd7b5dbb6",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-delivery",
          "source": "context/skills/sane-assistant-engineering-delivery/SKILL.md",
          "sha256": "689edd20ee8d920f45a15d9849d2d3f3145a0ceede1d88f9be084895e50addac",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-pickup",
          "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
          "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
        }
      ]
    },
    "range": {
      "offset": 5936,
      "length": 1511
    }
  },
  {
    "id": "sane-assistant-engineering-pickup",
    "category": "procedure",
    "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
    "reason": "Initial lifecycle procedure",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "sane-assistant-engineering-pickup",
        "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
        "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
      }
    },
    "range": {
      "offset": 7759,
      "length": 687
    }
  },
  {
    "id": "session",
    "category": "session",
    "sha256": "10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609",
    "reason": "Explicit synthetic activation state",
    "provenance": {
      "kind": "fragment",
      "source": "fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session",
      "revision": "fixture-root-A"
    },
    "range": {
      "offset": 8764,
      "length": 225
    }
  }
]
```

### Recorded instrumentation trace

```text
load:context
prepare:start
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
revalidate:after-await
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
adapter:read-actual-pending
original:beforeNative
gate:sync-source-ownership-cancel
original:intent-durable
persist:injected-refusal-class-fault
failClosed:Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
failClosed:Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
failClosed:Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
lifecycle:terminate-mocked
adapter:read-actual-pending
original:outcome:not-submitted
persist:outcome:not-submitted
owner:settled
owner:retained-failClosed
lifecycle:admission-unconfirmed
lifecycle:settlement-denied
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered unknown; manifest expectation unknown is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 0 sends; expected 0\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** exact recorded bytes and ranges: Production submission decoder validated UTF\-8 ranges, framing, hashes and exact transport; this alone is not source trust\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** recorded failure has no mock effects: Zero sends is recorded mock instrumentation; durable projection independently must not establish submission/acceptance\.
- **PASS** scenario coverage boundary: partial: Owner closed this journal with partial coverage; Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; Owner health failure: Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; Owner health failure: Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; Owner health failure: Error: Uncertified context message pre\-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: unknown; expected unknown; Evidence coverage is not complete; missing history cannot establish freshness or admission
- **PASS** mock\-send\-count: 0; expected 0; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=11; execution=4; pairing=4
- **PASS** uncertified\-refusal\-fails\-closed: Refusal\-class decorator persistence fault is wrapped, sticky partial, terminated and owner retained; never certified as local pause

### Projection provenance

```text
[]
```

### Recorded scenario error

```text
Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
```

### Journal / verification issues

```text
Owner closed this journal with partial coverage
Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
Owner health failure: Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
Owner health failure: Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
Owner health failure: Error: Uncertified context message pre-native refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal; cause: Error: Injected decorator persistence failure, NOT an owner refusal
```

## attempt\-unresolved — One simulated effect / deliberately unknown outcome \(not a process kill\)

**PASS** · Recovered fact: **attempt\-unresolved** · Expected: attempt\-unresolved

Coverage: **complete** · Source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/attempt\-unresolved/events\.jsonl

Coverage reason: No additional coverage reason\.

Projection: Possible native execution with no confirmed submission; never automatically resend

### Exact original query

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "e5965fa2-2efe-4899-8d5e-f915095ecb68",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-80281c82-f2cd-4bec-bbd6-ce530b8dc467",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "ff8a9604-ae6b-4198-9d63-af3c1510ec8e",
    "nativeCommandId": "fixture-message-1effc0f0-24c5-40c2-8beb-f01da86d8046"
  },
  "messageId": "fixture-message-1effc0f0-24c5-40c2-8beb-f01da86d8046"
}
```

### Authored body (structured byte-range extraction)

```text
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 body: 143 bytes at offset 9049 · SHA-256: ba283d6d1837bcd64aaf70ca8e52e174311931a7c8391fdc3db06e39cc51ac5d

### Exact recorded outgoing transport

```text
[SANE CONTEXT MESSAGE v1]
SANE activation: these selected procedures and session details are composed on the user's behalf. The user directs the work and may change these conventions.
[SANE CONTEXT SEGMENT {"id":"role.assistant.engineering","category":"role","source":"context/agents/sane/assistant/engineering.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selected main role activation","bytes":1577}]

You are a SANE Engineering Assistant Agent.

SANE is a structured, reasonable way for people and agents to acquire and apply knowledge in service of deliberate change.

You write and update one document per solution area in `design/solutions/<name>.md`.
Start from the approved `design/SDD.md` and follow the supplied solution template.
Work with the user to make technical implementation decisions.

Perform the following setup steps:

1. Use the workstream, workstream root, and implementation root from your SANE Session context. If no workstream is listed, use `sane_link` with your phase slot and the agreed `workstream` to establish membership.
2. Run commands in the implementation root and resolve workstream documents from the workstream root.
3. Read `sane-assistant-engineering-pickup`, complete its steps, and report readiness. Wait for user confirmation before proceeding, including when the initial message is a handoff.

Once done, perform your role steps:

1. When the user confirms, read `sane-assistant-engineering-assistance` and follow it for the work and discussion with the user.
2. For later handoffs, follow Assistance. Give each outgoing `sane_handoff` a distinct `requestId`; recover delivery with `sane_handoff_status` using that ID. Finish independent work and end your turn; replies arrive as separate handoffs.
3. When ready for delivery, read `sane-assistant-engineering-delivery` and follow its steps.
4. If further changes are requested, return to Assistance.

If you get blocked in any of those steps stop and report to the user immediately.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.core","category":"framework","source":"context/framework/core.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1946}]
# SANE Context

## SANE

SANE means **Sane Agentic Noesis Edifice**. It is a structured, reasonable, and agile way for people and agents to acquire and apply knowledge in service of deliberate change.

A **workstream** groups the documents and state for an undertaking. Its documents describe current requirements, solutions, and outcomes; the CLI and sessions hold progress and collaboration history. Implementation happens in the target repository, not in a separate duplicate tree.

The user directs the work and makes decisions with the assistant.

There are 2 types of agents: **Assistants**, and **Workers**. Assistants work directly with the user while workers can be run by assistants to perform tasks.

You shall never talk about or reference workstream specific language or workflow in the implementation repository contents. Keep the meta-language separate from the implementation repository.

## Context

**Knowledge Gaps** are missing understanding needed to make a product,
design, or implementation decision—for example, how a feature should
behave or how a dependency integrates with the solution. They are often
visible in Design and Engineering documents.

**Operational Gaps** are missing procedures, tooling, or repository
context needed for agents to carry out assigned work—for example, how a
worker locates relevant code, prepares the environment, runs verification,
or updates artifacts. They are often visible in Planning and Execution
documents.

**Context Artifacts** preserve reusable knowledge and operational guidance
for future work. Skills and documentation are examples; the term is
independent of how that context is represented or stored.

## Lifecycle

Workstreams have a Main Track and Support Tracks.

The Main Track follows four phases: Design → Engineering → Planning → Execution.

Support Tracks may run alongside the Main Track to help resolve Knowledge Gaps and Operational Gaps along the way.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"framework.assistant","category":"framework","source":"context/framework/assistant.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Required standing framework","bytes":1156}]
## State

Follow your role's skills for the assigned work and coordination with other sessions.

View current status with `sane view` and use the CLI to record state.

1. **Pickup:** at new session start, read the assigned context and check required
   inputs. Confirm readiness and wait for the user to proceed, including when
   the session starts from a handoff.
2. **Assistance:** work with the user within the agreed scope. This may include
   handoff or handling updates from other sessions, following your role's skill.
3. **Delivery:** validate outputs with `sane validate <phase>` and present them
   for user review. Delivery may include handoff when the user requests it.
   If revisions are requested, return to Assistance and then Delivery.

## State Statuses

- `pending` — Not started.
- `in_progress` — Session is in progress.
- `delivered` — Phase work has been delivered.

A worker notification or consultation is not completion. Respond to an authorized ongoing child with `sane_worker_message`; retain its worker identity. Dispatch dependent work only after its terminal outcome. Ending your own turn permits asynchronous replies.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"procedure-index","category":"procedure-index","source":"Pinned procedure index","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Selective loading from pinned files","bytes":1511}]
# SANE private procedures

Resolve the SANE lifecycle procedure names in your role instructions using this index and the ordinary file-reading tool, rather than native Skill discovery. Other repository skills retain their normal loading mechanism.

Load only the procedure needed for the current lifecycle step. Assistant activation includes the initial Pickup procedure; this index alone does not select or repeat Pickup on update or resume.

- sane-assistant-engineering-assistance: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md — Use after Engineering Pickup confirmation for solution work and mid-session requests.

- sane-assistant-engineering-delivery: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md — Use when preparing Engineering solution specs for review and delivery.

- sane-assistant-engineering-pickup: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md — Use when starting a new SANE Engineering Assistant session.
[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"sane-assistant-engineering-pickup","category":"procedure","source":"context/skills/sane-assistant-engineering-pickup/SKILL.md","revision":"8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412","reason":"Initial lifecycle procedure","bytes":687}]

# SANE Engineering Assistant — Pickup

## Workstream Setup

1. Run `sane provide engineering` to supply missing starters.
2. Run `sane view` and link this session with `sane_link` (`slot: "engineering"`).

## Required Inputs

Read `design/SDD.md`, `<workstream>/resources/SOLUTION_SPEC_TEMPLATE.md`, and any existing solution specs relevant to the assignment. Ask the user about missing or unclear inputs.

## Initial Handoff Context

If the initial message is a handoff, retain the request, referenced documents, and qualified sender identity from `From:`.

## Readiness and User Confirmation

Summarize the current state and solution areas to work on. Wait for the user to proceed.

[/SANE CONTEXT SEGMENT]
[SANE CONTEXT SEGMENT {"id":"session","category":"session","source":"fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session","revision":"fixture-root-A","reason":"Explicit synthetic activation state","bytes":225}]
# Session
Synthetic experiment-owned session only.
root: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout/roots/A
No App project or workstream records exist.
[/SANE CONTEXT SEGMENT]
[SANE AUTHORED BODY {"bytes":143}]
﻿  Fixture-authored body 😀
[SANE CONTEXT MESSAGE v1]
[/SANE CONTEXT SEGMENT]
# Session
These are literal authored markers, not metadata.
```

UTF-8 transport: 9192 bytes · SHA-256: 9001549bc5f1f15455d3f3f8053cff208d78fe0dc022eb59d85c95b4e0124ef8

Placement: \{"kind":"bootstrap"\} · Origin: activation · Package revision: 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412

Ordered selection SHA-256: 20f39fb8ff323c9b63b30a584fc8a5ccbca417729cfc09972b9e17a3669a028f

### Selected segments

| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |
| --- | --- | --- | --- | --- |
| role\.assistant\.engineering / role | context/agents/sane/assistant/engineering\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selected main role activation | 449 + 1577 bytes | 84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0 |
| framework\.core / framework | context/framework/core\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 2288 + 1946 bytes | 0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421 |
| framework\.assistant / framework | context/framework/assistant\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Required standing framework | 4506 + 1156 bytes | 6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43 |
| procedure\-index / procedure\-index | Pinned procedure index / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Selective loading from pinned files | 5936 + 1511 bytes | 807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436 |
| sane\-assistant\-engineering\-pickup / procedure | context/skills/sane\-assistant\-engineering\-pickup/SKILL\.md / 8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412 | Initial lifecycle procedure | 7759 + 687 bytes | 0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59 |
| session / session | fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/synthetic\-session / fixture\-root\-A | Explicit synthetic activation state | 8764 + 225 bytes | 10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609 |

### Segment provenance (structured, not marker inference)

```text
[
  {
    "id": "role.assistant.engineering",
    "category": "role",
    "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
    "reason": "Selected main role activation",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "role.assistant.engineering",
        "source": "context/agents/sane/assistant/engineering.md",
        "sha256": "84f80eb43ee8273dd4c9e4a0882eabe6be5e11151d383498acfda266057062b0",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/role.assistant.engineering.md"
      }
    },
    "range": {
      "offset": 449,
      "length": 1577
    }
  },
  {
    "id": "framework.core",
    "category": "framework",
    "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.core",
        "source": "context/framework/core.md",
        "sha256": "0de77209f54926848fd6492c6af3464000dce67930b0f67876dd437015a34421",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.core.md"
      }
    },
    "range": {
      "offset": 2288,
      "length": 1946
    }
  },
  {
    "id": "framework.assistant",
    "category": "framework",
    "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
    "reason": "Required standing framework",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "framework.assistant",
        "source": "context/framework/assistant.md",
        "sha256": "6bcadd59bac6b12370f6376c2de1f3be2f80d711954a7dcbe7b07982ddf95a43",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/framework.assistant.md"
      }
    },
    "range": {
      "offset": 4506,
      "length": 1156
    }
  },
  {
    "id": "procedure-index",
    "category": "procedure-index",
    "sha256": "807295e5870d16017717efc8ee1d7463d5a3fb30d337d27bfb5acf057a03d436",
    "reason": "Selective loading from pinned files",
    "provenance": {
      "kind": "procedure-index",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "assets": [
        {
          "id": "sane-assistant-engineering-assistance",
          "source": "context/skills/sane-assistant-engineering-assistance/SKILL.md",
          "sha256": "a122256ecab01a9ecb487d3352ac69bea736668bb4112e35dfb392dbd7b5dbb6",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-assistance/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-delivery",
          "source": "context/skills/sane-assistant-engineering-delivery/SKILL.md",
          "sha256": "689edd20ee8d920f45a15d9849d2d3f3145a0ceede1d88f9be084895e50addac",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-delivery/SKILL.md"
        },
        {
          "id": "sane-assistant-engineering-pickup",
          "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
          "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
          "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
        }
      ]
    },
    "range": {
      "offset": 5936,
      "length": 1511
    }
  },
  {
    "id": "sane-assistant-engineering-pickup",
    "category": "procedure",
    "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
    "reason": "Initial lifecycle procedure",
    "provenance": {
      "kind": "asset",
      "packageRevision": "8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412",
      "asset": {
        "id": "sane-assistant-engineering-pickup",
        "source": "context/skills/sane-assistant-engineering-pickup/SKILL.md",
        "sha256": "0d7490ad72bb045bc626b39e76d09b3b2a9e2821725db70327231ca3da169f59",
        "path": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/data/context-packages/8f2f2b7523d1809ac05d17d0ca9b985d6c9196ac94c18d56da6ecd3238de7412/sane-assistant-engineering-pickup/SKILL.md"
      }
    },
    "range": {
      "offset": 7759,
      "length": 687
    }
  },
  {
    "id": "session",
    "category": "session",
    "sha256": "10518629436f44987a49253ddd2746dd1ff23a3c0a7f7f655d1907e746c5a609",
    "reason": "Explicit synthetic activation state",
    "provenance": {
      "kind": "fragment",
      "source": "fixture:/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/synthetic-session",
      "revision": "fixture-root-A"
    },
    "range": {
      "offset": 8764,
      "length": 225
    }
  }
]
```

### Recorded instrumentation trace

```text
load:context
prepare:start
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
prepare:complete
readiness:mocked
gate:sync-source-ownership-cancel
owner:installed-once
adapter:pending-captured
adapter:controlled-await
revalidate:after-await
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
pairing:real-full-validator
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:execution
load:context
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
gate:sync-source-ownership-cancel
load:context
adapter:read-actual-pending
original:beforeNative
gate:sync-source-ownership-cancel
original:intent-durable
persist:before-native:attempted
mock:effect
adapter:read-actual-pending
original:outcome:unknown
persist:outcome:unknown
mock:outcome-unknown-not-process-kill
owner:settled
owner:released
lifecycle:admission-admitted
lifecycle:settlement-denied
```

### Independent replay checks

- **PASS** recovered expected fact: Recovered attempt\-unresolved; manifest expectation attempt\-unresolved is not execution proof\. Accepted means simulated harness acceptance only\.
- **PASS** protected owner association: Exact original query dispatch/message/run/session/checkout association; no owner substitution\.
- **PASS** recorded scenario assertions: Recorded scenario assertions, not independently recovered native effects\.
- **PASS** recorded expected mock effects: Recorded instrumentation: 1 sends; expected 1\.
- **PASS** durable mock effect instrumentation: Recorded effect counters match exact message\-correlated mock hook records; these are simulated effects, not native proof\.
- **PASS** durable attempt precedes mock effect: The same owner journal orders the fsynced attempt before each scripted mock effect\.
- **PASS** exact recorded bytes and ranges: Production submission decoder validated UTF\-8 ranges, framing, hashes and exact transport; this alone is not source trust\.
- **PASS** independent protected role and pins: Verified owner\-selected context/execution revisions and pinned role/asset bytes; not selected from the message\.
- **PASS** unresolved attempt never authorizes resend: One scripted effect followed by unknown outcome remains unresolved; read\-only replay never sends, retries or repairs\. This is not a killed native process\.
- **PASS** scenario coverage boundary: complete: Possible native execution with no confirmed submission; never automatically resend

### Original recorded scenario checks (instrumentation)

- **PASS** restart\-fact: attempt\-unresolved; expected attempt\-unresolved; Possible native execution with no confirmed submission; never automatically resend
- **PASS** mock\-send\-count: 1; expected 1; simulated effects only
- **PASS** authored\-body\-preserved: UTF\-8 body including BOM/CRLF/emoji/SANE\-looking markers is preserved
- **PASS** one\-owner\-installation: Real registry\.start installs exactly one fixture RunOwner
- **PASS** measured\-load\-calls: Actual instrumented methods: context=11; execution=4; pairing=4
- **PASS** durable\-before\-effect: Original owner intent → synchronous composition persistence → single mock effect
- **PASS** honest\-unresolved\-effect: Explicit unknown outcome after one simulated effect; no process was killed, no exact acceptance and no retry

### Projection provenance

```text
[
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/attempt-unresolved/events.jsonl",
    "sequence": 6,
    "kind": "submission"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/attempt-unresolved/events.jsonl",
    "sequence": 7,
    "kind": "dispatch"
  },
  {
    "source": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/journals/attempt-unresolved/events.jsonl",
    "sequence": 10,
    "kind": "dispatch"
  }
]
```

## Restart corruption / missing-record variants

### torn

Directory: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/replay\-variants/torn

Fact: **unknown** · Coverage: **partial**

Coverage source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/activation/events\.jsonl

Coverage reason: Decoder reported a torn or unterminated tail; replay did not repair it; log: Demo journal: checkpoint log length/hash/count mismatch

Projection: Evidence coverage is not complete; missing history cannot establish freshness or admission

- **PASS** original activation query retained: Corruption never changes the query to fit surviving owner records\.
- **PASS** incomplete restart stays unknown: partial: Decoder reported a torn or unterminated tail; replay did not repair it; log: Demo journal: checkpoint log length/hash/count mismatch; read\-only, no resend\.

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "c664b96d-bc48-4cc0-9135-876a15c89469",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-51a3201e-7be3-4ba7-afcf-ed475e0d5daa",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "08c8854e-01ad-47fc-9e90-901f23fcb37e",
    "nativeCommandId": "fixture-message-53f142c4-c29d-4dba-a83d-6d4ef6c32829"
  },
  "messageId": "fixture-message-53f142c4-c29d-4dba-a83d-6d4ef6c32829"
}
```

### missing

Directory: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/replay\-variants/missing

Fact: **unknown** · Coverage: **partial**

Coverage source: /private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/journals/activation/events\.jsonl

Coverage reason: events\.jsonl: ENOENT: no such file or directory, open '/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/replay\-variants/missing/events\.jsonl'

Projection: Evidence coverage is not complete; missing history cannot establish freshness or admission

- **PASS** original activation query retained: Corruption never changes the query to fit surviving owner records\.
- **PASS** incomplete restart stays unknown: partial: events\.jsonl: ENOENT: no such file or directory, open '/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context\-engine\-demo\-check\.fOViT6/verified/replay\-variants/missing/events\.jsonl'; read\-only, no resend\.

```text
{
  "identity": {
    "source": {
      "harnessId": "mock-context-demo",
      "sessionId": "c664b96d-bc48-4cc0-9135-876a15c89469",
      "authorityId": "fixture-authority-0072eca1-8d31-45a0-9864-3c3a308e899e",
      "nativeSessionId": "fixture-native-51a3201e-7be3-4ba7-afcf-ed475e0d5daa",
      "cwd": "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-demo-check.fOViT6/verified/checkout"
    },
    "runId": "08c8854e-01ad-47fc-9e90-901f23fcb37e",
    "nativeCommandId": "fixture-message-53f142c4-c29d-4dba-a83d-6d4ef6c32829"
  },
  "messageId": "fixture-message-53f142c4-c29d-4dba-a83d-6d4ef6c32829"
}
```

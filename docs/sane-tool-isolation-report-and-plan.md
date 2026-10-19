# SANE tool isolation: investigation report and implementation plan

## Status and scope

- **Date:** October 19, 2026.
- **Status:** research complete for the bounded sample; solution proposed, not implemented or approved as a final design.
- **Request:** investigate ordinary OpenCode sessions calling SANE workers/tools, then propose a small fix that leaves vanilla harnesses and agents alone.
- **Runtime reviewed:** OpenCode v2.0.32.
- **Repository-name caveat:** the request named `silly-goose-style`. No matching directory appeared in the inspected project/session metadata, stored OpenCode directories, or current worktrees. The investigation used the likely intended repository, `/Users/beto/silly-goose-stats`. Findings below apply to that repository; the name mapping remains unconfirmed.
- **Changes made by this work:** this report only. No implementation, agent permissions, skills, context, enrollment, or runtime configuration was changed. No tests or browser verification were performed.

## Executive summary

SANE's globally installed OpenCode plugin exposes its tools to ordinary OpenCode agents. Those agents sometimes interpret the tools as general-purpose delegation, parent messaging, or session-context facilities.

The review found three distinct behaviors:

1. **Unwanted attempts:** native OpenCode children called SANE worker and parent-messaging tools. The inspected calls were rejected; no successful SANE-worker launch from an ordinary agent was found.
2. **Unwanted mutation:** an ordinary `build` session followed an unenrolled-context error's advice to call `sane_link` and enrolled itself without a user request to use SANE. Enrollment did not make it App-managed.
3. **Legitimate external bootstrap:** another ordinary session enrolled and queued a kickoff handoff after the user explicitly requested a workstream kickoff. A blanket ban would remove this useful path unless an explicit bootstrap mechanism replaces it.

The evidence supports **unconditional tool exposure and protocol confusion**, not a demonstrated SANE-skill-driven cause or a demonstrated bypass of worker admission authorization.

**Recommended direction:** keep vanilla OpenCode and its agent definitions unchanged. Reuse SANE's existing trusted caller qualification and App-owned execution evidence to authorize operations internally. Reject unknown callers without self-enrollment advice. Consider a single read-only, session-aware discovery entry point to reduce exposure, but only if ordinary sessions stop receiving the complete worker catalog automatically. Discovery must never grant authority, and every operation must retain its own authorization checks.

## Problem and design constraints

### The problem to solve

Installing SANE currently changes the tool choices visible to ordinary conversations, even when those conversations were not started or managed by SANE. Rejected calls waste work and confuse native subagent protocols. Accessible enrollment also permits an agent to mutate SANE state while trying to recover from an unrelated failure.

There are two separate boundaries:

- **Execution authorization:** which callers may perform a SANE operation?
- **Capability exposure:** which SANE tools and instructions should an agent see or discover?

Internal authorization is mandatory. Reducing exposure is a usability improvement that prevents unnecessary attempts; it is not a replacement for authorization.

### User constraints

- Leave the harness alone: ordinary OpenCode installations, agents, permissions, and native delegation should work without per-agent configuration changes.
- Enforce SANE access inside SANE's plugin/MCP and App boundaries.
- Prefer a focused change that reuses existing identity, execution bindings, and admission checks rather than a new authorization subsystem or large worker refactor.
- Do not treat enrollment, repository location, an environment variable, an agent-name prefix, or a caller-supplied session ID as sufficient authorization.
- Keep discovery read-only. Do not make every vanilla conversation perform a mandatory SANE probe.
- Preserve managed role restrictions, authorized child relationships, retry identity, continuation evidence, and uncertain-admission handling.

### Terms

| Term | Meaning in this report |
| --- | --- |
| Ordinary / standalone session | A native OpenCode conversation without evidence of SANE App-managed execution. It may still be in a SANE-enabled repository. |
| Native child | An OpenCode subagent session created through the harness's native delegation mechanism. Native parentage alone does not authorize SANE operations. |
| Enrolled conversation | A conversation registered in SANE's repository domain. Enrollment alone does not establish an App-owned session or run. |
| Managed session | A session for which SANE has authoritative management/execution evidence. The concrete check must reuse existing App ownership and execution mechanisms. |
| Authenticated-session approach | Trusted harness caller qualification plus SANE-side authorization of that identity and operation. It is not authentication by a raw session ID. |

## Research method and coverage

The investigation was read-only and used the `review-opencode-sessions` procedure, with SANE linkage inspection where needed.

1. Verified the installed OpenCode version, CLI help, and V2 API schemas.
2. Selected sessions using metadata before inspecting transcripts.
3. Started with five recent root sessions in `/Users/beto/silly-goose-stats`: scheduled pipeline checks, Pro-view restyling, logo/favicon, 404 styling, and NFL production deployment. None called SANE tools, and none had native children.
4. Expanded to **85 recent root sessions and 5,311 projected messages**, then inspected **44 descendants** of relevant scheduling, projections, and NFL-audit roots.
5. Examined captured instruction/catalog entries, relevant user assignments, tool arguments/results, native parentage, and available App/domain records.
6. Distinguished attempted tool calls, enrollment mutations, successful handoffs, and successful worker launches. A projected parent transcript was not assumed to contain complete child transcripts.

Classification used generic agent identities, native parentage, captured instructions, absence of captured SANE framework/context, App records, and rejection results—not titles alone.

All actual SANE calls listed below were made through `execute` and inner `tools.…` calls, rather than direct outer tool calls. Some additional events were tool searches only.

**Evidence provenance:** session and message references below come from the delegated read-only review, returned in OpenCode review session `ses_eaaf71bfeffeZMr2qF7EaQ12Pk`. Current source inspection corroborated the implementation paths. Current source is not, by itself, proof of instructions received by a historical session.

## Observed session evidence

### Case A: ordinary session followed error advice and enrolled itself

- **Session:** `ses_ec2f2478cffe7zi25Rk79GjN1P` — “Bounded-memory analytics loader fix.”
- **Date / agent / directory:** October 15, 2026; `build`; `/Users/beto/silly-goose-stats`.
- **User input:** `msg_13d0db877001vSeoRAQy4MGLpk` supplied a cancelled worker's implementation prompt for a local fix. It did not request restarting SANE management.

| Message | Outer `execute` call | Inner operation and result |
| --- | --- | --- |
| `msg_13d0db8cd001Sp6a38bU95djsN` | `call-f5b6cb88-b2c4-45c7-b612-d6d7fa980535-0` | `sane_context()` rejected the unenrolled caller and said: “Native conversation is not enrolled in this repository. Use sane_link explicitly.” |
| `msg_13d0dd13e001kiL9ccjZZfaE2g` | `call-cebc8e83-9ac3-44bb-9453-e4a0f6699ecd-4` | `sane_link({slot:"execution"})` failed with “Associate the conversation before assigning a phase.” |
| `msg_13d0ddc52001t93cNUSCKtQXer` | `call-34a2c776-4b21-47ba-a036-604e9d40eacb-6` | `sane_link({})` succeeded; workstream and phase were null. |

The review found SANE conversation `0afb433e-43e2-4d5c-b355-726894f1c34a`, but no corresponding App session, admission, worker, memberships, or captured SANE framework.

**Conclusion:** this is an observed self-enrollment chain, not merely a hypothetical effect of the error wording. It also proves why enrollment cannot stand in for managed identity. Current `linkNativeCaller` enrolls before assigning a phase, so the failed phase-assignment call may already have created the enrollment; the transcript does not establish which link call first persisted it.

### Case B: native implementation child attempted SANE delegation, then used native delegation

- **Root:** `ses_ebad63066ffeddYCn61zbMzpn6` — “Plan for Completing Pipeline Scheduling Implementation,” agent `build`.
- **User authorization:** `msg_145967a51001QozGMVySW5DDI7` authorized ordinary subagent delegation, not SANE enrollment or switching management protocols.
- **Root context probe:** October 16, 16:40 UTC; `msg_145969008001gymY7cnGpX0fMW`; call `call_afdb1f25cf494d14a58cc3c54f8906a4`; `sane_context()` returned the unenrolled error. The root subsequently used native subagents.

The relevant native child was `ses_eba68dc17ffeiLa4ha5KxlYmE8`, “Implement refresh orchestration foundations,” agent `task-implementer`:

| Time (UTC) | Message / outer call | Observed behavior |
| --- | --- | --- |
| October 16, 16:41 | `msg_145976098001AotEGwntASojuH` / `call_3956eaccd3dd45ca91a393a55d373c82` | Called `sane_worker_start({worker:"implementer", …})` to delegate staging reconciliation and projection-context gating. Rejected as unenrolled; no SANE worker launched. |
| Immediately afterward | `msg_145978427001vqN0Ut3QQk9QPu` / `call_ff335746c8624654b3c510d4aa25f2e2` | Successfully launched native child `ses_eba686165ffe3yHPRh5ntd4bLR` using OpenCode's `subagent` tool. |

**Conclusion:** a native child confused SANE's worker facility with harness delegation. The execution boundary rejected the attempt; catalog exposure still caused an unnecessary detour.

### Case C: native children used SANE parent messaging as generic coordination

Each actual call below was rejected as unenrolled. These are not successful parent-message deliveries or worker launches.

| Native child session | UTC time | Message | Intent |
| --- | --- | --- | --- |
| `ses_ebabf677cffe1vWyY8EDlLaIIB` — Implement S3 pipeline runtime | October 16, 15:07 | `msg_145413cf9001ZjI2ZnobNOGYFy` | Coordinate runtime contract through `sane_worker_message_parent`. |
| `ses_ebabf08ceffeKuKuHX4m7NHYHr` — Add shared pipeline ECS infrastructure | October 16, 15:07 | `msg_145414700001VIp1MWwFE8JscF` | Coordinate Docker/infrastructure work. |
| `ses_eba686165ffe3yHPRh5ntd4bLR` — Implement staging reconciliation | October 16, 16:42 | `msg_145984d8c001V2wHqw2476QgQS` | Confirm identity/race policy. |
| `ses_eba6930e3ffecktSTTcm5I5GRi` — Bootstrap and validate cloud refresh | October 16, 16:44 | `msg_1459986e00016ytmwJoo9AOtP9` | Send a progress report. |
| `ses_eb989638affejiwHyNnb4oI73Q` — Validate deployed pipeline automation | October 16, 20:48 | `msg_1467983ac001qJ995aGn9fnMTw` | Send validation progress. |
| `ses_eb9867887ffeUZD5oqMhmhFyeX` — Support native MoneyPuck download layout | October 16, 20:51 | `msg_1467ba588001mL5UQSsXdfGItH` | Warn about unsafe publication. |
| `ses_eb9506bfcffeBNV24B0hr4PHUm` — Implement requested pipeline cadences | October 16, 21:48 | `msg_146afc2e7001Kl7wcXAtUUNBhS` | Coordinate file ownership/interfaces. |
| `ses_eb8b63aa2ffeiaztwLEco7EF1b` — Audit NFL projection display | October 17, 00:43 | `msg_1475062ac0011p1NNdUN7Jb1R3` | Report implementation/hook dependency. |

These sessions used `task-implementer`. The last child's root was `ses_eb8b6840cffePr1AGErz8qvAY4`, “Implement player projections plan with subagent audits.” Its assignment explicitly prohibited delegation, yet parent messaging was still treated as a generally applicable coordination facility. Messaging should not be conflated with launching another worker, but it demonstrates the same protocol confusion.

Additional ordinary children probed `sane_context`: `ses_eb92fc28dffe3pvkvesnMaBbel` at `msg_146d06ed70012ay6SsBs8qMK3E`, and `ses_eb8fe66bcffeM3tR74CR6deX7C` at `msg_14701e8d70015YROnW8k1EKo2t`. Search-only evidence included parent-messaging discovery in `ses_eb9a9b1bdffebo183FHj9eokzD` at `msg_146573b400010rm76cOkswXTPZ`, and `sane_worker_wait` discovery in `ses_eb989638affejiwHyNnb4oI73Q` at `msg_1469330320019rtM8Yic4UjCo0`.

### Case D: authorized kickoff from an ordinary session

- **Session:** `ses_ec772c5deffeS73jzJOP0Yjb0p` — “Auditing NFL stats sources and matchup displays for NFL player stats feature.”
- **Date / agent / directory:** October 14, 2026; `build`; `/Users/beto/silly-goose-stats`.
- **Explicit user request:** `msg_138b45f4a001bTKT5ohZAIUl8q` requested “workstream kickoff handoff in a new worktree.”

| Message | Observed behavior |
| --- | --- |
| `msg_138b45f2a001VkRzqmlE5xWCUV` | Unenrolled context probe. |
| `msg_138b4723f001siz8nh2GhKPGuB` | Searched for `sane_handoff sane_link`; received schemas. |
| `msg_138b4ce9a001JrVJ4c9G1fuCrE` | Explicit enrollment succeeded. |
| `msg_138b4ddb5001qNe0fkKBbhdqbV` | Kickoff handoff queued successfully. |

Handoff `76ac1080-eb06-469c-b6a1-a8931c832121` subsequently completed delivery.

**Conclusion:** there is a legitimate bootstrap use case outside managed execution. Preserve it deliberately or replace it with explicit App/operator admission; do not accidentally remove it while tightening worker authorization.

### What the instruction evidence establishes

Captured `instruction_state.initial_values` and associated `instruction_blob` entries showed the SANE catalog injected into ordinary agents, including context, enrollment, handoff, and most worker tools. Some sessions received the complete `sane_worker_start` schema immediately.

No SANE skill was loaded before the representative erroneous calls. Captured repository instructions did not direct these agents to use SANE. The evidence supports exposure and protocol confusion; it does not establish a skill-driven cause.

The initial conversation recommendation about removing “Use sane_link explicitly” was based on source inspection and was initially a hypothesis. The completed session review subsequently confirmed the concrete chain in Case A.

## Current implementation and root causes

| Source | Relevant behavior |
| --- | --- |
| [`opencode/plugins/sane/index.ts`](../opencode/plugins/sane/index.ts), lines 26–50 | Registers worker, handoff, enrollment, and context tools unconditionally. Ordinary sessions can receive their schemas. |
| Same file, lines 52–62 | Installs a shell hook that attempts caller qualification and injects `SANE_CALLER_CONTEXT`, even when qualification fails. This is another integration surface to scope carefully. |
| [`packages/sane-cli/src/install-sane-agent-context-packages.ts`](../packages/sane-cli/src/install-sane-agent-context-packages.ts), runtime configuration installation | Publishes the native plugin into global OpenCode configuration. Scope is not automatically restricted to App-managed sessions. |
| [`packages/sane-cli/src/native-opencode.ts`](../packages/sane-cli/src/native-opencode.ts), `qualifyOpenCodeCaller` | Qualifies native caller identity against the selected local OpenCode registration and matching local/remote session evidence. This is useful existing infrastructure, not an App-management grant. |
| [`packages/sane-cli/src/native-caller.ts`](../packages/sane-cli/src/native-caller.ts), lines 43 and 144 | Unenrolled errors direct callers to `sane_link`. |
| Same file, `linkNativeCaller`, lines 151–160 | Opens with enrollment enabled before membership/phase work. Later failure is not proof that no enrollment mutation occurred. |
| [`packages/sane-cli/src/native-worker.ts`](../packages/sane-cli/src/native-worker.ts), lines 7–10 | Opens an enrolled native caller before sending a worker request. This rejected the inspected unenrolled worker attempts. |
| [`packages/sane-app/src/native-workers.ts`](../packages/sane-app/src/native-workers.ts), caller resolver contract and handler | Requires App-owned parent/run and invocation evidence, with additional continuation and Code Mode provenance requirements. Existing enforcement should be reused, not weakened or duplicated. |
| [`opencode/plugins/sane/execution.ts`](../opencode/plugins/sane/execution.ts) | Holds durable canonical execution bindings and validates managed roots/authorized native children. A source of existing management evidence, not a reason to trust agent-name prefixes alone. |
| [`packages/sane-app/src/canonical-agent-operations.ts`](../packages/sane-app/src/canonical-agent-operations.ts) | Renders operation-specific managed agent and child policies. Discovery must not broaden these role grants. |
| [`packages/sane-cli/src/native-worker-contract.ts`](../packages/sane-cli/src/native-worker-contract.ts), descriptions | Describes useful worker/messaging operations without a prominent standalone-session boundary, making them attractive as general coordination tools. |

### Root-cause distinction

1. **Global registration leaks capabilities into ordinary decision-making.** Discovery is not required when the schema is already in the prompt.
2. **Recovery guidance bridges from a rejected read to a mutation.** A context failure suggests enrollment; enrollment is callable by the same agent.
3. **Native and SANE protocols look interchangeable.** Tools named `message_parent`, `start`, and `wait` resemble general subagent facilities, but require different ownership and lifecycle evidence.
4. **Worker authorization is not shown to be bypassed.** The reviewed unsuccessful calls and existing App checks point to a visibility/interaction problem alongside a real enrollment-side-effect problem.

## Proposed solutions and tradeoffs

### Option 1: internal authorization and clearer rejection only

Reuse trusted identity qualification and existing App ownership/invocation checks. Add or consolidate a SANE-owned operation-eligibility decision where necessary. Unknown or enrolled-but-unmanaged callers receive a definitive non-mutating rejection; managed callers retain role-specific checks.

- **Advantages:** smallest behavioral correction; no vanilla agent edits; preserves the existing worker architecture.
- **Limitations:** advertised tools remain tempting, so ordinary agents may still attempt and receive rejections. Wording changes alone are not an authorization boundary.
- **Important:** most worker admission enforcement already exists. Inventory the gaps first; do not build a second authentication or binding store.

### Option 2: internal authorization plus one read-only discovery entry point

Expose one SANE-owned discovery/status entry point broadly instead of the full worker catalog. A qualified unknown session receives a stable result equivalent to “SANE is not active for this session,” with no enrollment, App admission, worker activity, or automatic recovery action. An authorized caller receives only its permitted capabilities.

The entry point is not mandatory for vanilla work, and its description should discourage use unless the user is asking for SANE functionality.

- **Advantages:** addresses both authorization and catalog confusion while keeping vanilla agents/configuration unchanged.
- **Limitations:** adding discovery alongside today's full catalog does not solve the observed issue. OpenCode already has Code Mode `search`; a second catalog is redundant unless it changes exposure or explains session eligibility.
- **Design constraint:** a discovery response cannot itself make a hidden native tool callable. Verify the installed plugin API's per-session inventory/Code Mode behavior before selecting an exposure mechanism. Do not toggle a location-global tool registry based on whichever session last called discovery.
- **Fallback if necessary:** a bounded SANE invocation gateway could dispatch discovered operations internally, but only after confirming it can preserve tool evidence, provenance, retry identities, cancellation, and existing policies. This is not the default first change.

**Recommended target:** Option 2, incrementally, with Option 1 as the first correction. Tool names and response schemas remain design decisions, not approved contracts.

### Option 3: manual per-agent permission changes

Deny `sane_*` in ordinary `build`, `plan`, `general`, and custom agent configurations; allow selected managed agents.

**Not recommended:** this makes vanilla users maintain SANE-specific permission rules, is easy to miss for custom agents, and conflicts with the stated product constraint. It was suggested earlier in the discussion and superseded by the internal-authorization direction.

### Option 4: separate OpenCode service/profile or project-only plugin loading

Load SANE only in an isolated harness runtime or selected projects.

**Not recommended as the default fix:** operationally heavier, does not distinguish ordinary and managed sessions sharing a project, and is unnecessary given existing ownership evidence. It remains an optional deployment-isolation choice, not a prerequisite for vanilla use.

### Bootstrap policy must be explicit

Discovery cannot authorize enrollment merely because an agent asks for it. Select one supported path:

- **Strict managed-only:** enrollment/kickoff admission happens through SANE's App/operator boundary. Ordinary sessions cannot bootstrap themselves through tools. Case D needs a documented replacement.
- **Controlled external kickoff:** preserve an explicit bootstrap operation with a trusted user/App approval or narrowly scoped capability. It may admit the requested kickoff but must not grant general worker authority to the caller.

Do not use an agent's assertion that “the user requested this” as authentication. Historical user text establishes the legitimate use case, not a sufficient runtime security mechanism.

## Recommended implementation plan

### Phase 1 — Specify and reuse the internal boundary

**Likely touchpoints:** native plugin handlers, `native-opencode.ts`, `native-caller.ts`, and the existing App worker caller resolver.

1. Map caller states: unqualified, qualified standalone, enrolled-but-unmanaged, managed root, authorized native child, and authorized bootstrap caller.
2. Map operations to the existing evidence they require. Management is necessary for worker operations but is not sufficient for every role; explicit protocol and parent/child rules still apply.
3. Identify the authoritative existing App records and canonical bindings to reuse. Account for supported legacy managed sessions and native continuations; do not assume canonical bindings are exhaustive without checking.
4. Make caller/session authority derive from trusted harness callbacks and selected registration/transport context, never model-supplied IDs or an agent-name regex.
5. Preserve App-side authoritative checks even if the plugin adds an early eligibility check. Avoid a new persistent binding store or a broad transport rewrite.

**Deliverable:** a small operation/caller-state matrix and a clear owner for each check. No changes to ordinary agent files or permissions.

### Phase 2 — Correct the rejection and bootstrap behavior

1. Remove self-enrollment advice from rejection paths used by ordinary worker/context callers. Prefer an explicit, stable not-managed result with no repair mutation.
2. Narrow tool descriptions to their managed scope. Descriptions are guidance, not enforcement.
3. Apply the selected bootstrap policy to `sane_link` and kickoff handoffs. Merely keeping enrollment reachable under a different name would preserve Case A.
4. Validate bootstrap prerequisites before persistence where possible, or make mutation semantics explicit. A rejected phase assignment should not silently serve as an enrollment back door.
5. Distinguish **definitively not admitted** from **admission unknown**. Only the first may safely direct ordinary agents back to native mechanisms. Preserve current warnings against duplicate starts or native fallback when a worker may already have been admitted.

**Deliverable:** ordinary tool misuse cannot change SANE state or coach itself into management. Intentional kickoff remains possible only through the chosen explicit path.

### Phase 3 — Prototype the smallest session-aware discovery surface

1. Check the installed OpenCode V2 API's inventory construction, direct tool exposure, Code Mode search/catalog, and execution paths. Documentation confirms plugin context is location-scoped and model requests capture tool snapshots; neither should be mistaken for a session-local mutable registry.
2. Choose the smallest supported SANE-internal exposure mechanism. Prefer preserving existing operation handlers and management evidence over creating a new invocation protocol.
3. For ordinary sessions, stop advertising worker/protocol schemas automatically. Keep discovery read-only and do not require it for native work.
4. For managed sessions, expose only role-authorized capabilities. Retain all handler checks against stale discovery, guessed names, direct calls, and replay.
5. Ensure two sessions sharing a directory/service cannot enable tools for each other. Do not mutate a global registry as a side effect of discovery.
6. If a gateway is required, document its provenance and invocation-identity implications before implementation; reassess whether that remains a small change.

**Deliverable:** a validated exposure design. This phase is deliberately conditional on API support; the research has not established a working per-session discovery implementation.

### Phase 4 — Limit integration side effects and prepare rollout

1. Scope SANE's shell caller-context injection to sessions/bootstrap flows that need it. Preserve explicit bootstrap compatibility chosen in Phase 2.
2. Review equivalent Claude MCP entry points for shared authorization consistency, without turning this OpenCode-focused fix into an unrelated transport migration.
3. Check runtime installation and reload behavior so source changes actually reach the installed plugin closure. Inventory reduction will affect future tool snapshots, not erase historical schemas/transcripts.
4. Document operator upgrade/reload steps. Do not automatically delete accidental enrollments or rewrite old sessions; identify them for explicit review if cleanup is desired.
5. Do not modify the global user configuration or restart running services without separate authorization.

**Deliverable:** a bounded rollout and compatibility note, not a harness configuration migration.

## Acceptance criteria and verification plan

The following are proposed verification scenarios, **not tests written or run by this report**. Only write/run focused tests or perform browser verification when separately requested, per repository policy.

| Scenario | Required outcome |
| --- | --- |
| Fresh vanilla root in a SANE-enabled repository | Native work functions without SANE-specific agent/permission edits; full SANE worker catalog is not automatically advertised under the selected exposure design. |
| Ordinary native child | Uses native report-back/delegation; SANE operations reject without enrollment or worker-side effects. |
| Unknown caller directly invokes a known SANE operation | Internal authorization rejects even if discovery was bypassed or a name/schema was remembered. |
| Enrolled but unmanaged caller | Cannot launch or coordinate SANE workers solely because enrollment exists. |
| Read-only discovery for unknown caller | Returns inactive/unavailable status; does not enroll, admit an App session, queue a handoff, mutate permissions, or launch a worker. |
| Managed root / authorized child | Existing role-specific tools and explicit worker protocol continue working; native ancestry and management evidence are checked. |
| Managed caller uses an unauthorized role/relationship | Existing operation/parent-child restrictions still reject it. |
| Shared directory and service, concurrent ordinary/managed sessions | No cross-session capability leakage or discovery-triggered global enablement. |
| Restart/reload, stale schemas, resumed sessions | Authorization is rechecked; no reliance on stale discovery or name prefixes. Existing continuation/retry rules remain valid. |
| Definite rejection versus uncertain admission | No duplicate starts or unsafe native fallback after an admission-unknown result. |
| Explicit external kickoff | Works only via the chosen trusted bootstrap path; does not grant unrestricted worker access. |
| Failed phase/bootstrap request | Mutation semantics are explicit; rejection cannot silently establish management authority. |

Suggested regression anchors are Cases A–D. Verify new behavior using purpose-built disposable sessions rather than replaying mutation calls into historical conversations. Preserve historical evidence; do not clean up enrolled records automatically.

## Open decisions and limitations

### Decisions to settle before implementation

1. Is external enrollment/kickoff supported through a trusted approval/capability path, or moved entirely to App/operator admission?
2. Should ordinary sessions see one optional discovery tool, or no SANE tool unless the user explicitly enters a bootstrap flow?
3. What installed V2 API mechanism can narrow per-session native/Code Mode inventory without ordinary agent edits or a global registry toggle?
4. Which existing records cover all supported managed sessions, including legacy sessions and authorized native children? Canonical execution bindings are a candidate, not a complete answer established by this review.
5. Which checks can run locally in the plugin for quick rejection, and which remain authoritative at App admission? Define unavailable versus unauthorized behavior without weakening fail-closed handling.

### Research limitations

- The requested `silly-goose-style` location remains unconfirmed.
- This was a bounded sample, not an exhaustive review of all repository history or every root's descendants.
- Current App metadata contained 307 OpenCode-parented workers in matching checkouts; none had a generic-agent parent. This supports the sampled finding of no ordinary-agent worker launch, but does not prove absence across alternate or deleted App stores.
- Older arbitrary agent-system prompts were not fully recoverable from the inspected instruction entries. Causal claims rely on captured catalog/instructions, assignments, calls, results, and available App/domain evidence.
- Captured tool visibility and current registration code establish exposure; they do not prove that every exposed schema caused an attempted call.
- No prototype established session-aware discovery/inventory behavior. Do not interpret the proposed interface or phases as a completed implementation.
- This report intentionally excludes raw transcripts, credentials, connection tokens, and broad database dumps.

## References

### Investigation evidence

- Delegated review: `ses_eaaf71bfeffeZMr2qF7EaQ12Pk`, “Review recent non-SANE sessions.”
- Case A self-enrollment: `ses_ec2f2478cffe7zi25Rk79GjN1P`; messages and calls listed above.
- Case B attempted worker launch: root `ses_ebad63066ffeddYCn61zbMzpn6`, child `ses_eba68dc17ffeiLa4ha5KxlYmE8`.
- Case C native messaging confusion: session/message table above.
- Case D authorized kickoff: `ses_ec772c5deffeS73jzJOP0Yjb0p`; handoff `76ac1080-eb06-469c-b6a1-a8931c832121`.

### Implementation and runtime documentation

- Source links in “Current implementation and root causes.” Line references describe the source inspected for this investigation and may move.
- [OpenCode V2 plugins](https://opencode.ai/v2/docs/plugins): global/local discovery, plugin loading and control.
- [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins): location-scoped context, transforms, hooks, and stable per-request tool snapshots.
- [OpenCode V2 MCP servers](https://opencode.ai/v2/docs/mcp-servers): Code Mode discovery, server tools, and context metadata. A session ID is correlation context, not authentication by itself.
- [OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions): tool actions and nested Code Mode enforcement. Relevant for understanding current behavior, not a recommendation to rewrite vanilla agents' permissions.

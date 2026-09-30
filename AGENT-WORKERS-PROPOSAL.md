# Proposal: Harness-native assistants & workers, worker tracking and visualization

Status: **proposal, not implemented**. Written 2026-09-29 for review.
Scope: sane-app (bridge + frontend), sane-cli installer/serialization. No changes to `./skills` or `./opencode/agents`.

**Principle: no fallbacks.** Every path fails fast with a clear error. No silent alternative executors, harnesses, endpoints or framing, unless explicitly specified later.

**Principle: preserve legacy agent configs (main).** Agent behaviour (permissions, models, temperatures, which workers an assistant may call) stays exactly as defined on `main`, unless a config has an obvious defect. The App and the installer carry those configs faithfully to each harness; they don't override them. Whether an agent wrote or didn't write something is a configuration/skill/context concern. **No extra rules, guardrails or write checks in code.**

Goal:

1. An assistant runs its **harness's own workers**: Engineering on CC → CC `sane-worker-*` subagents; Engineering on OC → OC `sane/worker/*` subagents.
2. Configuration of assistants **and** workers is explicit and predictable in both harnesses. It does not depend on the user's global settings.
3. When an assistant delegates to a worker, the App shows **what the worker is doing**: live status, and its messages, tools and final result in a read-only modal opened from the tool call.

---

## 1. Current state (as of this branch)

### 1.1 Where agents come from

- Source of truth: `opencode/agents/sane/{assistant,worker}/*.md` (OC format).
- `sane install context-packages` (`sane-cli/src/install-sane-agent-context-packages.ts`):
  - **OC:** copies to `~/.config/opencode/agents/sane/...` as-is. Workers are `mode: subagent`. Assistants declare which workers they may call via `permission.task`.
  - **CC:** serializes (`sane-cli/src/agent-serialization.ts`) to:
    - `~/.claude/agents/sane-{assistant,worker}-*.md` (frontmatter: name + description; body = prompt)
    - `~/.claude/sane-agent-settings/<agent>.settings.json` (permissions `allow` / `ask`)
  - Permission mapping: OC `task: {worker: allow|ask}` → CC `Agent(sane-worker-x)` in the matching list.
- Models:
  - No model on any worker (or assistant) by default, so **workers inherit the parent session's model** in both harnesses.
  - `--model-config` (`sane-cli/src/agent-model-config.ts`) can inject per-agent overrides at install time. The format is OC-only: `provider/model` + optional `variant`.

### 1.1b Parity with main (checked 2026-09-29)

- `opencode/agents/sane/**` and `models.yaml` are **identical to main**.
- The installer applies the same model config (`injectAgentModel`) and task validation (`validateAgentTaskPermissions`) as main.
- New on this branch: the CC projection (`sane-cli/src/agent-serialization.ts`). It maps OC permissions 1:1, keeping `ask` as `ask` and `allow` as `allow`. OC `deny` entries are dropped (CC deny precedence would block the named workers; unlisted tools stay unallowed). OC model overrides are not carried to CC.
- Where the branch **diverges** from legacy behaviour at runtime (fixed by A1): the App creates OC sessions without the agent (legacy `sane handoff` created them with `agent` + the agent's model).

### 1.2 How the App launches assistants

| | Claude Code | OpenCode |
|---|---|---|
| Launch | `claude -p --output-format stream-json --verbose` + `--agent sane-assistant-<role>` + `--model` / `--effort` + per-run settings file (hooks + permissions merged from `sane-agent-settings`) | Managed OC service (`src/opencode.ts`). `prompt(id, commandId, text)` posts only `{id, text}` |
| Assistant is the real SANE agent | ✅ yes | ❌ no. `bridge.ts:988-993` prefixes the prompt with `[SANE role: X assistant …]`. The session runs OC's **default agent** |
| Workers native to harness | ✅ Agent tool → `~/.claude/agents/sane-worker-*` | ⚠️ OC subagents exist, but the assistant's `permission.task` scoping is **not applied** (not running as that agent) |
| Worker delegation reliably allowed | ⚠️ `Agent(sane-worker-*)` and `Bash` are in **ask**. The App passes no `--permission-mode` and relies on the user's global `permissions.defaultMode: "auto"`. On another machine / default mode, `-p` runs would deny or stall | ⚠️ unscoped |
| Worker model | inherits the parent | inherits the parent |

### 1.3 Tracking and visualization

- **CC stream:**
  - With `--verbose`, subagent messages come through stream-json tagged `parent_tool_use_id`.
  - `frontend/cc-reducer.ts` (`record()`, the assistant branch) **ignores** that field. Subagent messages would be merged into the main thread, or dropped depending on the message id.
  - `src/reconcile.ts:77` **skips** `parent_tool_use_id` / `parent_agent_id` records when reconciling native history.
- **CC hooks:** `SubagentStart` / `SubagentStop` are registered in `bridge.ts:24` `hookEvents` and land in the run's diagnostic events. The UI doesn't use them, except in the raw "Hooks" list in run details.
- **OC:** a worker is a **child session** (`parentID` = assistant session). The App observes only the pinned session, so child sessions are invisible.
- **UI:** `frontend/thread.tsx:42-44` renders every tool part as a generic `<details className="tool">`: name + status ("Working" / "Result" / "No result recorded") + raw JSON input/output. There is no worker identity and no progress. The output appears only when the worker returns.

---

## 2. Part A: Configuration

### A1. OC sessions run the real assistant agent (required for goal 1)

**Legacy (main) already did this.** `main:packages/sane-cli/src/sane-handoff-command.ts:387-430`:

1. `GET /api/agent?location[directory]=<repo>` → find the entry with `id === "sane/assistant/<role>"` and read its configured `model` (`{id, providerID, variant?}`).
2. `POST /api/session` with `{ agent, model?, location: { directory }, title? }`.
   The comment there: "previously sessions came up as the default Build agent".

**The App today drops the agent in three places:**

- `src/opencode.ts:86` `create(cwd, model, effort)`: no `agent` in the body.
- `src/bridge.ts:952`: new OC conversations → `oc.create(cwd, model, effort)`, plus prompt framing at `bridge.ts:988-993`.
- `src/bridge.ts:185`: OC **handoff recipients** → `oc.create(cwd)`. Handoffs to OC in the App lost the legacy behaviour too.

**Plan:**

- `opencode.ts`:
  - `create(cwd, { agent?, model?, effort?, title? })` → `POST /api/session { agent, model?, location }`
  - `agents(cwd)` → `GET /api/agent` (cached per cwd) to resolve the agent's configured model when the profile's model is `""`
- Model precedence for an OC assistant session:
  1. profile model/effort, if set
  2. otherwise the agent's configured model from `/api/agent` (models.yaml via the installer)
  3. otherwise the harness default

  This is the same as legacy when the profile is left at its defaults.
- `bridge.ts:952` and `bridge.ts:185`: pass `agent: "sane/assistant/<role>"` for assistant profiles and handoff recipients. Base passes none.
- Remove the `[SANE role: …]` role framing entirely (both harnesses). Assistant sessions are always created as assistants.
- **Decision: no in-session Base → assistant upgrade (either harness).** An assistant session only comes from:
  1. a new conversation that picks an assistant profile in the composer
  2. **kickoff**: a Base (or any workstream-less) session → `sane_handoff` with `kickoff` + `createNew` → a new **Design** session
  3. **phase handoff with `createNew`**: every later phase (Design → Engineering → Planning → Execution, Research, Knowledge) gets a new session of its role

  Changes this implies:
  - `agent-profiles-contract.ts` `canAssign`: once a session exists, no profile change at all. The "Base session → assistant, same harness" branch is removed; the reason becomes "Start a new session or use a kickoff/handoff".
  - `bridge.ts` POST `/api/sessions`: drop the Base → assistant upgrade path (and the legacy follow-up `agent` → template mapping near line 901, which then just rejects).
  - Frontend `store.ts` / `agent-picker.tsx`: drop `Draft.upgradeId` and the "upgrade" mode of the picker. On an existing session the agent chip is read-only.
  - Existing sessions already upgraded keep working (their `profileId` is kept); only new transitions are blocked.
  - Tests in `tests/agent-profiles.test.ts` covering Base → assistant upgrade are inverted to expect rejection.

### A2. Assistant permissions: keep legacy `ask` semantics

The legacy configs deliberately put `bash: ask` on assistants, and `task: ask` for the workers Design and Engineering may call (Knowledge uses `effect: ask`). In the OC TUI, the user approves these. The CC projection already preserves them as `ask`.

**Decision: don't override.** No App-side allow lists, no forced `--permission-mode`, and no serializer changes to turn `ask` into `allow`.

- The App's job is to **surface** those prompts in the assistant session for both harnesses. OC: the App already supports permission replies. CC: verify the PermissionRequest hook → App reply path works for `-p` runs, and treat it as an App gap if not (not a config change).
- The user's global `defaultMode: auto` currently masks CC prompts. That's the user's own setting, left as is.

### A3. Worker models different from the parent

**OC** already supports this via the installer's model config (`models.yaml` on main pins e.g. `sane/worker/implementer: gpt-6-sol high`, `sane/worker/scout: gpt-6-luna max`). The OC agent file gets `model:` + `variant:` injected.

**CC** mechanisms (CLI 2.1.285), from most to least suitable:

| Option | Scope | How | Notes |
|---|---|---|---|
| **A3.a** Frontmatter `model:` (+ `effort:`, verify) in `~/.claude/agents/sane-worker-*.md` | Global default | Installer writes it from the model config | Accepts aliases (`opus`, `sonnet`, `haiku`), full ids (`claude-sonnet-5-5`), or `inherit`. Needs a CC section in the model config, since today it only accepts OC `provider/model` |
| **A3.b** `--agents <file>` per run | Per profile / per run | Bridge writes a JSON file redefining `sane-worker-*` (prompt body read from the installed md + `model`) and passes `--agents <path>` (with `--print` it takes a file path) | CLI-defined agents take precedence over user agents. No reinstall. Enables "Engineering (fast)" profiles with different worker models |
| A3.c `CLAUDE_CODE_SUBAGENT_MODEL` env per run | All workers of a run | Bridge sets env | Trivial but coarse (one model for every worker) |
| A3.d Agent tool `model` param | Per call, chosen by the assistant | The model decides | Not deterministic. Don't rely on it |

**Optimal CC config:**

- A3.a for defaults, with one model config file holding both harness sections:
  ```yaml
  opencode:
    sane/worker/implementer: { model: openai/gpt-6-sol, variant: high }
  claude-code:
    sane-worker-implementer: { model: claude-opus-5-5, effort: high }
    sane-worker-scout: { model: claude-haiku-4-5-20251001 }
  ```
  (The legacy flat format stays = the OC section.)
- A3.b for App per-profile overrides later (`workerModels` on assistant profiles).

**Hard limit:** CC subagents can only run Claude models (Anthropic API / Bedrock / Vertex / a gateway), and OC subagents only models configured in OC. A GPT worker under a CC Opus assistant (or the reverse) is **not possible with native subagents**. That needs A5.

### A4. Worker visibility in Settings (optional, read-only)

In Settings → Agents, each assistant card lists "Workers it can call", read from the installed agent files (CC settings allow/ask, or OC `permission.task`), with the effective model ("inherits"). This is read-only, since workers are context files and stay out of App editing for v1.

### A5. App-managed worker sessions (cross-harness workers)

Instead of (or alongside) native subagents, workers become **top-level App sessions** launched through a SANE tool, the same machinery as handoffs.

**Shape:**

- **Worker profiles:** `AgentProfile.kind` gains `"worker"`, `role` = worker id (implementer, scout, …), with harness + model + effort + visuals, the same as assistants. There are builtin templates per worker. An assistant profile optionally maps `workers: { implementer: <profileId>, … }`, with a global default mapping.
- **Tools** (sane MCP for CC, OC plugin for OC, both already exist for handoffs):
  - `sane_worker_start({ worker, prompt, context? })` → `{ workerId }`. The bridge creates a session with `--agent sane-worker-<x>` (CC) or `agent: sane/worker/<x>` (OC) using the mapped profile's harness/model, in the parent's cwd/checkout.
  - `sane_worker_wait({ ids, timeoutSec ≤ ~240 })` → finished results + still-running ids. Bounded, so it stays under MCP tool timeouts; the assistant loops. Supports fan-out/join (scout-crew).
  - `sane_worker_status({ ids })`.
  - (Optional) `sane_worker_cancel`.
- **Session record:** `kind: "worker"`, `parentSessionId`, `parentRunId`, `parentToolCallId`, `workstreamId`.
  - Title: `[<workstream>] Implementer · <task head> ← Engineering`.
  - Hidden from the sidebar by default; History view gets a "Workers" filter/tag; the parent's tool card links to the worker session.
- **Lifecycle:**
  - cancelling the parent run cascades to its running workers
  - depth limit (e.g. 2) for nested workers
  - bridge admission limits concurrency
  - shared-checkout write rules apply (`sharedCheckoutWrites`)

**What it buys (mid–long term):**

| Area | Native subagents | App-managed worker sessions |
|---|---|---|
| Model choice | Same vendor as the harness only | **Any model on any harness** (Opus assistant + GPT-6 implementer, or the reverse) |
| Config surface | 3 places (OC md frontmatter, CC md frontmatter, models.yaml) | **One**: Agent Profiles in Settings (the same UI as assistants) |
| Observability | Harness-specific plumbing (CC `--forward-subagent-text` + `parent_tool_use_id`; OC child-session following) | **Free**: every worker is a normal session with an event log, run details, usage, and history |
| Control | Can't stop individually; lost on crash | Individually cancellable, resumable, re-promptable; survives App restarts |
| Accounting | Folded into the parent's usage | Per-worker cost/tokens |
| Audit | None | sane-core audit trail like handoffs |
| Startup overhead | Low (in-process; harness already initialized) | Higher: a new process/session per worker (CC boots its settings, hooks and MCP servers; seconds) |
| Prompt cache | Worker has its own system prompt + tools, so it does **not** reuse the parent's cache either (only CC fork-style subagents do); it reuses its own prefix across calls within the TTL | Same as native for same-vendor workers (caching is server-side and prefix-based, not tied to the process). Cross-vendor: each provider caches independently |
| Sync semantics | Natural: the tool call returns the result | Async: start + bounded wait loop; more tool calls in the parent's context |
| Context files | Work today (`task` / `Agent` tool) | Assistant agents/skills must learn `sane_worker_*` (**context-file edits, owned by you**) and permissions must allow the tools |
| Offline / terminal use | Works in plain CC/OC terminals | Requires the App bridge running; `sane_worker_*` fails fast when it isn't |

**Assessment:** mid–long term this is the stronger architecture. It makes the App the orchestrator and harnesses interchangeable executors, which is the direction Agent Profiles already point. It also meets the real need visible on main (`models.yaml` pins GPT-6 variants per worker, which a CC assistant can never use natively), and it removes most of Part B, since worker visualization becomes "open the worker session". The costs are startup overhead, an async tool protocol, and context-file changes. The prompt-cache cost is small: see the cache row.

**Recommended path (hybrid):**

1. Keep native subagents as the default and for cheap/fast read-only fan-out (scout, scout-crew), where latency matters and the parent's model/vendor is fine. Do A1 + A2 + A3.a now.
2. Add worker profiles + `sane_worker_*` tools as an opt-in for heavy workers (implementer, fixer, tester, researcher, reviewer), where model choice, control and visibility matter most.
3. Part B is then needed only for the native subagents (CC `--forward-subagent-text`, OC children). It could even be limited to a lightweight status card, with rich viewing reserved for App-managed workers.

### A6. Direction: Claude assistants, OpenCode worker pool (heuristic, not a hard rule)

Caching is not a differentiator: SANE is context-conservative by design, and cross-session cache loss is small. The deciding factor is **executor quality**:

- **OpenCode** runs as a persistent managed service. Creating a session is an HTTP call with no process boot, and it provides event streams, per-session cancel, child sessions, any configured provider/model, and live model/variant changes.
- **Claude Code** is a process per run: a startup cost each time, and Claude models only.

**Default heuristic:**

- Assistants: CC with Claude (planning/judgement, subscription billing).
- App-managed workers (A5): **OpenCode by default**, any model (GPT-6 Sol/Luna/Astra, or Claude via API key).
- Native CC subagents stay for quick read-only fan-out (scout, scout-crew) inside CC assistants.

The heuristic lives only in **data**, not code:

- builtin worker templates default to `harness: "opencode"`
- the assistant → worker mapping picks the profiles

Changing direction later (e.g. if CC gains a server mode; CLI 2.1.285 already ships `claude --bg` / `claude agents` / `attach` background sessions worth re-evaluating) means editing profiles, not the architecture.

**Keep the bridge harness-agnostic:**

- A `WorkerExecutor` interface: `start(profile, prompt, cwd, parent) → workerId`, `wait(ids, timeout)`, `cancel(id)`, `events(id)`.
- Implemented first for OC (reusing `src/opencode.ts`: `create` with `agent: sane/worker/<x>` + model, `prompt`, activity, cancel).
- The CC implementation reuses the existing run launcher (`--agent sane-worker-<x>`), available but not the default.

**Things to design for with OC workers:**

- **Permissions: workers already have no `ask` (legacy).** Every `sane/worker/*.md` file uses allow/deny only (`ask: deny`, `question: deny` where set). The CC projection keeps that. Nothing to override.
  - If a harness still raises a permission or question in a worker session, the worker session shows it as pending, and the parent's worker card shows "Waiting: permission/question". The user can open the worker session from the parent (A5 link) to see what happened. **Answering from the UI is out of scope**, and there is no auto-approval.
- **Checkout sharing:** workers always run in the parent's cwd/worktree. Cross-worktree workers are out of scope. Concurrency is a simple per-checkout worker limit (A7).
- **Availability:** if the OC service (or the mapped harness) is unavailable, `sane_worker_start` fails fast with a clear error. **No fallback** to another harness or executor.
- **Billing:** Claude models on OC use API-key billing, not the Claude subscription. Another reason to keep Claude on CC as assistant and use OC for other vendors' models.

### A7. Worker catalog and access classes (writer vs read-only)

**Today there is no such field.**

- `sane-core/src/agent-catalog.ts` catalogs only assistants (`ASSISTANT_AGENT_IDS`, labels, descriptions).
- Workers are known only from their agent files. The only signal is the OC `permission.edit` in `opencode/agents/sane/worker/*.md`:

| Worker | `edit` | `bash` | What it actually writes |
|---|---|---|---|
| implementer | allow | allow | implementation code |
| fixer | allow | allow | implementation code |
| tester | allow | allow | test code + Test Report |
| grounder | allow | allow | SANE artifacts (Job Spec context) only |
| researcher | allow | allow | SANE research outputs only |
| reviewer | deny | allow | nothing (read-only) |
| scout | deny | allow | nothing (read-only) |
| scout-crew | deny | allow | nothing (read-only; spawns scouts) |

`edit` alone isn't enough (grounder/researcher can edit but only touch SANE artifacts), so the class is declared in the catalog. It's **descriptive only**: a tag for organization and display. It is not enforced and not validated against what an agent actually wrote; that stays a config/skill concern. The legacy permissions themselves stay as they are.

**Proposal:** add a worker catalog to `sane-core/src/agent-catalog.ts` (implementation file, not a context file):

```ts
export const WORKER_AGENT_IDS = ["implementer", "fixer", "tester", "grounder", "researcher", "reviewer", "scout", "scout-crew"] as const;
export type WorkerAccess = "code" | "artifacts" | "read";
export const WORKER_ACCESS: Record<WorkerAgentId, WorkerAccess> = {
  implementer: "code", fixer: "code", tester: "code",
  grounder: "artifacts", researcher: "artifacts",
  reviewer: "read", scout: "read", "scout-crew": "read",
};
// + WORKER_AGENT_LABELS / DESCRIPTIONS like the assistant catalog
```

- Worker profiles (A5) carry `role: WorkerAgentId`. The access class comes from the catalog (not user-editable), so a custom "Implementer (GPT-6 Sol)" profile is still `code`.
- Worker sessions store `workerRole` + `access`, shown as a tag in History and on the worker card.

**Admission: one simple limit.**

- Max **4 running workers per checkout** (cwd/worktree), configurable in Settings → Application. The access class isn't used for admission; planning decides how many writers run together.
- Over the limit → `sane_worker_start` **rejects** with a clear capacity error (fail fast, no queueing). The assistant decides whether to wait on running workers and retry.
- Worker runs also count toward the bridge-wide `maxConcurrentRuns` (default 16, `bridge.ts:88`).

---

## 3. Part B: Tracking worker runs

### B0. Spike first (small, required)

Before building, confirm on real runs:

1. `claude -p --output-format stream-json --verbose --agent sane-assistant-engineering` with a prompt that delegates to a worker:
   - Are worker `assistant` / `user` records emitted with `parent_tool_use_id`?
   - Are they emitted live or only at the end?
   - What do `SubagentStart` / `SubagentStop` hook payloads contain (`agent_id`, `agent_type`, `agent_transcript_path`)?
   - How do they correlate to the parent `tool_use` id?
2. OC:
   - Which event or message-part field links a child session to the parent's `task` tool part (e.g. `part.state.metadata.sessionId`)?
   - Does the managed service expose child session events on the same stream?

Record the findings in this doc (section 6).

### B1. Common data model (frontend `types.ts`)

```ts
type WorkerRun = {
  id: string;              // CC: parent tool_use id; OC: child session id
  parentToolId: string;    // `${run.id}:${toolUseId}`, the Agent/Task tool part in the assistant thread
  agent?: string;          // "sane-worker-implementer" | "sane/worker/implementer"
  description?: string;    // tool input description/prompt head
  status: RunStatus;       // running → completed/failed/interrupted
  startedAt: string; endedAt?: string;
  messages: Message[];     // same shape as the main thread (reuse renderers)
  toolCount: number;
  lastActivity?: string;   // e.g. "Edit frontend/store.ts"
  parentWorkerId?: string; // nested workers (scout-crew → scout)
};
// Run gains: workers: Map<string, WorkerRun>
```

This is derived from the run's event log that the bridge already persists. No new storage for CC.

### B2. Claude Code

Options:

| Option | How | Live? | Survives reload / old runs? |
|---|---|---|---|
| **B2.a** Stream routing (recommended) | Launch with `--forward-subagent-text` (CLI 2.1.285: forwards subagent text/thinking as messages with `parent_tool_use_id`; only with `--print` + stream-json). In `cc-reducer.ts` `record()`, if `r.parent_tool_use_id` is set, route to `run.workers[parent]` using the same parsing as the main thread; never merge into `run.messages` | ✅ | ✅ (replayed from events) |
| **B2.b** Hooks for lifecycle | `SubagentStart` → status running + agent type; `SubagentStop` → completed + transcript path | ✅ | ✅ |
| **B2.c** Transcript read (only if the B0 spike shows the stream omits worker records) | Bridge endpoint `GET /api/runs/:id/workers/:wid/transcript` reads `agent_transcript_path` from SubagentStop (under `~/.claude/projects/...`), with path validation | ❌ (post-hoc) | ✅ even if the stream lacked the records |

**Recommendation:** B2.a + B2.b. B2.c only if the spike shows the stream omits worker records. Also make `reconcile.ts` keep skipping worker records for the main history, but expose them grouped if B2.c is used.

### B3. OpenCode

Options:

| Option | How | Notes |
|---|---|---|
| **B3.a** Follow child sessions in the bridge (recommended) | When a run is active, the bridge subscribes to/polls sessions with `parentID === session`, and appends their message snapshots to the run log as events tagged `{ worker: { id, parentToolId, agent } }`. The frontend reducer builds `WorkerRun`s the same way as for CC | Links via the task part metadata; handle nested children recursively (depth limit) |
| **B3.b** On-demand fetch | Only when the modal opens: `GET /api/sessions/:id/workers/:childId/messages` proxies OC | Simpler; no live list in the thread; loses history if OC prunes |
| B3.c Ignore OC | CC only | Breaks the "both harnesses" goal |

**Recommendation:** B3.a, with B3.b as the first step if B3.a turns out expensive. The modal works for both, and the live list follows.

### B4. Bridge API (either harness)

- `GET /api/runs/:runId/workers` → `WorkerRun[]` summaries (for history view and clients that don't replay events).
- `GET /api/runs/:runId/workers/:workerId` → full messages (B2.c / B3.b backing).
- Events stay the source of truth. These endpoints are projections.

---

## 4. Part C: Visualization

### C1. Worker tool card (thread)

Replace the generic tool `<details>` for `Agent` / `Task` tool parts (`thread.tsx:42-44`) with a `WorkerCard`:

- avatar + short name ("Implementer", derived from `sane-worker-implementer` or `sane/worker/implementer`) + the description from the tool input
- status: spinner / elapsed time / "N tools" / last activity line (e.g. "Editing frontend/store.ts")
- when done: the first lines of the result + duration
- **"View output"** button → C2
- keeps the raw input/output behind a small "Raw" disclosure for debugging

### C2. Worker output modal

- Built on the existing `ShellDialog` (wide variant). Read-only, live-updating, auto-scroll with "jump to latest".
- Header: worker avatar/name, harness, model (observed if available), status, elapsed time.
- Body: reuses the thread's message/tool renderers on `WorkerRun.messages`.
- Final report pinned at the top once completed.
- Nested workers: breadcrumb (Scout Crew › Scout 2) or tabs, each clickable.
- Footer note: "Workers can't be stopped individually. Cancel the run to stop all work."
- Deep-linkable: `?worker=<id>` on the session route (optional).

### C3. Run details drawer

Add a "Workers · N" section listing each worker (agent, status, duration, tool count) with "Open" → C2.

### C4. Optional extras (later)

- Composer/status bar: "2 workers running" indicator on the active run.
- History search indexes worker text (off by default; can get noisy).

---

## 5. Suggested order

1. **B0 spike** (CC + OC, ~1 short session). Record the findings below.
2. **A1** OC runs the native assistant agent (depends on the API check).
3. **A2** verify the CC PermissionRequest → App reply path for assistant `ask` prompts (no config changes).
4. **B2.a + B2.b** CC worker tracking in the reducer.
5. **C1 + C2** worker card + modal (CC first).
6. **B3** OC child-session tracking reusing the same UI.
7. **C3** run details workers list.
8. Verification agents: targeted integration tests, no mocks beyond the existing claude-stub pattern:
   - CC: the claude stub emits a worker stream with `parent_tool_use_id` + hook events → the worker is grouped under the right tool, the main thread is untouched, status transitions happen
   - OC: the child session is linked to its task part and appears as a worker
   - permission: a CC assistant `ask` prompt (e.g. Bash) is surfaced and answerable in the App session
9. Later, if wanted: A3 worker models, A4 read-only worker listing.

## 6. Decisions for review

- [x] **A2:** keep legacy `ask` on assistants; the App surfaces prompts (verify the CC PermissionRequest reply path); no permission overrides.
- [x] **A1:** no in-session Base → assistant upgrade; assistants only via new conversation, kickoff (→ Design), or `createNew` phase handoffs.
- [ ] **A3:** CC worker defaults via installer frontmatter (A3.a) with a two-section models.yaml; per-profile `--agents` later (A3.b).
- [ ] **A6:** confirm the default heuristic: CC/Claude assistants + OC worker pool; `WorkerExecutor` with OC first.
- [ ] **A7:** worker catalog with a descriptive `access` tag (not enforced); limit 4 running workers per checkout; reject over limit (no queue).
- [ ] **A5:** adopt App-managed worker sessions as opt-in for heavy workers (hybrid) vs. full switch vs. not now.
- [ ] **B3:** live child-session following (B3.a) vs. on-demand fetch first (B3.b).
- [ ] **C2:** nested workers as breadcrumb vs. tabs.
- [ ] **A4:** read-only "workers it can call" list in Settings: yes/no.

## 7. Spike findings

_(to fill after B0)_

- CC stream worker records: …
- CC hook payloads: …
- OC child ↔ task link field: …
- OC prompt endpoint accepts `agent`: …

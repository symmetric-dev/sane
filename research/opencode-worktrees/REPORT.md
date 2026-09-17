# OpenCode Git Worktrees — External Evidence Report

- Baseline: `/Users/beto/sane/alpha/docs/SANE_0_2_0.md` (Sections 2 and 4 — SANE assumes
  SANE-managed worktrees: `sane/<user>/<slug>` branches, `<dir>/<user>/<slug>` paths,
  `merges` row with `branch`/`base_rev`/`merge_commit`), supplied revision as read 2026-09-17.
- Consumer: `/Users/beto/sane/alpha/opencode/agents/sane/assistant/execution.md`
  (Execution assistant creates/cleans worktrees today).
- Relationship: this report is read-only evidence for the launcher's architecture decision
  (SANE-managed worktrees vs OpenCode-native handling). It changes no baseline.
- Local OpenCode binary: `opencode v2.0.6` (from `opencode --version`, 2026-09-17).
- Status note: every inference below is marked **INFERENCE**. Everything else is an observation
  with a cited source.

## Scope and question

How do git worktrees work in OpenCode (current version, 2026):

1. Q1 — Web/desktop client session start: what does choosing "new worktree" (vs "local") do?
   Where is the worktree created, from which branch/rev, with what branch name? What does the
   session see as its working directory afterward?
2. Q2 — Session working-directory semantics: fixed for session lifetime? Any way to change it
   mid-session (`/cd`, config, API)?
3. Q3 — Child sessions: when a session launches subagents (task tool / Task agent), do children
   inherit the parent's working directory (hence its worktree)? Any parameter to set a child's
   directory? Exact docs/API fields required.
4. Q4 — What worktree information is exposed to agents and plugins (plugin context `worktree`
   field, session info, environment)?

## Methods and commands

Permitted methods only: `websearch`, `webfetch`, read-only reads of the two exact context paths,
`opencode --version` / `opencode --help`. No repo discovery, no mutations, no subagents,
no `sane-*-assistant-role` skill loads.

Commands run:

- `opencode --version` → `opencode v2.0.6`
- `opencode --help` → subcommands incl. `run`, `session`, `serve`, `web`, `attach`, `acp`, `api`;
  global `[<directory>]` positional ("Directory to start OpenCode in"). No worktree flags.

URLs fetched (all via `webfetch`, markdown):

1. https://opencode.ai/docs/web/ — web-client docs (no worktree session-start docs found).
2. https://opencode.ai/docs/agents/ — primary/subagent model, child-session navigation
   (`session_child_first` etc.); no directory semantics.
3. https://opencode.ai/docs/plugins/ — plugin function signature with `directory` + `worktree`;
   custom-tool `context.directory` / `context.worktree`; full event list (no `session.creating`).
4. https://opencode.ai/docs/config/ — full config schema; no worktree/session-directory keys.
5. https://opencode.ai/docs/tools/ — built-in tool list (no `task`/`subagent` tool documented there,
   no `cd` tool).
6. https://opencode.ai/docs/server/ — HTTP API table: `POST /session` body is
   `{ parentID?, title? }`; `PATCH /session/:id` body is `{ title? }`. No directory field.
7. https://opencode.ai/docs/cli/ — CLI reference; `run --dir`, `attach --dir`, `acp --cwd`;
   no worktree commands.
8. https://opencode.ai/docs/tui/ — slash-command list (`/new`, `/sessions`, …); **no `/cd`**.
9. https://opencode.ai/changelog/ — v1.18.12–v1.18.31 entries scanned; no worktree entries
   (nearest: v1.18.15 "Revert and fork actions now use real message chronology",
   v1.18.20 "Surface failed subagent tool calls with a resumable `task_id`").
10. https://github.com/anomalyco/opencode/issues/29271 — `[FEATURE]: add directory parameter to
    task tool for monorepo subagent dispatch` (closed as not planned).
11. https://github.com/anomalyco/opencode/issues/9366 — `[FEATURE]: Allow sessions to have custom
    working directories` (closed; tracked PR #9365 still Open).
12. https://github.com/anomalyco/opencode/pull/9365 — `feat(session): add support for per-session
    working directories` (Open, unmerged; incl. andreafspeziale Mar 2026 test comments).
13. https://github.com/anomalyco/opencode/pull/23360 — `feat(tui): add /cd command` (Closed,
    unmerged — automated cleanup May 2026).
14. https://github.com/anomalyco/opencode/pull/30874 — `feat(app): Fork sessions into git
    worktrees` (Closed unmerged by author Jun 2026; describes fork-dialog workspace picker).
15. https://github.com/anomalyco/opencode/issues/43867 — TUI directory picker created a worktree
    under `~/.local/share/opencode/worktree/d89da5/new` in detached HEAD and switched the
    session into it (Open, Aug 2026).
16. https://github.com/anomalyco/opencode/issues/31851 — Desktop workspace discovery only scans
    `~/.local/share/opencode/worktree/<repo-hash>/…`; manually created worktrees are invisible
    (Open, Jun 2026).
17. https://github.com/0xSero/open-trees/issues/19 — community `open-trees` plugin: new session's
    working directory is not the worktree one (Open, Mar 2026; community evidence).

Web searches run:

- `opencode.ai docs worktrees session start new worktree`
- `opencode web client session directory worktree local working directory`
- `opencode task subagent child session working directory directory parameter`
- `opencode plugin context worktree field session info`
- `opencode desktop app worktree create session directory picker docs`
- `opencode changelog worktree 2026 managed worktrees`
- `opencode desktop worktree session "new worktree" branch`
- `opencode github pull managed worktrees session directory`
- `"opencode" session start "worktree" OR "local" directory option web desktop new session`

## Evidence

### E-Q1: App-managed worktree location and shape (indirect; no official docs)

- No page under https://opencode.ai/docs documents a "new worktree" vs "local" session-start
  choice. The `/docs/web/` page describes only viewing/managing sessions, no directory or
  worktree options. (Observation from fetches 1–8.)
- Two independent GitHub issues show OpenCode itself creating worktrees under
  `~/.local/share/opencode/worktree/<repo-hash>/<name>`:
  - #43867: `~/.local/share/opencode/worktree/d89da5/new`, in **detached HEAD** (`205246f
    (detached HEAD)`), at the repo's current commit; the running session's working directory
    was switched into it mid-session ("working directory has been changed" notices).
  - #31851: Desktop workspace children listed as
    `C:\Users\...\.local\share\opencode\worktree\<repo-hash>\<name>` (e.g. `silent-pixel`,
    `crisp-sailor`, `happy-island` — generated names); manually `git worktree add`-ed
    worktrees do NOT appear and cannot be added via Ctrl+O.
- #30874 (unmerged desktop PR) describes the intended native UX: a fork dialog letting the user
  pick target workspace — "a new worktree, an existing worktree, or the current worktree";
  on new-worktree creation the app copies the current uncommitted diff into the target worktree
  and forks the session with "a client bound to the target directory, so the new session opens
  in the isolated worktree". PR closed by author, never merged — so this describes
  aspirational, not shipped, behavior.
- Branch naming for app-managed worktrees: **not publicly documented anywhere found**.
  The only observed datum is detached HEAD (#43867), i.e. no branch at all in that instance.

### E-Q2: Session working-directory semantics

- TUI docs list all slash commands; there is **no `/cd`** (fetch 8). The `/cd` implementation
  PR #23360 was closed unmerged by automated cleanup (May 2026). Its discussion confirms the
  gap it tried to fill: "The built-in `!cd` shell command doesn't actually change OpenCode's
  working directory (it only affects the spawned shell subprocess)."
- Server API (fetch 6, docs current as of Sep 17 2026): `POST /session` accepts only
  `{ parentID?, title? }`; `PATCH /session/:id` accepts only `{ title? }`. There is **no
  documented API to set or change a session's directory**.
- Per-session directories exist only as an **unmerged proposal**: PR #9365 adds
  `Session.directory.get()/set()` with fallback to `Instance.directory`; still Open, no
  maintainer approval visible in thread. Companion `session.creating` plugin hook PR #9361
  likewise unmerged; current official plugin docs list session events (`session.created`,
  `session.updated`, …) with **no `session.creating`** (fetch 3).
- Sessions do persist a stored directory (issue title evidence: #28581 "opencode -s resumes
  sessions from the launch directory instead of the stored session directory", cited in #43867;
  #9365 discussion: "tools now correctly operate in the session's stored directory rather than
  `Instance.directory`" when patched). But resume behavior is reported buggy (#28581), and the
  open-trees community issue (#19) shows a CLI TUI not adopting the worktree directory on
  session switch. Both are second-hand (titles / community repo) — see Limitations.
- Net documented position: a session's working directory is effectively the instance/project
  directory it was started in; no official mid-session change mechanism exists in v2.0.6 docs.

### E-Q3: Child-session directory inheritance (direct evidence)

- #29271 states it verbatim: "The `task` tool always creates the child session inside the
  parent session's `InstanceContext`, so the subagent inherits the parent's working directory"
  — with `AGENTS.md` chain, agent registry, and skills resolving against the parent's path.
  The request (optional `directory: string` on the task tool) was **closed as not planned**
  (assignee jlongster). No `directory` parameter exists on the task tool in official docs
  (the task/subagent tool is not even in the public `/docs/tools/` list; agent docs describe
  only invocation and session navigation).
- Corroborating, from the #9365 thread (andreafspeziale, Mar 29 2026, after local testing):
  "`Session.create` and `Session.fork` use `Instance.directory` instead of
  `Session.directory.get()` when creating child sessions, so all subagent sessions (Task tool)
  inherit the wrong working directory." Same comment lists further gaps for subdirectory
  scoping: `AGENTS.md`/instruction resolution, formatter config, and file-tracking/diff
  (`file/index.ts`, InstanceState-scoped) all resolve from the Instance, and the "TUI header
  reads `Instance.worktree`".
- Therefore: children inherit the parent session's working directory, and there is no
  supported parameter to override it. (Per the assignment's explicit instruction, this is
  stated directly rather than guessed at.)

### E-Q4: Worktree info exposed to agents/plugins (direct, official)

From https://opencode.ai/docs/plugins/ (fetch 3):

- Plugin function signature: `({ project, client, $, directory, worktree })` — `directory` is
  "The current working directory", `worktree` is "The git worktree path".
- Custom tools receive the same in tool-execution context:
  `const { directory, worktree } = context`.
- `shell.env` hook: `output.env` injection with `input.cwd` available.
- Session events available to plugins: `session.created / compacted / deleted / diff / error /
  idle / status / updated`; message events; `server.connected`. No worktree-specific events.
- Caveat from #9365 thread (andreafspeziale, Mar 27 2026): in the pre-merge codebase, plugin
  tool context is built with `directory: ctx.directory` from the InstanceContext captured at
  init — i.e. the startup directory, not any per-session directory — so plugin tools can
  receive stale directory info for sessions bound to worktrees. Unmerged one-line fix proposed.
- Agent system prompt: #9365 changes `system.ts` to show `Session.directory` in environment
  info — also unmerged, so agents on stock builds see only the instance-level environment.

### E-context: relation to SANE's assumptions

- SANE 0.2.0 §2/§4 assumes SANE-created branches `sane/<user>/<workstream>`, paths
  `<dir>/<user>/<workstream>`, and a `merges` row. Nothing in OpenCode conflicts with an
  external manager doing this: OpenCode has no native `sane/*` branch concept, its own managed
  worktrees live under `~/.local/share/opencode/worktree/` with generated names and (observed
  once) detached HEAD — a disjoint scheme. Manually created worktrees are invisible to Desktop
  workspace discovery (#31851), which cuts both ways (no interference, no integration).
- The Execution assistant's current create/clean flow (via shell `git worktree` commands plus
  launching sessions with that directory, e.g. `opencode <dir>` positional / `run --dir`) uses
  only documented surfaces (CLI directory positional, server per-request directory routing
  mentioned in #29271 as `workspace-routing.ts` + `InstanceStore.load({ directory })`).

## Findings (direct answers)

- Q1: **Partially answered.** Official docs do not document any "new worktree" vs "local"
  session-start option. Indirect evidence: OpenCode-managed worktrees live at
  `~/.local/share/opencode/worktree/<repo-hash>/<name>` with generated names; one observed
  instance was detached HEAD at the repo's current commit; the session's working directory
  becomes the worktree root afterward. Branch name / from-rev selection semantics for the
  managed flow are **unverified** — no public source states them, and the only native-UW
  description (fork-dialog workspace picker, #30874) was never merged.
- Q2: **Answered.** Session working directory is effectively fixed for the session lifetime in
  stock OpenCode v2.0.6: no `/cd` command (TUI docs; PR #23360 closed unmerged), `!cd` affects
  only the spawned shell, server session create/update accept no directory field
  (`{parentID?, title?}` / `{title?}`), and per-session directories + `session.creating` hook
  are unmerged proposals (#9365/#9361). A stored session directory exists internally but
  resume/session-switch behavior around it is reported buggy (#28581, open-trees #19).
- Q3: **Answered.** Yes — task-tool children inherit the parent session's working directory
  (created inside the parent's `InstanceContext`), and there is no `directory` (or similar)
  parameter to override it; the feature request (#29271) was closed as not planned.
  `Session.create`/`Session.fork` likewise use `Instance.directory` (per local-test report in
  #9365 thread). So workers spawned via the task tool always operate in the parent's worktree.
- Q4: **Answered.** Official plugin API exposes `directory` (cwd) and `worktree` (git worktree
  path) to plugin functions and to custom-tool execute contexts, plus `input.cwd` in the
  `shell.env` hook and session lifecycle events (no worktree-specific events, no
  `session.creating`). Caveat: on stock builds these resolve from the Instance (startup
  directory), and plugin-tool context may be stale for worktree-bound sessions.

## Limitations (could not verify)

- Web-client ("new worktree" vs "local") internals are not publicly documented; Q1 rests on
  two GitHub-issue observations plus an unmerged PR description, not on docs or code I was
  permitted to inspect. Branch name, from-branch/rev selection, and uncommitted-change
  handling for the managed new-session flow are unverified (only the fork-flow PR, unmerged,
  mentions copying the uncommitted diff).
- Whether PRs #9365 (per-session directory), #9361 (`session.creating`), #23360 (`/cd`),
  #30874 (fork-to-worktree) were later superseded by other merged work: checked via PR state
  (Open/Closed-unmerged) at fetch time, but the 2026 changelog scan was limited to the
  v1.18.12–v1.18.31 page window and the local binary is v2.0.6, whose changelog was not
  separately reviewed.
- #28581 ("resume uses launch directory instead of stored session directory") was cited only
  by title via #43867's related-links; its body was not fetched.
- Community evidence (0xSero/open-trees #19, kdcokenny/opencode-worktree existence noted in
  search results) corroborates gaps but is labeled as such and carries no official weight.
- No live behavior was tested (forbidden by assignment); all findings are documentary.

## Unresolved conflicts (docs vs observed behavior)

1. Server docs show `POST /session` with no directory field, yet #9365-thread comments refer to
   a working `session.create({ directory })` internal API used by plugins like open-trees.
   Internal capability vs public API surface — unresolved from public sources.
2. Sessions appear to persist a stored directory (per #28581 title and #9365 tests), yet resume
   reportedly uses the launch directory and the CLI TUI reportedly does not adopt the worktree
   directory on session switch (open-trees #19). Stored-vs-effective directory is inconsistent
   in community/issue reports.
3. #43867 shows the TUI switching a live session's directory into a newly created worktree
   mid-session, while Q2's finding is that no supported mid-session directory change exists —
   the observed switch came from an (apparently unintended) directory-picker/workspaces path,
   i.e. experimental or buggy behavior, not a documented feature.

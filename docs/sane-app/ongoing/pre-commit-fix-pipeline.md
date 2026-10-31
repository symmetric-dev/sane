# Pre-commit Fix Pipeline (pilot)

Status: planned · Owner: Alberto · Dog-food target: this repo (`/Users/beto/sane`)

## Goal

When a git pre-commit check fails, the SANE App receives the failure, a **router** scores its complexity, a configured **policy** routes it to a fixer agent (or to the human), and the fix comes back as a patch. The pipeline must be low-noise: the committing agent gets a short status, never a log dump, and the codebase carries no pipeline signature.

This is the first instance of a generic **custom agent trigger pipeline** (event → router → policy → executor → notice) meant to be reused for other events and other repos.

## Current baseline

- `lefthook.yml` (pre-commit, parallel): `biome lint` on staged files + `bun run typecheck` (whole project, ~2.6s).
- `biome.json`: lint only (recommended rules), formatter/assist disabled, honors `.gitignore`.
- `package.json`: `prepare: lefthook install`, `lint: biome lint`.
- Known failures are **intentionally left in place** as test fixtures: 14 tsc errors (4 workspace, 10 `sane-app`) and ~818 Biome errors repo-wide. Do not fix them as part of this work.

## Decisions taken

1. **Entry point is the SANE App**, not a standalone `opencode run` script.
2. **Hook fails fast.** It reports to the App, prints a compact receipt, and exits non-zero. It never waits for agents.
3. **Dedupe in-flight work**, so retries do not start duplicate runs.
4. **Fixes run in App-managed worktrees that are reused**, not created and deleted per run.
5. **A separate router scores complexity.** It is a **utility** profile so it can later become a non-LLM process. The router only scores. A deterministic policy maps the score to a route.
6. **The pipeline only notifies the originating session.** It gets a short status notice now and a short outcome notice later. Logs and transcripts stay in App data.
7. **No pipeline signature in the repo.** The fixer never commits and adds no trailers or co-authors. The original committer commits with the original message.

## Architecture

```
git commit
  └─ lefthook (pre-commit | commit-msg) → checks fail
       └─ sane pipeline report pre-commit --log <file> [--message-file <f>]
            ├─ classify caller (SANE_CALLER_CONTEXT → origin session | human)
            ├─ POST <hook server>/native/pipelines  {event}
            ├─ print compact receipt (run id, status)
            └─ exit 1
App
  ├─ dedupe/reserve run (key = tree + HEAD + check fingerprint)
  ├─ router utility → {complexity, category, summary}
  ├─ policy bands → route: worker profile | origin session | human
  ├─ fix worktree pool → reset to event tree → fixer worker (no commit)
  ├─ verify: re-run checks in worktree (SANE_PIPELINE_RUN=1)
  ├─ artifact: patch + short summary
  └─ outbox notice → origin session / human escalation
```

### Event contract (v1)

```ts
type PipelineEvent = {
  version: 1
  kind: "pre-commit.failed"
  repo: { root: string; gitDir: string; branch: string | null }
  head: string                 // HEAD sha
  tree: string                 // `git write-tree` of the index
  stagedFiles: string[]
  message?: string             // only if run from commit-msg (see open question A)
  checks: { name: string; exitCode: number; logPath: string; summary: string }[]
  origin: { kind: "human" } | { kind: "session"; callerRef: CompactCallerRef }
}
```

Full check output goes to a log file. Only `summary` (for example "14 errors in 6 files") travels in the event and in notices.

### Run record

States: `queued → triaging → fixing → verifying → fixed | escalated | failed | superseded`.

- **Key:** `(repoRoot, tree, head, checkFingerprint)`. Copy the reserve-before-launch pattern from workers (`packages/sane-app/src/workers.ts:101-124`): the same key while a run is active returns the existing run id.
- **Supersede:** a new key on the same checkout and branch supersedes the previous active run (see open question C).
- Persist under the App data dir using the `atomicAppRecord` style (`app-store.ts:199`) or a small dedicated store.

### Router and policy

- Profile `utility:pre-commit-router`. Today `resolveUtilityProfile` only accepts `utility:session-namer` (`agent-profiles-contract.ts:199-205`, `utility-execution.ts:92`), so generalize it to a small allow-list.
- Input: the event plus truncated check summaries. Output: one JSON line `{complexity: 1-10, category, summary}`. There is no structured-output support, so parse and validate the line. **A parse failure means escalate.**
- Policy lives in config, not in the prompt:

```yaml
preCommitPipeline:
  router: utility:pre-commit-router
  bands:
    - { max: 4, route: { worker: fixer } }
    - { max: 7, route: { worker: fixer, profile: worker:fixer-plus } }  # "Super Fixer"
    - { route: human }
  limits: { maxTurns: 30, maxFilesChanged: 10, maxLinesChanged: 300 }
  forbid: ["@ts-ignore", "@ts-expect-error", "biome-ignore", "as any"]
  protectedPaths: [lefthook.yml, biome.json, "tsconfig*.json", package.json]
```

- Other routes: `origin`, where the originating session is asked to fix it, and `human`.
- The router never sees the list of sessions. The App knows the origin and applies the route.

### Fix worktrees

SANE does not create worktrees today. It discovers them through `git worktree list` (`catalog.ts:114-138`) and can remove them (`catalog.ts:149-185`). CLI worktree commands are retired (`sane-cli/src/sane-worktree-command.ts`).

- Pool per source checkout, size 1 for the pilot, located under the App data dir.
- Per run:
  1. Acquire the lease.
  2. `git checkout --detach <head>`, then `git read-tree -u --reset <tree>`.
  3. Clean, keeping `node_modules`.
  4. Run the fixer.
  5. Verify.
  6. Export the patch.
  7. Release the lease.
- Deleted only by an explicit prune.
- **Add a removal guard:** worktree deletion currently does not check bound sessions (`bridge.ts:4763-4780`).
- Mark pipeline worktrees in the catalog so the UI does not present them as user worktrees.

### Fixer execution

- Reuse the existing `fixer` worker role (`sane-core/src/agent-catalog.ts:48`). "Super Fixer" is a fixer-role profile with a stronger model.
- **Gap:** workers require a live App-owned parent run (`bridge.ts:3285-3300`) and inherit the parent checkout (`workers.ts:117`). Add an App-owned launch path whose owner is the pipeline run and whose checkout is the fix worktree.
- **Fixer contract:**
  - Edit files only.
  - Never commit or stage.
  - Never touch protected paths.
  - Never use forbidden suppressions.
  - Stay within limits.
- **Verify:** re-run the checks in the worktree with `SANE_PIPELINE_RUN=1`. If they still fail, escalate. Do not retry automatically.
- The fixer's final message is read with `workerOutput` (`worker-output.ts:8`) and becomes the summary.

### Origin feedback (context management)

- **Immediate notice = the hook's own stdout.** When an agent made the commit, set lefthook output to minimal, write full logs to files, and print only:
  `pre-commit failed: typecheck (14), lint ok · fix run fx_12 (triaging) · don't fix these yourself; you'll get an update · log: <path>`
- **Outcome notice:** an outbox modeled on worker report-back (`bridge.ts:3560-3657`, `worker-outbox.ts`).
  - Delivery: on idle, or live input for Claude Code. OpenCode must be idle first.
  - Envelope: `Pre-commit Fix\n\nRun: fx_12\nStatus: fixed | escalated (complexity 8) | failed\nPatch: <path>\nNext: apply and commit with the original message`.
- **Human origin:** use a push notification or a user question (`chrome-push.ts`, `/native/user-questions`).
- **Execution skill (needs explicit approval to edit context or skills):** add one sentence to `context/skills/sane-assistant-execution-assistance/SKILL.md` (commit paragraph): "If a commit is rejected with a fix-pipeline receipt, don't fix those errors yourself; wait for the outcome notice unless asked."
- **UI commits** (`git-operations.ts:554-617`) strip `SANE_*`, never return hook output, and map failures to `hook-rejected`. The App can link that failure directly to the pipeline run.

### Loop and safety guards

- `SANE_PIPELINE_RUN=1`: the hook runs checks but does not report.
- The fixer cannot commit. Even if it did, the guard prevents the run from re-triggering itself.
- Dedupe prevents repeated runs from human retries or the origin agent retrying.

## Phases

### Phase 1: Event and record (no agents)
- `sane pipeline report pre-commit` CLI command: collect the event and classify the caller with `classifyCaller` (`sane-cli/src/cli-arguments.ts:84-124`).
- Connection discovery:
  - The existing `native-handoff.json` pins its URL to `/native/handoffs` (`native-handoff.ts:47-52`). Add an operation or a sibling record.
  - Fix the `.data` vs `.data-fresh` path mismatch (`install-sane-agent-context-packages.ts:444`).
- `POST /native/pipelines` on the hook server: reserve or dedupe the run and return `{runId, status, deduped}`.
- Lefthook wrapper: run checks, write logs, report on failure, print the compact receipt, exit 1.
- **Done when:** committing twice with the same staged content yields the same run id, and changed content supersedes the old run.

### Phase 2: Router, policy, escalation
- Generalize utility resolution. Add `utility:pre-commit-router` and the policy config.
- Human escalation via push notification or user question. Show runs in the UI, even as a minimal list.
- **Done when:** the 14 tsc errors get scored and routed per bands, and a garbage router output escalates.

### Phase 3: Fix worktrees and fixer
- Worktree pool with leases and reset, plus the removal guard and catalog marking.
- App-owned fixer launch, limits and forbid checks, verify step, patch artifact.
- **Done when:**
  - A low-band run produces a patch that makes the checks pass in the worktree.
  - The source working tree is untouched.
  - A rerun reuses the same worktree.

### Phase 4: Origin notices and intent
- Outbox outcome notices to the origin session.
- Commit-message capture (open question A). "Apply and commit with the original message" flow (open question B).
- Execution skill sentence (with approval).
- **Done when:** an Execution assistant committing in this repo gets exactly one receipt line and one outcome notice.

## Open questions

- **A. Run checks in `commit-msg` instead of `pre-commit`?** This keeps the commit message in the event. Agents use `-m`, so it costs them nothing. Humans see the editor before the checks run. *Recommended: yes.*
- **B. Who applies the patch?** The committer always, or an App action "apply and commit with the original message"? *Recommended: the committer for the pilot; the App action in Phase 4.*
- **C. Changed staged content while a run is active:** supersede and cancel, or let the old run finish? *Recommended: supersede and cancel.*
- **D. Should the router get file contents or only error summaries?** *Recommended: summaries plus file list for the pilot.*
- **E. Pool size and location** for fix worktrees once multiple repos use it.

## Dog-fooding notes

- Run against this repo with the intentional errors. Reset between attempts by discarding the patch. The source tree is never modified by the pipeline.
- New routes need an App restart (there is no `--watch` or `--hot`).
- Pipeline fixes to `sane-app` source are patches only, so the running App is unaffected until applied and restarted.
- Validate on a second repo once Phase 3 is stable, to flush out SANE-specific assumptions.

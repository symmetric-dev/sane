# Pending 0.8.0 Storage and Supervision Follow-up

This note tracks the main follow-up issues still worth addressing around the sqlite-authoritative storage transition before or alongside a `0.8.0` release.

It is intentionally narrower than the broader architecture docs. The focus here is: what still feels unfinished after the recent sqlite/runtime cleanup work.

See also:

- [`LOCAL_FIRST_SQLITE_ARCHITECTURE.md`](./LOCAL_FIRST_SQLITE_ARCHITECTURE.md)
- [`SQLITE_STORAGE_NEXT_HORIZON.md`](./SQLITE_STORAGE_NEXT_HORIZON.md)
- [`SUPERVISOR.md`](./SUPERVISOR.md)

## What is already done

- sqlite is canonical for structured workflow state
- `work/index.json` and `work/<stream-id>/tasks.json` remain compatibility projections
- `threads.json` and `batch-status/*.json` are no longer normally projected for sqlite-native workstreams
- stale legacy `threads.json` / `batch-status/*.json` are no longer re-imported into sqlite-backed runtime views once canonical sqlite state exists
- malformed persisted stage/batch/thread/task identifiers are normalized much more aggressively across load and key write paths

## Main pending items

### 1. Decide the long-term role of `supervisor-state.json`

`supervisor-state.json` is now the main remaining legacy runtime sidecar that can still reappear during sqlite-native supervision flows.

Questions to settle:

- should sqlite-native workstreams stop projecting it by default too?
- if yes, what test matrix proves supervision and recovery still work without it?
- if no, what exact compatibility need still justifies it?

Recommended next step:

- treat this like the recent `batch-status/` and `threads.json` cleanup:
  - first test the sqlite-native supervision contract without relying on the file
  - then remove or narrow projection if the tests pass

### 2. Supervision branch/session context robustness

Storage correctness improved, but branch supervision orchestration still has known rough edges:

- stale checkpoint/context reuse
- branch lineage confusion (`already inside a supervision branch`-style failures)
- incorrect or outdated handoff prompts surfacing after real approval state changed

This is not purely a storage problem, but it affects confidence in sqlite-native runtime behavior.

Recommended next step:

- isolate and harden the supervision-branch/session handoff lifecycle
- make sure branch-local prompts, persisted supervision state, and current approval state cannot drift visibly from each other

### 3. Diagnostics and repair reporting are still deferred

The current system normalizes many malformed-but-unambiguous IDs, but it still does not clearly report when that happened.

Still missing:

- warnings for malformed historic IDs detected during hydration or load
- explicit stale-projection diagnostics
- a repair-oriented operator story for partially dirty sqlite/compatibility state

Recommended next step:

- add diagnostics only after the remaining runtime sidecar policy is settled

### 4. Compatibility cleanup policy still needs one more pass

The runtime compatibility contract is now asymmetrical:

- `index.json` / `tasks.json` still project
- `threads.json` / `batch-status/*.json` no longer normally project
- `supervisor-state.json` still may project

That is acceptable during transition, but it should be documented more explicitly and eventually simplified.

Recommended next step:

- keep the contract explicit in docs and release notes
- avoid silently re-expanding compatibility projection surfaces in future changes

### 5. Session-linking UX is still a workflow footgun

Implementation sessions can still observe `current_workstream Unknown` if the session has not yet called `link_thread_session`.

This is mostly a workflow/skill issue, not a storage bug, but it is a real operator experience gap.

Recommended next step:

- clarify the implementation skill and/or tool behavior so agents do not expect `current_workstream` to be populated before session linkage

## Suggested priority order

1. decide/test the future of `supervisor-state.json`
2. harden supervision branch/session context handling
3. add diagnostics and repair reporting
4. polish documentation and skill guidance around session linkage and compatibility artifacts

## Release framing

If these items are not addressed immediately, the current state is still viable for a `0.8.0`-style release **provided the release notes are clear**:

- sqlite is canonical
- compatibility runtime sidecars are shrinking
- `threads.json` and `batch-status/*.json` are no longer normal live projections
- `supervisor-state.json` remains transitional
- supervision branch orchestration still has follow-up hardening value

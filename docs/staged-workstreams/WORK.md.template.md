# WORK.md template

Use this as a stage-level or thread-level execution document when the work needs more nuance than short task items can safely carry.

---

# WORK.md

## Purpose

Describe exactly what this stage/thread exists to accomplish in 2-4 sentences.

Answer:

- what is being changed
- why this stage exists
- what is explicitly not being solved here

## Locked decisions

List all decisions the implementing agent must treat as already decided.

Examples:

- Shared route surface is `X`, `Y`, and `Z`
- `details` is historical context only and must not be implemented
- Weather is outside the shared games response contract
- Path parameters are authoritative

## Inputs

List the files and prior docs that define the truth for this stage.

Examples:

- `../REQUIREMENTS.md`
- `../PLAN.md`
- `../specs/foo-spec.md`
- canonical docs in `docs/api/...`

## Required outputs

List the exact files, directories, or artifacts this stage/thread must produce or update.

Examples:

- `packages/.../route.ts`
- `packages/.../factory.ts`
- `docs/...`
- removed obsolete route mounts

## Allowed files to modify

Be explicit.

Examples:

- `packages/apps/api/src/lib/sports/games/**`
- `packages/apps/api/src/api/sports/v1/hockey/nhl/games/**`

## Forbidden files / boundaries

Be explicit about what must not be touched.

Examples:

- do not modify player-route families
- do not add repo-wide `lib/sports/shared/*`
- do not reintroduce removed `details` route files
- do not mount weather inside `games/upcoming`

## Public surface to preserve or create

List the exact public API paths or contracts that are in scope.

Examples:

- `GET /api/.../games/upcoming`
- `GET /api/.../games/{gameId}/matchup/teams`

Also list anything that must not survive.

Examples:

- `GET /api/.../games/{gameId}/details` must not survive

## File ownership rules

State where code must live.

Examples:

- route leaves in `api/...`
- reusable schemas/helpers in `lib/...`
- league-specific query ownership in `lib/sports/{league}/...`
- shared weather code only in `lib/sports/weather/...`

## Parallelism / dependency notes

Explain what this thread depends on and what it must not race with.

Examples:

- depends on shared schemas existing first
- must run after adapter pipeline is implemented
- safe to run in parallel with docs-only thread

## Implementation rules

List the structural rules the agent must follow.

Examples:

- mirror public path in directories
- use `route.ts` for leaves and `index.ts` for composition
- keep route leaves thin
- split route assembly from service assembly
- fail fast on unsupported query values

## Negative requirements

List what must not remain after the work is done.

Examples:

- stale flat route files must be removed
- legacy mounts must not remain mounted
- weather fields must not appear in shared response schemas
- compatibility aliases must not be preserved by default

## Ambiguity policy

State what the agent should do when it encounters ambiguity.

Recommended default:

- apply only already-locked decisions
- if a conflict exists between files, report it
- do not invent a new direction locally
- do not preserve compatibility unless explicitly authorized

## Acceptance checks

List the conditions that must be true for this stage/thread to be considered done.

Examples:

- route tree matches locked public path
- no stale mounts remain in reviewed subtree
- public schemas match locked contracts
- forbidden fields do not appear
- expected files exist in correct ownership locations

## Validation / evidence

List what validation is expected at this stage.

Examples:

- targeted typecheck
- route tests
- mounted route smoke checks
- docs updated

## Reviewer checklist

Helpful final section for supervision/review.

- [ ] Locked decisions were followed exactly
- [ ] Only allowed files were modified
- [ ] Forbidden routes/files were not added or preserved
- [ ] Ownership boundaries were respected
- [ ] Public route surface matches the stage spec
- [ ] No unresolved ambiguity was silently decided
- [ ] Validation evidence matches stage expectations

---

## Optional thread-specific addendum

If one thread needs extra nuance, add a subsection like:

```md
## Thread 01 addendum

- additional allowed files
- thread-local constraints
- thread-local cleanup requirements
```

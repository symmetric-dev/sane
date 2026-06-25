# Staged workstream structure feedback

## Summary

For research-heavy, architecture-heavy, cleanup-sensitive workstreams, a stage-based structure is better than a single flat workstream with one top-level `REQUIREMENTS.md`, `PLAN.md`, and a monolithic tracker.

The current flat execution-tracker model loses too much nuance between:

- research/specification
- planning
- execution
- supervision/review

The biggest losses tend to be:

- exact route/file ownership boundaries
- exact negative constraints (`must not remain`, `must not be mounted`, `must not live here`)
- cross-file consistency requirements
- distinction between historical context and target implementation surface
- true serial dependencies hidden inside “parallel” groups

## Core recommendation

Use a hybrid model:

1. workstream-level docs for global context and cross-stage decisions
2. stage-level docs for exact acceptance criteria and implementation boundaries
3. richer execution docs with per-thread worker docs
4. lighter execution items for tracking only

This is better than either:

- many tiny checkbox entries that try to encode architecture nuance, or
- fully unstructured prose with no trackable execution units

## Recommended directory structure

```text
0xx-{workstream-name}/
  README.md
  resources/               # shared references across all stages
  docs/                    # synthesized research and canonical notes
  stages/
    01/
      REQUIREMENTS.md      # stage-local acceptance criteria
      PLAN.md              # stage-local batches/threads
      threads/
        01.01.01/
          WORK.md          # primary worker doc generated after approval
      specs/
        *.md
```

When filling a stage `PLAN.md`, rename its H1 to a meaningful title such as `# Stage 01 Implementation Plan` so previews and approvals can preserve the stage name.

## Why this is better

### 1. Better planning granularity

The root workstream should not have to carry all of:

- global research conclusions
- stage-specific execution boundaries
- deletion/cleanup rules
- local architectural constraints
- execution-time escalation rules

Stage-local docs hold those details much more cleanly.

### 2. Better preservation of nuance

Architecture and migration work often depends on truths like:

- code must live only in these directories
- these routes must be removed, not just replaced
- these fields must not appear in shared contracts
- this route is historical context only, not target surface
- report ambiguity instead of making a local decision

Those constraints fit poorly into terse execution items and belong in stage requirements or a thread worker doc.

### 3. Better supervision and review

Review becomes easier when each stage has its own:

- requirements
- plan
- specs
- work instructions

Then review can ask:

- did Stage 2 satisfy Stage 2 requirements?
- did Stage 2 follow the Stage 2 architecture spec?

instead of reconstructing that intent from a top-level checklist.

### 4. Better resumability

When work resumes later, stage-local docs make it much easier to understand:

- what this stage was for
- what was locked
- what was deferred
- what outputs were expected
- what ambiguities were already resolved

## Recommended split of responsibilities

### Root workstream level

Use root-level docs for:

- the overall goal
- cross-stage research outputs
- cross-stage locked decisions
- dependencies between stages
- final reporting context

### Stage level

Use stage-level docs for:

- exact acceptance criteria
- exact implementation architecture for that stage
- exact cleanup/deletion rules
- exact batch/thread boundaries
- stage-scoped open questions and resolutions

### Thread level

Use thread `WORK.md` sections for:

- exact inputs
- exact outputs
- allowed files
- forbidden files
- “do not decide this yourself” rules
- escalation/report-back rules

## Guidance on execution items

### Execution items should become lighter

Execution items should primarily:

- track status
- mark sequence
- define parallelization boundaries
- point to the owning stage/thread work instructions

They should not try to carry all architectural nuance themselves.

### Good use of execution items

- batch/thread orchestration
- status tracking
- sequencing and dependencies
- supervision checkpoints

### Bad use of execution items

- encoding subtle architecture rules
- encoding large negative constraints
- encoding all cleanup conditions
- encoding cross-file consistency expectations in one sentence

## Strong recommendation: add thread `WORK.md`

The most important improvement is introducing a richer `WORK.md` per thread.

That file should hold the nuance that repeatedly gets lost in execution:

- locked decisions
- exact allowed file paths
- exact forbidden file paths
- exact route surface
- cleanup/deletion rules
- “if conflict exists, report rather than decide” cases
- acceptance checks

## Suggested execution model

Best overall model:

1. **Root workstream docs** define the global problem and cross-stage direction.
2. **Stage docs** define exactly what this stage must accomplish.
3. **Thread `WORK.md`** gives detailed execution guidance.
4. **Execution items/checkpoints** remain minimal and machine-trackable.
5. **Supervision/review** judges the stage against stage-local requirements/specs, not only top-level checklists.

## Specific lessons from supervision-heavy architecture work

The most common drift patterns were:

1. exact allowed file ownership gets lost
2. exact disallowed route/file leftovers get lost
3. cross-file consistency is not fully reconciled
4. historical context is confused with target implementation
5. hidden serial dependencies are mistaken for parallel work

Stage-local structure plus richer thread `WORK.md` guidance addresses all five better than a flat top-level checklist.

## Bottom line

For complex workstreams, the best model is:

- structured stages and threads
- rich thread-local execution docs
- lighter tracking items
- explicit stage-local requirements and plan files

This preserves nuance much better without giving up orchestration.

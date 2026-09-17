# SANE State — <workstream-id>

<!-- Rendered from sqlite sane.db; database wins. Renderer regenerates this file. -->
<!-- Do not edit by hand; `renderSaneState` in scripts/sane-state.ts overwrites this file from the DB. -->
<!-- docs/SANE_0_2_0.md Section 2: sqlite is source of truth; markdown is render for humans/agent context. -->

- repo_root: <repo-root>
- user: <user>
- workstream_id: <workstream-id>

## Workstream

- scope: <one-aspect-scope>
- status: <open> <!-- open | blocked | done | abandoned -->
- foundation_rev: <foundation-workstream-id@revision-or-(none)>

## Phases

### design

- status: <pending> <!-- pending | in_progress | delivered | approved | blocked -->
- owner (owner_role): <design>
- approval_ref: <approval-ref-or-(none)>

### engineering

- status: <pending>
- owner (owner_role): <engineering>
- approval_ref: <approval-ref-or-(none)>

### planning

- status: <pending>
- owner (owner_role): <planning>
- approval_ref: <approval-ref-or-(none)>

### execution

- status: <pending>
- owner (owner_role): <execution>
- approval_ref: <approval-ref-or-(none)>

## Gates

<!-- Pending gates render `- status: [ ] Pending`; approved gates render `- status: [✓] Approved` plus approval_ref + sane_hash. -->

### root-plus-sdd

- status: [ ] Pending
- artifact_path: (none)
- sane_hash: (none)
- git_commit: (none)
- approval_ref: (none)

### solutions

- status: [ ] Pending
- artifact_path: (none)
- sane_hash: (none)
- git_commit: (none)
- approval_ref: (none)

### plan

- status: [ ] Pending
- artifact_path: (none)
- sane_hash: (none)
- git_commit: (none)
- approval_ref: (none)

### jobs-batch

- status: [ ] Pending
- artifact_path: (none)
- sane_hash: (none)
- git_commit: (none)
- approval_ref: (none)

### merge

- status: [ ] Pending
- artifact_path: (none)
- sane_hash: (none)
- git_commit: (none)
- approval_ref: (none)

<!-- Approved gate example (renderer emits approved_at only when approved): -->
<!-- - status: [✓] Approved -->
<!-- - artifact_path: <artifact-path> -->
<!-- - sane_hash: <sane-hash> -->
<!-- - git_commit: <git-commit-or-(none)> -->
<!-- - approval_ref: <user-approval-ref> -->
<!-- - approved_at: <timestamp> -->

## Jobs

<!-- Empty state renders `(no jobs recorded)`. -->

| job_id | spec_path | report_path | status |
| --- | --- | --- | --- |
| <job-id> | <plan/jobs/<job-id>-<job-slug>.md> | <execution/reports/<job-id>-<job-slug>.md-or-(none)> | <planned> |

### <job-id>

- job_id: <job-id>
- spec_path: <plan/jobs/<job-id>-<job-slug>.md>
- report_path: <execution/reports/<job-id>-<job-slug>.md-or-(none)>
- status: <planned> <!-- planned | authorized | running | reported | reviewed | accepted -->

## Baseline

<!-- Empty state renders `(no baseline recorded)`. -->

- revision: <revision>
- path: <research/BASELINE.md>

## Merge

<!-- Empty state renders `(no merge recorded)`; unmerged renders `merge_commit: (not merged)`. -->

- branch: <sane/<user>/<workstream>>
- base_rev: <main-head-at-worktree-creation>
- merge_commit: <merge-commit-or-(not-merged)>

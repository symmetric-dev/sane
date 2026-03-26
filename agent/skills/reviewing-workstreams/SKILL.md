---
name: reviewing-workstreams
description: Review workstream plans for structure, risks, and readiness.
---

# Reviewing Workstreams

## Review Steps

1. Inspect requirements and plan:
   - `work validate requirements`
   - `work review plan`
   - `work preview`
2. Validate:
    - `work validate plan`
    - `work check plan`
3. Check quality:
    - requirements summary is clear and complete
    - deliverables are concrete and verifiable
    - dependencies point to real repo files or directories
    - resources point to real files under the workstream `resources/` directory
    - thread independence within each batch
    - clear scope per thread
    - explicit inputs/outputs
    - no unresolved blocking questions

## Draft Plans

- A warning from `work validate plan` about "no stages defined yet" means the workstream is still a draft, not that the file is broken.
- Draft plans are not approval-ready; recommend scaffolding stages with `work plan create --stages <n>` before `work approve plan`.

## Output

- Provide concrete findings.
- Call out blockers first.
- Suggest exact edits, not general advice.

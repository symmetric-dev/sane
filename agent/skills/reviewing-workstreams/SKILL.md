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
- A workstream is not planning-ready if `REQUIREMENTS.md` is missing or `work validate requirements` does not pass.
- Draft plans are not approval-ready; recommend scaffolding stages with `work plan create --stages <n>` before `work approve plan`.

## Output

- Provide concrete findings.
- Call out blockers first.
- Suggest exact edits, not general advice.

## Structured Reviewer Output Contract (Machine-Consumable)

When a review pass is expected to drive Root Agent branch-orchestration decisions, return **JSON only** (no prose outside JSON) using this contract:

```json
{
  "schemaVersion": "1.0",
  "alignment": {
    "status": "aligned | partially_aligned | misaligned",
    "rationale": "Brief alignment-to-plan judgment"
  },
  "missingOutputs": ["list of required outputs that are missing"],
  "issues": [
    {
      "summary": "concise issue statement",
      "severity": "high | medium | low",
      "difficulty": "complex | regular | trivial",
      "ownership": "product | engineering",
      "effort": "tasks | revision | workstream",
      "evidence": "optional evidence",
      "suggestedAction": "optional action"
    }
  ],
  "confidence": "high | medium | low",
  "notes": ["optional reviewer notes"]
}
```

Rules:
- `issues` may be empty only when no problems were found.
- Base review findings on canonical workstream state (task status, task reports, runtime metadata, and real artifacts/files when available), not on a separate synthesis artifact.
- Do not invent enum values outside the allowed sets.

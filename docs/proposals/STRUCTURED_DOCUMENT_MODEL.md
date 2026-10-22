# Structured Document Model and Handoff Authorization Plan

Status: proposal and migration plan. This document captures the target design
for replacing file-based workstream Markdown documents and separate phase
approvals with a database-backed structured artifact model accessed via MCP.

## 1. Design Principles

1. **Structure exists to manage decisions and context.** SANE's artifacts keep
   assistants, workers, and users aligned on current decisions and boundaries.
   The storage and tool model should stay simple and avoid unrequested
   versioning, revision graphs, or snapshot machinery.
2. **Collections organize work by phase.** Each phase owns a clear collection
   of major artifacts.
3. **Major artifacts preserve document coherence.** Each logical document is a
   single addressable artifact with structured metadata and named sections.
4. **Sections provide bounded, idempotent reads and updates.** Agents can read
   or replace individual top-level sections without rewriting entire documents
   or relying on brittle text matching.
5. **Handoffs authorize action.** Human Approve/Deny on handoffs governs whether
   requested work proceeds, replacing separate phase-level approval gates.

Explicitly out of scope:
- Revision history, per-section or per-artifact revision numbers, and diff/history APIs.
- Optimistic concurrency tokens (`expected_section_revision`) and snapshot pinning.
- Separate document/phase approval lifecycles (`sane approve <phase>`) and approval-hash drift checks.
- Search indexing or cross-workstream query engines (FTS5, OpenSearch, etc.) during this migration. Indexing is deferred to a later effort focused on letting Grounding, Scouting, Research, and Experimentation draw on historical workstream patterns.

---

## 2. Phase Collections and Artifact Ownership

Workstream artifacts are organized into four phase collections. Verification
responsibility lives in Engineering (solution-level verification) and Planning
(checkpoint verification specs), not Design.

| Collection (Phase) | Major Artifacts Owned | Responsibilities |
| --- | --- | --- |
| **Design** | `sdd` (1 per workstream) | Consolidates the previous typed root documents (`PRD.md`, `FOUNDATION.md`, `ISSUE.md`, `MAINTENANCE.md`) and `design/SDD.md` into one shared `SDD` schema covering problem/intent, goals, constraints, acceptance outcomes, technical direction, and proposed solutions. Workstream type (`feature`, `foundation`, `issue`, `maintenance`) is retained as metadata on the workstream/`sdd`. Does not include a verification approach section. |
| **Engineering** | `solution` (1 per solution area) | Concrete technical design, dependencies/integration, solution-level verification, and proposed jobs. |
| **Planning** | `execution_approach` (1 per workstream), `job` (1 per job), `verification` (1 per checkpoint) | Execution approach (run order, checkpoints, split rationale), implementation Job Specs, and checkpoint Verification Specs. |
| **Execution** | `job_report` (1 per job attempt/job), `test_report` (1 per checkpoint verification), `final_report` (1 per workstream) | Worker-authored job and test reports, plus Execution's final workstream summary. |

### Database as sole source of truth (no disk mirror)

Structured artifacts live exclusively in the database and are accessed via MCP,
the CLI, and the App UI. SANE does not maintain mirrored `.md` files under
`.sane/workstreams/<name>/`.

### What moves into artifact storage vs. stays on the filesystem

| Stored as structured database artifacts | Kept outside artifact storage (filesystem) |
| --- | --- |
| Expanded `SDD` | Implementation source code and tests |
| Solution Specs (`solution`) | Agent definitions and skills |
| Execution Approach (`execution_approach`), Job Specs (`job`), Verification Specs (`verification`) | Raw logs, screenshots, videos, and large evidence blobs (referenced from reports) |
| Job Reports (`job_report`), Test Reports (`test_report`), Final Report (`final_report`) | Support Track (e.g., Research) files and general repository documentation |

---

## 3. Three-Level Document Model

Every structured workstream document follows three levels:

```text
Collection (design | engineering | planning | execution)
└── Major Artifact (sdd | solution | job | verification | execution_approach | job_report | test_report | final_report)
    └── Section (named, schema-defined top-level section key)
```

Example hierarchy for `planning`:

```text
planning
├── execution_approach
│   ├── summary
│   ├── job_split
│   └── checkpoints
├── jobs
│   ├── job_contract_core
│   │   ├── goal
│   │   ├── context
│   │   ├── operational_readiness
│   │   ├── instructions
│   │   ├── boundaries
│   │   ├── verification
│   │   ├── report_requirements
│   │   └── resolutions
│   └── job_invitation_redemption
│       └── ...
└── verifications
    └── checkpoint_backend
        ├── scope
        ├── test_work
        ├── automated_checks
        ├── manual_and_live_verification
        └── required_outcomes
```

### Identity and addressing

- **Immutable internal ID:** Each artifact has a generated primary key (e.g., `artifact_abc123`) used for stored foreign-key relationships.
- **Unique readable alias:** Each multi-instance artifact has a unique slug/alias within the workstream (e.g., `job_contract_core`, `solution_authentication`, `checkpoint_backend`). Single-instance artifacts (`sdd`, `execution_approach`, `final_report`) use their singleton kind or alias directly.
- **Explicit display order:** Ordering is stored as an explicit field/list rather than inferred from array indices.
- **Stable section keys:** Each artifact kind defines its allowed top-level section keys in schema. The human-readable Markdown heading (e.g., `## Operational Readiness`) is a presentation label; the section key (`operational_readiness`) is its durable identity.
- **Path addressing:** Tools accept readable paths such as `jobs.job_contract_core.context` or `solutions.solution_authentication.technical_design`, never positional indices like `jobs[2].context`.

### Structured metadata vs. prose sections

- Prose sections store Markdown strings.
- Machine-consumed relationships and state—such as job `depends_on`, checkpoint job membership, execution order, and job completion status—live in structured fields/columns on the artifact rather than inside Markdown tables that must be regex-parsed.

Representative artifact shape:

```json
{
  "id": "artifact_abc123",
  "workstream_id": "ws_01",
  "phase": "planning",
  "kind": "job",
  "alias": "job_contract_core",
  "title": "Establish Contract Core",
  "order_index": 1,
  "metadata": {
    "depends_on": [],
    "checkpoint": "checkpoint_backend",
    "status": "ready"
  },
  "sections": {
    "goal": "...",
    "context": "...",
    "operational_readiness": "...",
    "instructions": "...",
    "boundaries": "...",
    "verification": "...",
    "report_requirements": "...",
    "resolutions": "..."
  }
}
```

---

## 4. MCP Operations, Idempotency, and Access Control

Assistants, workers, the CLI, and the App UI interact with workstream artifacts
through the artifact service and its MCP tool surface rather than direct
`.sane/workstreams/<name>/**/*.md` file reads and writes.

### Core MCP operations

- **Read collection / list artifacts:** List artifacts in a phase collection with metadata and section summaries.
- **Read artifact:** Return the complete logical artifact (metadata + all sections) or render it as Markdown.
- **Read section(s):** Return one or more named sections of an artifact (e.g., `jobs.job_contract_core.context`). Never silently truncate a section on read.
- **Create / replace artifact:** Create a new major artifact or replace all sections and metadata of an existing artifact.
- **Update section(s):** Replace one named section, or atomically update multiple named sections and metadata fields of an artifact in a single call.
- **Validate collection / artifact:** Check structural completeness (required sections present and non-empty, valid dependencies and checkpoint references, valid report diagnostics).

### Idempotent updates

Write operations accept a caller-supplied `request_id`:

```json
{
  "target": "jobs.job_contract_core",
  "request_id": "grounding-context-01",
  "sections": {
    "context": "Replacement context...",
    "operational_readiness": "Replacement readiness..."
  }
}
```

Required behavior:
- **Same `request_id` and identical payload:** Return the original success result without duplicating work.
- **Same `request_id` and different payload:** Reject as a conflicting reuse of `request_id`.
- **Identical content:** Succeed cleanly as a no-op update.

### Role and worker boundary enforcement

Because workers read and write through the artifact service instead of the raw
filesystem, the service enforces role boundaries directly across all read,
list, and search routes:

- **Implementer:** Read-only access to its assigned Job Spec and explicitly permitted context; write access only to its assigned Job Report. **Verification Specs are inaccessible to Implementers through every route.**
- **Grounder:** Read access to Design/Engineering/Planning context; write access only to authorized sections of specified, non-completed Job Specs. No file export/import loop is needed.
- **Tester:** Read access to checkpoint Verification Specs, relevant Job Specs, and Job Reports; write access to its assigned Test Report.
- **Reviewer:** Read-only access to assigned artifacts, reports, and evidence.
- **Scout:** Access only to explicitly assigned context.
- **Completed jobs:** Once a job is marked completed, its Job Spec is immutable; subsequent changes require either reopening or creating a follow-up job.

---

## 5. Replacing Phase Approvals with Authorized Handoffs

### What is removed

- Separate `sane approve design`, `sane approve engineering`, `sane approve planning`, and `sane approve execution` commands and gates.
- Artifact `approved` flags and `approval_files` content-hash drift checks.
- Upstream phase-approval prerequisites that block reading or working in downstream phases.

### What replaces them

1. **Human Approve/Deny on handoffs:**
   - Approving a handoff means **permission to perform the requested work**, not a declaration that upstream artifacts are permanently frozen.
   - A denied handoff means do not dispatch that request; it does not roll back or invalidate existing artifacts.
   - An accepted handoff records the request, recipient, scope, and referenced input artifacts (by ID/alias).
2. **Distinguishing handoff intent:**
   - Not every handoff advances the workstream's active phase. Support requests, clarifications, and feedback-loop corrections do not mark a phase complete.
   - Directly starting an Execution session requires explicit user authorization equivalent to an approved handoff.
3. **Structural validation remains separate from approval:**
   - Validation still checks for missing required sections, malformed jobs, missing dependencies, or invalid checkpoint references before delivery or dispatch.
4. **Relocating existing approval side effects:**
   - Currently in `packages/sane-core/src/server.ts` (lines 752–791) and `packages/sane-core/src/schema.ts` (lines 83–88):
     - Planning approval registers rows in `jobs` with a required `planning_approval_id` foreign key.
     - Execution approval marks jobs completed.
   - In the new model:
     - Creating/admitting `job` artifacts in Planning directly registers/updates job records without requiring a `planning_approval_id`.
     - Execution marks jobs completed through explicit job status/completion operations when verification and acceptance succeed.
     - Existing historical rows in `approvals` and `approval_files` remain intact as historical records.

---

## 6. Architecture and Incremental Delivery

```text
Assistants and Workers
         │
        MCP
         │
  Artifact Service ────── App UI / CLI
         │
         ├── Collections (Design, Engineering, Planning, Execution)
         ├── Typed Major Artifacts (ID + alias + structured metadata)
         ├── Named Sections (schema-defined keys, Markdown prose)
         ├── Request-ID Idempotency
         ├── Role-Scoped Access & Mutation Permissions
         └── Handoff Authorization & Job Lifecycle
         │
  Transactional Database (SQLite)
```

### Why start on SQLite without search indexing

- **Focused scope:** Keeps this migration strictly on the structured data model—collections, major artifacts, structured metadata, named sections, `request_id` idempotency, and handoff authorization—inside SANE's existing SQLite database.
- **No extra infrastructure or query layer:** Agents and workers continue with their current bounded context access patterns rather than introducing search/indexing tools at the same time.
- **Ready for future historical indexing:** Because all artifacts and sections are stored in a normalized structure behind the Artifact Service, a future indexing layer (to help Grounding, Scouting, Research, and Experimentation leverage historical workstream patterns) can be added later without changing how artifacts are authored or stored.

### Delivery Sequence

1. **Step 1 (Completed):** Remove `## Verification Approach` from Design templates and instructions so verification lives in Engineering and Planning.
2. **Step 2 — Schema & Artifact Service Foundation:** Define the SQLite schema for major artifacts, sections, structured metadata, and `request_id` deduplication; decouple `jobs` from `planning_approval_id`.
3. **Step 3 — Vertical Slice (Planning & Execution Jobs/Reports):** Implement structured `job` and `job_report` artifacts, section read/update MCP tools, Grounder section updates, Implementer access boundaries (blocking `verification` specs), and explicit job admission/completion.
4. **Step 4 — Design & Engineering Artifacts:** Consolidate root docs + `design/SDD.md` into the single structured `sdd` artifact (with proposed solutions) and move `solution` specs (with proposed jobs) and `verification` / `execution_approach` specs to the artifact service.
5. **Step 5 — Retire Phase Approval Gates:** Remove `approvePhase` gates from assistant delivery skills, CLI, and server validation while keeping handoff Approve/Deny and structural validation.

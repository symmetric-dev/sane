# Worker procedures: purpose and authoring conventions

This file is authoring documentation, not a worker procedure. It is never injected
into a session. Only files selected by the worker-role catalog are loaded; adding
a Markdown file here does not create a worker role.

## Purpose

Each `<worker-role>.md` contains the static SANE workflow for that worker: how it
uses assigned workstream artifacts, observes edit boundaries, verifies its work,
and delivers its result. These are automatically supplied instructions, not
optional skills that the worker must discover or load.

Keep the responsibilities separate:

- `context/agents/sane/worker/<worker-role>.md`: worker identity, capabilities,
  permissions, and general behavior.
- `context/worker-procedures/<worker-role>.md`: the SANE-specific workflow and
  artifact/report conventions. Avoid repeating or contradicting the agent file.
- The assignment and invocation prompt: concrete paths, jobs, questions, scope,
  allowed outputs, and verification permissions for this invocation.
- The dynamic SANE Session block: current workstream membership, implementation
  root, and runtime waiting/message-correlation state.

Procedure files contain the complete text that is injected, including any worker
completion or interaction guidance. There are no shared prose snippets silently
appended by the loader. Tool authorization and lifecycle enforcement remain code,
not Markdown permissions.

## File format and delivery

- Use UTF-8 Markdown with a `# SANE Procedure: <Worker label>` heading.
  Optional YAML frontmatter can document the file's purpose without instructing
  the agent. When present, include a nonempty `description`; a multiline `notes`
  field can hold maintenance rationale. The entire frontmatter block is removed
  before injection. See `../framework/template.md` for an example.
- Name the file after its exact worker-role ID, such as `scout-crew.md`.
- The procedure is selected by role. An implementer with no assigned job skips
  its job-specific procedure; its agent instructions and assignment still apply.
- The procedure is static. Job IDs, paths, and other assignment data are supplied
  separately; the App does not substitute placeholders inside the Markdown.
- Canonical activations pin the procedure bytes and their hash alongside the
  agent definition. Editing a source file affects new activations, not existing
  pinned sessions. Do not edit private materialized copies to update a procedure.
- This directory is not scanned for skills. `template.md` is documentation only.

## Path and identifier conventions

Angle-bracket expressions are explanatory placeholders, not literal directories,
environment variables, shell syntax to execute, or a template interpolation API.
Resolve them from the assignment and prompt before reading files or running commands.

| Convention | Meaning |
| --- | --- |
| `<implementation>/` | Absolute checkout root supplied by the assignment; implementation code belongs here. |
| `<workstream>/` | Absolute workstream artifact root supplied by the assignment. It may be in a different checkout from the implementation. |
| `<job id>` | Exact assigned job ID, as listed in the assignment. |
| `<Job Report path>` | Exact report path paired with an assigned job, not a path to guess from the job ID. |
| `<checkpoint-id>` | Checkpoint identifier supplied by the prompt or its named verification context. |
| `<topic>` | Assigned research topic identifier. |
| `<path>` | Concrete input or output path supplied by the assignment or prompt. |

Job-backed assignments list each job's ID, Job Spec path, Job Report path, and
Report template path. The prompt supplies role-specific inputs such as a
Verification Spec, checkpoint Test Report destination, or research report path.
These paths identify inputs and outputs; they do not grant permission to edit
every referenced file.

A worker can have no workstream. In that case there is no `<workstream>` root:
do not invent one or treat the current checkout as an implicit workstream. Keep
job/workstream-specific instructions conditional when a role also supports
generic assignments. Paths in procedure examples are conventions; supplied exact
paths and the role's authorization boundaries determine the actual work.

Launching another worker does not pass along the current worker's assignment.
Give the child its own self-contained task with the absolute paths, context, and
boundaries it needs.

## Suggested outline

Use only sections the role needs. This outline is documentation, not injected text:

```markdown
# SANE Procedure: <Worker label>

State when this workflow applies and the required assignment inputs.

## Workflow

Describe the ordered actions, authoritative references, and allowed artifacts.
Separate modes explicitly when the role supports more than one workflow.

## Boundaries and blockers

State writable outputs, forbidden changes, verification limits, and when to
consult the parent versus returning a terminal blocked result.

## Return

Specify the final report or inline result, required evidence, and completion tool.
Keep progress updates distinct from findings reserved for the final result.
```

Moving procedures into this directory preserves their existing behavior; it does
not automatically reconcile overlaps or conflicts with agent instructions. Review
both sources together when changing a worker's workflow.

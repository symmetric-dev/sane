# SANE Alpha Mock Workflow

This fictional walkthrough illustrates a complete, user-directed SANE
workstream. It uses the example outcome: **let finance users export completed
invoices as CSV**. It is an example of the interaction model, not a required
sequence or product specification.

Every OpenCode session below starts in the implementation repository. The user
selects the named SANE agent in OpenCode; the agent reads the paired repository,
the selected workstream, its role skill, and its Pickup inputs before assisting.
The user alone starts sessions, approves a delivery or Job outcome, redirects
work, and stops work.

## 1. One-Time Machine and Repository Setup

From the SANE checkout, install the command wrapper and make it available to the
current shell:

```bash
bun alpha/scripts/install-sane-alpha.ts
export PATH="$HOME/.local/bin:$PATH"
```

Install the OpenCode role agents and skills, then pair the implementation
repository with its local SANE workstream repository:

```bash
IMPL="/absolute/path/to/invoice-application"

sane-alpha install-context-packages
sane-alpha init-sane "$IMPL"
```

Quit and restart OpenCode after installing the context packages.

The initializer creates or validates the separate paired Git repository at
`~/workstreams/invoice-application-work/` and records the pairing locally in
`$IMPL/.sane/paths`.

## 2. User Starts a Workstream

The user chooses a stable relative name and creates the workstream:

```bash
WORKSTREAM="01-invoice-csv-export"
sane-alpha create-workstream "$IMPL" "$WORKSTREAM" --type feature
```

This selects the workstream and creates its initial artifacts:

```text
PRD.md
type                         # feature
SANE_CONTEXT.md
SANE_STATE.md
resources/IMPLEMENTATION_REPORT_TEMPLATE.md
resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md
resources/SECTION_SPEC_TEMPLATE.md
resources/JOB_TEMPLATE.md
resources/RESEARCH_REPORT_TEMPLATE.md
resources/RESEARCH_BASELINE_TEMPLATE.md
resources/ROOT_DESIGN_SPEC_TEMPLATE.md
resources/STAGES_TEMPLATE.md
resources/STAGE_DESIGN_SPEC_TEMPLATE.md
resources/STAGE_SECTIONS_TEMPLATE.md
resources/EXECUTION_PLAN_TEMPLATE.md
```

## 3. Product Session

**User action:** Open OpenCode in `$IMPL`, select the **SANE Product Assistant**,
and start a session.

**User prompt:**

```text
This is a feature workstream. I want finance users to download completed
invoices as CSV. Help me define the user outcome, scope, non-goals, and success
criteria. Do not decide technical implementation yet.
```

The assistant performs Pickup, reports what it will work on, and waits for the
user to confirm. It then helps create or refine `PRD.md`.

**User decision after delivery:**

```text
I approve the Product delivery. Update the Product entry in SANE_STATE.md.
```

If the user instead needs a change, they request an Update in the same session;
the assistant redelivers before the user approves it.

## 4. Research Session

**User action:** Select the **SANE Research Assistant** in OpenCode.

**User prompt:**

```text
Research the existing invoice data model, authorization rules, completed-invoice
definition, current export conventions, and CSV safety concerns. Record evidence
and open questions needed for Design.
```

This session is assigned Stage 01 scope. Its coordinating Research Assistant
creates `research/stage-01/BASELINE.md` from
`resources/RESEARCH_BASELINE_TEMPLATE.md`.

Topic researchers create authoritative evidence reports such as
`research/stage-01/csv-safety/REPORT.md` from
`resources/RESEARCH_REPORT_TEMPLATE.md`. Parallel or delegated researchers edit
only their reports. The coordinating Research Assistant reviews those reports
and alone updates the assigned Stage baseline. Evidence from workstream or other
Stage scopes applies only when this baseline explicitly links it.

For one bounded external-evidence topic, the coordinating Research Assistant may
launch a Research Worker with an exact, self-contained prompt. The worker reads
`research/stage-01/BASELINE.md`, writes only its assigned `REPORT.md` and any
named supporting files, and returns a concise findings/output/verification/blocker
summary. It does not perform user Pickup or Delivery, seek approval, ask the
user questions, update State, or edit the baseline. The user may instead start
another Research Assistant session.

**User decision:** Review the findings. Either request additional research,
return to Product if the desired outcome must change, or explicitly approve the
Research delivery and request its State update.

## 5. Root Design Session

**User action:** Select the **SANE Design Assistant**.

**User prompt:**

```text
Using the approved Product and Research delivery, design the CSV export. Define
the overall design and the smallest safe Stages. Keep unresolved product or
research questions visible rather than inventing a decision.
```

The assistant creates `design/SPEC.md` and `design/STAGES.md` from
`resources/ROOT_DESIGN_SPEC_TEMPLATE.md` and `resources/STAGES_TEMPLATE.md`, then
delivers them. For this example, the user and assistant identify a Stage named
`01-csv-export`.

Root Design reads `research/workstream/BASELINE.md`. When preparing Stage 01,
Stage Design reads `research/stage-01/BASELINE.md`. At Pickup, Design records the
revision of the baseline for its assigned Design scope; at Delivery, it rechecks
that revision and reconciles any changes before offering the Design for approval.

**User decision:** Explicitly approve the root Design delivery and request the
corresponding State update, or request an Update first.

## 6. Stage Design and Engineering Sessions

Start another **SANE Design Assistant** session for that Stage. It creates
`design/stages/01-csv-export/SPEC.md` by copying
`resources/STAGE_DESIGN_SPEC_TEMPLATE.md` before editing it:

**User prompt:**

```text
Design Stage 01-csv-export in enough detail for implementation planning. Define
the behavior, interfaces, error handling, authorization, and testable outcomes.
```

After reviewing its delivery, the user explicitly approves the Stage Design and
requests its State update.

Next, start the **SANE Engineering Assistant**. It creates
`design/stages/01-csv-export/SECTIONS.md` from
`resources/STAGE_SECTIONS_TEMPLATE.md` before editing it:

**User prompt:**

```text
Break the approved Stage Design into focused Section Specs. Identify the relevant
source paths, interfaces, tests, and dependencies without changing the approved
design decisions.
```

The assistant delivers `design/stages/01-csv-export/SECTIONS.md` and the related
Section Specs. It creates each Section Spec by copying
`resources/SECTION_SPEC_TEMPLATE.md`. The user reviews, requests Updates where
needed, then explicitly approves the complete Stage Design.

After the user normally confirms Engineering Assistance, Engineering may launch
Scout to inspect one exact internal `$IMPL` scope—for example, the existing
invoice model, its callers, tests, and integration path. Scout is read-only,
runs only safe non-destructive commands, and returns inline observations,
inferences, limitations, and path-and-line evidence. It does not write a
Research Report or use external research. If the inspection depends on the
approved Stage or Section design, Engineering includes those exact paths from
the separate `$WORK` repository in the assignment; Scout may read them as
context without discovering wider workstream state.

If the user explicitly requests a bounded external research investigation during
this Engineering session, Engineering may launch Researcher without changing its
normal Pickup, Assistance, baseline-recheck, and Delivery lifecycle. Researcher
may read exact supplied local context needed to understand that external
question, but internal repository discovery belongs to Scout. Its prompt must
prohibit implementation writes, installs, migrations, and deployments.
Live-credential or external-system access requires an exact explicit assignment.
These are behavioral boundaries rather than a claim of dynamic path enforcement.

## 7. Execution Planning Session

Start the **SANE Planning Assistant** (`sane-assistant-planning`) in the
Execution phase. It reads Pickup inputs, reports readiness, and waits for the
user to permit Assistance before creating or editing the compact Stage
Execution Plan from `resources/EXECUTION_PLAN_TEMPLATE.md`:

**User prompt:**

```text
Turn the approved 01-csv-export Stage Design into the smallest safe set of Jobs.
Propose a compact Jobs index and Split Notes explaining boundaries,
dependencies, and permitted parallelism. Wait for me to confirm that breakdown
before drafting or grounding Job Specs. Do not start implementation.
```

The assistant presents the compact plan. **User decision:** “I confirm this
breakdown; draft and ground the Job Specs.” Readiness confirmation alone does
not satisfy this gate. After this separate confirmation, the assistant creates
each draft Job Spec by copying `resources/JOB_TEMPLATE.md`, with the H1
`# Job Spec NN: <job name>` matching its plan entry.

Planning delegates one existing draft to each **Job Grounder**, supplying its
exact writable path, bounded `$IMPL` inspection scope, approved Design and plan
paths, and predecessor context. The worker enriches only that spec with verified
path/symbol/reason read maps, actionable steps, integration contracts, and exact
command definitions. It distinguishes current repository facts, required
changes, expected predecessor outputs, and commands actually run. It returns
findings, gaps, and limitations without asking users questions or editing the
application, Design, plan, State, or other specs.

Planning reviews summaries and cross-job consistency and performs targeted
repository inspection where needed. If evidence changes the split, it revises
the plan and obtains renewed confirmation before affected work continues. Design
changes go back for an explicit Design Update and approval first. Grounding is
descriptive work, not a new State status.

The completed package contains:

```text
execution/stages/01-csv-export/EXECUTION_PLAN.md
execution/stages/01-csv-export/jobs/<job-id>-<job-slug>.md
```

**User decision:** Review the plan and every Job Spec. Explicitly approve the
completed package and request its Execution State update. This authorizes the defined Jobs;
it does not automatically start implementation.

## 8. Implementation Session and Execution Batches

Coordination consumes `Jobs` and `Split Notes`. Sequential list order is the
default; parallel work requires explicit plan authorization. An execution batch
is one Job or an explicitly parallel set, not a new heading or State schema.

**User action:** Select the **SANE Coordination Assistant** in OpenCode.

**User prompt:**

```text
Run the first execution batch for Stage 01-csv-export. Start with Pickup,
report the runnable Jobs and planned repository changes, and wait for my
confirmation before launching an implementation agent.
```

After the user confirms, the Coordination Assistant launches the bounded
implementation agent or agents in `$IMPL`, then a read-only review agent for the
completed batch. It reports the Job outcomes and review findings to the user.

Before dispatch it checks grounded specs and actual predecessor outputs, reports,
reviews, and user acceptance without repeating grounding. If, for example, a Job
Spec names a stale export symbol, Coordination reports **“Planning needs to make
these corrections”** with the absolute spec path, affected Context/Instructions,
and repository evidence. It never edits the spec or launches Grounder. The user
returns to Planning for revisions and applicable approvals before resuming.

Implementers start with required-start read maps and follow conditional references
or expand for concrete concerns without hard read caps. Reviewers receive the
relevant Design Section Specs, Job Specs, and bounded repository/review/output
instructions. They independently inspect actual code and evidence and read
reports only as necessary to verify accuracy; no report template or Execution
Plan is mandatory review context, and reviewers never edit files.

Each implementation agent writes its report by copying the workstream-local
template:

```text
resources/IMPLEMENTATION_REPORT_TEMPLATE.md
```

to the Job-specific destination:

```text
implementation/reports/01-csv-export/<job-id>-<job-slug>.md
```

Once every authorized Job has completed and received its batch review, the
Coordination Assistant creates or updates this actual-state handoff before
offering Stage implementation delivery:

```text
implementation/briefs/STAGE_01.md
```

It is created from `resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md` only when
absent. The brief supplements the per-Job reports with actual implemented
results, repository changes, verification evidence, and next-Stage Design context.
Handoff readiness uses the Stage Spec, Job Specs, actual reports, and reviews.

**User decision after each execution batch:** The user may accept completed Job
outcomes, request a permitted retry or fix, return work to Research, Design, or
Planning, or stop. The assistant does not continue to another batch without
the user's authorization. For review/fix cycles, the user chooses checkpointed
reviews or delegates an explicit scope and attempt limit. Narrow Fix reviews stay
targeted; Bounded Remediation reviews cover all assigned outcomes. Delegation
never accepts results on the user's behalf. After the final batch, the user reviews the Stage handoff
record and explicitly accepts or redirects the implementation outcomes.

Approved Design remains the implementation authority. If a newer Research
Report or baseline conflicts materially with it, Execution or Implementation
stops and requests a Design Update; Research does not silently override the
approved direction.

## 9. Inspect and Commit Workstream Artifacts

The paired SANE repository contains all workstream directories. `sane-path`
prints that repository root; it does not point to an individual workstream:

```bash
SANE_REPOSITORY="$(sane-alpha sane-path "$IMPL")"

git -C "$SANE_REPOSITORY" status
git -C "$SANE_REPOSITORY" add "$WORKSTREAM"
git -C "$SANE_REPOSITORY" commit -m "Document invoice CSV export workstream"
```

Repository changes made by implementation agents remain in `$IMPL`; review and
commit them using that repository's normal workflow. The SANE workstream
repository and the implementation repository are separate Git repositories.

## 10. Pause and Resume

The user can stop after any delivery or execution batch. To resume later, select the
workstream explicitly if another one became selected:

```bash
sane-alpha select-workstream "$IMPL" "$WORKSTREAM"
```

Then open the role session that owns the next user-directed action. That role's
Pickup reads the existing Context, State, and artifacts before proposing further
work. Nothing advances merely because an artifact exists or because a previous
session ended.

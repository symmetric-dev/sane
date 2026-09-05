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

sane-alpha install-sane-agent-context-packages
sane-alpha init-sane-repository "$IMPL"
```

The initializer creates or validates the separate paired Git repository at
`~/workstreams/invoice-application-work/` and records the pairing locally in
`$IMPL/.sane/paths`.

## 2. User Starts a Workstream

The user chooses a stable relative name and creates the workstream:

```bash
WORKSTREAM="01-invoice-csv-export"
sane-alpha create-sane-repository-workstream "$IMPL" "$WORKSTREAM"
```

This selects the workstream and creates its initial artifacts:

```text
PRD.md
SANE_CONTEXT.md
SANE_STATE.md
resources/IMPLEMENTATION_REPORT_TEMPLATE.md
resources/SECTION_SPEC_TEMPLATE.md
resources/JOB_TEMPLATE.md
```

## 3. Product Session

**User action:** Open OpenCode in `$IMPL`, select the **SANE Product Assistant**,
and start a session.

**User prompt:**

```text
I want finance users to download completed invoices as CSV. Help me define the
user outcome, scope, non-goals, and success criteria. Do not decide technical
implementation yet.
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

Create the Research artifacts before opening the role session:

```bash
sane-alpha provision-sane-role "$IMPL" research --workstream "$WORKSTREAM"
```

**User action:** Select the **SANE Research Assistant** in OpenCode.

**User prompt:**

```text
Research the existing invoice data model, authorization rules, completed-invoice
definition, current export conventions, and CSV safety concerns. Record evidence
and open questions needed for Design.
```

The assistant delivers `research/INDEX.md` and `research/TECH_BRIEF.md`.

**User decision:** Review the findings. Either request additional research,
return to Product if the desired outcome must change, or explicitly approve the
Research delivery and request its State update.

## 5. Root Design Session

Provision the root Design artifacts:

```bash
sane-alpha provision-sane-role "$IMPL" design --workstream "$WORKSTREAM"
```

**User action:** Select the **SANE Design Assistant**.

**User prompt:**

```text
Using the approved Product and Research delivery, design the CSV export. Define
the overall design and the smallest safe Stages. Keep unresolved product or
research questions visible rather than inventing a decision.
```

The assistant delivers `design/SPEC.md` and `design/STAGES.md`. For this example,
the user and assistant identify a Stage named `01-csv-export`.

**User decision:** Explicitly approve the root Design delivery and request the
corresponding State update, or request an Update first.

## 6. Stage Design and Engineering Sessions

Create the Stage Design artifact, then start another **SANE Design Assistant**
session for that Stage:

```bash
STAGE="01-csv-export"
sane-alpha provision-sane-role "$IMPL" stage-design \
  --workstream "$WORKSTREAM" --stage "$STAGE"
```

**User prompt:**

```text
Design Stage 01-csv-export in enough detail for implementation planning. Define
the behavior, interfaces, error handling, authorization, and testable outcomes.
```

After reviewing its delivery, the user explicitly approves the Stage Design and
requests its State update.

Next, create Section planning artifacts and start the **SANE Engineering
Assistant**:

```bash
sane-alpha provision-sane-role "$IMPL" engineering \
  --workstream "$WORKSTREAM" --stage "$STAGE"
```

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

## 7. Execution Planning Session

Create the Stage Execution Plan, then start the **SANE Execution Assistant**:

```bash
sane-alpha provision-sane-role "$IMPL" execution \
  --workstream "$WORKSTREAM" --stage "$STAGE"
```

**User prompt:**

```text
Turn the approved 01-csv-export Stage Design into the smallest safe set of Jobs.
Define Job Groups, dependencies, edit boundaries, verification, report
requirements, and handoff requirements. Do not start implementation.
```

The assistant delivers:

```text
execution/stages/01-csv-export/EXECUTION_PLAN.md
execution/stages/01-csv-export/jobs/<job-id>-<job-slug>.md
```

The assistant creates each Job document by copying
`resources/JOB_TEMPLATE.md`.

**User decision:** Review the plan and every Job. Explicitly approve the Stage
Execution Plan and request its State update. This authorizes the defined Jobs;
it does not automatically start implementation.

## 8. Implementation Session and Job Groups

**User action:** Select the **SANE Implementation Assistant** in OpenCode. No
report-provisioning command is needed.

**User prompt:**

```text
Run the first approved Job Group for Stage 01-csv-export. Start with Pickup,
report the runnable Jobs and planned repository changes, and wait for my
confirmation before launching an implementation agent.
```

After the user confirms, the Implementation Assistant launches the bounded
implementation agent or agents in `$IMPL`, then a read-only review agent for the
completed Job Group. It reports the Job outcomes and review findings to the user.

Each implementation agent writes its report by copying the workstream-local
template:

```text
resources/IMPLEMENTATION_REPORT_TEMPLATE.md
```

to the Job-specific destination:

```text
implementation/reports/01-csv-export/<job-id>-<job-slug>.md
```

**User decision after each Job Group:** The user may accept completed Job
outcomes, request a permitted retry or fix, return work to Research, Design, or
Execution, or stop. The assistant does not continue to another Job Group without
the user's direction. After the final group, the user reviews the Stage handoff
record and explicitly accepts or redirects the implementation outcomes.

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

The user can stop after any delivery or Job Group. To resume later, select the
workstream explicitly if another one became selected:

```bash
sane-alpha select-sane-workstream "$IMPL" "$WORKSTREAM"
```

Then open the role session that owns the next user-directed action. That role's
Pickup reads the existing Context, State, and artifacts before proposing further
work. Nothing advances merely because an artifact exists or because a previous
session ended.

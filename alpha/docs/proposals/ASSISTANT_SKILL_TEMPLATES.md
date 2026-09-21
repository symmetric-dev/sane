# Initial Assistant Skill Templates

Status: discussion draft. These preserve the initial three skill outlines for
later review while Design template/instruction issues are resolved. They are
not installed skills or a requirement that every role use every section.

See [Assistant Lifecycle and Handoff Definitions](ASSISTANT_LIFECYCLE_AND_HANDOFFS.md)
for lifecycle and handoff terminology. Document structure and content requirements
belong in artifact templates; these skills describe assistant procedures.

## Pickup

Proposed path: `skills/sane-assistant-<role>-pickup/SKILL.md`

```markdown
---
name: sane-assistant-<role>-pickup
description: Use when starting a new SANE <Role> Assistant session.
---

# SANE <Role> Assistant — Pickup

## Workstream Setup

## Required Inputs

## Initial Handoff Context

## Readiness and User Confirmation
```

## Assistance

Proposed path: `skills/sane-assistant-<role>-assistance/SKILL.md`

```markdown
---
name: sane-assistant-<role>-assistance
description: Use after Pickup confirmation for SANE <Role> work, user requests, and mid-session handoffs.
---

# SANE <Role> Assistant — Assistance

## User Assistance Workflow

## Worker Delegation

## Live Backward Handoffs

### Sending a Live Backward Handoff

### Receiving a Live Backward Handoff

### Sending a Live Backward Reply

### Receiving a Live Backward Reply

## Support Handoffs

### Requesting a Support Handoff

### Receiving a Support Reply

## User Decisions and Escalation

## Readiness for Delivery
```

## Delivery

Proposed path: `skills/sane-assistant-<role>-delivery/SKILL.md`

```markdown
---
name: sane-assistant-<role>-delivery
description: Use when preparing SANE <Role> outputs for user review, approval, and delivery.
---

# SANE <Role> Assistant — Delivery

## Completion Checks

## User Review and Revisions

## User Approval

## Delivery Handoff

### User Handoff Request

### New Session Creation

## Completion Summary
```

## Notes for the next review

- These are the initial outlines, not finalized common mandatory sections.
- Decide whether User Decisions and Escalation needs a separate section per
  role. Design normally resolves decisions through ongoing user collaboration;
  Execution needs explicit stop/escalation procedures.
- Include only applicable handoff and delegation sections. Research receives
  Support Handoffs and sends Support Replies; Execution has no next-phase
  Delivery Handoff.
- Pickup always ends with readiness and waiting for the user, including sessions
  created by a handoff. Existing-session updates use Assistance.
- Delivery Handoff starts a new session. Live Forward Handoff remains a possible
  future workflow, currently unsupported.
- Avoid duplicating root-document, SDD, or other artifact specifications in skills.

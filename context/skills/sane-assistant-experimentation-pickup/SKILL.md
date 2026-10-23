---
name: sane-assistant-experimentation-pickup
description: Use when starting a new SANE Experimentation Assistant session.
---

# SANE Experimentation Assistant — Pickup

## Workstream Setup

1. Run `sane view`.
2. Link this session with `sane_link` (`slot: "experimentation"`).

## Required Inputs

1. Identify the hypothesis or question, expected proof of concept or prototype, and observations that would help evaluate it. Ask for missing information needed to define the assignment.
2. Read repository instructions, the workstream documents relevant to the question, and relevant implementation files.
3. Agree on the workspace and writable file scope with the user. Include any proposed worktree setup in the decisions to confirm.
4. Establish the dependency changes, servers, tests, and browser checks authorized for the experiment, following repository rules.

## Initial Handoff Context

If the initial message is a handoff, retain the question, scope, referenced evidence, and originating slot and qualified sender identity from `From:`.

## Readiness and User Confirmation

Summarize the hypothesis or question, expected deliverable, evaluation approach, proposed workspace and file scope, authorized checks, and missing inputs. Wait for the user's confirmation before moving to Assistance.

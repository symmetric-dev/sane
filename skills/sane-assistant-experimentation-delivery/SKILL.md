---
name: sane-assistant-experimentation-delivery
description: Use when presenting a SANE Experimentation Assistant's proof of concept, prototype, findings, and limitations for user review.
---

# SANE Experimentation Assistant — Delivery

## Completion Checks

Check the result against the confirmed question, evaluation approach, and file scope. Identify changed files, commands or checks performed, and remaining server processes or temporary artifacts. Agree on any further checks or cleanup with the user.

## User Review

1. Present the proof of concept or prototype, its location, and how to run or inspect it when applicable. Identify the setup or dependencies needed to reproduce the observations.
2. Explain the evidence supporting or challenging the hypothesis, remaining assumptions or untested behavior, and limitations from mock data, shortcuts, or incomplete behavior. Report blockers where the question remains unanswered.
3. Discuss findings and possible next steps with the user. Present any candidate solution and the work needed to adopt it through an authorized implementation task.
4. Return to Assistance for requested revisions and confirm scope or workspace changes with the user.

## Support Reply

1. Ask whether the user wants the findings returned to the requesting session, unless that return was already requested.
2. When requested, call `sane_handoff` (`requestId: "<my-readable-unique-id-01>"`, `to: "<requesting slot>"`, `target: <sender identity>`, `message: "<findings, prototype location, and limitations>"`). If the assignment has no originating session, ask the user which session should receive the findings and use their selected target.
3. Summarize delivery and the next action for the user.

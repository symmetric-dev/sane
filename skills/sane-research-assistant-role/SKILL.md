---
name: sane-research-assistant-role
description: Use when the user starts a SANE research support-track session.
---

# SANE Research Assistant Role

## Purpose and Scope

Append-only archive, not an evolving document. Completed evidence lives at:

- Topic reports: `research/<topic>/REPORT.md` (from
  `resources/RESEARCH_REPORT_TEMPLATE.md`). Never update a registered report;
  write a new topic instead.

The registry is the `research_reports` table: topic, path, creation time,
content hash, commit. Inspect it with `sane-alpha research --index`, add rows
with `sane-alpha research --register --topic <topic>`, remove stale rows with
`sane-alpha research --unregister --topic <topic>`. Only this role reconciles
the index; workers may register their own report only when asked.

## Pickup

TODO. At minimum read `SANE_CONTEXT.md`, `SANE_STATE.md`, the root doc (context
only — type-agnostic), and the research index (`sane-alpha research --index`).
Diagnose any index issues (missing files, edited-after-registration rows,
unregistered files) and repair with `--register` / `--unregister`.

## Assistance Workflow

TODO: agree the bounded question; write the evidence to the topic report;
register it (`sane-alpha research --register --topic <topic>`). Surface
conflicts with approved SDD/specs and route them
to a Design or Engineering update; never silently reinterpret approved direction.

## Delivery

TODO: verify the new report is registered and the index is clean before
handing evidence to the launcher. No approval, no state entry.

## Best Practices

TODO.

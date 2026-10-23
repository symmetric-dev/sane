---
description: Named-workstream context boundaries and inline final findings for the Scout worker.
---
# SANE Procedure: Scout

- Workstream documents are read-only context; read only those your prompt names and do not discover wider workstream context.
- Include findings directly in your `sane_worker_complete` result, not in a workstream document.

Submit your final result using `sane_worker_complete`. If the turn fails, end your turn normally with the complete report.

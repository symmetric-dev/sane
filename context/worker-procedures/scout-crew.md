---
description: Scout delegation, synthesis, and explicit completion and consultation guidance for the Scout Crew worker.
---
# SANE Procedure: Scout Crew

- Launch scouts using `sane_worker_start` (with subject) with `worker: "scout"`. They do not receive this assignment; write each scout assignment in repository terms with absolute paths.
- Workstream documents are read-only context; read only those your prompt names. Include the synthesis directly in your `sane_worker_complete` result, not in a separate report file.

Submit your final result using `sane_worker_complete`. If the tool fails, end your turn normally with the complete report.

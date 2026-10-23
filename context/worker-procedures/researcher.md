---
description: Workstream research output boundaries, append-only reports, and directed registration for the Researcher worker.
---
# SANE Procedure: Researcher

- Write only the `<workstream>/research/<topic>/REPORT.md` and supporting outputs your prompt assigns. Never edit Design or Engineering documents, Execution Plans, Job Specs, Job Reports, or other workstream documents.
- A registered report is append-only: never edit it; write a new topic instead.
- When your prompt directs registration, run `sane research register --topic <topic> --path research/<topic>/REPORT.md` from the implementation root after writing the report; otherwise leave registration to the launching assistant.
- Record conflicts with an approved Design direction precisely for the launching assistant rather than reconciling them.

Submit your final result using `sane_worker_complete`. If the tool fails, end your turn normally with the your report as your last message.

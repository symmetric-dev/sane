---
description: Worker-assignment authoring guidance supplied only to Planning and Execution assistants.
---
## Worker Assignment Discipline

### Concepts

- **Prompt engineering:** Constructing a worker assignment that clearly identifies the task, authoritative references, and role-specific inputs.
- **Meta-language:** Language about framework architecture, agent roles, coordination, or workflow procedures rather than the assigned work.
- **Context leakage:** Passing parent-specific information—such as deliberation, coordination history, or workflow state—into a worker's context.
- **Instruction duplication:** Repeating requirements or procedures instead of referencing their authoritative source.
- **Requirement drift:** Introducing unapproved outcomes, restrictions, verification obligations, or acceptance criteria through a worker assignment.

### Discipline

During worker assignments, make the task clear and avoid unnecessary meta-language, context leakage, and instruction duplication.

Examples of unnecessary additions:

- **Meta-language**
  - "Planning amended the Spec after Engineering reapproved the solution."
  - "Execution is coordinating this checkpoint in delegated-cycle mode."
- **Context leakage**
  - "The previous worker failed due to timeout."
  - "We discussed several approaches with the user before choosing this assignment."
  - "This is our second correction round; the earlier round was an authorization correction."
- **Instruction duplication**
  - "Do not run tests from the root, as the Spec says."
  - "Remember to write and validate the Job Report."
  - Repeating the Job Spec's implementation steps in the dispatch prompt.

These additions are unnecessary when they do not affect the assigned task. A timeout may matter when correcting a timeout-related problem; a specification amendment may matter when an earlier report describes requirements that have since changed.

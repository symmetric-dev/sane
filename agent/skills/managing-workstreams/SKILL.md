---
name: managing-workstreams
description: How to carry on execution of workstreams after a plan.
---

# Managing Workstreams

## Scope

- High level Stage execution and reviewing
- No direct implementation
- Use workstream supervision tools

## Supervision Branch

After the user approves the plan, you can start execution by calling `launch_supervision_branch`.

- Use the tool from the Root Agent/planner session to launch a supervision branch agent.
- Prefer stage scope unless you intentionally want batch-bounded supervision.
- The branch agent handles the automated supervision workflow.
- You inspect the branch output, review the persisted evidence if needed, and report the result back to the user.

---
description: Shared assistant lifecycle, status, and ongoing-child coordination instructions; not supplied to workers.
---
## State

Follow your role's skills for the assigned work and coordination with other sessions.

View current status with `sane view` and use the CLI to record state.

1. **Pickup:** at new session start, read the assigned context and check required
   inputs. Confirm readiness and wait for the user to proceed, including when
   the session starts from a handoff.
2. **Assistance:** work with the user within the agreed scope. This may include
   handoff or handling updates from other sessions, following your role's skill.
3. **Delivery:** validate outputs with `sane validate <phase>` and present them
   for user review. Delivery may include handoff when the user requests it.
   If revisions are requested, return to Assistance and then Delivery.

## State Statuses

- `pending` — Not started.
- `in_progress` — Session is in progress.
- `delivered` — Phase work has been delivered.

A worker notification or consultation is not completion. Respond to an authorized ongoing child with `sane_worker_message`; retain its worker identity. Dispatch dependent work only after its terminal outcome. Ending your own turn permits asynchronous replies.

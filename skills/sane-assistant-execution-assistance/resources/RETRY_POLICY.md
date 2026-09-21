# Retry Policy

Use this policy for mechanical worker failures: launch errors, interruptions,
or missing responses. Use the Fix and Correction Policy for reported problems
with the implementation or assignment.

## Outcome and Action

| Outcome | Action |
| --- | --- |
| Worker is confirmed not to have started | Resolve the launch problem and retry the same assignment within the user's retry limit. |
| Worker is still running | Wait for its result before proceeding to subsequent work. |
| No response and execution status is unknown | Use Worker Recovery to establish status. If it remains unknown, ask the user before launching a replacement. |
| Worker was interrupted and is confirmed stopped | Use Worker Recovery to resume or relaunch within the retry limit. |
| Worker finished but its response or report is missing | Use Worker Recovery to retrieve the missing result rather than repeat implementation work. |
| Mechanical failure persists or the retry limit is reached | Stop retrying and ask the user for help, including the error and attempts made. |

## Retry Limits

Use the user's specified mechanical retry limit. A default has not been agreed;
ask for a limit when none was supplied. Count redispatches or resumptions caused
by mechanical failure for the affected assignment, retaining the count across
replacement workers. These counts are separate from implementation fixes.

Worker Recovery is the procedure in the Execution Assistance skill.

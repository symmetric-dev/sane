const TASK_WORKFLOW_REMOVAL_MESSAGE = [
  "Error: This workflow was removed in 0.9.0.",
  "Plan approval now initializes execution state directly from PLAN.md.",
  "Use 'work approve plan' after validating/checking the plan.",
].join("\n")

export function printRemovedTaskWorkflowError(commandHint?: string): never {
  console.error(TASK_WORKFLOW_REMOVAL_MESSAGE)
  if (commandHint) {
    console.error(commandHint)
  }
  process.exit(1)
}

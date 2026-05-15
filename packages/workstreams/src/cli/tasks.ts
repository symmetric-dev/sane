/**
 * CLI: Tasks
 *
 * Legacy TASKS.md workflow removed in 0.9.0.
 */

import { printRemovedTaskWorkflowError } from "../lib/removed-workflows.ts"

function printHelp(): void {
  console.log(`
work tasks - Removed TASKS.md workflow

The TASKS.md workflow was removed in 0.9.0.
Plan approval now initializes execution state directly from PLAN.md.

Use:
  work validate plan
  work check plan
  work approve plan
`)
}

export function main(argv: string[] = process.argv): void {
  const args = argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    process.exit(0)
  }

  printRemovedTaskWorkflowError(
    "Use 'work approve plan' to seed compatibility tasks and prompts directly.",
  )
}

if (import.meta.main) {
  main()
}

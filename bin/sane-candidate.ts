#!/usr/bin/env bun
// Candidate-only entry avoids loading the legacy CLI command graph.
import { runCli } from "../packages/sane-cli/src/sane-candidate-command.ts"
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))

#!/usr/bin/env bun
/**
 * Test GitHub branch management
 * Usage: bun run ./scripts/check-github-branch.ts [--create <stream-id>] [--check <stream-id>]
 *
 * WARNING: --create will create a real branch and checkout to it!
 */

import { getGitHubAuth } from "../packages/workstreams/src/lib/github/auth.ts"
import { loadGitHubConfig } from "../packages/workstreams/src/lib/github/config.ts"
import {
  formatBranchName,
  createWorkstreamBranch,
  workstreamBranchExists,
  getWorkstreamBranchName,
} from "../packages/workstreams/src/lib/github/branches.ts"
import { loadIndex } from "../packages/workstreams/src/lib/index.ts"
import { execSync } from "node:child_process"

interface GitHubBranchResponse {
  name: string
  commit: {
    sha: string
  }
}

const repoRoot = process.cwd()

function getCurrentBranch(): string {
  try {
    return execSync("git branch --show-current", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim()
  } catch {
    return "unknown"
  }
}

function getDefaultBranch(): string {
  try {
    const result = execSync("git remote show origin", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const match = result.match(/HEAD branch: (.+)/)
    return match?.[1]?.trim() || "main"
  } catch {
    return "main"
  }
}

async function main() {
  console.log("=== GitHub Branch Management Test ===\n")

  // Get auth
  const token = getGitHubAuth()
  if (!token) {
    console.log("❌ No GitHub authentication found!")
    process.exit(1)
  }
  console.log("✅ Authentication found")

  // Get config
  const config = await loadGitHubConfig(repoRoot)
  if (!config.owner || !config.repo) {
    console.log("❌ Repository not configured!")
    console.log("   Run: bun run ./scripts/check-github-config.ts --enable")
    process.exit(1)
  }
  console.log(`✅ Repository: ${config.owner}/${config.repo}`)

  // Current git state
  console.log("\n--- Current Git State ---")
  console.log(`Current branch: ${getCurrentBranch()}`)
  console.log(`Default branch: ${getDefaultBranch()}`)
  console.log(`Branch prefix: ${config.branch_prefix || "workstream/"}`)

  // List workstreams with branch metadata
  console.log("\n--- Workstreams with Branches ---")
  try {
    const index = loadIndex(repoRoot)
    let foundAny = false
    for (const stream of index.streams) {
      const branchName = stream.github?.branch
      if (branchName) {
        foundAny = true
        console.log(`  ${stream.id}`)
        console.log(`    Branch: ${branchName}`)

        // Check if branch exists on remote
        const exists = await workstreamBranchExists(repoRoot, stream.id)
        console.log(`    Remote: ${exists ? "✅ exists" : "❌ not found"}`)
      }
    }
    if (!foundAny) {
      console.log("  No workstreams have branches configured")
    }
  } catch (e) {
    console.log("  Could not load index:", (e as Error).message)
  }

  // Parse command
  const arg = process.argv[2]
  const streamId = process.argv[3]

  if (arg === "--preview") {
    const id = streamId || "002-github-integration"
    console.log(`\n--- Branch Name Preview ---`)
    const branchName = formatBranchName(config, id)
    console.log(`Stream ID: ${id}`)
    console.log(`Branch name: ${branchName}`)
    console.log(`URL would be: https://github.com/${config.owner}/${config.repo}/tree/${branchName}`)
  } else if (arg === "--check") {
    if (!streamId) {
      console.log("\n❌ Please provide stream ID: --check <stream-id>")
      process.exit(1)
    }

    console.log(`\n--- Checking Branch for ${streamId} ---`)

    // Check stored metadata
    const storedBranch = getWorkstreamBranchName(repoRoot, streamId)
    console.log(`Stored branch: ${storedBranch || "(none)"}`)

    // Check if exists on GitHub
    const exists = await workstreamBranchExists(repoRoot, streamId)
    const branchName = formatBranchName(config, streamId)
    console.log(`Branch "${branchName}": ${exists ? "✅ exists on GitHub" : "❌ not found on GitHub"}`)
  } else if (arg === "--create") {
    if (!streamId) {
      console.log("\n❌ Please provide stream ID: --create <stream-id>")
      process.exit(1)
    }

    const branchName = formatBranchName(config, streamId)
    console.log(`\n--- Creating Branch for ${streamId} ---`)
    console.log(`Branch name: ${branchName}`)
    console.log(`Base branch: ${getDefaultBranch()}`)

    // Check if already exists
    const exists = await workstreamBranchExists(repoRoot, streamId)
    if (exists) {
      console.log(`\n❌ Branch "${branchName}" already exists!`)
      process.exit(1)
    }

    console.log("\n⚠️  This will:")
    console.log(`   1. Create branch "${branchName}" on GitHub`)
    console.log(`   2. Fetch and checkout the branch locally`)
    console.log(`   3. Store branch metadata in index.json`)
    console.log("\nProceeding in 3 seconds... (Ctrl+C to cancel)")

    await new Promise(resolve => setTimeout(resolve, 3000))

    try {
      const result = await createWorkstreamBranch(repoRoot, streamId)
      console.log("\n✅ Branch created!")
      console.log(`   Name: ${result.branchName}`)
      console.log(`   SHA: ${result.sha}`)
      console.log(`   URL: ${result.url}`)
      console.log(`   Current branch: ${getCurrentBranch()}`)
    } catch (e) {
      console.log("\n❌ Failed:", (e as Error).message)
      process.exit(1)
    }
  } else if (arg === "--list-remote") {
    console.log("\n--- Remote Workstream Branches ---")
    try {
      const response = await fetch(
        `https://api.github.com/repos/${config.owner}/${config.repo}/branches?per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "workstreams-test",
          },
        }
      )
      const branches = (await response.json()) as unknown
      const prefix = config.branch_prefix || "workstream/"
      const workstreamBranches = Array.isArray(branches)
        ? (branches as GitHubBranchResponse[]).filter((branch) => branch.name.startsWith(prefix))
        : []

      if (workstreamBranches.length === 0) {
        console.log(`  No branches starting with "${prefix}" found`)
      } else {
        for (const branch of workstreamBranches) {
          console.log(`  - ${branch.name}`)
          console.log(`    SHA: ${branch.commit.sha.slice(0, 7)}`)
        }
      }
    } catch (e) {
      console.log("  Failed to list branches:", (e as Error).message)
    }
  } else {
    console.log("\n--- Commands ---")
    console.log("  --preview [id]     Preview branch name for a stream")
    console.log("  --check <id>       Check if branch exists for a stream")
    console.log("  --create <id>      Create branch and checkout (CREATES REAL BRANCH!)")
    console.log("  --list-remote      List all workstream branches on GitHub")
    console.log("\nExamples:")
    console.log("  bun run ./scripts/check-github-branch.ts --preview 002-github-integration")
    console.log("  bun run ./scripts/check-github-branch.ts --check 002-github-integration")
    console.log("  bun run ./scripts/check-github-branch.ts --create 002-github-integration")
  }
}

main().catch(console.error)

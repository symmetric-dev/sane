#!/usr/bin/env bun
/**
 * Test GitHub label creation
 * Usage: bun run ./scripts/check-github-label.ts [--create]
 */

import { getGitHubAuth } from "../packages/workstreams/src/lib/github/auth.ts"
import { loadGitHubConfig } from "../packages/workstreams/src/lib/github/config.ts"
import { GitHubClient } from "../packages/workstreams/src/lib/github/client.ts"

const repoRoot = process.cwd()

interface GitHubLabelResponse {
  name: string
  color: string
}

async function main() {
  console.log("=== GitHub Label Test ===\n")

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

  // Create client
  const client = new GitHubClient(token, { owner: config.owner, repo: config.repo })

  // List existing labels
  console.log("\n--- Existing Workstream Labels ---")
  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}/labels?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "workstreams-test",
        },
      }
    )
    const labels = (await response.json()) as unknown
    const workstreamLabels = Array.isArray(labels)
      ? (labels as GitHubLabelResponse[]).filter(
          (label) =>
            label.name.startsWith("workstream:") ||
            label.name.startsWith("stage:") ||
            label.name.startsWith("batch:"),
        )
      : []

    if (workstreamLabels.length === 0) {
      console.log("No workstream labels found")
    } else {
      for (const label of workstreamLabels) {
        console.log(`  - ${label.name} (#${label.color})`)
      }
    }
  } catch (e) {
    console.log("❌ Failed to list labels:", (e as Error).message)
  }

  // Create test labels
  const arg = process.argv[2]
  if (arg === "--create") {
    console.log("\n--- Creating Test Labels ---")
    const testLabels = [
      { name: "workstream:test", color: "7B68EE", description: "Test workstream label" },
      { name: "stage:01-test", color: "0366D6", description: "Test stage label" },
      { name: "batch:01.01-test", color: "28A745", description: "Test batch label" },
    ]

    try {
      await client.ensureLabels(testLabels)
      console.log("✅ Labels created/verified!")
      for (const label of testLabels) {
        console.log(`   - ${label.name}`)
      }
    } catch (e) {
      console.log("❌ Failed:", (e as Error).message)
    }
  } else if (arg === "--delete") {
    console.log("\n--- Deleting Test Labels ---")
    const testLabelNames = ["workstream:test", "stage:01-test", "batch:01.01-test"]

    for (const name of testLabelNames) {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${config.owner}/${config.repo}/labels/${encodeURIComponent(name)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": "workstreams-test",
            },
          }
        )
        if (response.ok || response.status === 404) {
          console.log(`   ✅ Deleted: ${name}`)
        } else {
          console.log(`   ❌ Failed: ${name}`)
        }
      } catch (e) {
        console.log(`   ❌ Error: ${name}`, (e as Error).message)
      }
    }
  } else {
    console.log("\n--- Commands ---")
    console.log("  --create   Create test labels")
    console.log("  --delete   Delete test labels")
  }
}

main().catch(console.error)

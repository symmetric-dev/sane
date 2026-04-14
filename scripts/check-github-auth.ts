#!/usr/bin/env bun
/**
 * Test GitHub authentication
 * Usage: bun run ./scripts/check-github-auth.ts
 */

import {
  getGitHubAuth,
  getAuthFromEnv,
  getAuthFromGhCli,
  validateAuth,
} from "../packages/workstreams/src/lib/github/auth.ts"

interface GitHubUserResponse {
  login?: string
}

async function main() {
  console.log("=== GitHub Authentication Test ===\n")

  // Check environment variables
  const envToken = getAuthFromEnv()
  console.log("GITHUB_TOKEN or GH_TOKEN:", envToken ? "Found" : "Not set")

  // Check gh CLI
  const cliToken = getAuthFromGhCli()
  console.log("gh CLI token:", cliToken ? "Found" : "Not available")

  // Get token (priority order)
  const token = getGitHubAuth()
  if (!token) {
    console.log("\n❌ No GitHub authentication found!")
    console.log("   Set GITHUB_TOKEN, GH_TOKEN, or run 'gh auth login'")
    process.exit(1)
  }

  console.log("\nToken source:", envToken ? "Environment variable" : "gh CLI")
  console.log("Token preview:", token.slice(0, 8) + "..." + token.slice(-4))

  // Validate token
  console.log("\nValidating token against GitHub API...")
  const isValid = await validateAuth(token)

  if (isValid) {
    console.log("✅ Token is valid!")

    // Get user info
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "workstreams-test",
      },
    })
    const user = (await response.json()) as GitHubUserResponse
    console.log(`   Authenticated as: ${user.login ?? "unknown"}`)
  } else {
    console.log("❌ Token is invalid or expired!")
    process.exit(1)
  }
}

main().catch(console.error)

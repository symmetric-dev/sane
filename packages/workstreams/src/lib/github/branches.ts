/**
 * Branch management for GitHub integration
 * Handles workstream branch creation, checkout, and metadata storage
 */

import { execSync } from "node:child_process";
import type { GitHubConfig } from "./types";
import { loadGitHubConfig } from "./config";
import { ensureGitHubAuth } from "./auth";
import { createGitHubClient } from "./client";
import { loadIndex, saveIndex, getStream } from "../index";
import { buildWorkstreamStartCommitMessage } from "../git/auto-commit-message.ts";
import { executeGitAutoCommit } from "../git/auto-commit-executor.ts";

export interface CreateBranchResult {
  branchName: string;
  sha: string;
  url: string;
}

/**
 * Formats a branch name for a workstream.
 * Uses the configured branch prefix (default: "workstream/")
 * @param config The GitHub configuration
 * @param streamId The workstream ID (e.g., "002-github-integration")
 * @returns The formatted branch name (e.g., "workstream/002-github-integration")
 */
export function formatBranchName(config: GitHubConfig, streamId: string): string {
  const prefix = config.branch_prefix || "workstream/";
  return `${prefix}${streamId}`;
}

/**
 * Checks if a local branch exists.
 * @param repoRoot The root directory of the repository
 * @param branchName The branch name to check
 * @returns True if the branch exists locally, false otherwise
 */
function localBranchExists(repoRoot: string, branchName: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branchName}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a local branch if it exists.
 * Used to clean up branches from previous failed attempts before creating fresh.
 * @param repoRoot The root directory of the repository
 * @param branchName The branch name to delete
 */
function deleteLocalBranchIfExists(repoRoot: string, branchName: string): void {
  if (!localBranchExists(repoRoot, branchName)) {
    return;
  }

  // Force delete the local branch (-D works even if not fully merged)
  execSync(`git branch -D ${branchName}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Deletes a remote branch if it exists.
 * Used to clean up branches from previous failed attempts before creating fresh.
 * @param repoRoot The root directory of the repository
 * @param branchName The branch name to delete
 */
function deleteRemoteBranchIfExists(repoRoot: string, branchName: string): void {
  try {
    execSync(`git push origin --delete ${branchName}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Ignore errors - branch might not exist on remote
  }
}

/**
 * Creates a workstream branch on GitHub and checks it out locally.
 * 
 * Flow:
 * 1. Store branch metadata in index.json (while on current branch)
 * 2. Commit all pending changes (including the workstream files)
 * 3. Create local branch from current HEAD (preserves workstream files)
 * 4. Push to origin with tracking (creates branch on GitHub)
 * 
 * This ensures workstream files are included in the new branch, unlike
 * creating from remote main which wouldn't have the workstream.
 * 
 * @param repoRoot The root directory of the repository
 * @param streamId The workstream ID
 * @param fromRef Optional base ref to create from (unused, kept for API compatibility)
 * @returns The created branch result
 */
export async function createWorkstreamBranch(
  repoRoot: string,
  streamId: string,
  fromRef?: string
): Promise<CreateBranchResult> {
  const config = await loadGitHubConfig(repoRoot);
  
  if (!config.enabled) {
    throw new Error("GitHub integration is not enabled. Run 'work github enable' first.");
  }

  if (!config.owner || !config.repo) {
    throw new Error("GitHub repository not configured. Run 'work github enable' first.");
  }

  const branchName = formatBranchName(config, streamId);

  // Step 1: Store branch metadata while still on current branch
  await storeWorkstreamBranchMeta(repoRoot, streamId, branchName);

  // Step 2: Commit all pending changes (including workstream files and updated index.json)
  commitPendingChanges(repoRoot, streamId);

  // Step 3: Delete local and remote branches if they exist (from previous failed attempts)
  // This ensures we create a fresh branch from current HEAD
  deleteLocalBranchIfExists(repoRoot, branchName);
  deleteRemoteBranchIfExists(repoRoot, branchName);

  // Step 4: Create local branch from current HEAD
  // This preserves all workstream files since they're committed
  execSync(`git checkout -b ${branchName}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Step 5: Push to origin with tracking (creates branch on GitHub)
  execSync(`git push -u origin ${branchName}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Get the SHA of the current commit
  const sha = execSync("git rev-parse HEAD", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

  return {
    branchName,
    sha,
    url: `https://github.com/${config.owner}/${config.repo}/tree/${branchName}`,
  };
}

/**
 * Gets the current branch name.
 * @param repoRoot The root directory of the repository
 * @returns The current branch name or undefined if not on a branch
 */
function getCurrentBranch(repoRoot: string): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // HEAD means detached state
    return branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
}

/**
 * Gets the default branch of the repository.
 * Tries to detect from git remote or falls back to "main".
 * @param repoRoot The root directory of the repository
 * @returns The default branch name
 */
async function getDefaultBranch(repoRoot: string): Promise<string> {
  try {
    // Try to get the default branch from git remote
    const result = execSync("git remote show origin", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    const match = result.match(/HEAD branch: (.+)/);
    if (match?.[1]) {
      return match[1].trim();
    }
  } catch {
    // Fallback: try main then master
  }
  
  // Check if main branch exists
  try {
    execSync("git rev-parse --verify main", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "main";
  } catch {
    // Try master
    try {
      execSync("git rev-parse --verify master", {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return "master";
    } catch {
      return "main"; // Default fallback
    }
  }
}

/**
 * Commits any uncommitted changes to the current branch.
 * @param repoRoot The root directory of the repository
 * @returns True if changes were committed, false if working tree was clean
 */
function commitPendingChanges(repoRoot: string, streamId: string): boolean {
  const index = loadIndex(repoRoot);
  const stream = getStream(index, streamId);
  const commitResult = executeGitAutoCommit(repoRoot, buildWorkstreamStartCommitMessage({
    streamId: stream.id,
    streamName: stream.name,
  }));

  if (!commitResult.success) {
    throw new Error(commitResult.error || "Failed to create workstream start commit.");
  }

  return commitResult.created;
}

/**
 * Checks if a workstream branch exists on GitHub.
 * @param repoRoot The root directory of the repository
 * @param streamId The workstream ID
 * @returns True if the branch exists, false otherwise
 */
export async function workstreamBranchExists(
  repoRoot: string,
  streamId: string
): Promise<boolean> {
  const config = await loadGitHubConfig(repoRoot);
  
  if (!config.enabled || !config.owner || !config.repo) {
    return false;
  }

  const token = await ensureGitHubAuth();
  const client = createGitHubClient(token, config.owner, config.repo);
  
  const branchName = formatBranchName(config, streamId);
  
  try {
    await client.getBranch(branchName);
    return true;
  } catch (error) {
    // 404 means branch doesn't exist
    if (error instanceof Error && error.message.includes("404")) {
      return false;
    }
    throw error;
  }
}

/**
 * Stores the workstream branch metadata in index.json.
 * @param repoRoot The root directory of the repository
 * @param streamId The workstream ID
 * @param branchName The branch name to store
 */
export async function storeWorkstreamBranchMeta(
  repoRoot: string,
  streamId: string,
  branchName: string
): Promise<void> {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex(
    (s) => s.id === streamId || s.name === streamId
  );

  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamId}" not found`);
  }

  const stream = index.streams[streamIndex]!;
  stream.github = {
    ...stream.github,
    branch: branchName,
  };
  stream.updated_at = new Date().toISOString();

  saveIndex(repoRoot, index);
}

/**
 * Gets the branch name for a workstream from the index.
 * @param repoRoot The root directory of the repository
 * @param streamId The workstream ID
 * @returns The branch name or undefined if not set
 */
export function getWorkstreamBranchName(
  repoRoot: string,
  streamId: string
): string | undefined {
  const index = loadIndex(repoRoot);
  const stream = getStream(index, streamId);
  return stream.github?.branch;
}

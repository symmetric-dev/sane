/**
 * GitHub Sync Operations
 *
 * Functions for synchronizing workstream data with GitHub issues.
 * 
 * ## Stage-Level Sync
 * - `syncStageIssues()` - Sync stage issues with execution status (uses github.json)
 * - `isStageComplete()` - Check if all items in a stage are completed
 */

import { loadGitHubConfig, isGitHubEnabled } from "./config";
import { listThreadExecutionItems } from "../thread-execution";
import { getGitHubAuth } from "./auth";
import { createGitHubClient } from "./client";
import {
  loadWorkstreamGitHub,
  saveWorkstreamGitHub,
  updateStageIssueState,
  type StageIssue,
} from "./workstream-github";

// ============================================
// STAGE-LEVEL SYNC FUNCTIONS
// ============================================

/**
 * Result of syncing stage issue states
 */
export interface SyncStageIssuesResult {
  closed: { stageNumber: string; stageName: string; issueNumber: number; issueUrl: string }[];
  unchanged: { stageNumber: string; stageName: string; issueNumber: number; reason: string }[];
  errors: { stageNumber: string; stageName: string; issueNumber: number; error: string }[];
}

/**
 * Check if all items in a stage are completed (or cancelled)
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param stageNumber - Stage number (e.g., 1, 2)
 * @returns true if all items in the stage are completed or cancelled
 */
export function isStageComplete(
  repoRoot: string,
  streamId: string,
  stageNumber: number
): boolean {
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`;
  const stageItems = listThreadExecutionItems(repoRoot, streamId).filter((t) =>
    t.id.startsWith(stagePrefix)
  );

  // If no items in stage, consider it not complete
  if (stageItems.length === 0) return false;

  // Check if all items are completed (or cancelled)
  return stageItems.every(
    (t) => t.status === "completed" || t.status === "cancelled"
  );
}

/**
 * Get metadata for a stage from execution items
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param stageNumber - Stage number (e.g., 1, 2)
 * @returns Stage name from first execution item, or null if none found
 */
function getStageName(
  repoRoot: string,
  streamId: string,
  stageNumber: number
): string | null {
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`;
  const firstItem = listThreadExecutionItems(repoRoot, streamId).find((t) => t.id.startsWith(stagePrefix));

  return firstItem?.stageName || null;
}

/**
 * Synchronize stage-level GitHub issues with local item status.
 * 
 * For each stage with an open issue in github.json:
 * - If all items in the stage are completed/cancelled, close the issue
 * - Update the state field in github.json
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @returns Result with closed, unchanged, and error counts
 */
export async function syncStageIssues(
  repoRoot: string,
  streamId: string
): Promise<SyncStageIssuesResult> {
  const result: SyncStageIssuesResult = {
    closed: [],
    unchanged: [],
    errors: [],
  };

  // Check if GitHub is enabled
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    return result;
  }

  const config = await loadGitHubConfig(repoRoot);
  if (!config.owner || !config.repo) {
    return result;
  }

  // Load github.json for this workstream
  let githubData = await loadWorkstreamGitHub(repoRoot, streamId);
  if (!githubData) {
    // No github.json exists - nothing to sync
    return result;
  }

  // Get GitHub client
  const token = getGitHubAuth();
  if (!token) {
    // No auth - can't sync
    return result;
  }

  const client = createGitHubClient(token, config.owner, config.repo);

  // Track if we need to save github.json
  let needsSave = false;

  // Process each stage in github.json
  for (const [stageNumber, stageIssue] of Object.entries(githubData.stages) as [string, StageIssue][]) {
    const stageName = getStageName(repoRoot, streamId, parseInt(stageNumber, 10)) || `Stage ${stageNumber}`;

    // Skip if issue is already closed
    if (stageIssue.state === "closed") {
      result.unchanged.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        reason: "Issue already closed",
      });
      continue;
    }

    // Check if stage is complete
    const stageNum = parseInt(stageNumber, 10);
    const isComplete = isStageComplete(repoRoot, streamId, stageNum);

    if (!isComplete) {
      result.unchanged.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        reason: "Stage has incomplete items",
      });
      continue;
    }

    // Stage is complete - close the issue
    try {
      await client.closeIssue(stageIssue.issue_number);

      // Update github.json state
      const closedAt = new Date().toISOString();
      updateStageIssueState(githubData, stageNumber, "closed", closedAt);
      needsSave = true;

      result.closed.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        issueUrl: stageIssue.issue_url,
      });
    } catch (error) {
      result.errors.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Save github.json if any changes were made
  if (needsSave) {
    await saveWorkstreamGitHub(repoRoot, streamId, githubData);
  }

  return result;
}

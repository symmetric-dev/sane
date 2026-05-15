import { loadGitHubConfig, isGitHubEnabled } from "./config";
import { getGitHubAuth } from "./auth";
import { createGitHubClient } from "./client";
import type { GitHubConfig } from "./types";
import { formatLabel } from "./labels";
import type { StageIssue } from "./workstream-github";

/**
 * Input for creating a stage-level GitHub issue
 */
export interface CreateStageIssueInput {
  streamId: string
  streamName: string
  stageNumber: number
  stageName: string
  batches: StageBatch[]
}

/**
 * A batch within a stage, containing threads
 */
export interface StageBatch {
  batchId: string
  batchName: string
  threads: StageThread[]
}

/**
 * A thread within a batch, containing execution items
 */
export interface StageThread {
  threadId: string
  threadName: string
  items: StageItem[]
}

/**
 * An execution item within a thread (simplified for issue body)
 */
export interface StageItem {
  itemId: string
  itemName: string
  status: string
}

/**
 * Format the title for a stage-level GitHub issue.
 * Format: [{stream-id}] Stage {N}: {Stage Name}
 *
 * @param streamId - The workstream ID
 * @param stageNumber - The stage number (1-99)
 * @param stageName - The stage name
 * @returns Formatted issue title
 */
export function formatStageIssueTitle(
  streamId: string,
  stageNumber: number,
  stageName: string
): string {
  const stageId = stageNumber.toString().padStart(2, "0");
  return `[${streamId}] Stage ${stageId}: ${stageName}`;
}

/**
 * Format the body for a stage-level GitHub issue.
 * Lists all batches, threads, and execution items in the stage.
 *
 * @param input - Stage issue input data
 * @returns Formatted markdown body
 */
export function formatStageIssueBody(input: CreateStageIssueInput): string {
  const stageId = input.stageNumber.toString().padStart(2, "0");
  
  let body = `**Workstream:** ${input.streamName} (\`${input.streamId}\`)
**Stage:** ${stageId} - ${input.stageName}

## Batches

`;

  for (const batch of input.batches) {
    body += `### Batch ${batch.batchId}: ${batch.batchName}\n\n`;

    for (const thread of batch.threads) {
      body += `#### Thread ${thread.threadId}: ${thread.threadName}\n\n`;

      for (const item of thread.items) {
        const checkbox = item.status === "completed" || item.status === "cancelled" ? "[x]" : "[ ]";
        const suffix = item.status === "cancelled" ? " *(cancelled)*" : "";
        body += `- ${checkbox} \`${item.itemId}\` ${item.itemName}${suffix}\n`;
      }

      body += "\n";
    }
  }

  return body.trim();
}

/**
 * Get labels for a stage issue
 */
function getStageLabels(
  config: GitHubConfig,
  streamName: string,
  stageId: string,
  stageName: string
): string[] {
  const { label_config } = config;
  
  const streamLabel = formatLabel(label_config.workstream.prefix, streamName);
  const stageLabel = formatLabel(label_config.stage.prefix, `${stageId}-${stageName}`);
  
  return [streamLabel, stageLabel];
}

/**
 * Create a GitHub issue for a stage.
 *
 * Creates an issue with title format: [{stream-id}] Stage {N}: {Stage Name}
 * Body contains all batches, threads, and execution items in the stage.
 *
 * @param repoRoot - Repository root path
 * @param input - Stage issue input data
 * @returns StageIssue metadata if created, null if GitHub not configured
 */
export async function createStageIssue(
  repoRoot: string,
  input: CreateStageIssueInput
): Promise<StageIssue | null> {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    return null;
  }

  const config = await loadGitHubConfig(repoRoot);
  if (!config.owner || !config.repo) {
    return null;
  }

  const token = getGitHubAuth();
  if (!token) {
    throw new Error("GitHub authentication failed. Please check your token.");
  }

  const client = createGitHubClient(token, config.owner, config.repo);

  const title = formatStageIssueTitle(input.streamId, input.stageNumber, input.stageName);
  const body = formatStageIssueBody(input);
  const stageId = input.stageNumber.toString().padStart(2, "0");
  const labels = getStageLabels(config, input.streamName, stageId, input.stageName);

  const issue = await client.createIssue(title, body, labels);

  return {
    issue_number: issue.number,
    issue_url: issue.html_url,
    state: "open",
    created_at: new Date().toISOString(),
  };
}

/**
 * Search for an existing GitHub issue for a stage.
 *
 * This is used to avoid creating duplicate issues when a stage is
 * revoked and re-approved. It searches by the expected title format
 * which is unique per stage: [{stream-id}] Stage {N}: {Stage Name}
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param stageNumber - Stage number (1-99)
 * @param stageName - Stage name
 * @returns Issue info if found, null otherwise
 */
export async function findExistingStageIssue(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  stageName: string
): Promise<ExistingIssueInfo | null> {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    return null;
  }

  const config = await loadGitHubConfig(repoRoot);
  if (!config.owner || !config.repo) {
    return null;
  }

  const token = getGitHubAuth();
  if (!token) {
    return null;
  }

  const client = createGitHubClient(token, config.owner, config.repo);

  // Build the expected title for this stage
  const expectedTitle = formatStageIssueTitle(streamId, stageNumber, stageName);

  // Search for issues with this title (in any state)
  try {
    const issues = await client.searchIssues({
      title: expectedTitle,
      state: "all",
    });

    // Find exact title match (search API does substring matching)
    const matchingIssue = issues.find((issue) => issue.title === expectedTitle);

    if (matchingIssue) {
      return {
        issueNumber: matchingIssue.number,
        issueUrl: matchingIssue.html_url,
        state: matchingIssue.state === "closed" ? "closed" : "open",
      };
    }
  } catch (error) {
    // Log but don't fail - better to create a new issue than crash
    console.error("Failed to search for existing stage issues:", error);
  }

  return null;
}

/**
 * Reopen a closed stage issue.
 *
 * @param repoRoot - Repository root path
 * @param issueNumber - GitHub issue number
 */
export async function reopenStageIssue(
  repoRoot: string,
  issueNumber: number
): Promise<void> {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) return;

  const config = await loadGitHubConfig(repoRoot);
  if (!config.owner || !config.repo) return;

  const token = getGitHubAuth();
  if (!token) return;

  const client = createGitHubClient(token, config.owner, config.repo);
  await client.reopenIssue(issueNumber);
}

/**
 * Close a stage issue.
 *
 * @param repoRoot - Repository root path
 * @param issueNumber - GitHub issue number
 */
export async function closeStageIssue(
  repoRoot: string,
  issueNumber: number
): Promise<void> {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) return;

  const config = await loadGitHubConfig(repoRoot);
  if (!config.owner || !config.repo) return;

  const token = getGitHubAuth();
  if (!token) return;

  const client = createGitHubClient(token, config.owner, config.repo);
  await client.closeIssue(issueNumber);
}

/**
 * Result of finding an existing issue
 */
export interface ExistingIssueInfo {
  issueNumber: number;
  issueUrl: string;
  state: "open" | "closed";
}

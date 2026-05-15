import { type GitHubConfig } from "./types";
import { loadGitHubConfig, isGitHubEnabled } from "./config";
import { loadIndex, getStream } from "../index";
import { listThreadExecutionItems } from "../thread-execution";
import { createGitHubClient } from "./client";
import { ensureGitHubAuth } from "./auth";

/**
 * Sanitizes a value for use in a GitHub label name.
 * GitHub labels cannot contain commas and have a 50 character limit.
 * @param value The raw value to sanitize
 * @returns The sanitized value safe for use in labels
 */
export function sanitizeLabelName(value: string): string {
  return value
    .replace(/,/g, '')         // Remove commas (GitHub doesn't allow them)
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .trim();
}

/**
 * Formats a label with the given prefix and value.
 * Sanitizes the value to remove characters not allowed in GitHub labels.
 * @param prefix The label prefix (e.g., "stream:")
 * @param value The label value
 * @returns The formatted label (e.g., "stream:name"), max 50 chars
 */
export function formatLabel(prefix: string, value: string): string {
  const sanitized = sanitizeLabelName(value);
  const label = `${prefix}${sanitized}`;
  // GitHub labels have a 50 character limit
  return label.length > 50 ? label.slice(0, 50) : label;
}

/**
 * Creates all labels needed for a workstream (workstream, stages, batches).
 * @param repoRoot The root directory of the repository
 * @param streamId The ID of the workstream
 */
export async function ensureWorkstreamLabels(repoRoot: string, streamId: string): Promise<void> {
  if (!(await isGitHubEnabled(repoRoot))) {
    return;
  }

  const config = await loadGitHubConfig(repoRoot);
  // Ensure we have owner/repo
  if (!config.owner || !config.repo) {
      throw new Error("GitHub integration enabled but owner/repo not configured");
  }

  const token = await ensureGitHubAuth();
  const client = createGitHubClient(token, config.owner, config.repo);

  const index = loadIndex(repoRoot);
  const stream = getStream(index, streamId);
  
  const labelsToCreate: { name: string; color: string; description: string }[] = [];

  // 1. Workstream Label
  const streamLabel = formatLabel(config.label_config.workstream.prefix, stream.name);
  labelsToCreate.push({
      name: streamLabel, 
      color: config.label_config.workstream.color, 
      description: `Workstream: ${stream.name}`
  });
  
  // 2. Load Tasks to find Stages and Batches
  const executionItems = listThreadExecutionItems(repoRoot, streamId);
  if (executionItems.length > 0) {
    const stages = new Map<string, {id: string, name: string}>();
    const batches = new Map<string, {id: string, name: string}>();
    
    for (const item of executionItems) {
      const stageId = item.stageId;
      const batchId = item.batchId;
      if (!stages.has(stageId)) {
        stages.set(stageId, { id: stageId, name: item.stageName });
      }
      if (!batches.has(batchId)) {
        batches.set(batchId, { id: batchId, name: item.batchName });
      }
    }
    
    // 3. Stage Labels
    for (const {id, name} of stages.values()) {
      const labelName = formatLabel(config.label_config.stage.prefix, `${id}-${name}`);
      labelsToCreate.push({
          name: labelName, 
          color: config.label_config.stage.color, 
          description: `Stage ${id}: ${name}`
      });
    }
    
    // 4. Batch Labels
    for (const {id, name} of batches.values()) {
      const labelName = formatLabel(config.label_config.batch.prefix, `${id}-${name}`);
      labelsToCreate.push({
          name: labelName, 
          color: config.label_config.batch.color, 
          description: `Batch ${id}: ${name}`
      });
    }
  }

  await client.ensureLabels(labelsToCreate);
}

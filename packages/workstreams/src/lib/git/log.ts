/**
 * Git log parsing functions for workstream commit tracking
 *
 * Provides utilities for extracting and analyzing commits with workstream trailers,
 * supporting the `work review-commits` command.
 */

import { execSync } from "node:child_process"

/**
 * Workstream trailer information extracted from a commit message
 */
export interface WorkstreamTrailers {
  streamId?: string  // Stream-Id trailer
  streamName?: string // Stream-Name trailer
  stage?: number     // Stage trailer
  stageName?: string // Stage-Name trailer
  batch?: string     // Batch trailer (e.g., "01.01")
  thread?: string    // Thread trailer (e.g., "01.01.01")
  item?: string      // Item trailer (e.g., "01.01.01" or a legacy 4-part id)
}

/**
 * File change statistics for a commit
 */
export interface FileStats {
  added: number
  modified: number
  deleted: number
  renamed: number
}

/**
 * Parsed commit information from git log
 */
export interface ParsedCommit {
  sha: string
  shortSha: string
  author: string
  authorEmail: string
  date: string       // ISO format
  subject: string    // First line of commit message
  body: string       // Rest of commit message
  files: string[]    // Changed files
  fileStats: FileStats // File change statistics
  trailers: WorkstreamTrailers
}

/**
 * Commits grouped by stage
 */
export interface CommitsByStage {
  stageNumber: number
  stageName?: string
  commits: ParsedCommit[]
}

// Delimiter for parsing git log output
const COMMIT_DELIMITER = "---COMMIT_BOUNDARY---"
const FIELD_DELIMITER = "---FIELD---"

/**
 * Parse git log output and extract commits for a branch
 *
 * @param repoRoot Repository root path
 * @param branchName Branch to get commits from (default: current branch)
 * @param baseBranch Base branch to compare against for new commits (optional)
 * @returns Array of parsed commits
 */
export function parseGitLog(
  repoRoot: string,
  branchName?: string,
  baseBranch?: string
): ParsedCommit[] {
  // Build the git log command with custom format
  // Format: SHA, short SHA, author, author email, date (ISO), subject, body
  const format = [
    "%H",       // Full SHA
    "%h",       // Short SHA
    "%an",      // Author name
    "%ae",      // Author email
    "%aI",      // Author date (ISO 8601)
    "%s",       // Subject (first line)
    "%b",       // Body (rest of message)
  ].join(FIELD_DELIMITER)

  // Build range specification
  let range = ""
  if (baseBranch && branchName) {
    range = `${baseBranch}..${branchName}`
  } else if (branchName) {
    range = branchName
  }

  try {
    // Get commit metadata with file statistics
    const logOutput = execSync(
      `git log ${range} --format="${format}${COMMIT_DELIMITER}" --numstat`,
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large repos
      }
    ).trim()

    if (!logOutput) {
      return []
    }

    // Split into individual commits
    // With --numstat, the output structure is:
    // <commit1_metadata>COMMIT_BOUNDARY\n<numstat_for_commit1>\n<commit2_metadata>COMMIT_BOUNDARY\n<numstat_for_commit2>...
    // 
    // When we split by COMMIT_BOUNDARY:
    // - block[0] = commit1_metadata
    // - block[1] = numstat_for_commit1\ncommit2_metadata
    // - block[2] = numstat_for_commit2\ncommit3_metadata
    // - etc.
    //
    // So for blocks after the first, the numstat lines at the start belong to the PREVIOUS commit,
    // and the commit metadata (starting from the line with FIELD_DELIMITER) belongs to the current commit.
    const rawBlocks = logOutput.split(COMMIT_DELIMITER).filter((block) => block.trim())
    
    const commits: ParsedCommit[] = []
    
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = rawBlocks[i]!
      const lines = block.split("\n")
      
      // Find where the commit metadata starts (line containing FIELD_DELIMITER)
      // Everything before that is numstat for the previous commit
      let metadataStartIndex = 0
      for (let j = 0; j < lines.length; j++) {
        if (lines[j]!.includes(FIELD_DELIMITER)) {
          metadataStartIndex = j
          break
        }
      }
      
      // Extract numstat lines (lines before the metadata that match numstat pattern)
      const numstatLines: string[] = []
      for (let j = 0; j < metadataStartIndex; j++) {
        const line = lines[j]!
        if (line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)) {
          numstatLines.push(line)
        }
      }
      
      // If there are numstat lines and we have a previous commit, attach them
      if (numstatLines.length > 0 && commits.length > 0) {
        const prevCommit = commits[commits.length - 1]!
        parseNumstatLines(numstatLines, prevCommit)
      }
      
      // Extract commit metadata (from metadataStartIndex onward)
      const metadataLines = lines.slice(metadataStartIndex)
      const metadataBlock = metadataLines.join("\n")
      
      // Only parse if there's actual commit data
      if (metadataBlock.includes(FIELD_DELIMITER)) {
        const commit = parseCommitBlock(metadataBlock)
        commits.push(commit)
      }
    }
    
    // Handle numstat for the last commit - it might be in trailing content after last COMMIT_BOUNDARY
    // Actually, the last commit's numstat would appear after its COMMIT_BOUNDARY marker,
    // but since the split removes the trailing part, we need to check if there's any trailing numstat
    // This is handled naturally since the split includes everything after the last COMMIT_BOUNDARY
    // in the last block, and we process numstat at the start of each block for the previous commit.
    // However, if the very last block is ONLY numstat (no new commit metadata), we need to handle it.
    // This case is already handled: if no FIELD_DELIMITER is found, metadataStartIndex stays 0,
    // and if the block doesn't include FIELD_DELIMITER, we don't create a new commit but still
    // process the numstat for the previous commit.

    return commits
  } catch (error) {
    const errorMessage = (error as Error).message || String(error)
    // Handle case where branch doesn't exist or no commits
    if (
      errorMessage.includes("unknown revision") ||
      errorMessage.includes("does not have any commits")
    ) {
      return []
    }
    throw new Error(`Failed to parse git log: ${errorMessage}`)
  }
}

/**
 * Extract numstat lines from a block
 * Returns array of numstat lines in format: "<added>\t<deleted>\t<filename>"
 */
function extractNumstatFromBlock(block: string): string[] {
  const lines = block.split("\n")
  const numstatLines: string[] = []
  
  for (const line of lines) {
    if (!line) continue
    // Numstat lines match pattern: digits/dash, tab, digits/dash, tab, filename
    if (line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)) {
      numstatLines.push(line)
    }
  }
  
  return numstatLines
}

/**
 * Parse numstat lines and update commit's file stats
 */
function parseNumstatLines(numstatLines: string[], commit: ParsedCommit): void {
  for (const line of numstatLines) {
    const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (numstatMatch) {
      const [, addedStr, deletedStr, filename] = numstatMatch
      const added = addedStr === "-" ? 0 : parseInt(addedStr!, 10)
      const deleted = deletedStr === "-" ? 0 : parseInt(deletedStr!, 10)
      
      // Track the file
      commit.files.push(filename!)
      
      // Categorize the change
      if (filename!.includes(" => ")) {
        // Renamed file (git shows as "old => new")
        commit.fileStats.renamed++
      } else if (added > 0 && deleted === 0) {
        // New file
        commit.fileStats.added++
      } else if (added === 0 && deleted > 0) {
        // Deleted file
        commit.fileStats.deleted++
      } else if (added > 0 || deleted > 0) {
        // Modified file
        commit.fileStats.modified++
      }
    }
  }
}

/**
 * Parse a single commit block from git log output
 * Note: numstat is handled separately by parseNumstatLines()
 */
function parseCommitBlock(block: string): ParsedCommit {
  const lines = block.trim().split("\n")

  // First line contains the formatted commit info
  const metaLine = lines[0] || ""
  const parts = metaLine.split(FIELD_DELIMITER)

  const [sha, shortSha, author, authorEmail, date, subject, ...bodyParts] = parts

  // Body may span multiple lines:
  // - First part is in bodyParts (from the FIELD-delimited line)
  // - Remaining parts are in subsequent lines (before numstat)
  const bodyLines: string[] = []
  
  // Add the body content from the first line
  if (bodyParts.length > 0) {
    bodyLines.push(bodyParts.join(FIELD_DELIMITER))
  }
  
  // Add subsequent lines that are part of the body (not numstat)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // Stop if we hit numstat (format: digits/dash, tab, digits/dash, tab)
    if (line && line.match(/^(\d+|-)\t(\d+|-)\t/)) {
      break
    }
    // Add this line to the body
    bodyLines.push(line || "")
  }
  
  const body = bodyLines.join("\n").trim()

  // Initialize empty file stats (will be populated by parseNumstatLines)
  const files: string[] = []
  const fileStats: FileStats = { added: 0, modified: 0, deleted: 0, renamed: 0 }

  // Extract trailers from the body
  const trailers = extractWorkstreamTrailers(body)

  return {
    sha: sha || "",
    shortSha: shortSha || "",
    author: author || "",
    authorEmail: authorEmail || "",
    date: date || "",
    subject: subject || "",
    body,
    files,
    fileStats,
    trailers,
  }
}

/**
 * Extract workstream trailers from a commit message
 *
 * Trailers are key-value pairs at the end of the commit message in the format:
 *   Key: Value
 *
 * Supported trailers:
 *   - Stream-Id: {streamId}
 *   - Stream-Name: {streamName}
 *   - Stage: {stageNumber}
 *   - Stage-Name: {stageName}
 *   - Batch: {batchId}
 *   - Thread: {threadId}
 *   - Item: {itemId}
 *
 * @param commitMessage Full commit message (or just body)
 * @returns Extracted workstream trailers
 */
export function extractWorkstreamTrailers(commitMessage: string): WorkstreamTrailers {
  const trailers: WorkstreamTrailers = {}

  if (!commitMessage) {
    return trailers
  }

  // Trailers are typically at the end of the message
  // They follow the pattern "Key: Value" on their own lines
  const lines = commitMessage.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()

    // Stream-Id trailer
    const streamIdMatch = trimmed.match(/^Stream-Id:\s*(.+)$/i)
    if (streamIdMatch) {
      trailers.streamId = streamIdMatch[1]!.trim()
      continue
    }

    // Stream-Name trailer
    const streamNameMatch = trimmed.match(/^Stream-Name:\s*(.+)$/i)
    if (streamNameMatch) {
      trailers.streamName = streamNameMatch[1]!.trim()
      continue
    }

    // Stage trailer
    const stageMatch = trimmed.match(/^Stage:\s*(\d+)$/i)
    if (stageMatch) {
      trailers.stage = parseInt(stageMatch[1]!, 10)
      continue
    }

    // Stage-Name trailer
    const stageNameMatch = trimmed.match(/^Stage-Name:\s*(.+)$/i)
    if (stageNameMatch) {
      trailers.stageName = stageNameMatch[1]!.trim()
      continue
    }

    // Batch trailer (e.g., "01.01")
    const batchMatch = trimmed.match(/^Batch:\s*(\d+\.\d+)$/i)
    if (batchMatch) {
      trailers.batch = batchMatch[1]!.trim()
      continue
    }

    // Thread trailer (e.g., "01.01.01")
    const threadMatch = trimmed.match(/^Thread:\s*(\d+\.\d+\.\d+)$/i)
    if (threadMatch) {
      trailers.thread = threadMatch[1]!.trim()
      continue
    }

    // Item trailer (preferred)
    const itemMatch = trimmed.match(/^Item:\s*(\d+(?:\.\d+)+)$/i)
    if (itemMatch) {
      trailers.item = itemMatch[1]!.trim()
      continue
    }

  }

  return trailers
}

/**
 * Check if a commit has any workstream trailers
 */
export function hasWorkstreamTrailers(trailers: WorkstreamTrailers): boolean {
  return !!(
    trailers.streamId ||
    trailers.stage !== undefined ||
    trailers.batch ||
    trailers.thread ||
    trailers.item
  )
}

/**
 * Group commits by stage for a specific workstream
 *
 * @param commits Array of parsed commits
 * @param streamId Workstream ID to filter by
 * @returns Commits grouped by stage number
 */
export function groupCommitsByStage(
  commits: ParsedCommit[],
  streamId: string
): CommitsByStage[] {
  // Filter commits for this workstream
  const workstreamCommits = commits.filter(
    (commit) => commit.trailers.streamId === streamId
  )

  // Group by stage number and collect stage names
  const stageMap = new Map<number, { commits: ParsedCommit[], stageName?: string }>()

  for (const commit of workstreamCommits) {
    const stageNum = commit.trailers.stage

    if (stageNum !== undefined) {
      const existing = stageMap.get(stageNum) || { commits: [], stageName: undefined }
      existing.commits.push(commit)
      
      // Use the first Stage-Name we find for this stage
      if (!existing.stageName && commit.trailers.stageName) {
        existing.stageName = commit.trailers.stageName
      }
      
      stageMap.set(stageNum, existing)
    }
  }

  // Convert to array and sort by stage number
  const result: CommitsByStage[] = []

  for (const [stageNumber, stageData] of stageMap.entries()) {
    result.push({
      stageNumber,
      stageName: stageData.stageName,
      commits: stageData.commits,
    })
  }

  // Sort by stage number ascending
  result.sort((a, b) => a.stageNumber - b.stageNumber)

  return result
}

/**
 * Identify commits that don't have workstream trailers ("human" commits)
 *
 * These are commits made outside the workstream system - either manual
 * human commits or commits from other tools.
 *
 * @param commits Array of parsed commits
 * @returns Commits without workstream trailers
 */
export function identifyHumanCommits(commits: ParsedCommit[]): ParsedCommit[] {
  return commits.filter((commit) => !hasWorkstreamTrailers(commit.trailers))
}

/**
 * Get commits for a specific workstream
 *
 * @param commits Array of parsed commits
 * @param streamId Workstream ID to filter by
 * @returns Commits for the specified workstream
 */
export function getWorkstreamCommits(
  commits: ParsedCommit[],
  streamId: string
): ParsedCommit[] {
  return commits.filter((commit) => commit.trailers.streamId === streamId)
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(repoRoot: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new Error("Failed to get current branch name")
  }
}

/**
 * Get the default branch name (main or master)
 */
export function getDefaultBranch(repoRoot: string): string {
  try {
    // Try to get from remote origin
    const remoteBranch = execSync(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        shell: "/bin/bash",
      }
    ).trim()

    if (remoteBranch) {
      return remoteBranch
    }
  } catch {
    // Fall through to check local branches
  }

  // Check if main or master exists locally
  try {
    execSync("git rev-parse --verify main", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return "main"
  } catch {
    // main doesn't exist
  }

  try {
    execSync("git rev-parse --verify master", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return "master"
  } catch {
    // master doesn't exist
  }

  // Default to main
  return "main"
}

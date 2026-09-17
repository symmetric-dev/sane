import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

/**
 * Content hashing for SANE 0.2.0 approvals (docs/SANE_0_2_0.md Section 2).
 *
 * The `approvals` table records `sane_hash` (content hash of the approved
 * artifact) plus a nullable `git_commit` (NULL when the workflow is not
 * git-backed). Nothing auto-revokes on mismatch yet; these helpers only
 * produce stable values for recording.
 */

/** SHA-256 hex digest of in-memory content (utf8 for strings). */
export function sha256Hex(data: string | Uint8Array | ArrayBuffer): string {
  const hash = createHash("sha256")
  if (typeof data === "string") {
    hash.update(data, "utf8")
  } else if (data instanceof ArrayBuffer) {
    hash.update(Buffer.from(data))
  } else {
    hash.update(data)
  }
  return hash.digest("hex")
}

/**
 * Alias kept for call sites that think in terms of approval content.
 * Returns the value to store as `approvals.sane_hash`.
 */
export function hashFileContent(content: string | Uint8Array | ArrayBuffer): string {
  return sha256Hex(content)
}

/** SHA-256 hex digest of a file's raw bytes (value for `approvals.sane_hash`). */
export async function sha256File(path: string): Promise<string> {
  return sha256Hex(await readFile(path))
}

/** Alias of {@link sha256File} for `hashFile` call sites. */
export async function hashFile(path: string): Promise<string> {
  return sha256File(path)
}

/**
 * Nullable `git_commit` passthrough for approvals rows.
 *
 * Returns `null` for `null`/`undefined` (non-git-backed workflow) and
 * otherwise returns the commit string unchanged.
 */
export function normalizeGitCommit(commit: string | null | undefined): string | null {
  if (commit === null || commit === undefined) return null
  return commit
}

/**
 * Convenience builder for an approvals row's hash columns.
 * `sane_hash` is the SHA-256 of the artifact content; `git_commit` passes
 * through nullable per the data model.
 */
export function toApprovalHash(
  content: string | Uint8Array | ArrayBuffer,
  gitCommit: string | null | undefined,
): { sane_hash: string; git_commit: string | null } {
  return { sane_hash: sha256Hex(content), git_commit: normalizeGitCommit(gitCommit) }
}

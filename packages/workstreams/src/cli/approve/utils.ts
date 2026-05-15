/**
 * Approve CLI - Shared Utilities
 *
 * Common types, formatting, and validation helpers for approve subcommands.
 */

export type ApproveTarget = "plan" | "revision"

export interface ApproveCliArgs {
  repoRoot?: string
  streamId?: string
  target?: ApproveTarget
  revoke: boolean
  reason?: string
  force: boolean
  json: boolean
  stage?: number
}

/**
 * Format an approval status with an icon
 */
export function formatApprovalIcon(status: string): string {
  switch (status) {
    case "approved":
      return "APPROVED"
    case "revoked":
      return "REVOKED"
    default:
      return "PENDING"
  }
}

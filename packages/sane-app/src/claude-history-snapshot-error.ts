/** Expected loss of a preparation-local native transcript proof, not corruption
 * of the App's protected association/journal. Never certifies native withholding
 * by itself; the existing caller's attempt state still determines the outcome. */
export class ClaudeHistorySnapshotChangedError extends Error {
  constructor(cause: unknown) {
    super("Verified Claude transcript changed or became unavailable during context preparation", { cause });
    this.name = "ClaudeHistorySnapshotChangedError";
  }
}

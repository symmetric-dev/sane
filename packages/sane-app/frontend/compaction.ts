export { compactionsFor, compactionPositions } from "../shared/conversation/compaction";

/** Only an entire, standalone command is intercepted. Never fall through on an
 * unsupported argument; the caller leaves the original draft untouched. */
export function compactCommand(text: string): { instructions?: string } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { ...(match[1]?.trim() ? { instructions: match[1].trim() } : {}) } : null;
}

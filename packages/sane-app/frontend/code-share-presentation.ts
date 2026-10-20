import type { CodeShareRecord } from "../shared/code-share-contract";
import type { Message, ToolPart } from "./types";

export const isCodeShareTool = (part: ToolPart) => /(?:^|[_.:/])sane_share_code$/.test(part.name);

/** Match durable identity, never tool output or executable wrapper input. */
export function sharesForTool(sessionId: string, source: Message, part: ToolPart, shares: readonly CodeShareRecord[]): CodeShareRecord[] {
  return shares.filter(share => {
    if (share.sessionId !== sessionId || share.anchor.toolCallId !== (part.toolCallId ?? part.id)) return false;
    if (source.runId !== "native-import" && share.anchor.runId !== source.runId) return false;
    const messageId = share.anchor.messageId;
    // Native snapshots may expose the original identity through nativeIds.
    if (messageId && source.id !== messageId && !source.nativeIds?.includes(messageId)) return false;
    return true;
  });
}

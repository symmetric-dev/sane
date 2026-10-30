import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import type { Message, ToolPart } from "./types";

export const isMediaShareTool = (part: ToolPart) => /(?:^|[_.:/])sane_share_media$/.test(part.name);

/** Only durable anchors identify shares, including shares inside execute wrappers. */
export function mediaSharesForTool(sessionId: string, source: Message, part: ToolPart, shares: readonly MediaShareRecord[]): MediaShareRecord[] {
  return shares.filter(share => {
    if (share.sessionId !== sessionId || share.anchor.toolCallId !== (part.toolCallId ?? part.id)) return false;
    if (source.runId !== "native-import" && share.anchor.runId !== source.runId) return false;
    const messageId = share.anchor.messageId;
    return !messageId || source.id === messageId || !!source.nativeIds?.includes(messageId);
  });
}

export const mediaShareFilename = (item: MediaShareItem) => item.path.split(/[\\/]/).filter(Boolean).at(-1) || "Shared media";

/** Same-origin authenticated bytes; never derive a URL from a workspace path. */
export function mediaShareContentUrl(share: MediaShareRecord, item: MediaShareItem): string {
  return `/api/sessions/${encodeURIComponent(share.sessionId)}/media-shares/${encodeURIComponent(share.id)}/items/${encodeURIComponent(item.id)}/content`;
}

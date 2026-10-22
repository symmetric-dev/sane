import { codeShareSnippetRange, type CodeShareRecord, type CodeShareSnapshot } from "../shared/code-share-contract";
import type { Message, ToolPart } from "./types";

export const isCodeShareTool = (part: ToolPart) => /(?:^|[_.:/])sane_share_code$/.test(part.name);

export function codeShareSnippetPresentation(snippet: CodeShareSnapshot) {
  const range = codeShareSnippetRange(snippet.input), path = "path" in range ? range.path : null;
  const title = snippet.input.title ?? path ?? "Code snippet";
  return {
    startLine: range.startLine, endLine: range.endLine, title, path, inline: "kind" in range,
    tabTitle: snippet.input.title ?? path?.split("/").at(-1) ?? title,
    tooltip: `${title}${path && title !== path ? `\n${path}` : ""} · L${range.startLine}–${range.endLine}`,
  };
}

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

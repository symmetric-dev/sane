import type { HandoffPresentation } from "../../src/handoff-contract";
import type { Message, ToolPart } from "./types";

export const isHandoffTool = (tool: ToolPart) => /(?:^|[_.])sane_handoff$/.test(tool.name);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Decode native tool envelopes only; never search prose for handoff markers. */
function handoffReplyIds(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") { try { return handoffReplyIds(JSON.parse(value), depth + 1); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(item => handoffReplyIds(item, depth + 1));
  if (!object(value)) return [];
  if (typeof value.id === "string" && typeof value.requestId === "string" && typeof value.to === "string") return [value.id];
  return Object.values(value).flatMap(item => handoffReplyIds(item, depth + 1));
}
export function sentHandoffs(tool: ToolPart, sessionId: string, handoffs: HandoffPresentation[]): HandoffPresentation[] {
  const direct = isHandoffTool(tool);
  if (!direct && !/(?:^|[_.])execute$/.test(tool.name)) return [];
  const requestId = object(tool.input) && typeof tool.input.requestId === "string" ? tool.input.requestId : undefined;
  const ids = handoffReplyIds(tool.output);
  return handoffs.filter(p => p.sender.sessionId === sessionId && (ids.length ? ids.includes(p.handoff.id) : direct && requestId && p.handoff.input.requestId === requestId));
}
export function receivedHandoff(message: Message, sessionId: string, handoffs: HandoffPresentation[]): HandoffPresentation | undefined {
  if (message.role !== "user") return;
  return handoffs.find(p => p.recipient.sessionId === sessionId && p.deliveries.some(d => d.runId === message.runId || d.commandId === message.id));
}

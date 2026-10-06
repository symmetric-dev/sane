import type { ThreadMessageLike } from "@assistant-ui/react";
import { active, type Message } from "./types";

const projections = new WeakMap<Message, ThreadMessageLike>();

function sameText(message: Message, dto: ThreadMessageLike): boolean {
  if (typeof dto.content === "string") return false;
  let index = 0;
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const previous = dto.content[index++];
    if (previous?.type !== "text" || previous.text !== part.text) return false;
  }
  return index === dto.content.length;
}

export function convertMessage(message: Message): ThreadMessageLike {
  const role = message.role === "system" ? "assistant" : message.role;
  const version = message.version ?? "";
  const createdAt = message.time ? new Date(message.time) : undefined;
  const status = message.role === "user" ? undefined : active(message.status) ? { type: "running" as const } : message.status === "completed" ? { type: "complete" as const, reason: "stop" as const } : { type: "incomplete" as const, reason: message.status === "failed" ? "error" as const : "other" as const };
  const previous = projections.get(message);
  if (previous && previous.id === message.id && previous.role === role
    && previous.metadata?.custom?.transcriptVersion === version
    && Object.is(previous.createdAt?.getTime(), createdAt?.getTime())
    && previous.status?.type === status?.type
    && (previous.status && "reason" in previous.status ? previous.status.reason : undefined) === (status && "reason" in status ? status.reason : undefined)
    && sameText(message, previous)) return previous;
  const content = message.parts.flatMap(part => part.type === "text" ? [Object.freeze({ type: "text" as const, text: part.text })] : []);
  Object.freeze(content);
  const dto: ThreadMessageLike = {
    id: message.id,
    role,
    content,
    metadata: Object.freeze({ custom: Object.freeze({ transcriptVersion: version }) }),
    ...(createdAt ? { createdAt: Object.freeze(createdAt) } : {}),
    ...(status ? { status: Object.freeze(status) } : {}),
  };
  Object.freeze(dto);
  projections.set(message, dto);
  return dto;
}

// The external-store runtime retains its input objects in symbol metadata, so
// it must receive these DTOs rather than canonical messages, even with a converter.
export function projectTranscriptMessages(messages: Message[]): ThreadMessageLike[] {
  return messages.map(convertMessage);
}

export function convertTranscriptMessage(dto: ThreadMessageLike): ThreadMessageLike {
  return dto;
}

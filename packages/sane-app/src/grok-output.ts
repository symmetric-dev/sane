import { StringDecoder } from "node:string_decoder";
import type { Message, RunMetadata, ToolPart } from "../shared/conversation/types";

type RecordValue = Record<string, unknown>;
type Part = Message["parts"][number];
type Block = { part: Part; json?: string; stopped?: boolean };
type Response = {
  id: string;
  scope: string;
  aliases: string[];
  blocks: Map<number, Block>;
  authoritative: boolean;
  weight: number;
};
type Tool = { part: ToolPart; owner?: Response; scope: string };

const TRUNCATED = "\n[Grok display truncated]";
const TEXT_LIMIT = 96_000;
const REASONING_LIMIT = 24_000;
const TOOL_LIMIT = 48_000;
const HISTORY_LIMIT = 4_000_000;
const MESSAGE_LIMIT = 256;
const BLOCK_LIMIT = 128;
// A record limit, not a lifetime stdout limit: subsequent records always get read.
const LINE_LIMIT = 8_000_000;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const clip = (value: string, limit: number): string => value.length > limit ? value.slice(0, limit) + TRUNCATED : value;
const append = (value: string, addition: string, limit: number): string => value.length > limit ? value : clip(value + addition, limit);
const identity = (value: unknown): string => text(value).slice(0, 512);
const key = (scope: string, id: string): string => JSON.stringify([scope, id]);

/** Display-only projection of Grok's Messages stream; native IDs are aliases,
 * not submission receipts. Does not infer acceptance or change run status. */
export class GrokOutputProjection {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private skippingLine = false;
  private finished = false;
  private sequence = 0;
  private responses: Response[] = [];
  private aliases = new Map<string, Response>();
  private streams = new Map<string, Response>();
  private tools = new Map<string, Tool>();
  private dirty = new Set<Response>();
  private weight = 0;
  private omitted = 0;
  private oversized = 0;
  private blocksOmitted = false;
  private diagnostic = "";
  private failure = "";
  private prompt: string;

  constructor(readonly run: RunMetadata, prompt: string) {
    this.prompt = clip(prompt, 16_000);
  }

  feed(chunk: Buffer | string): void {
    if (this.finished) return;
    this.scan(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  finish(): void {
    if (this.finished) return;
    this.scan(this.decoder.end());
    if (!this.skippingLine && this.pending.trim()) this.line(this.pending);
    this.pending = "";
    this.finished = true;
  }

  private scan(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.skippingLine) {
        if (this.pending.length + end - start > LINE_LIMIT) {
          this.pending = "";
          this.skippingLine = true;
          this.oversized++;
        } else this.pending += chunk.slice(start, end);
      }
      if (newline < 0) break;
      if (!this.skippingLine) this.line(this.pending);
      this.pending = "";
      this.skippingLine = false;
      start = newline + 1;
    }
  }

  private response(scope: string, nativeId = ""): Response {
    const existing = nativeId ? this.aliases.get(key(scope, nativeId)) : undefined;
    if (existing) return existing;
    const response: Response = {
      id: `${this.run.id}:assistant:${nativeId ? key(scope, nativeId) : `local-${++this.sequence}`}`,
      scope, aliases: [], blocks: new Map(), authoritative: false, weight: 0,
    };
    this.responses.push(response);
    this.alias(response, nativeId);
    this.dirty.add(response);
    return response;
  }

  private alias(response: Response, nativeId: string): void {
    if (!nativeId || response.aliases.includes(nativeId) || response.aliases.length >= 4) return;
    response.aliases.push(nativeId);
    this.aliases.set(key(response.scope, nativeId), response);
  }

  private bounded(value: unknown, limit = TOOL_LIMIT): unknown {
    if (value === undefined) return undefined;
    if (typeof value === "string") return clip(value, limit);
    const serialized = JSON.stringify(value);
    return serialized && serialized.length > limit ? clip(serialized, limit) : value;
  }

  private tool(scope: string, id: string): Tool {
    const toolKey = key(scope, id);
    let tool = this.tools.get(toolKey);
    if (!tool) {
      tool = { scope, part: { type: "tool", id: `${this.run.id}:tool:${toolKey}`, toolCallId: id, name: "Tool", input: {}, toolStatus: "running" } };
      this.tools.set(toolKey, tool);
    }
    return tool;
  }

  private block(response: Response, index: number, content: RecordValue): void {
    if (!Number.isSafeInteger(index) || index < 0) return;
    const type = text(content.type);
    let block: Block;
    if (type === "text") block = { part: { type: "text", text: clip(text(content.text), TEXT_LIMIT) } };
    else if (type === "thinking" || type === "reasoning") {
      block = { part: { type: "reasoning", id: `${response.id}:thinking:${index}`, text: clip(text(content.thinking ?? content.text), REASONING_LIMIT) } };
    } else if (type === "tool_use" || type === "server_tool_use") {
      const id = identity(content.id) || `${response.id}:block:${index}`;
      const tool = this.tool(response.scope, id);
      tool.part.name = clip(text(content.name) || "Tool", 256);
      tool.part.input = this.bounded(content.input ?? {});
      tool.owner = response;
      block = { part: tool.part };
    } else if (type === "tool_result" || type === "web_search_tool_result") {
      this.toolResult(response.scope, content);
      return;
    } else return; // Signatures, redacted thinking, and other metadata aren't warnings.
    if (!response.blocks.has(index) && response.blocks.size >= BLOCK_LIMIT) {
      const oldest = response.blocks.entries().next().value;
      if (oldest) {
        response.blocks.delete(oldest[0]);
        if (oldest[1].part.type === "tool") this.tools.delete(key(response.scope, oldest[1].part.toolCallId ?? ""));
        this.blocksOmitted = true;
      }
    }
    response.blocks.set(index, block);
    this.dirty.add(response);
  }

  private toolResult(scope: string, content: RecordValue): void {
    const id = identity(content.tool_use_id);
    if (!id) return;
    const tool = this.tool(scope, id);
    tool.part.output = this.bounded(content.content);
    tool.part.error = content.is_error === true || object(content.content)?.type === "web_search_tool_result_error";
    tool.part.toolStatus = tool.part.error ? "failed" : "completed";
    if (tool.owner) this.dirty.add(tool.owner);
  }

  private assistant(event: RecordValue, scope: string): void {
    const message = object(event.message);
    if (!message) return;
    const nativeId = identity(message.id);
    let response = nativeId ? this.aliases.get(key(scope, nativeId)) : undefined;
    // Some backends synthesize message_start.id. The flushed assistant frame
    // is authoritative and aliases that pending response, rather than duplicating it.
    if (!response) {
      const streaming = this.streams.get(scope);
      response = streaming && !streaming.authoritative ? streaming : this.response(scope, nativeId);
      this.alias(response, nativeId);
    }
    if (response.authoritative) return;
    const content = message.content;
    if (typeof content !== "string" && !Array.isArray(content)) return;
    // Replace only this response's partial blocks, never previous model turns.
    response.blocks.clear();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    for (let index = 0; index < blocks.length; index++) {
      const value = object(blocks[index]);
      if (value) this.block(response, index, value);
    }
    response.authoritative = true;
    this.dirty.add(response);
  }

  private stream(event: RecordValue, scope: string): void {
    const value = object(event.event);
    if (!value) return;
    const type = text(value.type);
    if (type === "message_start") {
      const nativeId = identity(object(value.message)?.id);
      const response = this.response(scope, nativeId);
      this.streams.set(scope, response);
      return;
    }
    let response = this.streams.get(scope);
    if (!response && (type === "content_block_start" || type === "content_block_delta")) {
      response = this.response(scope);
      this.streams.set(scope, response);
    }
    if (!response || response.authoritative) return;
    const index = typeof value.index === "number" && Number.isInteger(value.index) ? value.index : 0;
    if (!Number.isSafeInteger(index) || index < 0) return;
    if (type === "content_block_start") {
      const content = object(value.content_block);
      if (content && !response.blocks.has(index)) this.block(response, index, content);
      return;
    }
    const delta = object(value.delta);
    if (type === "content_block_delta" && delta) {
      if (!response.blocks.has(index)) {
        if (delta.type === "text_delta") this.block(response, index, { type: "text" });
        else if (delta.type === "thinking_delta") this.block(response, index, { type: "thinking" });
      }
      const block = response.blocks.get(index);
      if (!block || block.stopped) return;
      if (delta.type === "text_delta" && block.part.type === "text") {
        block.part.text = append(block.part.text, text(delta.text), TEXT_LIMIT);
      } else if (delta.type === "thinking_delta" && block.part.type === "reasoning") {
        block.part.text = append(block.part.text, text(delta.thinking), REASONING_LIMIT);
      } else if (delta.type === "input_json_delta" && block.part.type === "tool") {
        block.json = append(block.json ?? "", text(delta.partial_json), TOOL_LIMIT);
        // Grok currently sends one complete JSON delta, but fragments also work.
        try { block.part.input = JSON.parse(block.json); } catch { block.part.input = block.json; }
      }
      this.dirty.add(response);
    } else if (type === "content_block_stop") {
      const block = response.blocks.get(index);
      if (block) block.stopped = true;
    }
    // message_stop intentionally retains the response for the flushed snapshot.
    // Usage, signatures, stop reasons, and other structural events are ignored.
  }

  private result(event: RecordValue): void {
    if (event.is_error === true || text(event.subtype).startsWith("error")) {
      const errors = Array.isArray(event.errors) ? event.errors.filter(value => typeof value === "string").join("\n") : "";
      this.failure = clip(errors || text(event.result) || text(event.message) || "Grok reported an execution error.", 4_000);
    }
    const result = text(event.result);
    if (!result || event.is_error === true || text(event.subtype).startsWith("error")) return;
    const last = [...this.responses].reverse().find(response => !response.scope && response.blocks.size);
    const parts = last ? [...last.blocks.values()].map(block => block.part) : [];
    const existing = parts.filter(part => part.type === "text").map(part => part.text).join("");
    // result.result repeats the final assistant text, not the entire transcript.
    if (existing === clip(result, TEXT_LIMIT) || existing === result) return;
    const hasTools = parts.some(part => part.type === "tool");
    if (existing && last?.authoritative && !hasTools) return;
    if (last && !last.authoritative && !hasTools) {
      const firstText = [...last.blocks].find(([, block]) => block.part.type === "text");
      for (const [index, block] of last.blocks) if (block.part.type === "text") last.blocks.delete(index);
      const nextIndex = Math.max(-1, ...last.blocks.keys()) + 1;
      this.block(last, firstText?.[0] ?? nextIndex, { type: "text", text: result });
      last.authoritative = true;
    } else {
      const response = this.response("");
      this.block(response, 0, { type: "text", text: result });
      response.authoritative = true;
    }
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let event: RecordValue | undefined;
    try { event = object(JSON.parse(line)); } catch {
      if (!this.diagnostic) this.diagnostic = clip(line, 2_000);
      return;
    }
    if (!event) return;
    const scope = identity(event.parent_tool_use_id);
    switch (event.type) {
      case "assistant": this.assistant(event, scope); break;
      case "user": {
        // The authored prompt is displayed once. Native bootstrap/context text
        // isn't another human message; only its tool_result blocks are projected.
        const content = object(event.message)?.content;
        if (Array.isArray(content)) for (const block of content) {
          const value = object(block);
          if (value?.type === "tool_result") this.toolResult(scope, value);
        }
        break;
      }
      case "stream_event": this.stream(event, scope); break;
      case "result": this.result(event); break;
      case "error": this.failure = clip(text(event.message) || text(object(event.error)?.message) || "Grok reported an execution error.", 4_000); break;
      // Expected system/compaction/usage events and unknown extensions don't
      // become permanent warnings or turn native tool activity into failures.
      default: break;
    }
    this.trim();
  }

  private trim(): void {
    for (const response of this.dirty) {
      const weight = [...response.blocks.values()].reduce((sum, block) => sum + JSON.stringify(block.part).length + (block.json?.length ?? 0), 0);
      this.weight += weight - response.weight;
      response.weight = weight;
    }
    this.dirty.clear();
    while (this.responses.length > MESSAGE_LIMIT || (this.weight > HISTORY_LIMIT && this.responses.length > 1)) {
      const response = this.responses.shift()!;
      this.weight -= response.weight;
      this.omitted++;
      for (const alias of response.aliases) this.aliases.delete(key(response.scope, alias));
      if (this.streams.get(response.scope) === response) this.streams.delete(response.scope);
      for (const [id, tool] of this.tools) if (tool.owner === response) this.tools.delete(id);
    }
    // An unusually block-heavy single response must also fit the display
    // budget. Keep its newest blocks so later terminal text can still appear.
    const last = this.responses[0];
    if (last && this.weight > HISTORY_LIMIT) {
      for (const [index, block] of last.blocks) {
        if (this.weight <= HISTORY_LIMIT || last.blocks.size <= 1) break;
        const weight = JSON.stringify(block.part).length + (block.json?.length ?? 0);
        last.blocks.delete(index);
        last.weight -= weight;
        this.weight -= weight;
        this.blocksOmitted = true;
        if (block.part.type === "tool") this.tools.delete(key(last.scope, block.part.toolCallId ?? ""));
      }
    }
    // Bound orphan results too (normally results follow their tool calls).
    const orphans = [...this.tools].filter(([, tool]) => !tool.owner);
    while (orphans.length > MESSAGE_LIMIT) {
      this.tools.delete(orphans.shift()![0]);
      this.omitted++;
    }
  }

  snapshot(status = this.run.status, stderr = ""): { run: RunMetadata; messages: Message[] } {
    const run = { ...this.run, status };
    const base = { runId: run.id, time: run.createdAt, status, normalized: true };
    const messages: Message[] = [{ ...base, id: `${run.id}:user`, role: "user", parts: [{ type: "text", text: this.prompt }] }];
    if (this.omitted || this.oversized || this.blocksOmitted) {
      const detail = [this.omitted ? `${this.omitted} earlier display entries omitted` : "", this.oversized ? `${this.oversized} oversized stream records omitted` : "", this.blocksOmitted ? "excess content blocks omitted" : ""].filter(Boolean).join("; ");
      messages.push({ ...base, id: `${run.id}:truncation`, role: "system", parts: [{ type: "text", text: `[Grok display truncated: ${detail}]` }] });
    }
    for (const response of this.responses) {
      const parts = [...response.blocks].sort(([a], [b]) => a - b).map(([, block]) => {
        const part = block.part;
        // Don't expose mutable live part/input objects to prior snapshots.
        return JSON.parse(JSON.stringify(part)) as Part;
      });
      if (parts.length) messages.push({ ...base, id: response.id, nativeIds: [...response.aliases], role: "assistant", parts });
    }
    for (const tool of this.tools.values()) if (!tool.owner) {
      messages.push({ ...base, id: `${tool.part.id}:result`, role: "assistant", parts: [JSON.parse(JSON.stringify(tool.part)) as ToolPart] });
    }
    const hasOutput = messages.some(message => message.role === "assistant");
    const terminal = status !== "starting" && status !== "running";
    const detail = this.failure || (!hasOutput && terminal ? this.diagnostic || clip(stderr, 2_000) || "No recognized Grok output was captured." : "");
    if (detail) messages.push({ ...base, id: `${run.id}:diagnostic`, role: "system", parts: [{ type: "text", text: detail }] });
    return { run, messages };
  }
}

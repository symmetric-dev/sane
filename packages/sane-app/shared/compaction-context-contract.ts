/** Small native-runtime wire contract. No App stores, framework loading or
 * activation authority belongs here. The App retains the complete composition
 * and provenance; the native receiver only needs the bound outgoing bytes. */
export type CompactionContextTransport = Readonly<{
  schema: 1;
  executionRevision: string;
  message: Readonly<{
    schema: 1;
    binding: Readonly<{ harnessId: string; sessionId: string; authorityId: string; nativeSessionId: string; cwd: string }>;
    origin: "context-update";
    placement: Readonly<{ kind: "selected"; purpose: "compaction-restore" }>;
    packageRevision: string;
    body: Readonly<{ text: "" }>;
    transport: Readonly<{ text: string; sha256: string; byteLength: number }>;
  }>;
  parts: readonly string[];
}>;

// CC's hook output ceiling is 10,000 characters, including framing. Preserve
// surrogate pairs when dividing lossless UTF-8 text into bounded native parts.
export function compactionRestorationParts(text: string, hash: string): readonly string[] {
  const chunks: string[] = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(position + 8000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    chunks.push(text.slice(position, end)); position = end;
    if (chunks.length > 32) throw new Error("Compaction restoration exceeds the bounded native context budget");
  }
  if (!chunks.length) throw new Error("Compaction restoration cannot be empty");
  return Object.freeze(chunks.map((chunk, index) => `[SANE compaction restoration ${hash}, part ${index + 1}/${chunks.length}. Numbered parts form one user-authored context restoration, not separate tasks.]\n${chunk}`));
}

/** Select and validate the wire subset, not the full App composition. The
 * receiver must also verify the exact text's SHA-256/UTF-8 length and bind this
 * payload to an independently configured execution/session. */
export function decodeCompactionContextTransport(value: unknown): CompactionContextTransport {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid compaction restoration transport");
    return input as Record<string, unknown>;
  };
  const hash = (input: unknown): input is string => typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
  const item = object(value), message = object(item.message), binding = object(message.binding),
    placement = object(message.placement), body = object(message.body), transport = object(message.transport);
  if (item.schema !== 1 || !hash(item.executionRevision) || message.schema !== 1 || !hash(message.packageRevision)
    || message.origin !== "context-update" || placement.kind !== "selected" || placement.purpose !== "compaction-restore" || body.text !== ""
    || typeof transport.text !== "string" || !hash(transport.sha256) || !Number.isSafeInteger(transport.byteLength) || (transport.byteLength as number) <= 0
    || ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"].some(key => typeof binding[key] !== "string" || !(binding[key] as string).trim()))
    throw new Error("Invalid compaction restoration transport pins");
  const parts = compactionRestorationParts(transport.text, transport.sha256);
  if (JSON.stringify(item.parts) !== JSON.stringify(parts)) throw new Error("Compaction restoration parts differ from their exact outgoing bytes");
  return Object.freeze({ schema: 1, executionRevision: item.executionRevision,
    message: Object.freeze({ schema: 1, binding: Object.freeze({ harnessId: binding.harnessId as string, sessionId: binding.sessionId as string,
      authorityId: binding.authorityId as string, nativeSessionId: binding.nativeSessionId as string, cwd: binding.cwd as string }),
      origin: "context-update", placement: Object.freeze({ kind: "selected", purpose: "compaction-restore" }), packageRevision: message.packageRevision,
      body: Object.freeze({ text: "" }), transport: Object.freeze({ text: transport.text, sha256: transport.sha256, byteLength: transport.byteLength as number }) }), parts });
}

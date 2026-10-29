import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { standingFrameworkNames } from "sane-core/sane-framework";
import type { DispatchOrigin, DispatchSource } from "../shared/conversation/dispatch-contract";
import { contextHash, validateContextDelivery, validateContextPackage, type ContextAsset, type ContextDelivery, type ContextPackage } from "./context-package";

/** Internal composition inputs, NOT a public lifecycle API or a runtime delivery
 * switch. No store, native transport, journal, or activation state is consulted.
 * The caller decides placement; origin, resume, and revision never decide it. */
export const CONTEXT_MESSAGE_VERSION = 1 as const;
export type ContextMessageBinding = Readonly<DispatchSource & { authorityId: string; nativeSessionId: string }>;
export type ContextMessageOrigin = DispatchOrigin | "activation" | "context-update" | "worker-launch" | "branch";
type Immutable<T> = T extends readonly (infer U)[] ? readonly Immutable<U>[] : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** A reference to selected inherited history, not proof that a native fork copied
 * it. Branch/admission evidence must independently establish that fact. */
export type ContextMessageInheritance = Readonly<{
  source: ContextMessageBinding;
  packageRevision: string;
  transportHashes: readonly string[];
  reason: string;
}>;
export type ContextMessagePlacement =
  | Readonly<{ kind: "body-only"; inherited?: ContextMessageInheritance }>
  | Readonly<{ kind: "bootstrap"; workerMode?: "assigned" | "free"; inherited?: ContextMessageInheritance }>
  | Readonly<{ kind: "selected"; purpose: "update" | "sharing" | "branch-update"; inherited?: ContextMessageInheritance }>;

/** Supply only from an independently loaded, verified pinned store. Pure
 * composition checks package integrity, but cannot attest to filesystem bytes. */
export type PinnedMessageContext = Readonly<{ bundle: Immutable<ContextPackage>; paths: Readonly<Record<string, string>> }>;
export type ContextMessageFragment = Readonly<{
  id: string;
  category: "session" | "worker-assignment" | "branch" | "protocol" | "shared";
  text: string;
  source: string;
  /** Authoritative state/artifact revision, not necessarily a content hash. */
  revision: string;
  reason: string;
}>;
export type ContextMessageSelection =
  | Readonly<{ kind: "asset"; assetId: string; reason: string }>
  | Readonly<{ kind: "procedure-index"; reason: string }>
  | Readonly<{ kind: "fragment"; fragment: ContextMessageFragment }>;
type MessageInputBase = Readonly<{ body: string; binding: ContextMessageBinding; origin: ContextMessageOrigin }>;
export type ContextMessageInput = MessageInputBase & (
  | Readonly<{ placement: Extract<ContextMessagePlacement, { kind: "body-only" }> }>
  | Readonly<{
    placement: Extract<ContextMessagePlacement, { kind: "bootstrap" }>;
    context: PinnedMessageContext;
    session: ContextMessageFragment;
    /** Assignment bytes EXCLUDE the procedure: never split by user-like tags.
     * Worker bootstrap requires this; assistant bootstrap forbids it. */
    assignment?: ContextMessageFragment;
    /** Explicit worker protocol only, in caller order after procedure/assignment
     * and before Session. Never selected automatically from the package. */
    runtimeSelections?: readonly ContextMessageSelection[];
  }>
  | Readonly<{
    placement: Extract<ContextMessagePlacement, { kind: "selected" }>;
    context?: PinnedMessageContext;
    /** Exact caller-selected order. No role, Session, or package auto-resend. */
    selections: readonly ContextMessageSelection[];
  }>
);

export type ContextMessageAssetReference = Readonly<{ id: string; source: string; sha256: string; path: string }>;
export type ContextMessageProvenance =
  | Readonly<{ kind: "asset"; packageRevision: string; asset: ContextMessageAssetReference }>
  | Readonly<{ kind: "procedure-index"; packageRevision: string; assets: readonly ContextMessageAssetReference[] }>
  | Readonly<{ kind: "fragment"; source: string; revision: string }>;
/** Offsets and lengths are UTF-8 BYTES, not JS string indices. No normalization,
 * trimming, BOM removal, or newline conversion is performed. */
export type ContextMessageRange = Readonly<{ offset: number; length: number }>;
export type ContextMessageSegment = Readonly<{
  id: string;
  category: ContextAsset["kind"] | "procedure-index" | ContextMessageFragment["category"];
  text: string;
  sha256: string;
  reason: string;
  provenance: ContextMessageProvenance;
  range: ContextMessageRange;
}>;
export type ContextMessage = Readonly<{
  schema: typeof CONTEXT_MESSAGE_VERSION;
  binding: ContextMessageBinding;
  origin: ContextMessageOrigin;
  placement: ContextMessagePlacement;
  packageRevision: string | null;
  body: Readonly<{ text: string; sha256: string; range: ContextMessageRange }>;
  segments: readonly ContextMessageSegment[];
  /** Hash of the ordered segment identities, bytes, reasons and provenance. */
  selectionHash: string;
  transport: Readonly<{ text: string; sha256: string; byteLength: number }>;
}>;
type SegmentContent = Omit<ContextMessageSegment, "range">;

const HASH = /^[a-f0-9]{64}$/;
const origins = new Set<ContextMessageOrigin>(["user", "queued-user", "worker-report", "worker-exchange", "worker-recovery", "handoff", "questionnaire-response", "activation", "context-update", "worker-launch", "branch"]);
const categories = new Set(["role", "framework", "procedure", "resource", "procedure-index", "session", "worker-assignment", "branch", "protocol", "shared"]);
function fail(message: string): never { throw new Error(`Invalid context message: ${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail("unexpected or missing fields");
}
function text(value: unknown, name: string, nonempty = true): asserts value is string {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail(`${name} must be a string${nonempty ? " with content" : ""}`);
  // Lone UTF-16 surrogates have no lossless UTF-8 representation. Reject rather
  // than silently replacing them and claiming byte-exact body integrity.
  if (Buffer.from(value, "utf8").toString("utf8") !== value) fail(`${name} is not lossless UTF-8`);
}
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("expected a SHA-256 hash"); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]*$/.test(value) || value.split("/").includes("..")) fail("invalid selected ID");
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** Canonical object-key ordering for metadata comparison, not prompt encoding. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? fail("non-JSON metadata");
}

/** Generic exact binding; intentionally no CC/OC allowlist or native ID regex.
 * This does not change the existing production harness wire validators. */
export function validateContextMessageBinding(value: unknown): asserts value is ContextMessageBinding {
  const binding = record(value);
  keys(binding, ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"]);
  for (const key of ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"]) text(binding[key], key);
}
function inheritance(value: unknown): ContextMessageInheritance {
  const item = record(value);
  keys(item, ["source", "packageRevision", "transportHashes", "reason"]);
  validateContextMessageBinding(item.source); hash(item.packageRevision); text(item.reason, "inheritance reason");
  if (!Array.isArray(item.transportHashes) || !item.transportHashes.length) fail("inherited history needs exact message hashes");
  item.transportHashes.forEach(hash);
  if (new Set(item.transportHashes).size !== item.transportHashes.length) fail("duplicate inherited message hashes");
  return { source: { ...item.source }, packageRevision: item.packageRevision, transportHashes: [...item.transportHashes], reason: item.reason };
}
function placement(value: unknown): ContextMessagePlacement {
  const item = record(value);
  if (item.kind === "bootstrap") {
    keys(item, ["kind"], ["workerMode", "inherited"]);
    if (item.workerMode !== undefined && item.workerMode !== "assigned" && item.workerMode !== "free") fail("invalid bootstrap worker mode");
    return { kind: "bootstrap", ...(item.workerMode !== undefined ? { workerMode: item.workerMode } : {}),
      ...(item.inherited !== undefined ? { inherited: inheritance(item.inherited) } : {}) };
  }
  if (item.kind !== "body-only" && item.kind !== "selected") fail("unknown placement");
  keys(item, item.kind === "selected" ? ["kind", "purpose"] : ["kind"], ["inherited"]);
  const inherited = item.inherited === undefined ? {} : { inherited: inheritance(item.inherited) };
  if (item.kind === "body-only") return { kind: "body-only", ...inherited };
  if (item.purpose !== "update" && item.purpose !== "sharing" && item.purpose !== "branch-update") fail("unknown selection purpose");
  return { kind: "selected", purpose: item.purpose, ...inherited };
}
function assetReference(value: unknown): ContextMessageAssetReference {
  const item = record(value);
  keys(item, ["id", "source", "sha256", "path"]);
  identifier(item.id); text(item.source, "asset source"); hash(item.sha256); text(item.path, "pinned path");
  if (!isAbsolute(item.path) || /[\r\n]/.test(item.path)) fail("pinned path must be absolute and single-line");
  return { id: item.id, source: item.source, sha256: item.sha256, path: item.path };
}
function provenance(value: unknown): ContextMessageProvenance {
  const item = record(value);
  if (item.kind === "fragment") {
    keys(item, ["kind", "source", "revision"]); text(item.source, "fragment source"); text(item.revision, "fragment revision");
    return { kind: "fragment", source: item.source, revision: item.revision };
  }
  if (item.kind === "asset") {
    keys(item, ["kind", "packageRevision", "asset"]); hash(item.packageRevision);
    return { kind: "asset", packageRevision: item.packageRevision, asset: assetReference(item.asset) };
  }
  if (item.kind !== "procedure-index") fail("unknown provenance");
  keys(item, ["kind", "packageRevision", "assets"]); hash(item.packageRevision);
  if (!Array.isArray(item.assets) || !item.assets.length) fail("empty procedure index");
  const assets = item.assets.map(assetReference);
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) fail("duplicate index asset IDs");
  return { kind: "procedure-index", packageRevision: item.packageRevision, assets };
}
function segment(value: unknown): SegmentContent {
  const item = record(value);
  keys(item, ["id", "category", "text", "sha256", "reason", "provenance"]);
  identifier(item.id); text(item.text, "segment text"); text(item.reason, "selection reason"); hash(item.sha256);
  if (typeof item.category !== "string" || !categories.has(item.category) || contextHash(item.text) !== item.sha256) fail("segment category/hash mismatch");
  const source = provenance(item.provenance);
  if (source.kind === "asset" && (source.asset.id !== item.id || source.asset.sha256 !== item.sha256 || !["role", "framework", "procedure", "resource"].includes(item.category))) fail("asset provenance mismatch");
  if (source.kind === "procedure-index" && (item.id !== "procedure-index" || item.category !== "procedure-index")) fail("index provenance mismatch");
  if (source.kind === "fragment" && !["session", "worker-assignment", "branch", "protocol", "shared"].includes(item.category)) fail("fragment category mismatch");
  return { id: item.id, category: item.category as SegmentContent["category"], text: item.text, sha256: item.sha256, reason: item.reason, provenance: source };
}

/** v1 format: literal opening line and explicit placement semantics; ordered
 * blocks with JSON headers containing ID/category/source/revision/reason/UTF-8
 * byte length, raw selected text, and a literal closing line;
 * finally a length-header followed by the authored body through EOF. Lengths and
 * validated structured ranges disambiguate ANY lookalike delimiters in content.
 * These are prompt conventions, NOT an authority or security boundary. Ordinary
 * messages are byte-for-byte body-only (no framing, even with inheritance).
 * Never detect composition by scanning text. */
function encode(binding: ContextMessageBinding, origin: ContextMessageOrigin, selectedPlacement: ContextMessagePlacement, packageRevision: string | null, body: string, contents: readonly SegmentContent[]): ContextMessage {
  const ids = new Set<string>();
  for (const content of contents) {
    if (ids.has(content.id)) fail("duplicate selected IDs");
    ids.add(content.id);
    if (content.provenance.kind !== "fragment" && content.provenance.packageRevision !== packageRevision) fail("selected package revision mismatch");
  }
  if (selectedPlacement.kind === "body-only" && (contents.length || packageRevision !== null)) fail("body-only must not select context");
  if (selectedPlacement.kind !== "body-only" && !contents.length) fail("context-bearing placement must select context");
  if (selectedPlacement.kind === "selected" && !contents.some(content => content.provenance.kind !== "fragment") && packageRevision !== null) fail("no package revision without selected package content");
  if (selectedPlacement.kind === "bootstrap") {
    if (packageRevision === null || contents[0]?.category !== "role" || contents.filter(content => content.category === "role").length !== 1
      || !contents.some(content => content.id === "framework.core" && content.category === "framework")
      || contents.at(-1)?.id !== "session" || contents.at(-1)?.category !== "session") fail("incomplete bootstrap structure");
  }
  const purpose = selectedPlacement.kind === "bootstrap"
    ? "SANE activation: these selected procedures and session details are composed on the user's behalf. The user directs the work and may change these conventions."
    : selectedPlacement.kind === "selected" && selectedPlacement.purpose === "sharing"
      ? "SANE shared context: use the selected material for this message. Sharing alone does not change your role, assignment, or session membership."
      : selectedPlacement.kind === "selected" && selectedPlacement.purpose === "branch-update"
        ? "SANE branch context update: the selected branch-specific details supersede corresponding earlier details. Preserve other inherited context unless explicitly changed."
        : "SANE context update: the selected changed details supersede corresponding earlier details. Other context remains unchanged unless explicitly stated.";
  let transport = selectedPlacement.kind === "body-only" ? "" : `[SANE CONTEXT MESSAGE v1]\n${purpose}\n`;
  let bytes = Buffer.byteLength(transport, "utf8");
  const append = (value: string) => { transport += value; bytes += Buffer.byteLength(value, "utf8"); };
  const segments: ContextMessageSegment[] = [];
  for (const content of contents) {
    const length = Buffer.byteLength(content.text, "utf8");
    const source = content.provenance.kind === "fragment" ? content.provenance.source
      : content.provenance.kind === "asset" ? content.provenance.asset.source : "Pinned procedure index";
    const revision = content.provenance.kind === "fragment" ? content.provenance.revision : content.provenance.packageRevision;
    append(`[SANE CONTEXT SEGMENT ${JSON.stringify({ id: content.id, category: content.category, source, revision, reason: content.reason, bytes: length })}]\n`);
    const range = { offset: bytes, length };
    append(content.text); append("\n[/SANE CONTEXT SEGMENT]\n");
    segments.push({ ...content, range });
  }
  const length = Buffer.byteLength(body, "utf8");
  if (selectedPlacement.kind !== "body-only") append(`[SANE AUTHORED BODY ${JSON.stringify({ bytes: length })}]\n`);
  const range = { offset: bytes, length };
  append(body);
  return immutable({ schema: CONTEXT_MESSAGE_VERSION, binding: { ...binding }, origin, placement: selectedPlacement, packageRevision,
    body: { text: body, sha256: contextHash(body), range }, segments,
    selectionHash: contextHash(canonical(contents)), transport: { text: transport, sha256: contextHash(transport), byteLength: bytes } });
}

function reference(context: PinnedMessageContext, asset: Immutable<ContextAsset>): ContextMessageAssetReference {
  return assetReference({ id: asset.id, source: asset.source, sha256: asset.sha256, path: context.paths[asset.id] });
}
function assetSegment(context: PinnedMessageContext, id: string, reason: string): SegmentContent {
  const asset = context.bundle.assets.find(asset => asset.id === id);
  if (!asset) fail(`selected package asset is absent: ${id}`);
  return segment({ id, category: asset.kind, text: asset.text, sha256: asset.sha256, reason,
    provenance: { kind: "asset", packageRevision: context.bundle.revision, asset: reference(context, asset) } });
}
function fragmentSegment(fragment: ContextMessageFragment): SegmentContent {
  const item = record(fragment);
  keys(item, ["id", "category", "text", "source", "revision", "reason"]);
  text(item.text, "fragment text");
  return segment({ id: item.id, category: item.category, text: item.text, sha256: contextHash(item.text), reason: item.reason,
    provenance: { kind: "fragment", source: item.source, revision: item.revision } });
}
function procedureAssets(context: PinnedMessageContext) {
  return context.bundle.assets.filter(asset => asset.kind === "resource" || asset.kind === "procedure" && !asset.id.startsWith("worker-procedure."));
}
function indexSegment(context: PinnedMessageContext, reason: string): SegmentContent {
  const assets = procedureAssets(context);
  const references = assets.map(asset => reference(context, asset));
  // Unlike the old always-standing renderer, an independently selected index
  // must not claim that Pickup is necessarily included in this message.
  const content = ["# SANE private procedures", "Resolve the SANE lifecycle procedure names in your role instructions using this index and the ordinary file-reading tool, rather than native Skill discovery. Other repository skills retain their normal loading mechanism.",
    "Load only the procedure needed for the current lifecycle step. Assistant activation includes the initial Pickup procedure; this index alone does not select or repeat Pickup on update or resume.",
    ...assets.map((asset, index) => `- ${asset.id}: ${references[index]!.path}${asset.description ? ` — ${asset.description}` : ""}`)].join("\n\n");
  return segment({ id: "procedure-index", category: "procedure-index", text: content, sha256: contextHash(content), reason,
    provenance: { kind: "procedure-index", packageRevision: context.bundle.revision, assets: references } });
}
function selectionSegment(selected: ContextMessageSelection, context?: PinnedMessageContext): SegmentContent {
  const selection = record(selected);
  if (selected.kind === "fragment") keys(selection, ["kind", "fragment"]);
  else if (selected.kind === "asset") keys(selection, ["kind", "assetId", "reason"]);
  else keys(selection, ["kind", "reason"]);
  if (selected.kind === "fragment") return fragmentSegment(selected.fragment);
  if (!context) fail("package selection requires pinned context");
  if (selected.kind === "asset") return assetSegment(context, selected.assetId, selected.reason);
  if (selected.kind === "procedure-index") return indexSegment(context, selected.reason);
  return fail("unknown selection");
}

/** Pure selective composer. Ordinary input does not accept or load a package.
 * Bootstrap order is role ONCE, required standing framework, pinned index,
 * initial Pickup, applicable worker procedure/assignment, explicit runtime
 * protocol selections, Session. Selection
 * order for explicit updates/sharing is exactly the caller's order. No resource
 * bodies are included merely because the index references them. */
export function composeContextMessage(input: ContextMessageInput): ContextMessage {
  const fields = record(input);
  validateContextMessageBinding(input.binding); text(input.body, "authored body", false);
  if (!origins.has(input.origin)) fail("unknown origin");
  const selectedPlacement = placement(input.placement);
  // Use the discriminant on input as well so TypeScript preserves the input union.
  if (input.placement.kind === "body-only") {
    keys(fields, ["body", "binding", "origin", "placement"]);
    return encode(input.binding, input.origin, selectedPlacement, null, input.body, []);
  }
  if (input.placement.kind === "selected") keys(fields, ["body", "binding", "origin", "placement", "selections"], ["context"]);
  else keys(fields, ["body", "binding", "origin", "placement", "context", "session"], ["assignment", "runtimeSelections"]);
  const contents: SegmentContent[] = [];
  // Nested discriminants do not narrow the enclosing union in TypeScript.
  if ("selections" in input) {
    if (!Array.isArray(input.selections)) fail("selections must be ordered");
    if (input.context) validateContextPackage(input.context.bundle);
    for (const selected of input.selections) {
      contents.push(selectionSegment(selected, input.context));
    }
    // A package is recorded only when a package-derived segment is selected.
    const revision = contents.some(content => content.provenance.kind !== "fragment") ? input.context!.bundle.revision : null;
    return encode(input.binding, input.origin, selectedPlacement, revision, input.body, contents);
  }
  if (!("session" in input)) fail("bootstrap requires pinned context and Session");
  const { context } = input;
  validateContextPackage(context.bundle);
  const { identity } = context.bundle;
  contents.push(assetSegment(context, `role.${identity.kind}.${identity.role}`, "Selected main role activation"));
  for (const name of standingFrameworkNames(identity)) {
    const content = assetSegment(context, `framework.${name}`, "Required standing framework");
    if (content.category !== "framework") fail("standing framework has wrong asset kind");
    contents.push(content);
  }
  if (procedureAssets(context).length) contents.push(indexSegment(context, "Selective loading from pinned files"));
  if (identity.kind === "assistant") {
    const initial = `sane-assistant-${identity.role}-pickup`;
    if (context.bundle.initial.length !== 1 || context.bundle.initial[0] !== initial) fail("bootstrap requires the selected initial Pickup");
    if (input.assignment !== undefined || input.placement.workerMode !== undefined) fail("assistant bootstrap cannot have worker assignment/mode");
    contents.push(assetSegment(context, initial, "Initial lifecycle procedure"));
  } else {
    if (!input.assignment || !input.placement.workerMode) fail("worker bootstrap needs assignment and explicit worker mode");
    if (input.assignment.id !== "worker-assignment" || input.assignment.category !== "worker-assignment") fail("invalid worker assignment fragment");
    if (input.placement.workerMode === "free") {
      if (identity.role !== "implementer") fail("free-mode assignment requires an implementer");
    } else contents.push(assetSegment(context, `worker-procedure.${identity.role}`, "Applicable worker procedure"));
    contents.push(fragmentSegment(input.assignment));
  }
  if (input.runtimeSelections !== undefined) {
    if (!Array.isArray(input.runtimeSelections)) fail("runtime selections must be ordered");
    if (input.runtimeSelections.length && identity.kind !== "worker") fail("bootstrap runtime protocol requires a worker identity");
    for (const selected of input.runtimeSelections) {
      const content = selectionSegment(selected, context);
      if (!(selected.kind === "asset" && content.id === "framework.worker-protocol" && content.category === "framework")
        && !(selected.kind === "fragment" && content.category === "protocol")) fail("bootstrap runtime selection must be worker protocol");
      contents.push(content);
    }
  }
  if (input.session.id !== "session" || input.session.category !== "session") fail("bootstrap needs an explicit Session fragment");
  contents.push(fragmentSegment(input.session));
  return encode(input.binding, input.origin, selectedPlacement, context.bundle.revision, input.body, contents);
}

/** Structural decoder only: checks exact framing, bytes, body offsets, ordered
 * provenance/hash metadata, unique IDs and selected revision. A self-consistent
 * forged message can pass this; it is NEVER trusted-source or delivery evidence.
 * Accepts the structured object, NOT transport text or marker scanning. */
export function decodeContextMessage(value: unknown): ContextMessage {
  const item = record(value);
  keys(item, ["schema", "binding", "origin", "placement", "packageRevision", "body", "segments", "selectionHash", "transport"]);
  if (item.schema !== CONTEXT_MESSAGE_VERSION) fail("unsupported version");
  validateContextMessageBinding(item.binding);
  if (!origins.has(item.origin as ContextMessageOrigin)) fail("unknown origin");
  const selectedPlacement = placement(item.placement);
  if (item.packageRevision !== null) hash(item.packageRevision);
  const body = record(item.body); keys(body, ["text", "sha256", "range"]); text(body.text, "authored body", false);
  if (!Array.isArray(item.segments)) fail("segments must be ordered");
  const contents = item.segments.map(value => {
    const selected = record(value);
    keys(selected, ["id", "category", "text", "sha256", "reason", "provenance", "range"]);
    const { range: _, ...content } = selected;
    return segment(content);
  });
  const expected = encode(item.binding, item.origin as ContextMessageOrigin, selectedPlacement, item.packageRevision as string | null, body.text, contents);
  if (canonical(item) !== canonical(expected)) fail("metadata, ranges, hashes or exact outgoing bytes differ");
  return expected;
}

export function validateContextMessage(value: unknown): asserts value is ContextMessage { decodeContextMessage(value); }

/** Independent source validation. expected MUST be reconstructed from trusted
 * pinned package/state, placement/selection intent, binding AND authored body;
 * do not derive expected from the supplied message. No I/O or currency check is
 * hidden here: a dispatcher must refresh these dependencies before submission. */
export function validateTrustedContextMessage(value: unknown, expected: ContextMessageInput): ContextMessage {
  const decoded = decodeContextMessage(value);
  const trusted = composeContextMessage(expected);
  if (canonical(decoded) !== canonical(trusted)) fail("composition does not match independent trusted inputs");
  return trusted;
}

/** Explicit authored strings pass through losslessly, even when they contain
 * lookalike SANE tags. Structured inputs must fully validate before extraction.
 * Titles/classification/display should use this, never strip prompt markers.
 * Structural extraction is for presentation, not a source-trust attestation. */
export function contextMessageBody(value: string | ContextMessage): string {
  if (typeof value === "string") { text(value, "explicit authored body", false); return value; }
  const message = decodeContextMessage(value);
  const { offset, length } = message.body.range;
  return Buffer.from(message.transport.text, "utf8").subarray(offset, offset + length).toString("utf8");
}

export type ContextMessageComparison = Readonly<{
  currentPayloadHash: string;
  selectedContextHash: string;
  bindingMatches: boolean;
  packageRevisionMatches: boolean;
  /** Excludes v1 framing and authored body; NOT transport equivalence. */
  contextTextEqual: boolean;
  differences: readonly Readonly<{
    id: string;
    status: "same" | "changed" | "only-current" | "only-selected" | "opaque-role-reference";
    explanation: string;
  }>[];
  explanation: string;
}>;

/** Opt-in offline comparison seam, never called automatically by composition.
 * Compares the old renderer's standing/dynamic payload with selected new text.
 * Opaque native-role-reference channels cannot establish delivered role parity.
 * No journal, native requests, asset loading or live shadow execution occurs. */
export function compareContextMessage(current: ContextDelivery, selected: ContextMessage): ContextMessageComparison {
  validateContextDelivery(current);
  const message = decodeContextMessage(selected);
  const differences: ContextMessageComparison["differences"][number][] = [];
  const next = new Map(message.segments.map(segment => [segment.id, segment]));
  for (const old of current.segments) {
    const chosen = next.get(old.id);
    next.delete(old.id);
    if (old.channel === "native-role-reference") differences.push({ id: old.id, status: "opaque-role-reference", explanation: chosen
      ? "Current renderer records a role reference, not injected role bytes; the selected message explicitly includes role bytes. Native selection/consumption parity is not established."
      : "Current renderer records an opaque native role reference; no role bytes are selected in this message." });
    else if (!chosen) differences.push({ id: old.id, status: "only-current", explanation: "Present in the current standing/dynamic payload; deliberately not selected by this message's placement." });
    else differences.push({ id: old.id, status: old.text === chosen.text ? "same" : "changed", explanation: old.text === chosen.text
      ? `Exact selected bytes match the current ${old.channel} segment (not a delivery acknowledgment).`
      : old.id === "procedure-index"
        ? "Index wording no longer claims Pickup is included with every index selection. Pinned references may also differ; independently validate the selected package and paths."
        : `Selected bytes differ from the current ${old.channel} segment; inspect the explicit selection and its trusted source revision.` });
  }
  for (const chosen of next.values()) differences.push({ id: chosen.id, status: "only-selected", explanation: "Explicit selected content has no matching current renderer segment." });
  const currentText = `${current.standing}\n\n${current.dynamic}`;
  const selectedText = message.segments.map(segment => segment.text).join("\n\n");
  const bindingMatches = current.binding.harness === message.binding.harnessId && current.binding.sessionId === message.binding.sessionId
    && current.binding.authorityId === message.binding.authorityId && current.binding.nativeSessionId === message.binding.nativeSessionId && current.binding.cwd === message.binding.cwd;
  return immutable({ currentPayloadHash: contextHash(currentText), selectedContextHash: contextHash(selectedText), bindingMatches,
    packageRevisionMatches: current.packageRevision === message.packageRevision, contextTextEqual: currentText === selectedText, differences,
    explanation: "Text comparison only, excluding new framing and authored body. Selective omission, explicit main-role inclusion, and caller-selected order can intentionally differ. Binding, package and source trust require independent validation; neither renderer proves native admission or model consumption." });
}

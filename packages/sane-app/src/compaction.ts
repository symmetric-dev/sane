import type { Event, Run, Session } from "./history";
import type { CompactionLifecycle, CompactionMetadata, CompactionRecord, CompactionTrigger, MessageSnapshot } from "./oc-contract";

// Browser-safe: no native SDK, filesystem, clock, mutation, or submission path.
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const trigger = (v: unknown): CompactionTrigger => v === "auto" || v === "manual" ? v : "unknown";
const time = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const terminal = (v: CompactionLifecycle) => v === "completed" || v === "failed" || v === "skipped" || v === "unconfirmed";
function main(row: Record<string, unknown>, nativeId: string, rawTranscript = false) {
  return (rawTranscript ? row.sessionId : row.session_id) === nativeId && !row.parent_tool_use_id && !row.parent_agent_id && !row.subagent_type && !row.agent_id && !row.isSidechain;
}
function metrics(row: Record<string, unknown>): Pick<CompactionMetadata, "preTokens" | "postTokens" | "durationMs"> {
  const result: Pick<CompactionMetadata, "preTokens" | "postTokens" | "durationMs"> = {};
  for (const [key, snake] of [["preTokens", "pre_tokens"], ["postTokens", "post_tokens"], ["durationMs", "duration_ms"]] as const) {
    const value = row[snake] !== undefined ? row[snake] : row[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid native compaction metric");
    result[key] = value;
  }
  return result;
}

/** Normalize a genuine main-thread CC compact boundary, preserving its UUID
 * and metadata. Supports the CLI wire and raw transcript casing. A transcript
 * timestamp, when present, is the boundary time, not an invented start time. */
export function normalizeClaudeCompactionBoundary(value: unknown, nativeSessionId: string): MessageSnapshot | undefined {
  if (!object(value) || value.type !== "system" || value.subtype !== "compact_boundary") return;
  if (!main(value, nativeSessionId, value.session_id === undefined)) return;
  const metadata = value.compact_metadata !== undefined ? value.compact_metadata : value.compactMetadata;
  if (!uuid(value.uuid) || !object(metadata)) throw new Error("Invalid native compaction boundary identity or metadata");
  if (value.timestamp !== undefined && !time(value.timestamp)) throw new Error("Invalid native compaction boundary timestamp");
  const createdAt = time(value.timestamp) ? value.timestamp : "";
  return { messageId: value.uuid, role: "system", parts: [], status: "completed", createdAt, contextReset: true,
    compaction: { nativeId: value.uuid, trigger: trigger(metadata.trigger), lifecycle: "completed", nativeMetadata: metadata, ...metrics(metadata), ...(createdAt ? { endedAt: createdAt } : {}) },
  };
}

/** Deterministic replay over persisted runs, raw stdout/hooks, normalized
 * message UPSERTs, and optional reconciled native history. Pass all session runs
 * and logs; event sequence is ordered per run. No run result or English text is
 * interpreted as compaction success, and this function never changes a run.
 * IDs remain stable as live evidence accumulates; nativeId merges import/live.
 * observedAt is the durable App observation time, NOT a native timestamp. */
export function projectCompactions(
  session: Pick<Session, "sessionId" | "harness" | "nativeSessionId">,
  runs: readonly Run[], events: readonly Event[], messages: readonly MessageSnapshot[] = [],
): CompactionRecord[] {
  if (!session.harness || !session.nativeSessionId) return [];
  const harness = session.harness, nativeSessionId = session.nativeSessionId;
  const records: CompactionRecord[] = [], native = new Map<string, CompactionRecord>();
  const current = new Map<string, CompactionRecord>(), requested = new Map<string, CompactionRecord>();
  const runMap = new Map(runs.filter(r => r.sessionId === session.sessionId).map(r => [r.runId, r]));
  const nonadmissions = new Map<string, { rejected: boolean; failed: boolean; error?: unknown; observedAt: string }>();

  function create(run: Run | undefined, id: string, metadata: CompactionMetadata, observedAt?: string) {
    const record: CompactionRecord = { id, sessionId: session.sessionId, harness, ...(run ? { runId: run.runId } : {}), ...metadata, contextReset: metadata.lifecycle === "completed", ...(observedAt ? { observedAt } : {}) };
    records.push(record);
    if (run) current.set(run.runId, record);
    if (metadata.nativeId) native.set(metadata.nativeId, record);
    return record;
  }
  function update(record: CompactionRecord, metadata: Partial<CompactionMetadata>, observedAt?: string) {
    // Native projections are UPSERTs. A cached imported running snapshot must
    // not undo a terminal state already observed in the durable live log.
    if (record.nativeId && metadata.nativeId === record.nativeId && (record.lifecycle === "completed" || record.lifecycle === "failed" || record.lifecycle === "skipped") && metadata.lifecycle && ["requested", "running", "unconfirmed"].includes(metadata.lifecycle)) return;
    // Once the native boundary is committed it remains a reset, including when
    // the containing prompt or CLI is subsequently interrupted.
    const completed = harness === "claude-code" && record.contextReset && !!record.nativeId;
    Object.assign(record, metadata, metadata.trigger === "unknown" && record.trigger !== "unknown" ? { trigger: record.trigger } : {});
    if (completed) record.lifecycle = "completed";
    record.contextReset = record.lifecycle === "completed";
    if (observedAt) record.observedAt = observedAt;
    if (record.nativeId) native.set(record.nativeId, record);
  }
  function attempt(run: Run, event: Event, kind: "start" | "progress" | "end", t: CompactionTrigger, nativeId?: string, failed = false) {
    if (nativeId && native.has(nativeId)) return native.get(nativeId)!;
    let record = current.get(run.runId);
    // An explicit manual request must not steal an automatic attempt.
    const mismatch = record && t !== "unknown" && record.trigger !== "unknown" && t !== record.trigger;
    if (mismatch || (kind === "start" || kind === "progress") && record && terminal(record.lifecycle) || nativeId && record?.nativeId && record.nativeId !== nativeId || failed && record?.contextReset && record.nativeId) record = undefined;
    if (!record) {
      const request = requested.get(run.runId);
      if (request && request.lifecycle === "requested" && t !== "auto") record = request;
    }
    if (!record) record = create(run, `compact:${session.sessionId}:${run.runId}:${event.seq}`, { trigger: t, lifecycle: "running" }, event.time);
    current.set(run.runId, record);
    return record;
  }
  function snapshot(message: MessageSnapshot, run?: Run, event?: Event) {
    const metadata = message.compaction;
    if (!metadata) return;
    const nativeId = metadata.nativeId ?? message.messageId;
    let record = native.get(nativeId);
    const known = !!record;
    if (!record && harness === "claude-code" && run && event) record = attempt(run, event, "end", metadata.trigger, nativeId, metadata.lifecycle === "failed");
    if (!record) record = create(run, `compact:${harness}:${nativeId}`, { ...metadata, nativeId }, event?.time);
    else update(record, { ...metadata, nativeId }, event?.time);
    // Coalesced requests retain independent client request identities, but the
    // exact admitted native input supplies the outcome for every association.
    for (const associated of records) {
      if (associated !== record && associated.nativeAdmittedId === nativeId) update(associated, { ...metadata, nativeId }, event?.time);
    }
    // Repeated snapshots of an older boundary must not steal the current CC
    // attempt; its PostCompact/status evidence still belongs to that attempt.
    if (run && (!known || !current.has(run.runId) || current.get(run.runId) === record)) current.set(run.runId, record);
  }

  for (const run of runMap.values()) {
    if (run.operation === "compact" && run.compact) {
      const request = run.compact;
      const exactId = request.nativeAdmittedId ?? request.nativeRequestId ?? run.nativeCommandId;
      const existing = exactId ? native.get(exactId) : undefined;
      const record = create(run, `compact:${run.runId}:${request.requestId}`, { trigger: "manual", lifecycle: "requested", ...(request.instructions !== undefined ? { instructions: request.instructions } : {}) });
      Object.assign(record, { requestId: request.requestId, requestedAt: run.createdAt,
        ...(request.nativeRequestId ?? run.nativeCommandId ? { nativeRequestId: request.nativeRequestId ?? run.nativeCommandId } : {}),
        ...(request.nativeAdmittedId ? { nativeAdmittedId: request.nativeAdmittedId } : {}),
      });
      // A coalesced request may register after this native input's last snapshot.
      // Inherit only native evidence, never the earlier client's identity or
      // instructions, and retain the existing map entry rather than downgrading
      // terminal evidence to this registration's initial requested state.
      if (existing && existing.nativeId === exactId) {
        const { trigger, lifecycle, nativeId, startedAt, endedAt, preTokens, postTokens, durationMs, summary, error, summaryUsage, nativeMetadata } = existing;
        update(record, { trigger, lifecycle, nativeId, startedAt, endedAt, preTokens, postTokens, durationMs, summary, error, summaryUsage, nativeMetadata }, existing.observedAt);
      }
      if (exactId) native.set(exactId, existing ?? record);
      requested.set(run.runId, record);
    }
    const seen = new Set<number>(), seenStatuses = new Set<string>();
    for (const event of events.filter(e => e.sessionId === session.sessionId && e.runId === run.runId).sort((a, b) => a.seq - b.seq)) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      if (event.kind === "message" && object(event.data)) { snapshot(event.data as unknown as MessageSnapshot, run, event); continue; }
      if (event.kind === "status" && run.operation === "compact" && requested.has(run.runId) && object(event.data)) {
        const row = event.data, previous = nonadmissions.get(run.runId);
        const rejected = row.operation === "compact" && row.compactAdmissionRejected === true && typeof row.nativeStatus === "number" && [400, 401, 403, 404, 409].includes(row.nativeStatus);
        const withheld = row.operation === "compact" && row.compactNotSubmitted === true;
        if (rejected || withheld) {
          nonadmissions.set(run.runId, { rejected: rejected || previous?.rejected === true, failed: row.status === "failed" || previous?.failed === true,
            error: previous?.error ?? row.error ?? row.reason, observedAt: event.time });
        } else if (previous && (row.status === "failed" || row.status === "interrupted")) {
          // finishNative emits the terminal reason separately from the explicit
          // proof. Ordinary statuses matter only after that proof for this run.
          previous.failed ||= row.status === "failed";
          previous.error ??= row.error ?? row.reason;
          previous.observedAt = event.time;
        }
        continue;
      }
      if (harness !== "claude-code") continue;
      if (event.kind === "stdout" && object(event.data)) {
        const row = event.data;
        if (!main(row, nativeSessionId)) continue;
        if (row.type === "system" && row.subtype === "compact_boundary") {
          const boundary = normalizeClaudeCompactionBoundary(row, nativeSessionId);
          if (boundary) snapshot(boundary, run, event);
        } else if (row.type === "system" && row.subtype === "status") {
          if (typeof row.uuid === "string") {
            const key = JSON.stringify(row);
            if (seenStatuses.has(key)) continue;
            seenStatuses.add(key);
          }
          const result = row.compact_result;
          const failed = result === "failed" || row.compact_error !== undefined;
          if (row.status === "compacting" || row.status === "requesting" && current.has(run.runId) && !terminal(current.get(run.runId)!.lifecycle)) {
            const record = attempt(run, event, "progress", "unknown");
            if (!record.contextReset && !terminal(record.lifecycle)) update(record, { lifecycle: "running" }, event.time);
          }
          if (result === "success" || failed || result === "skipped") {
            const record = attempt(run, event, "end", "unknown", undefined, failed);
            update(record, { lifecycle: failed ? "failed" : result === "success" ? "completed" : "skipped",
              ...(row.compact_error !== undefined ? { error: row.compact_error } : {}),
            }, event.time);
          } else if (row.status === null) {
            const record = current.get(run.runId);
            if (record && !terminal(record.lifecycle)) update(record, { lifecycle: "unconfirmed", ...(row.compact_error !== undefined ? { error: row.compact_error } : {}) }, event.time);
          }
        }
      } else if (event.kind === "hook" && object(event.data) && object(event.data.payload)) {
        const name = event.data.event, row = event.data.payload;
        if ((name !== "PreCompact" && name !== "PostCompact") || row.hook_event_name !== name || !main(row, nativeSessionId)) continue;
        const t = trigger(row.trigger), failure = row.compact_result === "failed" || row.compact_error !== undefined;
        const record = attempt(run, event, name === "PreCompact" ? "start" : "end", t, undefined, failure);
        const lifecycle: CompactionLifecycle = failure ? "failed" : row.compact_result === "skipped" ? "skipped" : name === "PostCompact" ? "completed" : "running";
        const instructions = row.custom_instructions;
        const summary = row.compact_summary ?? row.summary;
        update(record, { trigger: t === "unknown" ? record.trigger : t, lifecycle,
          ...(typeof instructions === "string" && instructions.length <= 100000 && !instructions.includes("\0") ? { instructions } : {}),
          ...(typeof summary === "string" ? { summary } : {}),
          ...(row.compact_error !== undefined ? { error: row.compact_error } : {}),
        }, event.time);
      }
    }
  }
  // Reconciliation is native evidence, not a fabricated run/turn. Native UUIDs
  // join boundaries already observed in the durable live event log.
  for (const message of messages) snapshot(message);
  // Apply definitive non-admission only after all native evidence is replayed:
  // a committed boundary wins even if its containing run was later stopped.
  // Rejection is failed; withholding is skipped unless explicit failure/status
  // evidence identifies a preparation failure rather than a stopped request.
  for (const [runId, proof] of nonadmissions) {
    const record = requested.get(runId)!;
    if (record.contextReset || record.lifecycle === "completed") continue;
    const failed = proof.rejected || proof.failed || runMap.get(runId)?.status === "failed" || record.lifecycle === "failed";
    update(record, { lifecycle: failed ? "failed" : "skipped",
      error: record.error ?? proof.error ?? (proof.rejected ? "Native compaction admission rejected" : "Compaction withheld before native submission"),
    }, proof.observedAt);
  }
  for (const record of records) {
    const run = record.runId ? runMap.get(record.runId) : undefined;
    if (run && run.status !== "running" && !terminal(record.lifecycle)) record.lifecycle = "unconfirmed";
  }
  return records;
}

import { isClaudeRootRecord } from "./cc-scope";

export const CLAUDE_RESULT_TEXT_LIMIT = 2000;
export type ParsedClaudeResult = {
  record: Record<string, unknown>;
  exactSession: boolean;
  indexed: boolean;
  index?: number;
  invalidIndex: boolean;
  explicitSuccess: boolean;
  text?: string;
  uuid?: string;
};
export type ClaudeFrameworkResultState = {
  text: string; delivered: boolean; rejected: boolean;
  failures: { outcome: unknown; exitCode: unknown; stderr: unknown }[];
};
/** Plain JSON state so committed-history replay and live supervision agree. */
export type ClaudeResultSequenceState = {
  seen: boolean;
  error: boolean;
  indices: number[];
  integrityRejected: boolean;
  failureCauses: ("identity" | "invalid-index" | "duplicate" | "native-failure" | "framework")[];
  diagnostic?: string;
  failure?: Record<string, unknown>;
  framework?: ClaudeFrameworkResultState;
};
export function createClaudeResultSequenceState(): ClaudeResultSequenceState {
  return { seen: false, error: false, indices: [], integrityRejected: false, failureCauses: [] };
}

/** Required framework delivery must be evidenced even if init never arrives.
 * Rejection remains sticky if a late hook response subsequently arrives. */
export function rejectUndeliveredClaudeFramework(state: ClaudeResultSequenceState): boolean {
  if (!state.framework || state.framework.delivered) return false;
  state.error = state.framework.rejected = true;
  if (!state.failureCauses.includes("framework")) state.failureCauses.push("framework");
  state.diagnostic ??= "SANE framework SessionStart hook did not succeed";
  return true;
}

export function parseClaudeResult(value: unknown, nativeSessionId: string): ParsedClaudeResult | undefined {
  if (!isClaudeRootRecord(value)) return;
  const record = value as Record<string, unknown>;
  if (record.type !== "result") return;
  const indexed = Number.isSafeInteger(record.result_index) && (record.result_index as number) >= 0;
  return {
    record, exactSession: record.session_id === nativeSessionId, indexed,
    ...(indexed ? { index: record.result_index as number } : {}),
    invalidIndex: record.result_index !== undefined && !indexed,
    explicitSuccess: record.subtype === "success" && record.is_error === false,
    ...(typeof record.result === "string" ? { text: record.result } : {}),
    ...(typeof record.uuid === "string" && record.uuid.length > 0 ? { uuid: record.uuid } : {}),
  };
}

/** Mutates only the supplied state, in native receipt/committed event order.
 * Diagnostics intentionally preserve the supervisor's original precedence.
 * Native failures do not hide a later useful successful reply; integrity or
 * framework rejection does, because the source can no longer qualify it. */
export function consumeClaudeResultRecord(state: ClaudeResultSequenceState, value: unknown, nativeSessionId: string): {
  result?: ParsedClaudeResult; eligible: boolean; frameworkRejected: boolean;
} {
  if (!isClaudeRootRecord(value)) return { eligible: false, frameworkRejected: false };
  const record = value as Record<string, unknown>;
  const reject = (cause: ClaudeResultSequenceState["failureCauses"][number], integrity = false) => {
    state.error = true;
    if (!state.failureCauses.includes(cause)) state.failureCauses.push(cause);
    if (integrity) state.integrityRejected = true;
  };
  if ((record.type === "system" && record.subtype === "init" || record.type === "result") && record.session_id !== nativeSessionId) {
    reject("identity", true); state.diagnostic = "CLI session identity mismatch or missing session_id";
  }
  const framework = state.framework;
  if (framework && record.type === "system" && record.subtype === "hook_response" && record.hook_event === "SessionStart") {
    let output: any; try { output = JSON.parse(record.stdout as string); } catch { /* Not the framework delivery. */ }
    if (record.outcome === "success" && output?.hookSpecificOutput?.hookEventName === "SessionStart" && output.hookSpecificOutput.additionalContext === framework.text) framework.delivered = true;
    else if (record.outcome !== "success") framework.failures.push({ outcome: record.outcome ?? null, exitCode: record.exit_code ?? null, stderr: record.stderr ?? null });
  }
  const frameworkRejected = (record.type === "system" && record.subtype === "init" || record.type === "result")
    && rejectUndeliveredClaudeFramework(state);
  const result = parseClaudeResult(value, nativeSessionId);
  if (!result) return { eligible: false, frameworkRejected };
  if (result.invalidIndex) { reject("invalid-index", true); state.diagnostic ??= "Invalid CLI result_index"; }
  if (state.seen && (!result.indexed || !state.indices.length || state.indices.includes(result.index!))) {
    reject("duplicate", true); state.diagnostic = "Duplicate CLI result";
  }
  if (result.indexed && !state.indices.includes(result.index!)) state.indices.push(result.index!);
  state.seen = true;
  if (!result.explicitSuccess) {
    reject("native-failure"); state.diagnostic ??= "CLI result is not an explicit success";
    state.failure ??= {
      resultSubtype: record.subtype ?? null, isError: record.is_error ?? null,
      ...(record.api_error_status !== undefined ? { apiErrorStatus: record.api_error_status } : {}),
      result: typeof record.result === "string" ? record.result.slice(0, CLAUDE_RESULT_TEXT_LIMIT) : record.result ?? null,
      ...(record.permission_denials !== undefined ? { permissionDenials: record.permission_denials } : {}),
    };
  }
  return { result, eligible: result.exactSession && result.explicitSuccess && !state.integrityRejected
    && (!state.framework || state.framework.delivered && !state.framework.rejected), frameworkRejected };
}

export function claudeResultBoundaryId(runId: string, result: ParsedClaudeResult, sourceSequence: number): string {
  return result.indexed ? `cc-result:${runId}:index:${result.index}`
    : `cc-result:${runId}:legacy:${result.uuid ?? `seq:${sourceSequence}`}`;
}
export function claudeResultMessageId(runId: string, result: ParsedClaudeResult, sourceSequence: number): string {
  // SDKResultMessage has no authoritative assistant-message join. Its UUID is
  // the result's identity, not an assistant transcript alias.
  return result.indexed ? `${runId}:result:index:${result.index}` : `${runId}:result:legacy:${result.uuid ?? `seq:${sourceSequence}`}`;
}

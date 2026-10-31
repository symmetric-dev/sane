import type { Message } from "./types";
import { NativeSubagentCard, useNativeSubagents } from "./native-subagent-feature";
import { ChatCard, ChatCardBody, ChatCardHeader, ChatDisclosure, ChatStatus } from "./chat-ui";

/** Only native metadata identifies a result. User-authored XML is ordinary text. */
export function NativeSubagentResult({ source }: { source: Message }) {
  const feature = useNativeSubagents();
  const result = source.nativeSubagentResult!;
  const candidates = [...(feature?.summaries.values() ?? [])].filter(summary => summary.harness === "opencode" && summary.nativeSessionId === result.sessionId);
  const sameRun = candidates.filter(summary => summary.runId === source.runId);
  const matches = sameRun.length ? sameRun : candidates;
  const summary = matches.length === 1 ? matches[0] : undefined;
  const raw = source.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
  // Strip only the transport envelope of an authenticated native result.
  const wrapped = /^<subagent\s[^>]*>\r?\n([\s\S]*)\r?\n<\/subagent>\s*$/.exec(raw);
  const report = wrapped?.[1] ?? raw;
  const status = result.state === "completed" ? "completed" : result.state === "failed" ? "failed" : result.state === "interrupted" ? "interrupted" : "unknown";
  if (summary) return <NativeSubagentCard summary={{ ...summary, status, returnedReport: report }} recorded />;
  return <ChatCard density="compact" className="native-subagent-card" aria-label="Native subagent result">
    <ChatCardHeader title={result.agent ?? "Subagent response"} headingLevel={3} metadata={<><ChatStatus>Native</ChatStatus><ChatStatus tone={status === "failed" ? "danger" : status === "unknown" ? "warning" : status === "completed" ? "success" : "neutral"} role="status">{status === "unknown" ? "unconfirmed" : status}</ChatStatus></>} />
    <ChatDisclosure className="native-subagent-card-disclosure" title="Returned report"><pre>{report}</pre></ChatDisclosure>
    <ChatCardBody><p className="muted">{feature?.state.loading ? "Loading associated child history…" : "Associated delegation is not available in the loaded history."}</p></ChatCardBody>
  </ChatCard>;
}

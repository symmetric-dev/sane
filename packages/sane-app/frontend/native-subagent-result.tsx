import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiBriefcase, FiFileText, FiInfo } from "react-icons/fi";
import type { Message } from "./types";
import { NativeSubagentCard, useNativeSubagents } from "./native-subagent-feature";
import { ChatCard, ChatCardHeader, ChatDialog, ChatDialogBody, ChatOverflowMenu, ChatStatus } from "./chat-ui";

/** Only native metadata identifies a result. User-authored XML is ordinary text. */
export function NativeSubagentResult({ source }: { source: Message }) {
  const feature = useNativeSubagents();
  const [view, setView] = useState<"report" | "details" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
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
  const name = result.agent ?? "Subagent response";
  if (summary) return <NativeSubagentCard summary={{ ...summary, status, returnedReport: report }} recorded />;
  return <ChatCard density="compact" className="native-subagent-card" aria-label="Native subagent result">
    <ChatCardHeader className="native-subagent-card-header" title={<span title={name}>{name}</span>} headingLevel={3} icon={<FiBriefcase size={28} />}
      description={<><span>Native</span><span aria-hidden="true">·</span><ChatStatus tone={status === "failed" ? "danger" : status === "unknown" ? "warning" : status === "completed" ? "success" : "neutral"} role="status">{status === "unknown" ? "unconfirmed" : status}</ChatStatus></>}
      actions={<ChatOverflowMenu label="Native subagent result actions" attention={status === "unknown" || status === "failed"} items={[
        { id: "report", label: "View report", icon: <FiFileText />, opensDialog: true, onSelect: button => { trigger.current = button; setView("report"); } },
        { id: "details", label: "Details", icon: <FiInfo />, opensDialog: true, onSelect: button => { trigger.current = button; setView("details"); } },
      ]} />} />
    {view && createPortal(<ChatDialog title={view === "report" ? "Returned report" : "Native subagent details"} subtitle={name} size="wide" close={() => setView(null)} restoreFocus={() => trigger.current}>
      <ChatDialogBody className="native-subagent-card-details">{view === "report" ? <pre>{report}</pre> : <p className="muted">{feature?.state.loading ? "Loading associated child history…" : "Associated delegation is not available in the loaded history."}</p>}</ChatDialogBody>
    </ChatDialog>, document.body)}
  </ChatCard>;
}

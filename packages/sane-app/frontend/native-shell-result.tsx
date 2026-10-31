import type { Message } from "./types";
import { ChatCard, ChatCardHeader, ChatDisclosure, ChatStatus } from "./chat-ui";

export function NativeShellResult({ source }: { source: Message }) {
  const result = source.nativeShellResult!;
  const raw = source.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
  // Native command attributes can contain unescaped quotes and newlines. Match
  // the closing envelope delimiter, not XML attributes or the first quote.
  const envelope = /^<shell id="[^"\n]+" state="[^"\n]+" command="([\s\S]*?)">\r?\n([\s\S]*)\r?\n<\/shell>\s*$/.exec(raw);
  const failed = result.state === "failed" || result.exit !== undefined && result.exit !== 0;
  return <ChatCard density="compact" className="native-shell-card" aria-label="Background shell result">
    <ChatCardHeader title="Background shell" headingLevel={3} metadata={<><ChatStatus>Native</ChatStatus><ChatStatus tone={failed ? "danger" : result.state === "completed" ? "success" : "warning"} role="status">{result.state}{result.exit !== undefined && ` · exit ${result.exit}`}</ChatStatus></>} />
    {envelope && <ChatDisclosure title="Command"><pre>{envelope[1]}</pre></ChatDisclosure>}
    <ChatDisclosure title={`Output${result.truncated ? " (truncated by OpenCode)" : ""}`}><pre>{envelope?.[2] ?? raw}</pre></ChatDisclosure>
  </ChatCard>;
}

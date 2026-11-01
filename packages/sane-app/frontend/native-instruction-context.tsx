import type { Message } from "./types";
import { ChatDisclosure } from "./chat-ui";
import "./native-instruction-context.css";

/** Instruction discovery is harness activity, not an assistant response. */
export function NativeInstructionContext({ source }: { source: Message }) {
  const paths = source.nativeInstructionContext!.paths;
  const text = source.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
  return <ChatDisclosure className="native-instruction-context" title="Instructions loaded" aria-label="OpenCode instructions loaded">
    <p className="muted">OpenCode added these instructions to the conversation context.</p>
    <ul>{paths.map((path, index) => <li key={index}><code>{path}</code></li>)}</ul>
    {text && <pre>{text}</pre>}
  </ChatDisclosure>;
}

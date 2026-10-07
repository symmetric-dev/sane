import type { Message } from "./types";

export function NativeShellResult({ source }: { source: Message }) {
  const result = source.nativeShellResult!;
  const raw = source.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
  // Native command attributes can contain unescaped quotes and newlines. Match
  // the closing envelope delimiter, not XML attributes or the first quote.
  const envelope = /^<shell id="[^"\n]+" state="[^"\n]+" command="([\s\S]*?)">\r?\n([\s\S]*)\r?\n<\/shell>\s*$/.exec(raw);
  const failed = result.state === "failed" || result.exit !== undefined && result.exit !== 0;
  return <section className="native-subagent-card" aria-label="Background shell result">
    <header><div className="native-subagent-card-heading"><h3>Background shell</h3><span className="native-subagent-badge">Native</span></div><span className={`worker-status ${failed ? "failed" : result.state === "completed" ? "completed" : "unknown"}`} role="status">{result.state}{result.exit !== undefined && ` · exit ${result.exit}`}</span></header>
    {envelope && <details className="native-subagent-disclosure"><summary>Command</summary><pre>{envelope[1]}</pre></details>}
    <details className="native-subagent-disclosure"><summary>Output{result.truncated && " (truncated by OpenCode)"}</summary><pre>{envelope?.[2] ?? raw}</pre></details>
  </section>;
}

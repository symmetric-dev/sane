import type { ContextMessageSegment } from "../../packages/sane-app/src/context-message";
import type { DemoCheck, DemoReplayResult, DemoReplayScenario } from "./contract";

const TITLE = "MOCK ONLY — engine-path demonstration";
const BOUNDARY = "Not App end-to-end and not model consumption. All accepted labels mean simulated harness acceptance only. No synthetic recipient response establishes memory or retention.";
const LIMITATIONS = "Real composition/evidence engine, pinned stores, dispatch lifecycle and experiment journal; scripted transport/recipient and binding/settlement are simulated. The journal is not a production writer. This is not power-loss or native-crash proof. Replay is read-only: no native App/harness calls, transport, repair, retry or resend.";
const INSTRUMENTATION = "Counters, trace and original scenario assertions are recorded instrumentation, not independently recovered native effects. Replay independently decodes exact recorded bytes and projects protected journal coverage/facts; a manifest expectation is not execution proof.";

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
/** Text outside fences cannot become Markdown structure, links, or raw HTML. */
function md(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, "\\$1").replace(/\r/g, "\\r").replace(/\n/g, "<br>");
}
/** One more backtick than any content run, so authored lookalike markers and
 * fences cannot close the block. Content itself is never stripped or rewritten. */
function fence(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const delimiter = "`".repeat(length);
  return `${delimiter}text\n${text}${text.endsWith("\n") ? "" : "\n"}${delimiter}`;
}
const status = (passed: boolean): string => passed ? "PASS" : "FAIL";
const fact = (value: string): string => value === "accepted" ? "accepted (simulated only)" : value;
function source(segment: ContextMessageSegment): { source: string; revision: string } {
  const provenance = segment.provenance;
  return provenance.kind === "fragment" ? provenance : provenance.kind === "asset"
    ? { source: provenance.asset.source, revision: provenance.packageRevision }
    : { source: "Pinned procedure index", revision: provenance.packageRevision };
}
function markdownChecks(checks: readonly DemoCheck[]): string {
  return checks.map(c => `- **${status(c.passed)}** ${md(c.name)}: ${md(c.detail)}`).join("\n");
}
function htmlChecks(checks: readonly DemoCheck[]): string {
  return `<ul>${checks.map(c => `<li><strong class="${c.passed ? "pass" : "fail"}">${status(c.passed)}</strong> ${escapeHtml(c.name)}: ${escapeHtml(c.detail)}</li>`).join("")}</ul>`;
}
function markdownScenario(item: DemoReplayScenario): string {
  const { scenario: s, projection: p, message } = item;
  const lines = [
    `## ${md(s.id)} — ${md(s.title)}`,
    `**${status(item.checks.every(c => c.passed))}** · Recovered fact: **${md(fact(p.fact))}** · Expected: ${md(fact(s.expectedFact))}`,
    `Coverage: **${md(p.coverage.state)}** · Source: ${md(p.coverage.source)}`,
    `Coverage reason: ${md(p.coverage.reason ?? "No additional coverage reason.")}`,
    `Projection: ${md(p.reason)}`,
    "### Exact original query",
    fence(JSON.stringify({ identity: p.identity, messageId: p.messageId }, null, 2)),
  ];
  if (message) {
    lines.push("### Authored body (structured byte-range extraction)", fence(message.body.text),
      `UTF-8 body: ${message.body.range.length} bytes at offset ${message.body.range.offset} · SHA-256: ${md(message.body.sha256)}`,
      "### Exact recorded outgoing transport", fence(message.transport.text),
      `UTF-8 transport: ${message.transport.byteLength} bytes · SHA-256: ${md(message.transport.sha256)}`,
      `Placement: ${md(JSON.stringify(message.placement))} · Origin: ${md(message.origin)} · Package revision: ${md(message.packageRevision ?? "none")}`,
      `Ordered selection SHA-256: ${md(message.selectionHash)}`,
      "### Selected segments");
    const rows = ["| ID / category | Source / revision | Selection reason | UTF-8 range | SHA-256 |", "| --- | --- | --- | --- | --- |"];
    for (const segment of message.segments) {
      const provenance = source(segment);
      rows.push(`| ${md(segment.id)} / ${md(segment.category)} | ${md(provenance.source)} / ${md(provenance.revision)} | ${md(segment.reason)} | ${segment.range.offset} + ${segment.range.length} bytes | ${md(segment.sha256)} |`);
    }
    if (!message.segments.length) rows.push("| No context segments | — | Body-only | — | — |");
    lines.push(rows.join("\n"));
    lines.push("### Segment provenance (structured, not marker inference)", fence(JSON.stringify(message.segments.map(({ text: _, ...metadata }) => metadata), null, 2)));
  } else lines.push("### Authored body / transport", "Unavailable: no valid exact submission was recovered. No message bytes are synthesized from expectations or errors.");
  lines.push("### Recorded instrumentation trace", fence(s.trace.join("\n")),
    "### Independent replay checks", markdownChecks(item.checks),
    "### Original recorded scenario checks (instrumentation)", markdownChecks(s.checks),
    "### Projection provenance", fence(JSON.stringify(p.provenance, null, 2)));
  if (s.error) lines.push("### Recorded scenario error", fence(s.error));
  if (item.issues.length) lines.push("### Journal / verification issues", fence(item.issues.join("\n")));
  return lines.join("\n\n");
}

/** Pure renderer; output location and persistence belong to the CLI. */
export function renderDemoMarkdown(result: DemoReplayResult): string {
  const lines = [`# ${TITLE}`, `**${status(result.passed)} — simulated harness acceptance, not native/model proof.**`, BOUNDARY, INSTRUMENTATION,
    `Fixture root: ${md(result.root)}`, "## Acceptance and recorded counters"];
  const rows = ["| Scenario | Replay checks | Recovered fact | Coverage | Mock sends / expected | Context loads | Execution loads | Pairing checks |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const item of result.scenarios) {
    const s = item.scenario;
    rows.push(`| ${md(s.id)} | ${status(item.checks.every(c => c.passed))} | ${md(fact(item.projection.fact))} | ${md(item.projection.coverage.state)} | ${s.mockSends} / ${s.expectedMockSends} | ${s.contextLoads} | ${s.executionLoads} | ${s.pairingChecks} |`);
  }
  lines.push(rows.join("\n"), "## Scope and limitations", LIMITATIONS, ...result.scenarios.map(markdownScenario), "## Restart corruption / missing-record variants");
  if (!result.variants.length) lines.push("No corruption/missing variants were recorded; no variant coverage is claimed.");
  for (const variant of result.variants) lines.push(`### ${md(variant.id)}`, `Directory: ${md(variant.directory)}`,
    `Fact: **${md(fact(variant.projection.fact))}** · Coverage: **${md(variant.projection.coverage.state)}**`,
    `Coverage source: ${md(variant.projection.coverage.source)}`,
    `Coverage reason: ${md(variant.projection.coverage.reason ?? variant.projection.reason)}`,
    `Projection: ${md(variant.projection.reason)}`, markdownChecks(variant.checks),
    fence(JSON.stringify({ identity: variant.projection.identity, messageId: variant.projection.messageId }, null, 2)));
  return `${lines.join("\n\n")}\n`;
}

function htmlScenario(item: DemoReplayScenario): string {
  const { scenario: s, projection: p, message } = item;
  let content = `<section><h2>${escapeHtml(s.id)} — ${escapeHtml(s.title)}</h2><p><strong>${status(item.checks.every(c => c.passed))}</strong> · Recovered fact: <strong>${escapeHtml(fact(p.fact))}</strong> · Expected: ${escapeHtml(fact(s.expectedFact))}</p>
    <p>Coverage: <strong>${escapeHtml(p.coverage.state)}</strong> · Source: ${escapeHtml(p.coverage.source)}</p><p>Coverage reason: ${escapeHtml(p.coverage.reason ?? "No additional coverage reason.")}</p><p>Projection: ${escapeHtml(p.reason)}</p>
    <details><summary>Exact original query</summary><pre>${escapeHtml(JSON.stringify({ identity: p.identity, messageId: p.messageId }, null, 2))}</pre></details>`;
  if (message) {
    content += `<div class="messages"><article><h3>Authored body</h3><pre>${escapeHtml(message.body.text)}</pre><p>Structured UTF-8 range: ${message.body.range.offset} + ${message.body.range.length} bytes</p><p>SHA-256: <code>${escapeHtml(message.body.sha256)}</code></p></article>
      <article><h3>Exact recorded outgoing transport</h3><details open><summary>${message.transport.byteLength} UTF-8 bytes</summary><pre>${escapeHtml(message.transport.text)}</pre></details><p>SHA-256: <code>${escapeHtml(message.transport.sha256)}</code></p></article></div>
      <p>Placement: <code>${escapeHtml(JSON.stringify(message.placement))}</code> · Origin: ${escapeHtml(message.origin)} · Package revision: <code>${escapeHtml(message.packageRevision ?? "none")}</code></p><p>Ordered selection SHA-256: <code>${escapeHtml(message.selectionHash)}</code></p>
      <h3>Selected segments</h3><div class="table"><table><thead><tr><th>ID / category</th><th>Source / revision</th><th>Reason</th><th>UTF-8 range</th><th>SHA-256</th></tr></thead><tbody>`;
    for (const segment of message.segments) {
      const provenance = source(segment);
      content += `<tr><td>${escapeHtml(segment.id)} / ${escapeHtml(segment.category)}</td><td>${escapeHtml(provenance.source)}<br><code>${escapeHtml(provenance.revision)}</code></td><td>${escapeHtml(segment.reason)}</td><td>${segment.range.offset} + ${segment.range.length} bytes</td><td><code>${escapeHtml(segment.sha256)}</code></td></tr>`;
    }
    if (!message.segments.length) content += "<tr><td colspan=\"5\">No context segments; body-only.</td></tr>";
    content += `</tbody></table></div><details><summary>Structured segment provenance</summary><pre>${escapeHtml(JSON.stringify(message.segments.map(({ text: _, ...metadata }) => metadata), null, 2))}</pre></details>`;
  } else content += "<h3>Authored body / transport</h3><p>Unavailable: no valid exact submission was recovered. No message bytes are synthesized from expectations or errors.</p>";
  content += `<details><summary>Recorded instrumentation trace</summary><pre>${escapeHtml(s.trace.join("\n"))}</pre></details><h3>Independent replay checks</h3>${htmlChecks(item.checks)}
    <details><summary>Original recorded scenario checks (instrumentation)</summary>${htmlChecks(s.checks)}</details><details><summary>Projection provenance</summary><pre>${escapeHtml(JSON.stringify(p.provenance, null, 2))}</pre></details>`;
  if (s.error) content += `<h3>Recorded scenario error</h3><pre>${escapeHtml(s.error)}</pre>`;
  if (item.issues.length) content += `<h3>Journal / verification issues</h3><pre>${escapeHtml(item.issues.join("\n"))}</pre>`;
  return `${content}</section>`;
}

/** Standalone escaped HTML. No script, external assets, network or writes. */
export function renderDemoHtml(result: DemoReplayResult): string {
  const rows = result.scenarios.map(item => {
    const s = item.scenario;
    return `<tr><td>${escapeHtml(s.id)}</td><td>${status(item.checks.every(c => c.passed))}</td><td>${escapeHtml(fact(item.projection.fact))}</td><td>${escapeHtml(item.projection.coverage.state)}</td><td>${s.mockSends} / ${s.expectedMockSends}</td><td>${s.contextLoads}</td><td>${s.executionLoads}</td><td>${s.pairingChecks}</td></tr>`;
  }).join("");
  const variants = result.variants.map(v => `<article><h3>${escapeHtml(v.id)}</h3><p>Directory: ${escapeHtml(v.directory)}</p><p>Fact: <strong>${escapeHtml(fact(v.projection.fact))}</strong> · Coverage: <strong>${escapeHtml(v.projection.coverage.state)}</strong></p><p>Coverage source: ${escapeHtml(v.projection.coverage.source)}</p><p>Coverage reason: ${escapeHtml(v.projection.coverage.reason ?? v.projection.reason)}</p><p>Projection: ${escapeHtml(v.projection.reason)}</p>${htmlChecks(v.checks)}<details><summary>Original activation query</summary><pre>${escapeHtml(JSON.stringify({ identity: v.projection.identity, messageId: v.projection.messageId }, null, 2))}</pre></details></article>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${TITLE}</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;padding:2rem;max-width:1440px;color:#172033;background:#f7f8fb}h1,h2,h3{line-height:1.2}header,section{background:white;border:1px solid #d5dce6;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem}header{border-top:8px solid #936119}.boundary{font-weight:600;color:#74460b}.messages{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}.messages article{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#eef1f6;border-radius:4px;font-size:.85rem}code{overflow-wrap:anywhere;font-size:.85rem}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{padding:.6rem;border:1px solid #d5dce6;text-align:left;vertical-align:top}th{background:#edf1f7}details{margin:1rem 0}summary{cursor:pointer;font-weight:600}.pass{color:#12613a}.fail{color:#a32121}li{margin:.4rem 0}@media(max-width:850px){.messages{grid-template-columns:1fr}body{padding:1rem}}
</style></head><body><header><h1>${TITLE}</h1><p class="boundary">${status(result.passed)} — simulated harness acceptance, not native/model proof.</p><p>${BOUNDARY}</p><p>${INSTRUMENTATION}</p><p>Fixture root: <code>${escapeHtml(result.root)}</code></p></header>
<section><h2>Acceptance and recorded counters</h2><div class="table"><table><thead><tr><th>Scenario</th><th>Replay checks</th><th>Recovered fact</th><th>Coverage</th><th>Mock sends / expected</th><th>Context loads</th><th>Execution loads</th><th>Pairing checks</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Scope and limitations</h2><p>${LIMITATIONS}</p></section>
${result.scenarios.map(htmlScenario).join("\n")}
<section><h2>Restart corruption / missing-record variants</h2>${variants || "<p>No corruption/missing variants were recorded; no variant coverage is claimed.</p>"}</section></body></html>\n`;
}

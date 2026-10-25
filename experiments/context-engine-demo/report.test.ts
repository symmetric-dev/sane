import { describe, expect, test } from "bun:test";
import { composeContextMessage } from "../../packages/sane-app/src/context-message";
import type { DemoReplayResult } from "./contract";
import { renderDemoHtml, renderDemoMarkdown } from "./report";

const body = '[SANE CONTEXT MESSAGE v1]\n[SANE AUTHORED BODY {"bytes":0}]\n`````\n<script>alert("bad")</script>\n<& 😀';
function fixture(): DemoReplayResult {
  const identity = { source: { harnessId: "mock-context-demo", sessionId: "s", authorityId: "a", nativeSessionId: "n", cwd: "/fixture/checkout" }, runId: "r", nativeCommandId: "m" };
  const message = composeContextMessage({ body, binding: identity.source, origin: "user", placement: { kind: "body-only" } });
  return { schema: 1, type: "mock-context-demo-replay", simulation: true, root: '/fixture/<img src=x onerror="bad">', passed: false, variants: [{
    id: "missing", directory: "/fixture/missing", projection: { identity, messageId: "m", fact: "unknown", coverage: { state: "unavailable", source: "missing-owner", reason: "missing <script>" }, reason: "No complete coverage", provenance: [], composition: null },
    checks: [{ name: "missing", passed: true, detail: "unknown without resend" }],
  }], scenarios: [{
    scenario: { id: "ordinary", title: "<script>unsafe</script>", journalDirectory: "/fixture/journal", identity, messageId: "m", expectedFact: "accepted", expectedMockSends: 1, mockSends: 1, contextLoads: 0, executionLoads: 1, pairingChecks: 1,
      trace: ["owner-before", "<svg onload=bad>", "mock-send"], checks: [{ name: "original", passed: true, detail: "recorded <b>only</b>" }], error: "<iframe src=x>" },
    projection: { identity, messageId: "m", fact: "accepted", coverage: { state: "complete", source: "/fixture/journal" }, reason: "Exact per-message acceptance (simulated)", provenance: [], composition: null },
    message, issues: ["issue <img src=x>"], checks: [{ name: "independent <script>", passed: false, detail: "mismatch & unknown" }],
  }] };
}
describe("mock demo pure reports", () => {
  test("HTML escapes every recorded text surface without executable content", () => {
    const html = renderDemoHtml(fixture());
    expect(html).toContain("&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;svg onload=bad&gt;");
    expect(html).toContain("&lt;iframe src=x&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script"); expect(html).not.toContain("<img"); expect(html).not.toContain("<iframe");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("[SANE AUTHORED BODY {&quot;bytes&quot;:0}]");
    expect(html).toContain("accepted (simulated only)");
  });
  test("Markdown chooses a fence longer than arbitrary authored backticks", () => {
    const markdown = renderDemoMarkdown(fixture());
    expect(markdown).toContain(`\`\`\`\`\`\`text\n${body}\n\`\`\`\`\`\``);
    expect(markdown.split(body).length - 1).toBe(2); // body and exact transport, no stripping
    expect(markdown).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(markdown).toContain("UTF-8 body:");
  });
  test("both formats expose failure, counters, coverage and honest limitations", () => {
    for (const report of [renderDemoMarkdown(fixture()), renderDemoHtml(fixture())]) {
      expect(report).toContain("MOCK ONLY"); expect(report).toContain("FAIL");
      expect(report).toContain("not model consumption"); expect(report).toContain("recorded instrumentation");
      expect(report).toContain("not a production writer"); expect(report).toContain("native-crash proof");
      expect(report.replace(/\\-/g, "-")).toContain("missing-owner"); expect(report).toContain("unavailable");
      expect(report).toContain("Execution loads"); expect(report).toContain("Pairing checks");
    }
  });
  test("missing messages are not synthesized and absent variants are not claimed", () => {
    const result = fixture(), empty = { ...result, variants: [], scenarios: result.scenarios.map(s => ({ ...s, message: null })) };
    expect(renderDemoMarkdown(empty)).not.toContain(body);
    expect(renderDemoHtml(empty)).toContain("No message bytes are synthesized");
    expect(renderDemoMarkdown(empty)).toContain("no variant coverage is claimed");
  });
});

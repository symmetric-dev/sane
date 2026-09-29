import { mcpModule } from "./deps";
import { record, root } from "./evidence";
import { consume, payload } from "./binding";

try {
  const dir = root(process.argv[2]);
  const { Server } = await mcpModule("server/index.js");
  const { StdioServerTransport } = await mcpModule("server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await mcpModule("types.js");
  const server = new Server({ name: "native-caller-capabilities", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "capture", description: "Record native caller evidence. Leave _invocation absent; a native hook supplies it. wait_ms optionally holds this harmless call for background/interruption observation.",
    inputSchema: { type: "object", properties: { _invocation: { type: "string" }, wait_ms: { type: "integer", minimum: 0, maximum: 180000 } }, additionalProperties: false },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request: any, extra: any) => {
    if (request.params.name !== "capture") return { isError: true, content: [{ type: "text", text: "Unknown probe tool" }] };
    const input = request.params.arguments ?? {};
    let body;
    try { body = payload(input); } catch { return { isError: true, content: [{ type: "text", text: "Invalid wait_ms" }] }; }
    const binding = consume(dir, input, extra.requestId);
    if (binding.status === "bound" && body.wait_ms) {
      record(dir, "mcp.wait-start", { bindingEvent: binding.event, wait_ms: body.wait_ms });
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); extra.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, body.wait_ms);
        extra.signal.addEventListener("abort", done, { once: true });
        if (extra.signal.aborted) done();
      });
      record(dir, "mcp.wait-end", { bindingEvent: binding.event, aborted: extra.signal.aborted });
    }
    return { isError: binding.status !== "bound", content: [{ type: "text", text: JSON.stringify(binding) }] };
  });
  record(dir, "mcp.process-start", { ppid: process.ppid, nativeIdentityFromEnvironment: false });
  await server.connect(new StdioServerTransport());
} catch {
  console.error("native capability MCP unavailable (dependency/config/transport); no identity inferred");
  process.exitCode = 1;
}

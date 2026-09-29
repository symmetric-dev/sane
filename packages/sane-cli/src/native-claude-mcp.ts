import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { consumeClaudeInvocation } from "./native-claude.ts"
import { linkNativeCaller, nativeCallerContext, nativeLinkSchema } from "./native-caller.ts"
import { handoffNativeCaller, nativeHandoffSchema, nativeHandoffStatusSchema } from "./native-handoff.ts"

const [profileRoot, bindingRoot, appConnectionFile] = process.argv.slice(2)
if (!profileRoot || !bindingRoot) throw new Error("Explicit Claude profile and binding directory required")
const server = new Server({ name: "sane", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  ...([false, true] as const).map(status => { const schema = status ? nativeHandoffStatusSchema : nativeHandoffSchema; return { name: status ? "sane_handoff_status" : "sane_handoff", description: status ? "Read durable handoff status by requestId. Leave _invocation absent." : "Queue an asynchronous handoff through the running App without waiting for recipient work or reply. Reuse requestId for admission recovery. Leave _invocation absent.", inputSchema: { ...schema, required: [...schema.required], properties: { ...schema.properties, _invocation: { type: "string" } } } } }),
  { name: "sane_link", description: "Enroll this native conversation and assign its workstream phase. Leave _invocation absent; the native hook supplies it.", inputSchema: { ...nativeLinkSchema, required: [...nativeLinkSchema.required], properties: { ...nativeLinkSchema.properties, _invocation: { type: "string" } } } },
  { name: "sane_context", description: "Read the enrolled caller's compact context: workstream, phase, harness and execution checkout. Leave _invocation absent; the native hook supplies it.", inputSchema: { type: "object", properties: { _invocation: { type: "string" } }, additionalProperties: false } },
] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const tool = request.params.name
    if (tool !== "sane_link" && tool !== "sane_context" && tool !== "sane_handoff" && tool !== "sane_handoff_status") throw new Error("Unknown native tool")
    const bound = consumeClaudeInvocation(bindingRoot, profileRoot, tool, request.params.arguments ?? {})
    if (tool === "sane_context" && Object.keys(bound.input).length) throw new Error("Unexpected context arguments")
    const result = tool === "sane_link" ? linkNativeCaller(bound.caller, bound.input) : tool === "sane_context" ? nativeCallerContext(bound.caller) : await handoffNativeCaller(bound.caller, bound.input, appConnectionFile!, tool === "sane_handoff_status")
    return { content: [{ type: "text", text: JSON.stringify(result) }] }
  } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Native caller unavailable" }] } }
})
await server.connect(new StdioServerTransport())

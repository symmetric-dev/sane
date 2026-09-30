import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { consumeClaudeInvocation } from "./native-claude.ts"
import { linkNativeCaller, nativeCallerContext, nativeLinkSchema } from "./native-caller.ts"
import { handoffNativeCaller, nativeHandoffSchema, nativeHandoffStatusSchema } from "./native-handoff.ts"
import { nativeWorkerDescriptions, nativeWorkerOperations, nativeWorkerSchemas } from "./native-worker-contract.ts"
import { workerNativeCaller } from "./native-worker.ts"

const [profileRoot, bindingRoot, appConnectionFile] = process.argv.slice(2)
if (!profileRoot || !bindingRoot) throw new Error("Explicit Claude profile and binding directory required")
const server = new Server({ name: "sane", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  ...nativeWorkerOperations.map(operation => ({ name: `sane_worker_${operation}`, description: `${nativeWorkerDescriptions[operation]} Leave _invocation absent; the native hook supplies it.`, inputSchema: { ...nativeWorkerSchemas[operation], required: [...nativeWorkerSchemas[operation].required], properties: { ...nativeWorkerSchemas[operation].properties, _invocation: { type: "string" } } } })),
  ...([false, true] as const).map(status => { const schema = status ? nativeHandoffStatusSchema : nativeHandoffSchema; return { name: status ? "sane_handoff_status" : "sane_handoff", description: status ? "Read durable handoff status by requestId. Leave _invocation absent." : "Queue an asynchronous handoff through the running App without waiting for recipient work or reply. Reuse requestId for admission recovery. New recipients use the destination assistant's configured harness. A sender without a workstream may pass kickoff (with to: design and createNew) to enroll, create that workstream and start a new Design recipient without joining it. Kickoff defaults checkout to the caller's validated execution checkout; other createNew requests require explicit checkout or a workstream default. Leave _invocation absent.", inputSchema: { ...schema, required: [...schema.required], properties: { ...schema.properties, _invocation: { type: "string" } } } } }),
  { name: "sane_link", description: "Enroll this native conversation. Empty arguments enroll without claiming a phase; slot optionally assigns a phase. Leave _invocation absent; the native hook supplies it.", inputSchema: { ...nativeLinkSchema, required: [...nativeLinkSchema.required], properties: { ...nativeLinkSchema.properties, _invocation: { type: "string" } } } },
  { name: "sane_context", description: "Read the enrolled caller's compact context: workstream, phase, harness and execution checkout. Leave _invocation absent; the native hook supplies it.", inputSchema: { type: "object", properties: { _invocation: { type: "string" } }, additionalProperties: false } },
] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const tool = request.params.name
    const operation = nativeWorkerOperations.find(operation => tool === `sane_worker_${operation}`)
    if (!operation && tool !== "sane_link" && tool !== "sane_context" && tool !== "sane_handoff" && tool !== "sane_handoff_status") throw new Error("Unknown native tool")
    const bound = consumeClaudeInvocation(bindingRoot, profileRoot, tool as Parameters<typeof consumeClaudeInvocation>[2], request.params.arguments ?? {})
    if (tool === "sane_context" && Object.keys(bound.input).length) throw new Error("Unexpected context arguments")
    const result = operation ? await workerNativeCaller(bound.caller, operation, bound.input, appConnectionFile!) : tool === "sane_link" ? linkNativeCaller(bound.caller, bound.input) : tool === "sane_context" ? nativeCallerContext(bound.caller) : await handoffNativeCaller(bound.caller, bound.input, appConnectionFile!, tool === "sane_handoff_status")
    return { content: [{ type: "text", text: JSON.stringify(result) }] }
  } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Native caller unavailable" }] } }
})
await server.connect(new StdioServerTransport())

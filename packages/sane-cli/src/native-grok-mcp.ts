import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { consumeGrokRuntimeInvocation } from "./native-grok-binding.ts"
import { linkNativeCaller, nativeCallerContext, nativeLinkSchema } from "./native-caller.ts"
import { handoffNativeCaller, nativeHandoffSchema, nativeHandoffStatusSchema } from "./native-handoff.ts"
import { nativeWorkerDescriptions, nativeWorkerOperations, nativeWorkerSchemas, SANE_MANAGED_ONLY } from "./native-worker-contract.ts"
import { workerNativeCaller } from "./native-worker.ts"
import { nativeShareCodeDescription, nativeShareCodeSchema } from "./native-share-code-contract.ts"
import { shareCodeNativeCaller } from "./native-share-code.ts"
import { nativeShareMediaDescription, nativeShareMediaSchema } from "./native-share-media-contract.ts"
import { shareMediaNativeCaller } from "./native-share-media.ts"
import { nativeUserQuestionsDescription, nativeUserQuestionsSchema } from "./native-user-questions-contract.ts"
import { presentQuestionsNativeCaller } from "./native-user-questions.ts"
import { browserNativeCaller, nativeBrowserDescriptions, nativeBrowserSchemas, nativeBrowserToolNames } from "./native-browser.ts"

const [directory, bindingId, appConnectionFile] = process.argv.slice(2)
if (!directory || !bindingId || !appConnectionFile) throw new Error("Explicit Grok runtime binding and App connection required")
const tools = [
  { name: "present_questions_to_user", description: nativeUserQuestionsDescription, inputSchema: nativeUserQuestionsSchema },
  { name: "sane_share_code", description: nativeShareCodeDescription, inputSchema: nativeShareCodeSchema },
  { name: "sane_share_media", description: nativeShareMediaDescription, inputSchema: nativeShareMediaSchema },
  ...nativeWorkerOperations.map(operation => ({ name: `sane_worker_${operation}`, description: nativeWorkerDescriptions[operation], inputSchema: nativeWorkerSchemas[operation] })),
  { name: "sane_handoff", description: `${SANE_MANAGED_ONLY} Queue an asynchronous handoff only when explicitly requested by the user. Reuse requestId and the same payload for admission recovery; never invent a new ID after an unknown acknowledgment. Kickoff is the only enrollment operation.`, inputSchema: nativeHandoffSchema },
  { name: "sane_handoff_status", description: `${SANE_MANAGED_ONLY} Read durable handoff status by requestId.`, inputSchema: nativeHandoffStatusSchema },
  { name: "sane_link", description: `${SANE_MANAGED_ONLY} Change this enrolled conversation's workstream or phase; never enrolls.`, inputSchema: nativeLinkSchema },
  { name: "sane_context", description: `${SANE_MANAGED_ONLY} Read this caller's workstream, phase, harness and execution checkout.`, inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  ...nativeBrowserToolNames.map(name => ({ name, description: nativeBrowserDescriptions[name], inputSchema: nativeBrowserSchemas[name] })),
]
const server = new Server({ name: "sane-grok", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({ ...tool,
  description: `${tool.description} Leave _saneGrok absent; Grok's native hook supplies invocation provenance.`,
  inputSchema: { ...tool.inputSchema, type: "object" as const, required: [...tool.inputSchema.required], properties: { ...tool.inputSchema.properties, _saneGrok: { type: "string" } } },
})) }))
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const name = request.params.name
    if (!tools.some(tool => tool.name === name)) throw new Error("Unknown Grok native tool")
    const bound = consumeGrokRuntimeInvocation(directory, bindingId, name, request.params.arguments ?? {})
    const operation = nativeWorkerOperations.find(operation => name === `sane_worker_${operation}`)
    const browser = nativeBrowserToolNames.find(tool => tool === name)
    let result: unknown
    if (operation) result = await workerNativeCaller(bound.caller, operation, bound.input, appConnectionFile, extra.signal)
    else if (browser) result = await browserNativeCaller(bound.caller, browser, bound.input, appConnectionFile, extra.signal)
    else if (name === "sane_share_code") result = await shareCodeNativeCaller(bound.caller, bound.input, appConnectionFile, bound.invocation, extra.signal)
    else if (name === "sane_share_media") result = await shareMediaNativeCaller(bound.caller, bound.input, appConnectionFile, bound.invocation, extra.signal)
    else if (name === "present_questions_to_user") result = await presentQuestionsNativeCaller(bound.caller, bound.input, appConnectionFile, bound.invocation, extra.signal)
    else if (name === "sane_link") result = linkNativeCaller(bound.caller, bound.input)
    else if (name === "sane_context") {
      if (Object.keys(bound.input).length) throw new Error("Unexpected context arguments")
      result = nativeCallerContext(bound.caller)
    } else result = await handoffNativeCaller(bound.caller, bound.input, appConnectionFile, name === "sane_handoff_status")
    return { content: [{ type: "text", text: JSON.stringify(result) }] }
  } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Grok native tool unavailable" }] } }
})
await server.connect(new StdioServerTransport())

import { Rpc } from "@opencode/plugin/rpc"

/** Raw transport: POST /api/rpc/sane-execution/configure?location[directory]=...
 * with {input: configuration}; successful response is {output: receipt}.
 * Reuse the App's authenticated authority transport. This is server RPC, never
 * a model-visible tool or a separate unauthenticated listener. */
export const SaneExecution = Rpc.define({
  id: "sane-execution",
  events: {},
  methods: {
    configure: {
      input: {
        type: "object", additionalProperties: false,
        required: ["sessionID", "directory", "agent", "executionAgent", "permissions", "nativeChildren", "delegation", "directChildren"],
        properties: {
          sessionID: { type: "string", minLength: 1 }, directory: { type: "string", minLength: 1 },
          readOnly: { type: "boolean" },
          agent: { type: "string", minLength: 1 }, executionAgent: { type: "string", minLength: 1 }, temperature: { type: "number" },
          delegation: { type: "object", additionalProperties: { type: "string" } },
          directChildren: { type: "array", items: { type: "string" } },
          model: { type: "object", additionalProperties: false, required: ["providerID", "id"], properties: {
            providerID: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 }, variant: { type: "string", minLength: 1 },
          } },
          permissions: { type: "array", items: { type: "object", additionalProperties: false, required: ["action", "resource", "effect"], properties: {
            action: { type: "string" }, resource: { type: "string" }, effect: { enum: ["allow", "ask", "deny"] },
          } } },
          nativeChildren: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "canonicalId", "description", "system", "permissions", "children"], properties: {
            id: { type: "string", minLength: 1 }, system: { type: "string", minLength: 1 },
            canonicalId: { type: "string", minLength: 1 }, description: { type: "string" },
            children: { type: "array", items: { type: "string" } }, temperature: { type: "number" },
            model: { type: "object", additionalProperties: false, required: ["providerID", "id"], properties: {
              providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" },
            } },
            permissions: { type: "array", items: { type: "object", additionalProperties: false, required: ["action", "resource", "effect"], properties: {
              action: { type: "string" }, resource: { type: "string" }, effect: { enum: ["allow", "ask", "deny"] },
            } } },
          } } },
        },
      },
      output: { type: "object", additionalProperties: false, required: ["sessionID", "agent", "executionAgent", "nativeChildren"], properties: {
        sessionID: { type: "string" }, agent: { type: "string" }, executionAgent: { type: "string" }, nativeChildren: { type: "array", items: { type: "string" } },
      } },
    },
  },
})

import { workstreamTools } from "./tools/workstream.ts"

interface OpenCodePluginHooks {
  tool: Record<string, unknown>
}

export const AgenvWorkstreamsPlugin = async (): Promise<OpenCodePluginHooks> => ({
  tool: workstreamTools as Record<string, unknown>,
})

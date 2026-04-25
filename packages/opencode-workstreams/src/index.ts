import { workstreamTools, workstreamToolsWithManagement } from "./tools/workstream.ts"

interface OpenCodePluginHooks {
  tool: Record<string, unknown>
}

function resolveInstallProfile(): "manual" | "managed" {
  const profile = (process.env.AGENV_WORKSTREAMS_PROFILE ?? "manual").trim().toLowerCase()
  return ["managed", "management", "full", "legacy", "root-agent"].includes(profile)
    ? "managed"
    : "manual"
}

export const AgenvWorkstreamsPlugin = async (): Promise<OpenCodePluginHooks> => ({
  tool: (resolveInstallProfile() === "managed"
    ? workstreamToolsWithManagement
    : workstreamTools) as Record<string, unknown>,
})

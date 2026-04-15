export const WORKSTREAM_TOOL_VERSION = "2026-04-14-supervision-tmux-fix-v1"

export interface WorkstreamsToolCapabilities {
  fakeUserPrompt: boolean
  metadataOnlyCheckpoints: boolean
  messageBoundaryFork: boolean
  breakpointTags: boolean
  breakpointModes: boolean
  autoResolvedBranchSupervisionContext: boolean
}

export interface WorkstreamsToolRuntimeInfo {
  toolVersion: string
  toolFilePath?: string
  workCommandPath?: string
  resolvedWorkCommandPath?: string
  resolvedRuntimeModulePath?: string
  workstreamsPackageRoot?: string
  workstreamsPackageVersion?: string
  capabilities: WorkstreamsToolCapabilities
  errors?: {
    workCommandPath?: string
    resolvedRuntimeModulePath?: string
    workstreamsPackageVersion?: string
  }
}

export const WORKSTREAM_TOOL_CAPABILITIES: WorkstreamsToolCapabilities = {
  fakeUserPrompt: true,
  metadataOnlyCheckpoints: true,
  messageBoundaryFork: true,
  breakpointTags: true,
  breakpointModes: true,
  autoResolvedBranchSupervisionContext: true,
}

export function createWorkstreamsToolRuntimeInfo(
  args: Pick<WorkstreamsToolRuntimeInfo, "toolVersion" | "toolFilePath">,
): WorkstreamsToolRuntimeInfo {
  return {
    toolVersion: args.toolVersion,
    ...(args.toolFilePath ? { toolFilePath: args.toolFilePath } : {}),
    capabilities: { ...WORKSTREAM_TOOL_CAPABILITIES },
  }
}

export function formatWorkstreamsToolRuntimeInfo(info: WorkstreamsToolRuntimeInfo): string {
  return JSON.stringify(info, null, 2)
}

import type {
  DashboardTerminalViewMetadata,
  DashboardTmuxObservabilitySnapshot,
} from "../../../workstreams/src/internal/dashboard-contracts.ts"

export type TerminalObservabilityMode = "placeholder" | "ttyd"

export interface TerminalObservabilityCapability {
  enabled: boolean
  message: string
  mode: TerminalObservabilityMode
}

export interface TerminalObservabilityView extends DashboardTerminalViewMetadata {
  notes?: string
}

export interface TerminalObservabilityListViewsOptions {
  checkedAt: string
  tmux: DashboardTmuxObservabilitySnapshot
}

export interface TerminalObservabilityResolvedTarget {
  terminalViewId: string
  sessionName: string
  upstreamOrigin: string
  upstreamPath: string
  port: number
  pid: number
}

export interface TerminalObservabilityProvider {
  getCapability(): Promise<TerminalObservabilityCapability>
  listViews(options: TerminalObservabilityListViewsOptions): Promise<TerminalObservabilityView[]>
  resolveViewTarget(terminalViewId: string): Promise<TerminalObservabilityResolvedTarget | null>
  close(): void
}

export function createNoopTerminalObservabilityProvider(): TerminalObservabilityProvider {
  return {
    async getCapability(): Promise<TerminalObservabilityCapability> {
      return {
        enabled: false,
        message: "Terminal observability is scaffolded but not connected yet.",
        mode: "placeholder",
      }
    },
    async listViews(): Promise<TerminalObservabilityView[]> {
      return []
    },
    async resolveViewTarget(): Promise<TerminalObservabilityResolvedTarget | null> {
      return null
    },
    close(): void {},
  }
}

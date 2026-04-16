export type TerminalObservabilityMode = "placeholder" | "ttyd"

export interface TerminalObservabilityCapability {
  enabled: boolean
  message: string
  mode: TerminalObservabilityMode
}

export interface TerminalObservabilityView {
  id: string
  label: string
  notes?: string
  status: "pending" | "ready" | "unavailable"
}

export interface TerminalObservabilityProvider {
  getCapability(): Promise<TerminalObservabilityCapability>
  listViews(): Promise<TerminalObservabilityView[]>
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
  }
}

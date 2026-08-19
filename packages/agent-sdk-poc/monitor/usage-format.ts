export interface LatestUsageLike {
  timestamp?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export function formatTokenCount(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return new Intl.NumberFormat("en-US").format(value)
}

export function formatLatestUsageSummary(usage: LatestUsageLike | null | undefined): string {
  if (!usage) return "Usage not reported yet"

  const parts: string[] = []
  const input = formatTokenCount(usage.inputTokens)
  const output = formatTokenCount(usage.outputTokens)
  const total = formatTokenCount(usage.totalTokens)
  const cacheRead = formatTokenCount(usage.cacheReadTokens)
  const cacheWrite = formatTokenCount(usage.cacheWriteTokens)
  const reasoning = formatTokenCount(usage.reasoningTokens)

  if (input !== undefined) parts.push(`in ${input}`)
  if (output !== undefined) parts.push(`out ${output}`)
  if (total !== undefined) parts.push(`total ${total}`)
  if (cacheRead !== undefined) parts.push(`cache read ${cacheRead}`)
  if (cacheWrite !== undefined) parts.push(`cache write ${cacheWrite}`)
  if (reasoning !== undefined) parts.push(`reasoning ${reasoning}`)

  if (parts.length === 0) return "Usage not reported yet"

  const provider = usage.provider ? ` · ${usage.provider}` : ""
  return `${parts.join(" · ")}${provider}`
}

export function normalizeCanonicalStageId(stageId?: string): string | undefined {
  if (typeof stageId !== "string") {
    return undefined
  }

  const trimmed = stageId.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  const numericMatch = /^0*(\d+)$/.exec(trimmed)
  if (numericMatch) {
    return numericMatch[1]!.padStart(2, "0")
  }

  const labeledMatch = /^stage\s+0*(\d+)(?:\b|\s*:.*)$/i.exec(trimmed)
  if (labeledMatch) {
    return labeledMatch[1]!.padStart(2, "0")
  }

  return undefined
}

export function normalizeCanonicalStageIdOrFallback(stageId?: string): string | undefined {
  const canonicalStageId = normalizeCanonicalStageId(stageId)
  if (canonicalStageId) {
    return canonicalStageId
  }

  const trimmed = stageId?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

import { existsSync, readdirSync } from "fs"

export interface ParsedStageDirectoryName {
  name: string
  baseStageNumber: number
  revisionNumber?: number
  isRevision: boolean
}

const STAGE_DIRECTORY_NAME_RE = /^(\d+)(?:-r(\d+))?$/i

export function parseStageDirectoryName(name: string): ParsedStageDirectoryName | null {
  const match = STAGE_DIRECTORY_NAME_RE.exec(name.trim())
  if (!match) {
    return null
  }

  const baseStageNumber = Number.parseInt(match[1]!, 10)
  const revisionNumber = match[2] ? Number.parseInt(match[2], 10) : undefined

  return {
    name,
    baseStageNumber,
    revisionNumber,
    isRevision: revisionNumber !== undefined,
  }
}

export function compareStageDirectoryNames(
  left: ParsedStageDirectoryName,
  right: ParsedStageDirectoryName,
): number {
  if (left.baseStageNumber !== right.baseStageNumber) {
    return left.baseStageNumber - right.baseStageNumber
  }

  if (left.isRevision !== right.isRevision) {
    return left.isRevision ? 1 : -1
  }

  if (!left.isRevision && !right.isRevision) {
    return left.name.localeCompare(right.name)
  }

  return (left.revisionNumber ?? 0) - (right.revisionNumber ?? 0)
}

export function listOrderedStageDirectories(stagesDir: string): ParsedStageDirectoryName[] {
  if (!existsSync(stagesDir)) {
    return []
  }

  return readdirSync(stagesDir)
    .map((entry) => parseStageDirectoryName(entry))
    .filter((entry): entry is ParsedStageDirectoryName => entry !== null)
    .sort(compareStageDirectoryNames)
}

export function formatNormalStageDirectoryName(stageNumber: number): string {
  return stageNumber.toString().padStart(2, "0")
}

export function getNextAppendedStageDirectoryName(
  stageDirectories: ParsedStageDirectoryName[],
): string {
  const highestBaseStageNumber = stageDirectories.reduce(
    (highest, entry) => Math.max(highest, entry.baseStageNumber),
    0,
  )

  return formatNormalStageDirectoryName(highestBaseStageNumber + 1)
}

export function getNextInsertedRevisionDirectoryName(
  stageDirectories: ParsedStageDirectoryName[],
  afterStage: number,
): string {
  const ordered = [...stageDirectories].sort(compareStageDirectoryNames)
  const insertionAnchorIndex = ordered.findIndex(
    (entry) => entry.baseStageNumber === afterStage && !entry.isRevision,
  )

  if (insertionAnchorIndex === -1) {
    throw new Error(`Stage ${formatNormalStageDirectoryName(afterStage)} not found`)
  }

  if (insertionAnchorIndex === ordered.length - 1) {
    return getNextAppendedStageDirectoryName(ordered)
  }

  const nextRevisionNumber = ordered
    .filter((entry) => entry.baseStageNumber === afterStage && entry.isRevision)
    .reduce((highest, entry) => Math.max(highest, entry.revisionNumber ?? 0), 0) + 1

  return `${formatNormalStageDirectoryName(afterStage)}-r${nextRevisionNumber}`
}

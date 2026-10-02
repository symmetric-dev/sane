/** Browser-safe conversation slots. Support tracks confer no lifecycle authority. */
import { LIFECYCLE_PHASES, type LifecyclePhase } from "./lifecycle.ts"

export const SUPPORT_TRACKS = ["research", "knowledge", "prototype"] as const
export type SupportTrack = (typeof SUPPORT_TRACKS)[number]
export type Slot = LifecyclePhase | SupportTrack | `research:${string}`
export const SLOT_REGISTRY = Object.freeze([
  ...LIFECYCLE_PHASES.map(name => Object.freeze({ name, kind: "lifecycle" as const, acceptsTopic: false })),
  ...SUPPORT_TRACKS.map(name => Object.freeze({ name, kind: "support" as const, acceptsTopic: name === "research" })),
])
/** The final assertion excludes even a trailing newline (unlike plain JS `$`). */
export const SLOT_PATTERN = `^(${SLOT_REGISTRY.map(slot => slot.name).join("|")}|research:[a-z0-9][a-z0-9_-]{0,95})$(?![\\s\\S])`
const slotPattern = new RegExp(SLOT_PATTERN)
export function isSlot(value: unknown): value is Slot { return typeof value === "string" && slotPattern.test(value) }
export function validateSlot(value: unknown): Slot {
  if (!isSlot(value)) throw new Error("Invalid slot. Expected design, engineering, planning, execution, research, research:<safe-topic>, knowledge, or prototype.")
  return value
}
export type ParsedSlot =
  | { slot: Slot; kind: "lifecycle"; track: LifecyclePhase; topic: null }
  | { slot: Slot; kind: "support"; track: SupportTrack; topic: string | null }
export function parseSlot(value: unknown): ParsedSlot {
  const slot = validateSlot(value)
  if ((LIFECYCLE_PHASES as readonly string[]).includes(slot)) return { slot, kind: "lifecycle", track: slot as LifecyclePhase, topic: null }
  return { slot, kind: "support", track: slot.startsWith("research:") ? "research" : slot as SupportTrack, topic: slot.startsWith("research:") ? slot.slice(9) : null }
}

/** Browser-safe conversation slots. Support tracks confer no lifecycle authority. */
import { LIFECYCLE_PHASES, type LifecyclePhase } from "./lifecycle.ts"

export const SUPPORT_TRACKS = ["research", "curation", "experimentation"] as const
export type SupportTrack = (typeof SUPPORT_TRACKS)[number]
export type Slot = LifecyclePhase | SupportTrack | `research:${string}`
const LEGACY_SLOT_ALIASES = ["knowledge", "prototype"] as const
/** Raw persisted assignments remain readable; aliases are not canonical choices. */
export type StoredSlot = Slot | (typeof LEGACY_SLOT_ALIASES)[number]
export const SLOT_REGISTRY = Object.freeze([
  ...LIFECYCLE_PHASES.map(name => Object.freeze({ name, kind: "lifecycle" as const, acceptsTopic: false })),
  ...SUPPORT_TRACKS.map(name => Object.freeze({ name, kind: "support" as const, acceptsTopic: name === "research" })),
])
/** The final assertion excludes even a trailing newline (unlike plain JS `$`). */
const slotPatternFor = (names: readonly string[]) => `^(${names.join("|")}|research:[a-z0-9][a-z0-9_-]{0,95})$(?![\\s\\S])`
export const SLOT_PATTERN = slotPatternFor(SLOT_REGISTRY.map(slot => slot.name))
/** Alias-aware input/storage contract. Canonical registry and picker stay alias-free. */
export const STORED_SLOT_PATTERN = slotPatternFor([...SLOT_REGISTRY.map(slot => slot.name), ...LEGACY_SLOT_ALIASES])
const slotPattern = new RegExp(SLOT_PATTERN)
const storedSlotPattern = new RegExp(STORED_SLOT_PATTERN)
export function isSlot(value: unknown): value is Slot { return typeof value === "string" && slotPattern.test(value) }
export function isStoredSlot(value: unknown): value is StoredSlot { return typeof value === "string" && storedSlotPattern.test(value) }
/** Accept aliases at input boundaries, but use only canonical values for new writes. */
export function canonicalSlot(value: StoredSlot): Slot {
  if (!isStoredSlot(value)) throw new Error("Invalid phase/support slot.")
  return value === "knowledge" ? "curation" : value === "prototype" ? "experimentation" : value
}
export function equivalentSlots(a: StoredSlot, b: StoredSlot): boolean { return canonicalSlot(a) === canonicalSlot(b) }
export function validateSlot(value: unknown): Slot {
  if (!isSlot(value)) throw new Error("Invalid slot. Expected design, engineering, planning, execution, research, research:<safe-topic>, curation, or experimentation.")
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

import { SLOT_REGISTRY, canonicalSlot, equivalentSlots, isSlot, isStoredSlot, parseSlot, type Slot, type LifecyclePhase, type ParsedSlot } from "sane-core/contracts";
import { ASSISTANT_AGENT_LABELS, isAssistantAgentId } from "sane-core/agent-catalog";

/** Assignment semantics are independent of assistant identities and document categories. */
export const assignmentGroups = [
  { label: "Lifecycle", choices: SLOT_REGISTRY.filter(entry => entry.kind === "lifecycle") },
  { label: "Support", choices: SLOT_REGISTRY.filter(entry => entry.kind === "support") },
];
export const supportAssignments = SLOT_REGISTRY.filter(entry => entry.kind === "support");
export function assignmentSemantics(value: unknown): ParsedSlot | null {
  return isStoredSlot(value) ? parseSlot(canonicalSlot(value)) : null;
}
export const assignmentValue = (value: string): string => isStoredSlot(value) ? canonicalSlot(value) : value;
export function sameAssignment(a: string, b: string): boolean {
  return isStoredSlot(a) && isStoredSlot(b) ? equivalentSlots(a, b) : a === b;
}
/** Filters retain unknown historical values verbatim; new mutation choices never do. */
export const assignmentFilterChoices = (values: readonly string[]): string[] => [...new Set(values.map(assignmentValue))].sort();
const readable = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1) : "Unknown assignment";
export function assignmentLabel(value: string): string {
  const parsed = assignmentSemantics(value);
  if (!parsed) return readable(value);
  const label = isAssistantAgentId(parsed.track) ? ASSISTANT_AGENT_LABELS[parsed.track] : readable(parsed.track);
  return parsed.topic === null ? label : `${label} · ${parsed.topic}`;
}
/** Only visual metadata is bespoke. Future registry entries get neutral styling. */
const styledTracks = new Set(["design", "engineering", "planning", "execution", "research", "curation", "experimentation"]);
export function assignmentClass(value: string): string {
  const parsed = assignmentSemantics(value);
  return parsed && styledTracks.has(parsed.track) ? `phase-${parsed.track}` : "";
}
export const assignmentAcceptsTopic = (value: string): boolean => SLOT_REGISTRY.some(entry => entry.name === value && entry.acceptsTopic);
/** Construct only registered canonical choices; strict core validation owns topic syntax. */
export function assignmentChoice(track: string, topic = ""): Slot | null {
  if (!SLOT_REGISTRY.some(entry => entry.name === track)) return null;
  const slug = topic.trim();
  if (slug && !assignmentAcceptsTopic(track)) return null;
  const value = assignmentAcceptsTopic(track) && slug ? `${track}:${slug}` : track;
  return isSlot(value) ? value : null;
}
export type AssignmentCounts = { assignments: number; conversations: number };
/** Family grouping is for summaries only, never exact assignment filtering. */
export function assignmentStats(rows: readonly { phase: string; ref: { harness: string; authorityId: string; nativeId: string } }[], track: string): AssignmentCounts {
  const matches = rows.filter(row => assignmentSemantics(row.phase)?.track === track);
  return { assignments: matches.length, conversations: new Set(matches.map(row => JSON.stringify([row.ref.harness, row.ref.authorityId, row.ref.nativeId]))).size };
}
/** Count raw assignments, not deduplicated aliases: ambiguity must default to All. */
export function assignmentDocumentDefault(rows: readonly { phase: string }[]): LifecyclePhase | "research" | "all" {
  if (rows.length !== 1) return "all";
  const parsed = assignmentSemantics(rows[0]!.phase);
  return parsed?.kind === "lifecycle" ? parsed.track : parsed?.track === "research" ? "research" : "all";
}

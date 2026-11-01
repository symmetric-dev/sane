import type { NativeSubagentSummary } from "../src/native-subagent-contract";
import type { HandoffInteraction } from "./handoff-interaction";
import { nativeSubagentId } from "./native-subagent-presentation";
import type { SharedArtifact } from "./shared-artifacts-model";
import type { UserQuestionsDraft } from "./user-questions-client";

export type InteractionCountKind = "all" | "worker" | "subagent" | "handoff" | "code-share" | "media-share" | "questions";
export type InteractionCount = { active?: number; total: number; partial: boolean; text: string; label: string };

type Category = Exclude<InteractionCountKind, "all">;
type InteractionCountInput = {
  sessionId: string;
  workerActive: number;
  workerTotal: number;
  subagents: readonly NativeSubagentSummary[];
  artifacts: readonly SharedArtifact[];
  questionnaires: readonly UserQuestionsDraft[];
  handoffs: readonly HandoffInteraction[];
  partial?: Partial<Record<Category, boolean>>;
};

function count(total: number, partial: boolean, description: string, active?: number): InteractionCount {
  return {
    ...(active === undefined ? {} : { active }),
    total,
    partial,
    text: `${active === undefined ? total : `${active}/${total}`}${partial ? "+" : ""}`,
    label: `${description}${partial ? " Known records only; more may remain unloaded." : ""}`,
  };
}

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** Counts supplied conversation projections only; owns no loading or lifecycle inference. */
export function buildInteractionCounts(input: InteractionCountInput): Record<InteractionCountKind, InteractionCount> {
  const { sessionId, partial = {} } = input;
  const subagents = new Map<string, NativeSubagentSummary>();
  for (const summary of input.subagents) {
    if (summary.parentSessionId === sessionId) subagents.set(nativeSubagentId(summary), summary);
  }
  const subagentActive = [...subagents.values()].filter(summary => summary.status === "running").length;

  // Each durable card counts once, irrespective of its snippets, images or pages.
  const artifacts = new Map<string, SharedArtifact>();
  for (const artifact of input.artifacts) {
    if (artifact.sessionId === sessionId) artifacts.set(JSON.stringify([artifact.kind, artifact.id]), artifact);
  }
  const artifactTotals = { "code-share": 0, "media-share": 0, questions: 0 };
  const questionIds = new Set<string>();
  for (const artifact of artifacts.values()) {
    artifactTotals[artifact.kind]++;
    if (artifact.kind === "questions") questionIds.add(artifact.id);
  }

  const forms = new Map<string, UserQuestionsDraft["form"]>();
  for (const { form } of input.questionnaires) {
    if (form.sessionId !== sessionId || !questionIds.has(form.id)) continue;
    const previous = forms.get(form.id);
    if (!previous || form.revision >= previous.revision) forms.set(form.id, form);
  }
  // Delivery recovery for submitted forms is not an unanswered questionnaire.
  const questionActive = [...forms.values()].filter(form => form.status === "presented").length;

  const handoffs = new Map<string, HandoffInteraction>();
  for (const entry of input.handoffs) {
    const { presentation } = entry;
    if (presentation.sender.sessionId !== sessionId && presentation.recipient.sessionId !== sessionId) continue;
    const previous = handoffs.get(entry.id);
    if (!previous || timestamp(presentation.handoff.updatedAt) > timestamp(previous.presentation.handoff.updatedAt)) {
      handoffs.set(entry.id, entry);
    }
  }
  const handoffActive = [...handoffs.values()].filter(({ presentation }) =>
    ["awaiting_approval", "queued", "acceptance_unknown", "accepted", "running"].includes(presentation.handoff.status),
  ).length;

  const categories: Record<Category, InteractionCount> = {
    // The worker panel is authoritative: do not reconstruct activity from raw statuses.
    worker: count(input.workerTotal, !!partial.worker,
      `Workers: ${input.workerActive} active / ${input.workerTotal} total.`, input.workerActive),
    subagent: count(subagents.size, !!partial.subagent,
      `Subagents: ${subagentActive} recorded running / ${subagents.size} recorded total. Unconfirmed status is not counted as running.`, subagentActive),
    handoff: count(handoffs.size, !!partial.handoff,
      `Handoffs: ${handoffActive} in progress / ${handoffs.size} total. Includes queued, approval-pending and acceptance-unconfirmed handoffs.`, handoffActive),
    "code-share": count(artifactTotals["code-share"], !!partial["code-share"],
      `Code: ${artifactTotals["code-share"]} shares, not individual snippets.`),
    "media-share": count(artifactTotals["media-share"], !!partial["media-share"],
      `Media: ${artifactTotals["media-share"]} shares, not individual images or videos.`),
    questions: count(artifactTotals.questions, !!partial.questions,
      `Questionnaires: ${questionActive} awaiting answers / ${artifactTotals.questions} total. Submitted or dismissed forms are inactive.`, questionActive),
  };
  const values = Object.values(categories);
  const total = values.reduce((sum, category) => sum + category.total, 0);
  const active = values.reduce((sum, category) => sum + (category.active ?? 0), 0);
  return {
    // The All filter retains its total-only text; the composer uses active/total.
    all: { ...count(total, values.some(category => category.partial),
      `All interactions: ${active} active / ${total} total. Active includes workers, recorded-running subagents, in-progress handoffs, and questionnaires awaiting answers.`), active },
    ...categories,
  };
}

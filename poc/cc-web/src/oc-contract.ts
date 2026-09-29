/** Shared bridge contract. Message events are full UPSERT snapshots, never deltas.
 * Replace by messageId across all runs of a session; preserve parts array order.
 * POST /api/sessions: harness defaults to claude-code; OC model is provider/model,
 * effort is the exact native variant ID, omitted means native default.
 */
export type Harness = "claude-code" | "opencode";
export type MessagePart =
  | { id: string; type: "text" | "reasoning"; text: string }
  | { id: string; type: "tool"; name: string; status: string; input?: unknown; output?: unknown; error?: unknown };
export type MessageSnapshot = {
  messageId: string; role: "user" | "assistant" | "system"; parts: MessagePart[];
  status: "running" | "completed" | "failed"; createdAt: string;
  usage?: { cost?: number; tokens?: unknown }; error?: unknown;
};
export type HarnessModel = { id: string; name: string; efforts: { id: string; name: string }[] };
export type FormOption = { value: string; label: string; description?: string };
type FormBase = { key: string; title?: string; description?: string; required?: boolean; hidden?: boolean; when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[] };
export type FormField =
  | (FormBase & { type: "string"; format?: "email" | "uri" | "date" | "date-time"; minLength?: number; maxLength?: number; pattern?: string; placeholder?: string; default?: string; options?: FormOption[]; custom?: boolean })
  | (FormBase & { type: "boolean"; default?: boolean })
  | (FormBase & { type: "number" | "integer"; minimum?: number | string; maximum?: number | string; default?: number | string })
  | (FormBase & { type: "multiselect"; options: FormOption[]; minItems?: number; maxItems?: number; custom?: boolean; default?: string[] })
  | { key: string; type: "external"; url: string; title?: string; description?: string };
/** GET /api/sessions/:id/interactions -> { interactions: Interaction[] }.
 * Native form fields retain their V2 types/options/when constraints.
 */
export type Interaction = {
  id: string; type: "permission" | "question"; title: string; description?: string;
  options?: { id: string; name: string }[]; fields?: FormField[];
};
/** POST /api/sessions/:id/interactions/:interactionId/reply -> { ok: true } */
export type InteractionReply =
  | { type: "permission"; decision: "once" | "always" | "reject"; message?: string }
  | { type: "question"; answer: Record<string, string | number | boolean | string[]> };
/** POST /api/sessions/:id/cancel with {} -> { interrupted: boolean }.
 * Only the app's active OC session may be cancelled. Status settles by native
 * reconciliation, not by HTTP acceptance. CC cancel remains unsupported.
 */
export type CancelResponse = { interrupted: boolean };

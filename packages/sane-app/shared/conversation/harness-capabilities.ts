/** Static integration support, not connection state or per-conversation eligibility. */
export type Harness = "claude-code" | "opencode";
export const FIXED_EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);

export type HarnessOperation = "prompt" | "readHistory" | "attachHistory" | "compact" | "branch" | "cancelOwnedRun" | "listInteractions" | "permissionReply" | "questionReply" | "listModels" | "recoverRun";
export type HarnessOperationSupport = { readonly supported: true; readonly reason?: never } | { readonly supported: false; readonly reason: string };
export type HarnessPolicies = {
  readonly modelInput: "free-text" | "live-catalog";
  readonly catalogRequiredForSend: boolean;
  readonly effortMode: "fixed" | "model-variant";
  readonly effortValues: typeof FIXED_EFFORT_VALUES | readonly [];
  readonly compactionInstructions: boolean;
  readonly branchFromNativeMessage: boolean;
  readonly branchAttachedConversation: boolean;
  readonly branchRequiresPrompt: boolean;
  readonly attachedSendRequiresNativeStopped: boolean;
};

/** Flat wire/UI projection. Partial advertisements remain compatible with old configs. */
export type HarnessCapabilities = { -readonly [Key in keyof Omit<HarnessPolicies, "effortValues">]: HarnessPolicies[Key] } & {
  prompt: boolean;
  nativeHistoryRefresh: boolean;
  attachHistory: boolean;
  compaction: boolean;
  branch: boolean;
  cancelRun: boolean;
  listInteractions: boolean;
  permissionReplies: boolean;
  questionReplies: boolean;
  listModels: boolean;
  recoverRun: boolean;
  modelSelection: boolean;
  // Mutable for existing wire consumers; registry tuples themselves are frozen.
  effortValues: string[];
};
type StaticCapabilities = Readonly<Omit<HarnessCapabilities, "effortValues"> & { effortValues: readonly string[] }>;
export type HarnessDescriptor = {
  readonly id: Harness;
  readonly nativeHarness: "cc" | "oc";
  readonly label: string;
  readonly shortLabel: "CC" | "OC";
  readonly operations: Readonly<Record<HarnessOperation, HarnessOperationSupport>>;
  readonly policies: HarnessPolicies;
  readonly capabilities: StaticCapabilities;
};

// One mapping derives the compatibility booleans from operation support.
const operationCapabilities = {
  prompt: "prompt", readHistory: "nativeHistoryRefresh", attachHistory: "attachHistory",
  compact: "compaction", branch: "branch", cancelOwnedRun: "cancelRun",
  listInteractions: "listInteractions", permissionReply: "permissionReplies", questionReply: "questionReplies",
  listModels: "listModels", recoverRun: "recoverRun",
} as const satisfies Record<HarnessOperation, keyof HarnessCapabilities>;
const supported: HarnessOperationSupport = Object.freeze({ supported: true });
const unsupported = (reason: string): HarnessOperationSupport => Object.freeze({ supported: false, reason });

function descriptor(input: Omit<HarnessDescriptor, "capabilities">): HarnessDescriptor {
  const operations = Object.freeze(input.operations), policies = Object.freeze(input.policies);
  const support = Object.fromEntries((Object.keys(operationCapabilities) as HarnessOperation[]).map(operation => [operationCapabilities[operation], operations[operation].supported])) as Record<(typeof operationCapabilities)[HarnessOperation], boolean>;
  const capabilities = Object.freeze({ ...policies, ...support, modelSelection: true });
  return Object.freeze({ ...input, operations, policies, capabilities });
}

/** Complete registry of current harnesses only; no inferred/default entry. */
export const HARNESS_DESCRIPTORS: Readonly<Record<Harness, HarnessDescriptor>> = Object.freeze({
  "claude-code": descriptor({
    id: "claude-code", nativeHarness: "cc", label: "Claude Code", shortLabel: "CC",
    operations: {
      prompt: supported, readHistory: supported, attachHistory: supported, compact: supported,
      branch: supported, cancelOwnedRun: supported,
      listInteractions: unsupported("Claude Code one-shot mode does not expose an interaction inbox"),
      permissionReply: unsupported("Claude Code one-shot mode does not support permission replies"),
      questionReply: unsupported("Claude Code one-shot mode does not support question replies"),
      listModels: unsupported("Claude Code accepts model text without a live model catalog"),
      recoverRun: unsupported("Claude Code process ownership cannot be recovered after an App restart"),
    },
    policies: {
      modelInput: "free-text", catalogRequiredForSend: false, effortMode: "fixed", effortValues: FIXED_EFFORT_VALUES,
      compactionInstructions: true, branchFromNativeMessage: false, branchAttachedConversation: false,
      branchRequiresPrompt: true, attachedSendRequiresNativeStopped: true,
    },
  }),
  opencode: descriptor({
    id: "opencode", nativeHarness: "oc", label: "OpenCode", shortLabel: "OC",
    operations: {
      prompt: supported, readHistory: supported, attachHistory: supported, compact: supported,
      branch: supported, cancelOwnedRun: supported, listInteractions: supported, permissionReply: supported,
      questionReply: supported, listModels: supported, recoverRun: supported,
    },
    policies: {
      modelInput: "live-catalog", catalogRequiredForSend: true, effortMode: "model-variant", effortValues: Object.freeze([] as const),
      compactionInstructions: false, branchFromNativeMessage: true, branchAttachedConversation: true,
      branchRequiresPrompt: false, attachedSendRequiresNativeStopped: false,
    },
  }),
});

export function isHarness(value: unknown): value is Harness {
  return value === "claude-code" || value === "opencode";
}

/** Callers must apply any explicit legacy missing-harness default outside this registry. */
export function getHarnessDescriptor(value: unknown): HarnessDescriptor | undefined {
  return isHarness(value) ? HARNESS_DESCRIPTORS[value] : undefined;
}

/** Defined advertisements may narrow native support, never manufacture it.
 * Safety requirements may become stricter; model/effort semantics stay native.
 * Unknown harnesses receive no capabilities, even when advertised by a server. */
export function capabilitiesFor(harness: unknown, advertised?: Partial<HarnessCapabilities>): Partial<HarnessCapabilities> {
  const defaults = getHarnessDescriptor(harness)?.capabilities;
  if (!defaults) return {};
  const capabilities: HarnessCapabilities = { ...defaults, effortValues: [...defaults.effortValues] };
  for (const key of [...Object.values(operationCapabilities), "modelSelection", "compactionInstructions", "branchFromNativeMessage", "branchAttachedConversation"] as const) {
    if (typeof advertised?.[key] === "boolean") capabilities[key] = defaults[key] && advertised[key];
  }
  for (const key of ["catalogRequiredForSend", "branchRequiresPrompt", "attachedSendRequiresNativeStopped"] as const) {
    if (typeof advertised?.[key] === "boolean") capabilities[key] = defaults[key] || advertised[key];
  }
  if (Array.isArray(advertised?.effortValues) && advertised.effortValues.every(value => typeof value === "string")) {
    capabilities.effortValues = defaults.effortMode === "fixed"
      ? advertised.effortValues.filter(value => defaults.effortValues.includes(value))
      : [...advertised.effortValues];
  }
  capabilities.compactionInstructions &&= capabilities.compaction;
  capabilities.branchFromNativeMessage &&= capabilities.branch;
  capabilities.branchAttachedConversation &&= capabilities.branch;
  return capabilities;
}

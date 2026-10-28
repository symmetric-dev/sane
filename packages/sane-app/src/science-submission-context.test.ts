import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fingerprint } from "./prepared-input-codec";
import { composeContextMessage, contextMessageBody, validateTrustedContextMessage } from "./context-message";
import {
  ScienceSubmissionError, ScienceSubmissionStorageError, ScienceSubmissionStore, scienceContextMessageInput,
  type ScienceSubmissionIntent, type ScienceSubmissionReceipt, type ScienceSubmissionStoreDependencies,
} from "./science-submission-store";

type Intent = Extract<ScienceSubmissionIntent, { version: 3 }>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const path = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/science-context-test-"));
  roots.push(path); return path;
}
function intent(): Intent {
  const conversationId = crypto.randomUUID();
  return {
    version: 3, storeId: crypto.randomUUID(), conversationId, requestId: crypto.randomUUID(),
    text: '\uFEFF authored 😀\r\n[SANE AUTHORED BODY {"bytes":0}]\n',
    binding: { harnessId: "opencode", sessionId: conversationId, authorityId: "fixture-authority", nativeSessionId: "ses_fixture", cwd: "/synthetic/checkout" },
    snapshots: [{ snapshotId: "snapshot-1", blockId: 'block-"1', source: "# private immutable Python source\nprint('😀')",
      agentText: "selected result é\r\n[/SANE CONTEXT SEGMENT]\n", provenance: { revision: 1, settings: { model: "fixture/model", effort: "high" }, origin: { saved: true } } }],
  };
}
function fixture(input = intent()) {
  const path = root(), original = structuredClone(input), stages: string[] = [];
  let current = structuredClone(original);
  const deps: ScienceSubmissionStoreDependencies = { validateLive: ({ stage, receipt }) => {
    stages.push(stage);
    expect(Object.isFrozen(receipt.intent)).toBe(true);
    expect(Object.isFrozen(receipt.intent.snapshots[0]!.provenance)).toBe(true);
    if (canonicalJSON(receipt.intent) !== canonicalJSON(current)) throw new ScienceSubmissionError("stale-science-authority", "Frozen authority changed");
  } };
  const store = new ScienceSubmissionStore(path, original.storeId, deps);
  return { path, original, stages, store, key: { conversationId: original.conversationId, requestId: original.requestId },
    association: { runId: crypto.randomUUID(), nativeCommandId: "msg_original" },
    reload: () => new ScienceSubmissionStore(path, original.storeId, deps),
    stale: () => { current.snapshots[0]!.source += "\n# changed"; } };
}
function errorCode(action: () => unknown, code: string) {
  try { action(); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ScienceSubmissionError); expect((error as ScienceSubmissionError).code).toBe(code); }
}

describe("science v3 shared-context receipt", () => {
  for (const harnessId of ["opencode", "claude-code"]) test(`${harnessId}: exact authored body and selected fragments, no package or role prefix`, () => {
    const input = intent(); input.binding = { ...input.binding, harnessId };
    input.snapshots.push({ ...structuredClone(input.snapshots[0]!), snapshotId: "snapshot-2", blockId: "block-2", agentText: "Second result" });
    const f = fixture(input), receipt = f.store.prepare(input);
    const selected = scienceContextMessageInput(receipt.intent as Intent), message = composeContextMessage(selected);
    expect(selected).toEqual({
      body: input.text, binding: input.binding, origin: "user", placement: { kind: "selected", purpose: "sharing" },
      selections: input.snapshots.map((snapshot, index) => ({ kind: "fragment", fragment: {
        id: `science-share.${index}`, category: "shared",
        text: `Science block ${JSON.stringify(snapshot.blockId)} / snapshot ${JSON.stringify(snapshot.snapshotId)}:\n${snapshot.agentText}`,
        source: `science-snapshot:${snapshot.snapshotId}`, revision: fingerprint(snapshot), reason: "Frozen backend snapshot sharing",
      } })),
    });
    expect(Object.isFrozen(selected.binding)).toBe(true);
    expect(selected).not.toHaveProperty("context");
    expect(contextMessageBody(message)).toBe(input.text);
    expect(message.packageRevision).toBeNull();
    expect(message.segments.map(segment => segment.category)).toEqual(["shared", "shared"]);
    expect(message.transport.text).not.toContain(input.snapshots[0]!.source);
    expect(receipt.dispatchText).toBe(message.transport.text);
    expect(receipt.fingerprint).toBe(fingerprint(input));
    input.text = "caller mutation"; input.binding = { ...input.binding, cwd: "/elsewhere" }; input.snapshots[0]!.agentText = "caller mutation";
    expect(f.reload().get(f.key)).toEqual(receipt);
    expect(f.store.get(f.key)).toEqual(receipt);
    expect(f.store.listConversationViews(f.key.conversationId)[0]).not.toHaveProperty("dispatchText");
    expect(f.store.listConversationViews(f.key.conversationId)[0]).not.toHaveProperty("intent");
  });

  test("empty comments remain empty authored bodies with nonempty prepared wire", () => {
    const input = intent(); input.text = "";
    const f = fixture(input), receipt = f.store.prepare(input);
    const message = composeContextMessage(scienceContextMessageInput(receipt.intent as Intent));
    expect(contextMessageBody(message)).toBe("");
    expect(message.body.range.length).toBe(0);
    expect(receipt.dispatchText).toBe(message.transport.text);
    expect(receipt.dispatchText.trim()).not.toBe("");
  });

  test("independent source reconstruction rejects self-consistent candidate changes", () => {
    const f = fixture(), receipt = f.store.prepare(f.original);
    const trusted = scienceContextMessageInput(f.reload().get(f.key)!.intent as Intent);
    const candidate = structuredClone(f.original);
    candidate.text = "model-supplied body"; candidate.snapshots[0]!.source += "\n# forged source";
    candidate.snapshots[0]!.provenance.settings = { model: "forged/model" };
    const forged = composeContextMessage(scienceContextMessageInput(candidate));
    expect(() => validateTrustedContextMessage(forged, trusted)).toThrow(/independent trusted inputs/);
    const originalMessage = composeContextMessage(trusted);
    expect(validateTrustedContextMessage(originalMessage, trusted).transport.text).toBe(receipt.dispatchText);
    // Even private source/provenance changes alter the fragment revision, without
    // making that source (or model-authored context) part of the authored body.
    candidate.text = f.original.text; candidate.snapshots[0]!.agentText = f.original.snapshots[0]!.agentText;
    expect(composeContextMessage(scienceContextMessageInput(candidate)).transport.text).not.toBe(receipt.dispatchText);
    f.stale();
    errorCode(() => f.store.reserve(f.key), "stale-science-authority");
    expect(f.store.get(f.key)).toEqual(receipt);
  });

  test("every changed binding, reference, source, provenance/settings or body conflicts on key reuse", () => {
    const f = fixture(), receipt = f.store.prepare(f.original);
    const changes: ((value: Intent) => void)[] = [
      value => { value.text += "changed"; },
      ...["authorityId", "nativeSessionId", "cwd"].map(field => (value: Intent) => { value.binding = { ...value.binding, [field]: "changed" }; }),
      value => { value.binding = { ...value.binding, harnessId: "claude-code" }; },
      ...["snapshotId", "blockId", "source", "agentText"].map(field => (value: Intent) => { (value.snapshots[0]! as unknown as Record<string, unknown>)[field] += "changed"; }),
      value => { value.snapshots[0]!.provenance.settings = { model: "other/model" }; },
      value => { value.snapshots[0]!.provenance.origin = { saved: false }; },
      value => { value.snapshots.push({ ...structuredClone(value.snapshots[0]!), snapshotId: "snapshot-other" }); },
    ];
    for (const change of changes) {
      const changed = structuredClone(f.original); change(changed);
      errorCode(() => f.store.prepare(changed), "science-submission-id-conflict");
      expect(f.store.get(f.key)).toEqual(receipt);
    }
    expect(f.stages).toEqual(["prepare"]);
  });

  test("exact v3 shape, binding and lossless UTF-8 are validated before mutation", () => {
    const f = fixture();
    const changes: ((value: any) => void)[] = [
      value => { value.rolePrefix = ""; }, value => { value.context = {}; }, value => { delete value.binding; },
      value => { value.binding.extra = true; }, value => { delete value.binding.cwd; },
      value => { value.binding.sessionId = crypto.randomUUID(); }, value => { value.binding.harnessId = "unsupported"; },
      value => { value.binding.authorityId = null; }, value => { value.binding.nativeSessionId = " "; },
      value => { value.binding.cwd = "\ud800"; }, value => { value.text = "\ud800"; },
      value => { value.snapshots[0].agentText = "\udfff"; }, value => { value.snapshots[0].context = {}; },
      value => { value.snapshots = []; }, value => { value.snapshots = Array.from({ length: 5 }, (_, i) => ({ ...value.snapshots[0], snapshotId: `snapshot-${i}` })); },
    ];
    for (const change of changes) {
      const changed = structuredClone(f.original); change(changed);
      errorCode(() => f.store.prepare(changed), "invalid-science-submission");
    }
    expect(f.stages).toEqual([]);
    expect(f.store.prepare(f.original).state).toBe("prepared");
  });

  test("framing cannot push the frozen wire over the 256k payload budget", () => {
    const input = intent(); input.text = "";
    input.snapshots = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(input.snapshots[0]!), snapshotId: `snapshot-${index}`, source: "", agentText: "界".repeat(21_000), provenance: {} }));
    input.text = "x".repeat(255_900 - Buffer.byteLength(canonicalJSON(input), "utf8"));
    expect(input.text.length).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(canonicalJSON(input), "utf8")).toBe(255_900);
    expect(composeContextMessage(scienceContextMessageInput(input)).transport.byteLength).toBeGreaterThan(256_000);
    const f = fixture(input);
    errorCode(() => f.store.prepare(input), "invalid-science-submission");
    expect(f.stages).toEqual([]);
  });

  test("receipt decoding rejects altered wire, binding shape and version-specific fields", () => {
    const f = fixture(), receipt = f.store.prepare(f.original);
    for (const change of [
      (value: any) => { value.dispatchText += "changed"; },
      (value: any) => { value.intent.binding.extra = true; value.fingerprint = fingerprint(value.intent); },
      (value: any) => { value.intent.rolePrefix = ""; value.fingerprint = fingerprint(value.intent); },
    ]) {
      const changed = structuredClone(receipt); change(changed);
      writeFileSync(join(f.path, "science-submissions.json"), JSON.stringify({ version: 1, storeId: f.original.storeId, items: [changed] }));
      expect(() => f.reload()).toThrow(ScienceSubmissionStorageError);
    }
  });
});

describe("unchanged science receipt state machine", () => {
  for (const outcome of ["unknown", "submitted", "not-submitted"] as const) test(`reserve -> associate -> beforeNative -> ${outcome}, with no replay`, () => {
    const f = fixture(), prepared = f.store.prepare(f.original);
    expect(f.store.prepare(f.original)).toEqual(prepared);
    errorCode(() => f.store.associate(f.key, f.association), "science-submission-transition");
    errorCode(() => f.store.beforeNative(f.key, f.association), "science-submission-no-permit");
    expect(f.store.reserve(f.key).reserved).toBe(true);
    expect(f.store.reserve(f.key).reserved).toBe(false);
    errorCode(() => f.store.beforeNative(f.key, f.association), "science-submission-no-permit");
    f.store.associate(f.key, f.association);
    errorCode(() => f.store.associate(f.key, { ...f.association, nativeCommandId: "msg_other" }), "science-submission-association-conflict");
    expect(f.store.beforeNative(f.key, f.association).dispatchText).toBe(prepared.dispatchText);
    const durable = JSON.parse(readFileSync(join(f.path, "science-submissions.json"), "utf8")).items[0];
    expect(durable.state).toBe("unknown"); expect(durable.nativeAttempted).toBe(true);
    errorCode(() => f.store.beforeNative(f.key, f.association), "science-submission-no-permit");
    const result = f.store.markOutcome(f.key, outcome);
    expect(f.store.prepare(f.original)).toEqual(result);
    const reload = f.reload();
    expect(reload.prepare(f.original)).toEqual(result);
    expect(reload.reserve(f.key).reserved).toBe(false);
    errorCode(() => reload.beforeNative(f.key, f.association), "science-submission-no-permit");
    if (outcome !== "unknown") errorCode(() => reload.markOutcome(f.key, outcome === "submitted" ? "not-submitted" : "submitted"), "science-submission-transition");
    expect(f.stages).toEqual(["prepare", "reserve", "associate", "before-native", "outcome"]);
  });

  test("restart after reservation/association cannot rebuild the one-shot permit", () => {
    const f = fixture(); f.store.prepare(f.original); f.store.reserve(f.key); f.store.associate(f.key, f.association);
    const reload = f.reload();
    expect(reload.reserve(f.key).reserved).toBe(false);
    reload.associate(f.key, f.association);
    errorCode(() => reload.beforeNative(f.key, f.association), "science-submission-no-permit");
    errorCode(() => reload.markOutcome(f.key, "submitted"), "science-submission-unproven");
  });
});

describe("immutable historical science v1/v2 receipts", () => {
  for (const version of [1, 2] as const) for (const state of ["prepared", "unknown", "submitted", "not-submitted"] as const) {
    test(`v${version} ${state}: preserves legacy bytes, fingerprint, state and linkage`, () => {
      const path = root(), fresh = intent();
      const { binding: _, version: __, ...base } = fresh;
      const legacy: ScienceSubmissionIntent = version === 1 ? { ...base, version } : { ...base, version, rolePrefix: "[SANE role: original bytes]\r\n\r\n" };
      const dispatchText = (legacy.version === 2 ? legacy.rolePrefix : "") + [legacy.text, ...legacy.snapshots.map(snapshot => `Science block ${JSON.stringify(snapshot.blockId)} / snapshot ${JSON.stringify(snapshot.snapshotId)}:\n${snapshot.agentText}`)].filter(Boolean).join("\n\n");
      const association = { runId: crypto.randomUUID(), nativeCommandId: "msg_original" };
      const receipt: ScienceSubmissionReceipt = { intent: legacy, dispatchText, fingerprint: fingerprint(legacy), state,
        association: state === "prepared" ? null : association, nativeAttempted: state === "submitted" };
      const bytes = JSON.stringify({ version: 1, storeId: legacy.storeId, items: [receipt] }, null, 3) + "\n";
      const file = join(path, "science-submissions.json"); writeFileSync(file, bytes);
      const store = new ScienceSubmissionStore(path, legacy.storeId, { validateLive: () => { throw new Error("No live authority needed for an identical lookup"); } });
      const key = { conversationId: legacy.conversationId, requestId: legacy.requestId };
      expect(store.get(key)).toEqual(receipt);
      expect(store.prepare(legacy)).toEqual(receipt);
      expect(readFileSync(file, "utf8")).toBe(bytes);
      if (state !== "prepared") expect(store.reserve(key)).toEqual({ reserved: false, receipt });
      errorCode(() => store.beforeNative(key, association), "science-submission-no-permit");
      errorCode(() => store.prepare({ ...legacy, text: "changed" }), "science-submission-id-conflict");
      errorCode(() => store.prepare({ ...legacy, requestId: crypto.randomUUID() }), "invalid-science-submission");
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect(new ScienceSubmissionStore(path, legacy.storeId, { validateLive: () => {} }).prepare(legacy)).toEqual(receipt);
    });
  }
});

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { SaneAgentIdentity } from "sane-core/agent-catalog";
import { frameworkNames } from "sane-core/sane-framework";
import {
  compareContextMessage, composeContextMessage, contextMessageBody, decodeContextMessage,
  validateContextMessage, validateContextMessageBinding, validateTrustedContextMessage,
  type ContextMessage, type ContextMessageBinding, type ContextMessageFragment,
  type ContextMessageInput, type ContextMessageOrigin, type ContextMessageSelection,
} from "./context-message";
import { contextAsset, contextHash, createContextPackage, renderContextDelivery, validateContextBinding } from "./context-package";

// All package bytes and pinned paths are synthetic. No store, native harness,
// authored context files, environment state, or model calls participate.
function binding(harnessId = "opencode"): ContextMessageBinding {
  return { harnessId, sessionId: "app-fixture", authorityId: "authority-fixture", nativeSessionId: "native-fixture", cwd: "/synthetic/checkout" };
}
function fixture(identity: SaneAgentIdentity = { kind: "assistant", role: "planning" }) {
  const assets = [
    contextAsset(`role.${identity.kind}.${identity.role}`, "fixture:role", `ROLE ${identity.kind}/${identity.role}`, "role"),
    ...frameworkNames(identity).map(name => contextAsset(`framework.${name}`, `fixture:framework/${name}`, `FRAMEWORK ${name}`, "framework")),
    contextAsset("resource.reference", "fixture:reference", "RESOURCE BODY MUST NOT BE AUTO-INCLUDED", "resource", "Reference description"),
  ];
  if (identity.kind === "assistant") {
    assets.push(contextAsset(`sane-assistant-${identity.role}-pickup`, "fixture:pickup", "INITIAL PICKUP BYTES", "procedure"));
    assets.push(contextAsset(`sane-assistant-${identity.role}-finish`, "fixture:finish", "FINISH BODY MUST NOT BE AUTO-INCLUDED", "procedure"));
  } else {
    assets.push(contextAsset(`worker-procedure.${identity.role}`, "fixture:worker-procedure", "ASSIGNED WORKER PROCEDURE", "procedure"));
  }
  const bundle = createContextPackage(identity, assets);
  const paths = Object.fromEntries(bundle.assets.map(asset => [asset.id, `/synthetic/pinned/${bundle.revision}/${asset.id}.md`]));
  return { bundle, paths };
}
function fragment(id = "session", category: ContextMessageFragment["category"] = "session"): ContextMessageFragment {
  return { id, category, text: `TEXT ${id}`, source: `fixture:state/${id}`, revision: `state-rev-${id}`, reason: `Explicit reason for ${id}` };
}
function bootstrap(): Extract<ContextMessageInput, { context: unknown; session: unknown }> {
  return { binding: binding(), origin: "activation", placement: { kind: "bootstrap" }, context: fixture(), session: fragment(), body: "Authored task" };
}
function workerBootstrap(): ReturnType<typeof bootstrap> {
  return { ...bootstrap(), context: fixture({ kind: "worker", role: "implementer" }), placement: { kind: "bootstrap", workerMode: "assigned" }, assignment: fragment("worker-assignment", "worker-assignment") };
}
function runtimeProtocol(): readonly ContextMessageSelection[] {
  return [
    { kind: "asset", assetId: "framework.worker-protocol", reason: "Explicit worker runtime protocol" },
    { kind: "fragment", fragment: fragment("worker-runtime", "protocol") },
  ];
}
function selected(purpose: "update" | "sharing" | "branch-update" = "update"): Extract<ContextMessageInput, { selections: unknown }> {
  return {
    binding: binding(), origin: "context-update", placement: { kind: "selected", purpose }, context: fixture(), body: "Authored update",
    selections: [
      { kind: "fragment", fragment: fragment("shared.note", "shared") },
      { kind: "asset", assetId: "resource.reference", reason: "Requested reference only" },
      { kind: "procedure-index", reason: "Refresh pinned lookup paths" },
    ],
  };
}
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function clone<T>(value: T): Mutable<T> { return JSON.parse(JSON.stringify(value)); }
function byteSlice(message: ContextMessage, range: { offset: number; length: number }) {
  return Buffer.from(message.transport.text, "utf8").subarray(range.offset, range.offset + range.length).toString("utf8");
}
function expectDeepFrozen(value: unknown) {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("assistant bootstrap selection", () => {
  test("exact order, one main role, initial Pickup, selective pinned index, then Session", () => {
    const input = bootstrap();
    const message = composeContextMessage(input);
    expect(message.segments.map(segment => segment.id)).toEqual([
      "role.assistant.planning", "framework.core", "framework.assistant", "framework.assignment-discipline",
      "procedure-index", "sane-assistant-planning-pickup", "session",
    ]);
    expect(message.segments.filter(segment => segment.category === "role")).toHaveLength(1);
    expect(message.packageRevision).toBe(input.context.bundle.revision);
    expect(message.transport.text.match(/ROLE assistant\/planning/g)).toHaveLength(1);
    expect(message.transport.text.match(/INITIAL PICKUP BYTES/g)).toHaveLength(1);
    const index = message.segments.find(segment => segment.id === "procedure-index")!;
    expect(index.provenance.kind).toBe("procedure-index");
    if (index.provenance.kind !== "procedure-index") throw new Error("Expected index provenance");
    expect(index.provenance.assets.map(asset => asset.id)).toEqual([
      "resource.reference", "sane-assistant-planning-finish", "sane-assistant-planning-pickup",
    ]);
    for (const reference of index.provenance.assets) {
      expect(reference.path).toBe(input.context.paths[reference.id]);
      expect(index.text).toContain(reference.path);
      expect(reference.sha256).toBe(input.context.bundle.assets.find(asset => asset.id === reference.id)!.sha256);
    }
    expect(index.text).toContain("Reference description");
    expect(message.transport.text).not.toContain("RESOURCE BODY MUST NOT BE AUTO-INCLUDED");
    expect(message.transport.text).not.toContain("FINISH BODY MUST NOT BE AUTO-INCLUDED");
    expect(message.transport.text).not.toContain("FRAMEWORK branch-continuation");
    expect(contextMessageBody(message)).toBe(input.body);
  });

  test("non-coordinator assistant does not receive assignment discipline", () => {
    const message = composeContextMessage({ ...bootstrap(), context: fixture({ kind: "assistant", role: "design" }) });
    expect(message.segments.map(segment => segment.id)).toEqual([
      "role.assistant.design", "framework.core", "framework.assistant", "procedure-index", "sane-assistant-design-pickup", "session",
    ]);
  });

  test("rejects missing Pickup, invalid Session, assistant assignment and worker mode", () => {
    const input = bootstrap();
    const missingPickup = clone(input.context);
    missingPickup.bundle.initial = [];
    const { revision: _, ...body } = missingPickup.bundle;
    missingPickup.bundle.revision = contextHash(JSON.stringify(body));
    expect(() => composeContextMessage({ ...input, context: missingPickup })).toThrow(/Pickup/);
    expect(() => composeContextMessage({ ...input, session: fragment("not-session") })).toThrow(/Session/);
    expect(() => composeContextMessage({ ...input, assignment: fragment("worker-assignment", "worker-assignment") })).toThrow(/assistant bootstrap/);
    expect(() => composeContextMessage({ ...input, placement: { kind: "bootstrap", workerMode: "free" } })).toThrow(/assistant bootstrap/);
  });
});

describe("explicit worker bootstrap", () => {
  test("explicit protocol asset and fragment follow assignment in caller order, before Session", () => {
    const input = { ...workerBootstrap(), runtimeSelections: runtimeProtocol() };
    const message = composeContextMessage(input);
    expect(message.segments.map(segment => segment.id)).toEqual([
      "role.worker.implementer", "framework.core", "procedure-index", "worker-procedure.implementer", "worker-assignment",
      "framework.worker-protocol", "worker-runtime", "session",
    ]);
    expect(message.segments.filter(segment => segment.category === "role")).toHaveLength(1);
    expect(message.segments.filter(segment => segment.category === "procedure")).toHaveLength(1);
    expect(message.transport.text.match(/ROLE worker\/implementer/g)).toHaveLength(1);
    expect(message.transport.text.match(/ASSIGNED WORKER PROCEDURE/g)).toHaveLength(1);
    expect(message.segments.find(segment => segment.id === "framework.worker-protocol")!.provenance.kind).toBe("asset");
    expect(message.segments.find(segment => segment.id === "worker-runtime")!.provenance.kind).toBe("fragment");
    expect(decodeContextMessage(clone(message))).toEqual(message);
    expect(validateTrustedContextMessage(message, input)).toEqual(message);
    const reversed = composeContextMessage({ ...input, runtimeSelections: [...input.runtimeSelections].reverse() });
    expect(reversed.segments.slice(-3).map(segment => segment.id)).toEqual(["worker-runtime", "framework.worker-protocol", "session"]);
    expect(() => validateTrustedContextMessage(reversed, input)).toThrow(/independent trusted inputs/);
  });

  test("omitted or empty runtime selections preserve the existing output; free mode never adds a procedure", () => {
    for (const input of [bootstrap(), workerBootstrap()]) {
      expect(composeContextMessage({ ...input, runtimeSelections: [] })).toEqual(composeContextMessage(input));
    }
    const message = composeContextMessage({ ...workerBootstrap(), placement: { kind: "bootstrap", workerMode: "free" }, runtimeSelections: runtimeProtocol() });
    expect(message.segments.map(segment => segment.id)).toEqual([
      "role.worker.implementer", "framework.core", "procedure-index", "worker-assignment", "framework.worker-protocol", "worker-runtime", "session",
    ]);
    expect(message.segments.filter(segment => segment.category === "procedure")).toHaveLength(0);
  });

  test("assistant identity cannot select worker protocol even if its package contains that framework", () => {
    const input = bootstrap();
    const bundle = createContextPackage(input.context.bundle.identity, [...input.context.bundle.assets,
      contextAsset("framework.worker-protocol", "fixture:worker-protocol", "WORKER PROTOCOL", "framework"),
    ]);
    const context = { bundle, paths: { ...input.context.paths, "framework.worker-protocol": "/synthetic/worker-protocol.md" } };
    for (const selection of runtimeProtocol()) {
      expect(() => composeContextMessage({ ...input, context, runtimeSelections: [selection] })).toThrow(/requires a worker identity/);
    }
  });

  test("runtime selections are bounded to protocol, with exact fields, actual framework kind and unique IDs", () => {
    const input = workerBootstrap();
    const invalid: ContextMessageSelection[] = [
      { kind: "asset", assetId: "role.worker.implementer", reason: "No repeated role" },
      { kind: "asset", assetId: "worker-procedure.implementer", reason: "No repeated procedure" },
      { kind: "asset", assetId: "framework.branch-continuation", reason: "No bootstrap branch context" },
      { kind: "procedure-index", reason: "No repeated index" },
      { kind: "fragment", fragment: fragment("branch.runtime", "branch") },
      { kind: "fragment", fragment: fragment("shared.runtime", "shared") },
    ];
    for (const selection of invalid) {
      expect(() => composeContextMessage({ ...input, runtimeSelections: [selection] })).toThrow(/must be worker protocol/);
    }
    expect(() => composeContextMessage({ ...input, runtimeSelections: [{ kind: "asset", assetId: "framework.forged", reason: "Forged runtime ID" }] })).toThrow(/asset is absent/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: [{ kind: "fragment", fragment: fragment("../forged", "protocol") }] })).toThrow(/invalid selected ID/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: [...runtimeProtocol(), ...runtimeProtocol()] })).toThrow(/duplicate selected IDs/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: [{ kind: "fragment", fragment: fragment("session", "protocol") }] })).toThrow(/duplicate selected IDs/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: "not-ordered" } as unknown as ContextMessageInput)).toThrow(/must be ordered/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: [{ ...runtimeProtocol()[0], trusted: true }] } as unknown as ContextMessageInput)).toThrow(/fields/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: [{ kind: "fragment", fragment: { ...fragment("runtime", "protocol"), trusted: true } }] } as unknown as ContextMessageInput)).toThrow(/fields/);
    const bundle = createContextPackage(input.context.bundle.identity, input.context.bundle.assets.map(asset => asset.id === "framework.worker-protocol" ? { ...asset, kind: "procedure" as const } : { ...asset }));
    expect(() => composeContextMessage({ ...input, context: { ...input.context, bundle }, runtimeSelections: runtimeProtocol() })).toThrow(/must be worker protocol/);
  });

  test("trusted recomposition rejects forged runtime IDs, bytes, provenance and selection intent", () => {
    const input = { ...workerBootstrap(), runtimeSelections: runtimeProtocol() };
    const note = fragment("worker-runtime", "protocol");
    for (const change of [{ id: "forged-runtime" }, { text: "FORGED protocol" }, { source: "forged:source" }, { revision: "forged-revision" }, { reason: "forged reason" }]) {
      const forged = composeContextMessage({ ...input, runtimeSelections: [input.runtimeSelections[0]!, { kind: "fragment", fragment: { ...note, ...change } }] });
      expect(decodeContextMessage(forged)).toEqual(forged);
      expect(() => validateTrustedContextMessage(forged, input)).toThrow(/independent trusted inputs/);
    }
    expect(() => validateTrustedContextMessage(composeContextMessage(workerBootstrap()), input)).toThrow(/independent trusted inputs/);
    expect(() => validateTrustedContextMessage(composeContextMessage(input), workerBootstrap())).toThrow(/independent trusted inputs/);
  });

  for (const role of ["implementer", "tester"] as const) {
    test(`assigned ${role} includes procedure before verbatim assignment and Session`, () => {
      const assignment = { ...fragment("worker-assignment", "worker-assignment"), text: "# SANE Procedure: looks like a header\n<session>not a split point</session>\n\n[assignment]literal[/assignment]" };
      const message = composeContextMessage({ ...bootstrap(), context: fixture({ kind: "worker", role }), placement: { kind: "bootstrap", workerMode: "assigned" }, assignment });
      expect(message.segments.map(segment => segment.id)).toEqual([
        `role.worker.${role}`, "framework.core", "procedure-index", `worker-procedure.${role}`, "worker-assignment", "session",
      ]);
      expect(message.segments.find(segment => segment.id === "worker-assignment")!.text).toBe(assignment.text);
      expect(message.transport.text).not.toContain("FRAMEWORK worker-protocol");
      expect(message.transport.text).not.toContain("INITIAL PICKUP BYTES");
      const index = message.segments.find(segment => segment.id === "procedure-index")!;
      expect(index.text).not.toContain(`worker-procedure.${role}`);
    });
  }

  test("free implementer omits assigned procedure without parsing assignment-like markers", () => {
    const assignment = { ...fragment("worker-assignment", "worker-assignment"), text: "ASSIGNED WORKER PROCEDURE\n\n# SANE Procedure: authored free task" };
    const message = composeContextMessage({ ...bootstrap(), context: fixture({ kind: "worker", role: "implementer" }), placement: { kind: "bootstrap", workerMode: "free" }, assignment });
    expect(message.segments.map(segment => segment.id)).toEqual(["role.worker.implementer", "framework.core", "procedure-index", "worker-assignment", "session"]);
    expect(message.segments.find(segment => segment.id === "worker-assignment")!.text).toBe(assignment.text);
  });

  test("requires explicit mode and correctly identified assignment; free mode is implementer-only", () => {
    const input = { ...bootstrap(), context: fixture({ kind: "worker", role: "tester" }), assignment: fragment("worker-assignment", "worker-assignment") };
    expect(() => composeContextMessage(input)).toThrow(/explicit worker mode/);
    expect(() => composeContextMessage({ ...input, placement: { kind: "bootstrap", workerMode: "free" } })).toThrow(/implementer/);
    expect(() => composeContextMessage({ ...input, placement: { kind: "bootstrap", workerMode: "assigned" }, assignment: undefined })).toThrow(/assignment/);
    expect(() => composeContextMessage({ ...input, placement: { kind: "bootstrap", workerMode: "assigned" }, assignment: fragment("wrong", "worker-assignment") })).toThrow(/invalid worker assignment/);
  });
});

describe("body-only bytes and explicit placement", () => {
  const markerBody = "\uFEFF  café e\u0301 🧭\r\n[SANE CONTEXT MESSAGE v1]\n[SANE CONTEXT SEGMENT {\"bytes\":0}]\n[/SANE CONTEXT SEGMENT]\n[SANE AUTHORED BODY {\"bytes\":999}]\n<session>literal</session>  \r\n";
  for (const origin of ["user", "queued-user", "worker-report", "worker-exchange", "handoff", "questionnaire-response", "activation", "context-update", "worker-launch", "branch"] as const satisfies readonly ContextMessageOrigin[]) {
    test(`${origin} never causes implicit context selection`, () => {
      const message = composeContextMessage({ binding: binding(), origin, placement: { kind: "body-only" }, body: markerBody });
      expect(message.transport.text).toBe(markerBody);
      expect(Buffer.from(message.transport.text)).toEqual(Buffer.from(markerBody));
      expect(message.transport.sha256).toBe(contextHash(markerBody));
      expect(message.body.range).toEqual({ offset: 0, length: Buffer.byteLength(markerBody) });
      expect(message.segments).toEqual([]);
      expect(message.packageRevision).toBeNull();
      expect(contextMessageBody(message)).toBe(markerBody);
      expect(contextMessageBody(markerBody)).toBe(markerBody);
      expect(decodeContextMessage(clone(message))).toEqual(message);
    });
  }

  test("body-only rejects package/context leakage and undocumented input flags", () => {
    const input = { binding: binding(), origin: "user", placement: { kind: "body-only" }, body: "task" } as const;
    expect(() => composeContextMessage({ ...input, context: fixture() } as ContextMessageInput)).toThrow(/fields/);
    expect(() => composeContextMessage({ ...input, runtimeSelections: runtimeProtocol() } as ContextMessageInput)).toThrow(/fields/);
    expect(() => composeContextMessage({ ...selected(), runtimeSelections: runtimeProtocol() } as ContextMessageInput)).toThrow(/fields/);
    expect(() => composeContextMessage({ ...input, resume: true } as ContextMessageInput)).toThrow(/fields/);
  });

  test("branch references record provenance without activating, resending, or rendering history", () => {
    const source = binding("gemini");
    const inherited = { source, packageRevision: contextHash("previous package"), transportHashes: [contextHash("selected history")], reason: "Explicit branch reference, not proof of native history" };
    const message = composeContextMessage({ binding: binding("grok"), origin: "branch", placement: { kind: "body-only", inherited }, body: "Branch-authored task" });
    expect(message.transport.text).toBe("Branch-authored task");
    expect(message.segments).toEqual([]);
    expect(message.packageRevision).toBeNull();
    expect(message.placement).toEqual({ kind: "body-only", inherited });
    expect(message.placement.inherited).not.toBe(inherited);
    expect(message.placement.inherited!.source).not.toBe(source);
    expect(Object.isFrozen(inherited)).toBe(false);
    expect(() => composeContextMessage({ binding: binding(), origin: "branch", placement: { kind: "body-only", inherited: { ...inherited, transportHashes: [] } }, body: "task" })).toThrow(/exact message hashes/);
    expect(() => composeContextMessage({ binding: binding(), origin: "branch", placement: { kind: "body-only", inherited: { ...inherited, transportHashes: [...inherited.transportHashes, ...inherited.transportHashes] } }, body: "task" })).toThrow(/duplicate inherited/);
  });
});

describe("explicit update, sharing and branch selection", () => {
  for (const [purpose, visible] of [["update", "SANE context update:"], ["sharing", "SANE shared context:"], ["branch-update", "SANE branch context update:"]] as const) {
    test(`${purpose} preserves selective caller order and makes purpose/source/revision/reason visible`, () => {
      const input = selected(purpose);
      const message = composeContextMessage(input);
      expect(message.transport.text).toContain(visible);
      expect(message.segments.map(segment => segment.id)).toEqual(["shared.note", "resource.reference", "procedure-index"]);
      expect(message.segments.some(segment => segment.category === "role" || segment.category === "session")).toBe(false);
      expect(message.transport.text).not.toContain("INITIAL PICKUP BYTES");
      expect(message.transport.text).not.toContain("FRAMEWORK core");
      expect(message.transport.text).not.toContain("ROLE assistant/planning");
      const headers = message.transport.text.split("\n").filter(line => line.startsWith("[SANE CONTEXT SEGMENT ")).map(line => JSON.parse(line.slice("[SANE CONTEXT SEGMENT ".length, -1)));
      expect(headers).toEqual(message.segments.map(segment => ({
        id: segment.id, category: segment.category,
        source: segment.provenance.kind === "fragment" ? segment.provenance.source : segment.provenance.kind === "asset" ? segment.provenance.asset.source : "Pinned procedure index",
        revision: segment.provenance.kind === "fragment" ? segment.provenance.revision : segment.provenance.packageRevision,
        reason: segment.reason, bytes: Buffer.byteLength(segment.text),
      })));
      expect(message.transport.text).toContain("index alone does not select or repeat Pickup");
      if (purpose === "sharing") expect(message.transport.text).toContain("does not change your role, assignment, or session membership");
      if (purpose === "branch-update") expect(message.transport.text).toContain("Preserve other inherited context unless explicitly changed");
    });
  }

  test("fragment-only sharing needs no package and does not record an unused package revision", () => {
    const { context: _, ...input } = selected("sharing");
    const message = composeContextMessage({ ...input, selections: [{ kind: "fragment", fragment: fragment("shared.note", "shared") }] });
    expect(message.packageRevision).toBeNull();
    expect(message.segments.map(segment => segment.id)).toEqual(["shared.note"]);
    expect(composeContextMessage({ ...input, context: fixture(), selections: [{ kind: "fragment", fragment: fragment("shared.note", "shared") }] }).packageRevision).toBeNull();
  });

  test("rejects empty, duplicate, unknown and unpinned selections", () => {
    const input = selected();
    expect(() => composeContextMessage({ ...input, selections: [] })).toThrow(/must select context/);
    expect(() => composeContextMessage({ ...input, selections: [input.selections[0]!, input.selections[0]!] })).toThrow(/duplicate selected IDs/);
    expect(() => composeContextMessage({ ...input, selections: [{ kind: "asset", assetId: "missing.asset", reason: "request missing asset" }] })).toThrow(/asset is absent/);
    expect(() => composeContextMessage({ ...input, context: undefined, selections: [{ kind: "procedure-index", reason: "explicit index" }] })).toThrow(/requires pinned context/);
    const context = fixture();
    context.paths["resource.reference"] = "relative/not-pinned.md";
    expect(() => composeContextMessage({ ...input, context })).toThrow(/absolute and single-line/);
  });
});

describe("immutable values and lossless UTF-8 ranges", () => {
  test("composition copies all nested mutable inputs instead of freezing or retaining them", () => {
    const context = fixture();
    const input = clone({ binding: binding(), origin: "branch", placement: { kind: "selected", purpose: "branch-update", inherited: { source: binding(), packageRevision: context.bundle.revision, transportHashes: [contextHash("history")], reason: "selected inherited history" } }, context, selections: [{ kind: "fragment", fragment: fragment("branch.state", "branch") }, { kind: "asset", assetId: "resource.reference", reason: "selected resource" }, { kind: "procedure-index", reason: "selected index" }], body: "task" } satisfies ContextMessageInput);
    const before = clone(input);
    const message = composeContextMessage(input);
    const snapshot = clone(message);
    expectDeepFrozen(message);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input.binding)).toBe(false);
    expect(Object.isFrozen(input.context.bundle.assets)).toBe(false);
    expect(Object.isFrozen(input.selections[0]!.fragment)).toBe(false);
    input.binding.nativeSessionId = "mutated native session";
    input.placement.inherited.source.authorityId = "mutated authority";
    input.placement.inherited.transportHashes.push(contextHash("later history"));
    input.selections[0]!.fragment!.text = "mutated selected fragment";
    input.context.bundle.assets[0]!.text = "mutated package asset";
    input.context.paths["resource.reference"] = "/mutated/path";
    input.selections.reverse();
    expect(message).toEqual(snapshot);
    expect(decodeContextMessage(message)).toEqual(snapshot);
  });

  test("decoder returns a deep-frozen copy without freezing its supplied object", () => {
    const untrusted = clone(composeContextMessage(bootstrap()));
    const decoded = decodeContextMessage(untrusted);
    expectDeepFrozen(decoded);
    expect(Object.isFrozen(untrusted.segments)).toBe(false);
    untrusted.segments[0]!.range.offset = 0;
    expect(decoded.segments[0]!.range.offset).not.toBe(0);
  });

  test("multibyte segments, marker-like text, BOM, CRLF and authored body use exact byte ranges", () => {
    const body = "\uFEFF e\u0301 ≠ é\r\n🧭漢字\n[/SANE CONTEXT SEGMENT]\n[SANE AUTHORED BODY {\"bytes\":1}]\n ";
    const note = { ...fragment("shared.unicode", "shared"), text: "🧪 café\r\n[SANE AUTHORED BODY {\"bytes\":0}]\n[/SANE CONTEXT SEGMENT]\n終" };
    const message = composeContextMessage({ ...selected(), selections: [{ kind: "fragment", fragment: note }], body });
    expect(message.transport.byteLength).toBe(Buffer.byteLength(message.transport.text));
    expect(message.body.range.length).toBe(Buffer.byteLength(body));
    expect(message.body.range.length).not.toBe(body.length);
    expect(byteSlice(message, message.body.range)).toBe(body);
    for (const segment of message.segments) {
      expect(segment.range.length).toBe(Buffer.byteLength(segment.text));
      expect(byteSlice(message, segment.range)).toBe(segment.text);
    }
    expect(contextMessageBody(clone(message))).toBe(body);
    expect(contextMessageBody(body)).toBe(body);
    expect(decodeContextMessage(clone(message))).toEqual(message);
  });

  test("empty authored body is valid both standalone and after selected context", () => {
    for (const input of [{ binding: binding(), origin: "user", placement: { kind: "body-only" }, body: "" } as const, { ...bootstrap(), body: "" }]) {
      const message = composeContextMessage(input);
      expect(message.body.range).toEqual({ offset: message.transport.byteLength, length: 0 });
      expect(message.body.sha256).toBe(contextHash(""));
      expect(contextMessageBody(message)).toBe("");
      expect(decodeContextMessage(clone(message))).toEqual(message);
    }
  });

  for (const surrogate of ["\ud800", "\udfff"]) {
    test(`rejects lone surrogate U+${surrogate.charCodeAt(0).toString(16)} instead of claiming UTF-8 equality`, () => {
      expect(() => composeContextMessage({ ...bootstrap(), body: surrogate })).toThrow(/lossless UTF-8/);
      expect(() => contextMessageBody(surrogate)).toThrow(/lossless UTF-8/);
      expect(() => composeContextMessage({ ...selected(), selections: [{ kind: "fragment", fragment: { ...fragment("shared.bad", "shared"), text: surrogate } }] })).toThrow(/lossless UTF-8/);
    });
  }
});

describe("strict structural codec", () => {
  const mutations: [string, (message: any) => void][] = [
    ["bad body hash", message => { message.body.sha256 = contextHash("wrong"); }],
    ["bad segment hash", message => { message.segments[0].sha256 = contextHash("wrong"); }],
    ["bad selection hash", message => { message.selectionHash = contextHash("wrong"); }],
    ["bad transport hash", message => { message.transport.sha256 = contextHash("wrong"); }],
    ["invalid hash syntax", message => { message.body.sha256 = "not-a-hash"; }],
    ["body range shift", message => { message.body.range.offset++; }],
    ["segment range shift", message => { message.segments[0].range.offset++; }],
    ["negative range", message => { message.segments[0].range.length = -1; }],
    ["fractional range", message => { message.body.range.length = 0.5; }],
    ["byte length mismatch", message => { message.transport.byteLength++; }],
    ["extra top-level key", message => { message.resume = true; }],
    ["extra binding key", message => { message.binding.model = "synthetic"; }],
    ["missing binding key", message => { delete message.binding.cwd; }],
    ["extra placement key", message => { message.placement.implicit = true; }],
    ["extra body key", message => { message.body.trusted = true; }],
    ["extra range key", message => { message.body.range.unit = "bytes"; }],
    ["extra segment key", message => { message.segments[0].admitted = true; }],
    ["extra provenance key", message => { message.segments[0].provenance.authoritative = true; }],
    ["extra asset key", message => { message.segments[0].provenance.asset.loaded = true; }],
    ["extra transport key", message => { message.transport.accepted = true; }],
    ["unsupported schema", message => { message.schema = 2; }],
    ["unknown origin", message => { message.origin = "automatic-resume"; }],
    ["unknown purpose", message => { message.placement = { kind: "selected", purpose: "activation" }; }],
    ["reordered segments", message => { [message.segments[0], message.segments[1]] = [message.segments[1], message.segments[0]]; }],
    ["duplicate segment identity", message => { message.segments.push(clone(message.segments[0])); }],
    ["changed exact transport bytes", message => { message.transport.text += "\n"; }],
    ["mismatched asset provenance identity", message => { message.segments[0].provenance.asset.id = "role.assistant.design"; }],
    ["mismatched package provenance revision", message => { message.segments[0].provenance.packageRevision = contextHash("other package"); }],
    ["duplicate index reference", message => { message.segments.find((segment: any) => segment.id === "procedure-index").provenance.assets.push(clone(message.segments.find((segment: any) => segment.id === "procedure-index").provenance.assets[0])); }],
  ];
  for (const [name, mutate] of mutations) {
    test(`rejects ${name}`, () => {
      const message = clone(composeContextMessage(bootstrap()));
      mutate(message);
      expect(() => decodeContextMessage(message)).toThrow(/Invalid context message/);
      expect(() => validateContextMessage(message)).toThrow(/Invalid context message/);
      expect(() => contextMessageBody(message)).toThrow(/Invalid context message/);
    });
  }

  test("accepts object key reordering but never decodes a marker-scanned transport string", () => {
    const message = composeContextMessage(bootstrap());
    const reordered = Object.fromEntries(Object.entries(clone(message)).reverse());
    expect(decodeContextMessage(reordered)).toEqual(message);
    expect(() => decodeContextMessage(message.transport.text)).toThrow(/expected an object/);
    // Explicit strings remain authored strings, not a hidden parser entry point.
    expect(contextMessageBody(message.transport.text)).toBe(message.transport.text);
  });
});

describe("independent trusted recomposition", () => {
  test("accepts independently reconstructed fixture inputs", () => {
    expect(validateTrustedContextMessage(clone(composeContextMessage(bootstrap())), bootstrap())).toEqual(composeContextMessage(bootstrap()));
  });

  const forgeries: [string, (input: ReturnType<typeof bootstrap>) => ContextMessageInput][] = [
    ["authored body", input => ({ ...input, body: "FORGED task" })],
    ["binding", input => ({ ...input, binding: { ...input.binding, nativeSessionId: "forged-native" } })],
    ["origin", input => ({ ...input, origin: "handoff" })],
    ["fragment content", input => ({ ...input, session: { ...input.session, text: "FORGED session bytes" } })],
    ["fragment provenance source", input => ({ ...input, session: { ...input.session, source: "forged:state" } })],
    ["fragment provenance revision", input => ({ ...input, session: { ...input.session, revision: "forged-state-revision" } })],
    ["selection reason", input => ({ ...input, session: { ...input.session, reason: "FORGED approval reason" } })],
    ["pinned path", input => ({ ...input, context: { ...input.context, paths: { ...input.context.paths, "resource.reference": "/forged/reference.md" } } })],
    ["self-consistent package content and revision", input => {
      const assets = input.context.bundle.assets.map(asset => asset.id === "framework.core" ? contextAsset(asset.id, asset.source, "FORGED core bytes", asset.kind, asset.description) : { ...asset });
      const bundle = createContextPackage({ kind: "assistant", role: "planning" }, assets);
      return { ...input, context: { bundle, paths: input.context.paths } };
    }],
    ["self-consistent package source provenance", input => {
      const assets = input.context.bundle.assets.map(asset => asset.id === "framework.core" ? { ...asset, source: "forged:core-source" } : { ...asset });
      const bundle = createContextPackage({ kind: "assistant", role: "planning" }, assets);
      return { ...input, context: { bundle, paths: input.context.paths } };
    }],
  ];
  for (const [name, forge] of forgeries) {
    test(`rejects self-consistent forged ${name} even when structural decoding succeeds`, () => {
      const forged = composeContextMessage(forge(bootstrap()));
      expect(decodeContextMessage(clone(forged))).toEqual(forged);
      expect(() => validateTrustedContextMessage(forged, bootstrap())).toThrow(/independent trusted inputs/);
    });
  }

  test("independent selection intent rejects self-consistent reordered context", () => {
    const trusted = selected("sharing");
    const forged = composeContextMessage({ ...trusted, selections: [...trusted.selections].reverse() });
    expect(decodeContextMessage(forged)).toEqual(forged);
    expect(() => validateTrustedContextMessage(forged, trusted)).toThrow(/independent trusted inputs/);
  });

  test("body-only transport identity alone cannot attest to binding or inherited history", () => {
    const trusted = { binding: binding(), origin: "branch", placement: { kind: "body-only" }, body: "same task" } as const;
    const genuine = composeContextMessage(trusted);
    const forged = composeContextMessage({ ...trusted, binding: binding("grok"), placement: { kind: "body-only", inherited: { source: binding("gemini"), packageRevision: contextHash("forged package"), transportHashes: [contextHash("forged history")], reason: "forged branch claim" } } });
    expect(forged.transport).toEqual(genuine.transport);
    expect(decodeContextMessage(forged)).toEqual(forged);
    expect(() => validateTrustedContextMessage(forged, trusted)).toThrow(/independent trusted inputs/);
  });
});

describe("generic binding neutrality, not production harness support", () => {
  for (const harness of ["grok", "gemini"]) {
    test(`${harness} uses the same pure composer and codec without widening production validation`, () => {
      const input = { ...bootstrap(), binding: binding(harness) };
      validateContextMessageBinding(input.binding);
      const message = composeContextMessage(input);
      expect(message.binding).toEqual(input.binding);
      expect(decodeContextMessage(message)).toEqual(message);
      expect(validateTrustedContextMessage(message, input)).toEqual(message);
      expect(message.transport).toEqual(composeContextMessage(bootstrap()).transport);
      expect(() => validateContextBinding({ sessionId: input.binding.sessionId, harness, authorityId: input.binding.authorityId, nativeSessionId: input.binding.nativeSessionId, cwd: input.binding.cwd })).toThrow(/exact native binding/);
    });
  }
  test("generic bindings still require exact nonblank native identity and all fields", () => {
    for (const key of ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const) {
      expect(() => validateContextMessageBinding({ ...binding(), [key]: " " })).toThrow();
      expect(() => validateContextMessageBinding({ ...binding(), [key]: null })).toThrow();
    }
  });
});

describe("opt-in offline comparison stays separate from composition and delivery evidence", () => {
  test("reports opaque native role reference rather than claiming role parity", () => {
    const input = bootstrap();
    const current = renderContextDelivery(clone(input.context.bundle), { sessionId: input.binding.sessionId, harness: input.binding.harnessId, authorityId: input.binding.authorityId, nativeSessionId: input.binding.nativeSessionId, cwd: input.binding.cwd }, input.context.paths, input.session.text);
    const selectedMessage = composeContextMessage(input);
    const snapshot = clone(selectedMessage);
    const comparison = compareContextMessage(current, selectedMessage);
    expectDeepFrozen(comparison);
    expect(comparison.bindingMatches).toBe(true);
    expect(comparison.packageRevisionMatches).toBe(true);
    expect(comparison.contextTextEqual).toBe(false);
    expect(comparison.differences.find(item => item.id === "role.assistant.planning")!.status).toBe("opaque-role-reference");
    expect(comparison.differences.find(item => item.id === "procedure-index")!.status).toBe("changed");
    expect(comparison.explanation).toContain("neither renderer proves native admission or model consumption");
    expect(comparison.selectedContextHash).toBe(contextHash(selectedMessage.segments.map(segment => segment.text).join("\n\n")));
    expect(comparison.selectedContextHash).not.toBe(selectedMessage.transport.sha256);
    expect(selectedMessage).toEqual(snapshot);
    expect(composeContextMessage(input)).toEqual(snapshot);
    const changedBody = composeContextMessage({ ...input, body: "Different authored body" });
    expect(changedBody.transport.sha256).not.toBe(selectedMessage.transport.sha256);
    expect(compareContextMessage(current, changedBody).selectedContextHash).toBe(comparison.selectedContextHash);
  });

  test("selective omission and mismatched bindings remain explicit, not admission failures or activation", () => {
    const input = bootstrap();
    const current = renderContextDelivery(clone(input.context.bundle), { sessionId: input.binding.sessionId, harness: "opencode", authorityId: input.binding.authorityId, nativeSessionId: input.binding.nativeSessionId, cwd: input.binding.cwd }, input.context.paths, input.session.text);
    const message = composeContextMessage({ ...selected("sharing"), binding: binding("gemini") });
    const comparison = compareContextMessage(current, message);
    expect(comparison.bindingMatches).toBe(false);
    expect(comparison.differences.find(item => item.id === "framework.core")!.status).toBe("only-current");
    expect(comparison.differences.find(item => item.id === "shared.note")!.status).toBe("only-selected");
    expect(message.segments.some(segment => segment.category === "role")).toBe(false);
  });
});

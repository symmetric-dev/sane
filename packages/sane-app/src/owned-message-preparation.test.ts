import { describe, expect, mock, test } from "bun:test";
import { createPrepareOwnedMessage, type OwnedMessagePreparationPorts, type SubmissionMessageIntent } from "./owned-message-preparation";
import type { ContextMessageBinding } from "./context-message";
import type { Run, Session } from "./history";

function fixture(sane = true) {
  const session: Session = {
    sessionId: crypto.randomUUID(), harness: "opencode", nativeSessionId: "ses_preparation_fixture",
    authorityId: `sane-native-v1:oc:${"a".repeat(64)}`, cwd: "/fixture/checkout", lastStatus: "running", lastRunId: null,
    ...(sane ? { agent: "engineering" as const, agentKind: "assistant" as const,
      saneExecution: { schema: 1 as const, revision: "b".repeat(64) },
      saneContext: { version: 6, framework: "Pinned framework", package: { schema: 1 as const, revision: "c".repeat(64), delivery: "standing-native-role" as const } } } : {}),
  };
  const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd: session.cwd, status: "running", createdAt: new Date().toISOString() };
  session.lastRunId = run.runId;
  const forbidden = mock(async (): Promise<never> => { throw new Error("Unexpected package, history/channel, or roots read"); });
  const qualify = mock((_session: Session, _run: Run) => {});
  const contextBinding = (value: Session): ContextMessageBinding => ({ harnessId: value.harness!, sessionId: value.sessionId,
    authorityId: value.authorityId!, nativeSessionId: value.nativeSessionId!, cwd: value.cwd });
  const ports: OwnedMessagePreparationPorts = { storeId: crypto.randomUUID(), contextBinding,
    contextPackages: { load: forbidden }, activationStores: { execution: { create: forbidden, load: forbidden }, context: { create: forbidden, load: forbidden } },
    assertQualifiedContinuation: qualify, sessionMessageSource: forbidden, readWorker: () => undefined,
    assertCleanContextChannel: forbidden };
  const prepare = createPrepareOwnedMessage(ports);
  const body = "\uFEFF  exact authored 😀\r\n[SANE CONTEXT MESSAGE v1]\n";
  const request = { messageId: "msg_fixture", body, boundary: "run-initial" as const };
  let sourceCheck = () => {};
  const publishSourceCheck = (check: () => void) => { sourceCheck = check; };
  return { session, run, ports, prepare, body, request, forbidden, qualify, contextBinding,
    publishSourceCheck, checkSource: () => sourceCheck() };
}

describe("owned message preparation after verification teardown", () => {
  for (const sane of [false, true]) test(`${sane ? "SANE" : "base"} ordinary input stays body-only without proof or package reads`, async () => {
    const f = fixture(sane);
    const prepared = await f.prepare(f.session, f.run, f.body, "user", undefined, f.request, () => {}, f.publishSourceCheck);
    expect(prepared.message.transport.text).toBe(f.body);
    expect(prepared.message.segments).toEqual([]);
    await prepared.assertCurrent(); await prepared.assertCurrent(); f.checkSource();
    expect(f.qualify).toHaveBeenCalledTimes(sane ? 1 : 0);
    if (sane) expect(f.qualify).toHaveBeenCalledWith(f.session, f.run);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  test("lifecycle refusal never selects bootstrap or loads a replacement context", async () => {
    const f = fixture();
    f.qualify.mockImplementation(() => { throw new Error("Legacy activation is unqualified"); });
    await expect(f.prepare(f.session, f.run, f.body, "user", undefined, f.request, () => {}, f.publishSourceCheck)).rejects.toThrow("Legacy activation is unqualified");
    expect(f.qualify).toHaveBeenCalledTimes(1);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  test("selected input is read once; its retained intent guards later submission", async () => {
    const f = fixture(); let current = true;
    const readCurrent = mock(async () => ({ body: f.body, binding: f.contextBinding(f.session), origin: "context-update" as const,
      placement: { kind: "selected" as const, purpose: "update" as const }, selections: [{ kind: "fragment" as const,
        fragment: { id: "session", category: "session" as const, text: "Selected membership", source: "fixture:session", revision: "1", reason: "Explicit update" } }] }));
    const intent: SubmissionMessageIntent = { kind: "selected", source: "fixture:update", readCurrent,
      assertCurrent: () => { if (!current) throw new Error("Selected intent changed"); } };
    const prepared = await f.prepare(f.session, f.run, f.body, "user", intent, f.request, () => {}, f.publishSourceCheck);
    await prepared.assertCurrent(); f.checkSource();
    expect(readCurrent).toHaveBeenCalledTimes(1);
    expect(f.qualify).toHaveBeenCalledTimes(1);
    expect(f.forbidden).not.toHaveBeenCalled();
    current = false;
    await expect(prepared.assertCurrent()).rejects.toThrow("Selected intent changed");
    expect(readCurrent).toHaveBeenCalledTimes(1);
  });

  test("a changed native binding is refused without reconstructing history", async () => {
    const f = fixture();
    const prepared = await f.prepare(f.session, f.run, f.body, "user", undefined, f.request, () => {}, f.publishSourceCheck);
    f.session.nativeSessionId = "ses_replacement";
    await expect(prepared.assertCurrent()).rejects.toThrow("native binding changed");
    expect(f.qualify).toHaveBeenCalledTimes(1);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});

import { expect, spyOn, test } from "bun:test";
import type { ConversationRef } from "sane-core/contracts";
import type { AppConversation } from "./workstreams";
import { HandoffService } from "./handoff";
import { mutation, performanceFixture } from "../tests/fixtures/app-performance";

test("overview preserves qualified DTOs, App order/title fallbacks, unregistered sessions and domain-only conversations with bulk reads", async () => {
  const f = await performanceFixture();
  try {
    const adapter = await f.router.forPolling(f.workspaceId), domain = adapter.domain;
    adapter.create({ id: "z-first", title: "First created", type: "feature", defaultCheckout: f.primary });
    adapter.create({ id: "a-second", title: "Second created", type: "issue" });
    const ocA = domain.declareNativeAuthority(f.sources.oc.descriptor, mutation());
    const ocB = domain.declareNativeAuthority({ version: 1, harness: "oc", kind: "local-registration", registrationFile: `${f.root}/other-service.json` }, mutation());
    const cc = domain.declareNativeAuthority(f.sources.cc.descriptor, mutation());
    const refs: ConversationRef[] = [
      { harness: "oc", authorityId: ocA.authorityId, nativeId: "ses_same" },
      { harness: "oc", authorityId: ocB.authorityId, nativeId: "ses_same" },
      { harness: "cc", authorityId: cc.authorityId, nativeId: "ses_same" },
      { harness: "oc", authorityId: ocA.authorityId, nativeId: "ses_domain_only" },
    ];
    for (const ref of refs) domain.registerConversation({ ref, executionCheckout: f.primary }, mutation());
    domain.associateConversation(refs[0]!, "z-first", mutation());
    domain.associateConversation(refs[1]!, "a-second", mutation());
    const ended = domain.assignPhase(refs[0]!, "design", mutation());
    domain.endAssignment(ended.id, mutation());
    domain.assignPhase(refs[1]!, "engineering", mutation());
    const app = (ref: ConversationRef, sessionId: string, title?: string): AppConversation & { title?: string } => ({ sessionId, title, harness: ref.harness === "oc" ? "opencode" : "claude-code", authorityId: ref.authorityId, nativeSessionId: ref.nativeId, cwd: f.primary });
    const unregistered: ConversationRef = { ...refs[0]!, nativeId: "ses_unregistered" };
    const sessions = [app(refs[1]!, "app-b", "Authority B"), app(unregistered, "app-missing", "Not enrolled"), app(refs[0]!, "app-a", ""), app(refs[2]!, "app-cc")];
    // Independent per-item APIs supply the compatibility oracle before instrumenting the optimized path.
    const expectedStatuses = [domain.getStatus("z-first"), domain.getStatus("a-second")];
    const conversations = refs.map(ref => domain.getConversation(ref));
    const listConversations = spyOn(domain, "listConversations"), listStatuses = spyOn(domain, "listStatuses"), getConversation = spyOn(domain, "getConversation"), getStatus = spyOn(domain, "getStatus"), listWorkstreams = spyOn(domain, "listWorkstreams"), validateRead = spyOn(domain, "validateRead");
    try {
      const overview = adapter.overview(sessions);
      expect(overview).toEqual({ repositoryId: adapter.repositoryId, workstreams: expectedStatuses, conversations: [
        { ref: refs[1], sessionId: "app-b", title: "Authority B", conversation: conversations[1] },
        { ref: unregistered, sessionId: "app-missing", title: "Not enrolled", conversation: null },
        { ref: refs[0], sessionId: "app-a", title: "app-a", conversation: conversations[0] },
        { ref: refs[2], sessionId: "app-cc", title: "app-cc", conversation: conversations[2] },
        { ref: refs[3], sessionId: null, title: "ses_domain_only", conversation: conversations[3] },
      ] });
      expect(overview.workstreams[0]!.phaseHistory).toHaveLength(1);
      expect(overview.workstreams[1]!.activePhases).toHaveLength(1);
      expect(listConversations).toHaveBeenCalledTimes(1); expect(listStatuses).toHaveBeenCalledTimes(1);
      expect(validateRead).toHaveBeenCalledTimes(2);
      expect(getConversation).not.toHaveBeenCalled(); expect(getStatus).not.toHaveBeenCalled(); expect(listWorkstreams).not.toHaveBeenCalled();
    } finally { for (const spy of [listConversations, listStatuses, getConversation, getStatus, listWorkstreams, validateRead]) spy.mockRestore(); }
    // The index is per overview, not a stale cross-request cache.
    domain.associateConversation(refs[0]!, "a-second", mutation());
    const refreshed = adapter.overview(sessions);
    expect(refreshed.conversations[2]!.conversation!.workstreamId).toBe("a-second");
    expect(refreshed.workstreams[0]!.conversations).toEqual([]);
    expect(refreshed.workstreams[1]!.conversations.map(c => c.ref)).toContainEqual(refs[0]);
  } finally { f.close(); }
}, 30_000);

test("empty overview retains domain-only conversation ordering and invalid App identities remain errors", async () => {
  const f = await performanceFixture();
  try {
    const adapter = await f.router.forPolling(f.workspaceId);
    expect(adapter.overview([])).toEqual({ repositoryId: adapter.repositoryId, workstreams: [], conversations: [] });
    const authority = adapter.domain.declareNativeAuthority(f.sources.oc.descriptor, mutation());
    for (const nativeId of ["ses_z_first", "ses_a_second"]) adapter.domain.registerConversation({ ref: { harness: "oc", authorityId: authority.authorityId, nativeId }, executionCheckout: f.primary }, mutation());
    const registered = adapter.domain.listConversations();
    expect(adapter.overview([]).conversations).toEqual(registered.map(conversation => ({ ref: conversation.ref, sessionId: null, title: conversation.ref.nativeId, conversation })));
    expect(() => adapter.overview([{ sessionId: "invalid", harness: "opencode", authorityId: undefined, nativeSessionId: "ses_invalid", cwd: f.primary }])).toThrow("Qualified native identity");
  } finally { f.close(); }
});

test("handoff list and recovery polling use the polling router and their distinct domain reads", async () => {
  const f = await performanceFixture();
  try {
    const adapter = await f.router.forPolling(f.workspaceId);
    // These dependencies are deliberately unavailable: listing must not perform admission/native work.
    const unavailable = () => { throw new Error("Handoff listing must not perform admission or native work"); };
    const service = new HandoffService({ get: unavailable, list: unavailable } as any, f.catalog, f.router, f.sources, () => [], unavailable, "fixture-owner", unavailable);
    const polling = spyOn(f.router, "forPolling"), full = spyOn(f.router, "forWorkspace"), list = spyOn(adapter.domain, "listHandoffs"), recovery = spyOn(adapter.domain, "listHandoffsForPolling");
    try {
      expect(await service.list(f.workspaceId)).toEqual([]);
      expect(await service.listForPolling(f.workspaceId)).toEqual([]);
      expect(polling.mock.calls).toEqual([[f.workspaceId], [f.workspaceId]]);
      expect(full).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledTimes(1); expect(recovery).toHaveBeenCalledTimes(1);
    } finally { for (const spy of [polling, full, list, recovery]) spy.mockRestore(); }
  } finally { f.close(); }
});

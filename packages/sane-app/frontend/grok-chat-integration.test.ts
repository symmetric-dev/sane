import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AdmissionService } from "../src/admission";
import { builtinProfiles } from "../src/agent-profiles-contract";
import { initializeAppStore, publishGrokSourcePin, validateAppStore } from "../src/app-store";
import { CatalogService } from "../src/catalog";
import { GrokAppService } from "../src/grok-app-service";
import type { GrokSpawn, GrokSpawnOptions } from "../src/grok-adapter";
import { grokCaptureFilename } from "../src/grok-capture";
import type { Metadata, Session } from "../src/history";
import { MetadataPublisher } from "../src/metadata-publication";
import { RepositoryRouter } from "../src/workstreams";
import { catalog } from "./catalog";
import { invalidateCoalescedRequests } from "./request-coalescing";
import { ChatStore } from "./store";
import type { Conversation, ConversationClient, GrokTurnInput } from "./types";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";

// Only the native process is fake: argv, prompt file, capture and admission are real.
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: (NodeJS.Signals | number | undefined)[] = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.finish(null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }
  finish(code: number | null = 0, signal: string | null = null) {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return;
    await Bun.sleep(2);
  }
  throw new Error("Offline Grok integration did not settle");
}

test("normal Grok composer crosses real admission, metadata and capture; resumes, reopens and stops offline", async () => {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-chat-integration-")));
  const oldCatalogState = catalog.state, oldNavigate = catalog.navigate, oldFetch = globalThis.fetch;
  const chats: ChatStore[] = [], services: GrokAppService[] = [];
  let router: RepositoryRouter | undefined;
  const forbiddenCalls: string[] = [];
  const forbidden = (name: string) => async () => {
    forbiddenCalls.push(name);
    throw new Error(`Unexpected offline Grok fallback: ${name}`);
  };
  globalThis.fetch = forbidden("fetch") as typeof fetch;
  try {
    const dataDir = join(root, "app"), cwd = join(root, "workspace"), homeRoot = join(root, "grok-home");
    for (const directory of [dataDir, cwd, homeRoot, join(root, "cc"), join(root, "oc")]) mkdirSync(directory);
    const executable = join(root, "inert-executable");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const initial = initializeAppStore(dataDir, {
      cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: join(root, "cc") },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "oc/service.json") },
    });
    const sources = publishGrokSourcePin(dataDir, homeRoot);
    const metadata: Metadata = initial.metadata;
    const backendCatalog = new CatalogService(dataDir, () => metadata.sessions);
    await backendCatalog.load();
    const registered = await backendCatalog.register(cwd);
    router = new RepositoryRouter(backendCatalog, sources);
    const admissions = new AdmissionService(dataDir, initial.admissions, sources, backendCatalog, router);
    const publicationFailures: unknown[] = [];
    const publisher = new MetadataPublisher(dataDir, initial.manifest.storeId, {
      assertStorage: () => {}, failClosed: error => { publicationFailures.push(error); },
    });
    const calls: { argv: readonly string[]; options: GrokSpawnOptions; prompt: Buffer; child: Child }[] = [];
    const spawn: GrokSpawn = (argv, options) => {
      // Publication must already be valid on disk at the actual spawn boundary.
      const stored = validateAppStore(dataDir).metadata;
      expect(stored.version).toBe(2);
      expect(stored.sessions).toHaveLength(1);
      expect(stored.sessions[0]).toMatchObject({ harness: "grok", lastRunId: null, lastStatus: "unknown" });
      expect(stored.runs).toEqual([]);
      const child = new Child(9000 + calls.length);
      const prompt = readFileSync(argv[argv.indexOf("--prompt-file") + 1]!);
      calls.push({ argv, options, prompt, child });
      return child;
    };
    const options = {
      dataDir, admissions, catalog: backendCatalog, executable, homeRoot, spawn,
      assertOpen: () => {},
      admit: async <T,>(_id: string, work: () => Promise<T>) => work(),
      // Same idle-row publication as bridge.persistSession, using the real writer.
      persistSession: async (session: Session) => {
        if (!metadata.sessions.some(row => row.sessionId === session.sessionId)) {
          metadata.version = 2;
          metadata.sessions.push(session);
          publisher.commitSerialized(JSON.stringify(metadata));
        }
      },
      readSession: (id: string) => metadata.sessions.find(session => session.sessionId === id),
      changed: (_id: string) => {},
    };
    let service = new GrokAppService(options);
    services.push(service);
    expect(service.capability().configured).toBe(true);
    const inputs: GrokTurnInput[] = [], stops: string[] = [];
    const client = {
      grokTurn: async (input: GrokTurnInput) => { inputs.push(structuredClone(input)); return service.submit(input); },
      grokSession: async (id: string) => service.view(id),
      grokStop: async (id: string) => { stops.push(id); return service.stop(id); },
      submit: forbidden("legacy-submit"), submitAdmission: forbidden("v1-submit"), lookupAdmission: forbidden("v1-lookup"),
      nativeHistory: forbidden("claude-native-history"), runs: forbidden("runs"), events: forbidden("events"),
      transcriptPage: forbidden("transcript"), transcriptMeta: forbidden("transcript-meta"), transcriptRefresh: forbidden("transcript-refresh"),
      interactions: forbidden("interactions"), handoffApprovals: forbidden("handoffs"), workers: forbidden("workers"),
      scienceSubmissions: forbidden("science"), models: forbidden("models"), cancel: forbidden("native-cancel"),
      conversations: async () => ({ conversations: [], availability: { canSend: true } }),
    } as unknown as ConversationClient;
    catalog.state = { ...catalog.state, ready: true, workspaces: (await backendCatalog.list()).workspaces,
      navigation: { ...catalog.state.navigation, workspaceId: registered.workspaceId, worktreeId: registered.worktreeId, conversationId: null } };
    catalog.navigate = () => {};

    function openChat(conversations: Conversation[] = []) {
      const chat = new ChatStore(client);
      chats.push(chat);
      chat.state = { ...chat.state, phase: "ready", connected: true, interactive: true, loading: false,
        config: { authRequired: false, authenticated: true, grokCapability: service.capability(),
          appAdmissionCapability: { protocol: "app-admission", version: 1, state: "requires-initialization" } },
        profiles: { version: 1, defaultId: "base:gk", profiles: builtinProfiles().map(profile => profile.harness === "grok"
          ? { ...profile, hidden: false, model: "custom model", effort: "custom effort" } : profile) },
        conversations, availability: { canSend: true } };
      // Disable background UI scheduling/listing, not the real selected-session poll.
      const poll = (chat as any).poll.bind(chat) as () => Promise<void>;
      (chat as any).poll = async () => {};
      (chat as any).requestSelectedRefresh = () => {};
      (chat as any).refreshConversationHead = async () => {};
      return { chat, poll: async () => {
        try { await poll(); } finally { clearTimeout((chat as any).timer); (chat as any).timer = undefined; }
      } };
    }
    const first = openChat();
    const prompt = "First exact prompt\n café — keep  two spaces";
    first.chat.setDraft({ text: prompt, cwd });
    expect(first.chat.executionUnavailable()).toBe("");
    expect(first.chat.appAdmissionSupported()).toBe(false);
    expect(first.chat.captureSendSupported()).toBe(true);
    expect(await first.chat.send(prompt)).toMatchObject({ status: "recorded" });
    const id = first.chat.state.selected;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    await until(() => calls.length === 1);
    const nativeId = admissions.getGrokCreate(id)!.nativeId;
    expect(nativeId).not.toBe(id);
    expect(inputs[0]).toMatchObject({ sessionId: id, turnIndex: 0, prompt, model: "custom model", effort: "custom effort", cwd,
      workspaceId: registered.workspaceId, worktreeId: registered.worktreeId });
    expect(calls[0]!.prompt.equals(Buffer.from(prompt))).toBe(true);
    expect(calls[0]!.argv).toContain("--session-id");
    expect(calls[0]!.argv[calls[0]!.argv.indexOf("--session-id") + 1]).toBe(nativeId);
    expect(calls[0]!.options.env.GROK_SESSION_ID).toBe(nativeId);
    expect(first.chat.draft().text).toBe("");
    const text = "Hello café";
    const output = JSON.stringify({ type: "assistant", message: { id: "msg_offline", role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    calls[0]!.child.stdout.write(output);
    calls[0]!.child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: text }) + "\n");
    calls[0]!.child.finish();
    await until(async () => !(await service.view(id)).active);
    await first.poll();
    await first.poll();
    expect(first.chat.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(first.chat.state.messages[1]!.parts).toEqual([{ type: "text", text }]);
    expect(first.chat.state.grokView).toMatchObject({ phase: "idle", nextTurnIndex: 1, nativeAcceptance: "unknown", acceptedMessageId: null });
    expect(first.chat.state.runs[0]!.events).toEqual([]);
    expect(first.chat.state.runs[0]!.nativeCommandId).toBeUndefined();

    const continuation = "Continue exactly\n  α";
    first.chat.setDraft({ text: continuation });
    expect(await first.chat.send(continuation)).toMatchObject({ status: "recorded" });
    await until(() => calls.length === 2);
    expect(inputs[1]).toMatchObject({ sessionId: id, turnIndex: 1, model: "custom model", effort: "custom effort" });
    expect(calls[1]!.argv).not.toContain("--session-id");
    expect(calls[1]!.argv[calls[1]!.argv.indexOf("--resume") + 1]).toBe(nativeId);
    expect(calls[1]!.options.env.GROK_SESSION_ID).toBe(nativeId);
    expect(calls[1]!.prompt.equals(Buffer.from(continuation))).toBe(true);
    calls[1]!.child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Second response" }) + "\n");
    calls[1]!.child.finish();
    await until(async () => !(await service.view(id)).active);
    await first.poll();
    expect(first.chat.state.messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const capture = JSON.parse(readFileSync(join(dataDir, "grok-captures", grokCaptureFilename(id)), "utf8"));
    expect(capture.turns.map((turn: { prompt: string }) => turn.prompt)).toEqual([prompt, continuation]);
    expect(capture.execution.disposition).toBe("idle");
    expect(await service.close()).toEqual({ drained: true });

    // A fresh service + ChatStore must recover history from capture, not a cached UI view.
    const persisted = validateAppStore(dataDir);
    expect(persisted.metadata.version).toBe(2);
    expect(persisted.metadata.runs).toEqual([]);
    expect(persisted.metadata.sessions).toHaveLength(1);
    const stored = persisted.metadata.sessions[0]!;
    expect(stored).toMatchObject({ sessionId: id, nativeSessionId: nativeId, lastRunId: null, lastStatus: "unknown" });
    service = new GrokAppService(options);
    services.push(service);
    const reopened = openChat([{ id: stored.sessionId, harness: stored.harness, nativeSessionId: stored.nativeSessionId,
      authorityId: stored.authorityId, cwd: stored.cwd, model: stored.model, effort: stored.effort,
      workspaceId: registered.workspaceId, worktreeId: registered.worktreeId, association: "resolved", status: "unknown", lastRunId: null }]);
    reopened.chat.choose(id);
    await reopened.poll();
    expect(reopened.chat.state.messages).toEqual((await service.view(id)).messages);
    expect(reopened.chat.state.messages.map(message => ({ id: message.id, parts: message.parts })))
      .toEqual(first.chat.state.messages.map(message => ({ id: message.id, parts: message.parts })));
    expect(reopened.chat.state.availability.canSend).toBe(true);
    expect(calls).toHaveLength(2);

    reopened.chat.setDraft({ text: "Third turn, stop owned wrapper" });
    expect(await reopened.chat.send(reopened.chat.draft().text)).toMatchObject({ status: "recorded" });
    await until(() => calls.length === 3);
    expect(inputs[2]).toMatchObject({ sessionId: id, turnIndex: 2 });
    expect(calls[2]!.options.env.GROK_SESSION_ID).toBe(nativeId);
    await reopened.chat.cancel();
    await reopened.poll();
    expect(stops).toEqual([id]);
    expect(calls[2]!.child.signals).toEqual(["SIGTERM"]);
    expect(reopened.chat.state.actionNotice).toContain("Native cancellation is unproven");
    expect(reopened.chat.state.grokView).toMatchObject({ active: false, blocked: true, nativeAcceptance: "unknown" });
    expect(reopened.chat.state.availability.canSend).toBe(false);
    expect(service.activeCount()).toBe(0);
    expect(validateAppStore(dataDir).metadata.runs).toEqual([]);
    expect(publicationFailures).toEqual([]);
    expect(forbiddenCalls).toEqual([]);
  } finally {
    for (const chat of chats) (chat as any).stop();
    for (const service of services) await service.close();
    await router?.close();
    catalog.state = oldCatalogState;
    catalog.navigate = oldNavigate;
    globalThis.fetch = oldFetch;
    invalidateCoalescedRequests();
    rmSync(root, { recursive: true, force: true });
  }
});

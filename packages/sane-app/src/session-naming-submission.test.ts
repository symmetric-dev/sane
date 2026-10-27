import { expect, test } from "bun:test";
import type { Run, Session } from "./history";
import { SessionNamingService, submissionNamingTranscript } from "./session-naming";

const session = (): Session => ({
  sessionId: "session", harness: "claude-code", authorityId: "authority", nativeSessionId: "native",
  cwd: "/synthetic", lastStatus: "unknown", lastRunId: null, title: "Conversation", titleSource: "fallback",
  titleRevision: 0, titleAutoEligible: true,
});
const run = (): Run => ({ runId: "run", sessionId: "session", cwd: "/synthetic", status: "running", createdAt: "2026-10-27T00:00:00Z" });

test("submission naming keeps only the supplied user text", () => {
  expect(JSON.parse(submissionNamingTranscript("  authored\nbody  ")!)).toEqual([{ role: "user", text: "authored\nbody" }]);
  expect(submissionNamingTranscript(" \n\t ")).toBeUndefined();
});

test("automatic naming does not wait for completion or reconstruct a transcript", async () => {
  const current = session();
  const seen: string[] = [];
  const service = new SessionNamingService({
    session: () => current, healthy: () => true, commit: action => Promise.resolve(action()),
    generate: async transcript => { seen.push(transcript); return "Named"; },
  });
  service.submitted(current.sessionId, run(), "hello");
  for (let i = 0; i < 20 && !seen.length; i++) await Promise.resolve();
  const transcript = submissionNamingTranscript("hello");
  if (!transcript) throw new Error("expected a naming transcript");
  expect(seen).toEqual([transcript]);
  expect(current.titleGeneration?.state).toBe("pending");
  current.agentKind = "worker";
  service.submitted(current.sessionId, run(), "worker text");
  current.agentKind = undefined;
  current.attachment = { state: "pending" } as Session["attachment"];
  service.submitted(current.sessionId, { ...run(), operation: "prompt" }, "attached text");
  await Promise.resolve();
  expect(seen).toHaveLength(1);
});

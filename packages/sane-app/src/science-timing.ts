import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { scienceTiming, type ScienceTimingTrace } from "sane-science/timing";

/** Best effort, bounded, metadata-only diagnostic record. No native payloads. */
export async function timeScienceRun<T>(dataDir: string, ids: { requestId: string; blockId: string; conversationId: string }, work: () => Promise<T>): Promise<T> {
  const timestamp = new Date().toISOString();
  const trace: ScienceTimingTrace = { started: performance.now(), spans: [], droppedSpans: 0, sessionEvidence: "unobserved", outcome: "incomplete" };
  const attemptId = crypto.randomUUID();
  return scienceTiming.run(trace, async () => {
    try { return await work(); }
    catch (error) { trace.outcome = "error"; throw error; }
    finally {
      const durationMs = Math.round((performance.now() - trace.started) * 1000) / 1000;
      let fd: number | undefined;
      try {
        const path = join(dataDir, "science-timing.jsonl");
        const line = JSON.stringify({ version: 1, timestamp, attemptId, ...ids, durationMs, outcome: trace.outcome, sessionEvidence: trace.sessionEvidence, spans: trace.spans, droppedSpans: trace.droppedSpans }) + "\n";
        fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe timing destination");
        if (stat.size + Buffer.byteLength(line) > 2 * 1024 * 1024) {
          closeSync(fd); fd = undefined;
          renameSync(path, `${path}.1`);
          fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        writeSync(fd, line);
      } catch { /* Diagnostics must never affect execution or replay fences. */ }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
    }
  });
}

import type { BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { decodeLog, type Event, type Run } from "./history";
import { workerTerminationUncertainty } from "./worker-recovery";

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Read-only fast-path guard, not a replacement for historical decoding/repair.
 * False always requires the caller's existing full reconciliation path. Only
 * complete, unchanged journals without outstanding termination uncertainty pass.
 */
export async function hasVerifiedSettledTermination(path: string, run: Run): Promise<boolean> {
  if (run.status === "running") return false;
  let file: FileHandle | undefined;
  let verified = false;
  try {
    // Follow symlinks, like the legacy readFile path; compare the resolved file
    // against the opened handle both before and after consuming its contents.
    file = await open(path, "r");
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)
      || !sameSnapshot(before, await stat(path, { bigint: true }))) return false;

    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const fragments: string[] = [];
    let lastSeq = 0;
    let uncertainty: Event | undefined;

    function consume(text: string): boolean {
      // Search only this decoded chunk, never the growing record. Joining once
      // per newline keeps long records linear while retaining at most one line.
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        if (newline < 0) {
          if (start < text.length) fragments.push(text.slice(start));
          return true;
        }
        fragments.push(text.slice(start, newline));
        const line = fragments.join("");
        fragments.length = 0;
        // Delegate all record/schema/compaction validation to the existing
        // decoder. A terminated line must never need repair or omit a record.
        const decoded = decodeLog(line + "\n", run);
        const event = decoded.events[0];
        if (decoded.repaired !== undefined || decoded.events.length !== 1 || !event || event.seq <= lastSeq) return false;
        lastSeq = event.seq;
        if (event.kind === "status") {
          uncertainty = workerTerminationUncertainty(uncertainty ? [uncertainty, event] : [event]);
        }
        start = newline + 1;
      }
    }

    // Bound the read to the initial size: an actively growing journal must not
    // prolong startup indefinitely, and the final snapshots will reject growth.
    const size = Number(before.size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead || !consume(decoder.write(buffer.subarray(0, bytesRead)))) return false;
      position += bytesRead;
    }
    if (!consume(decoder.end()) || fragments.length || !lastSeq || uncertainty) return false;

    verified = sameSnapshot(before, await file.stat({ bigint: true }))
      && sameSnapshot(before, await stat(path, { bigint: true }));
  } catch {
    // Missing/corrupt/changing/unreadable journals retain the legacy path's
    // exact diagnostics and repair behavior; this helper never writes anything.
    verified = false;
  } finally {
    try { await file?.close(); } catch { verified = false; }
  }
  return verified;
}

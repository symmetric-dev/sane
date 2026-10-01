import ignore, { type Ignore } from "ignore";
import { validateIgnoreSnapshot } from "./workspace-ignore";

// This entrypoint performs CPU-only work on supplied snapshots. It never opens
// repository files, metadata, config or .gitignore paths. It is not a sandbox.
const MAX_FRAME = 4 * 1024 * 1024, MAX_REPLY = 2048;
const MAX_SCOPES = 256, MAX_BYTES = 512 * 1024, MAX_RULES = 2000, MAX_BATCH = 128, MAX_PATH = 4096;
const scopes = new Map<string, Ignore>();
let bytes = 0, rules = 0, previousId = 0;
const reader = Bun.stdin.stream().getReader();
const writer = Bun.stdout.writer();
let chunk: Uint8Array = new Uint8Array(0), offset = 0;

function validPath(path: unknown, root = false): path is string {
  return typeof path === "string" && path.length <= MAX_PATH && !/[\0\\]/.test(path)
    && (path === "" ? root : path.split("/").every(part => !!part && part !== "." && part !== ".."));
}
function requireCondition(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid evaluator protocol"); }

async function exact(length: number, eof = false): Promise<Buffer | null> {
  const result = Buffer.allocUnsafe(length);
  let used = 0;
  while (used < length) {
    if (offset === chunk.length) {
      const next = await reader.read();
      if (next.done) { if (eof && !used) return null; throw new Error("Incomplete frame"); }
      // Bound stream chunks too; callers cannot force unbounded accumulation.
      requireCondition(next.value.length <= MAX_FRAME + 4);
      chunk = next.value; offset = 0;
    }
    const take = Math.min(length - used, chunk.length - offset);
    result.set(chunk.subarray(offset, offset + take), used); used += take; offset += take;
  }
  return result;
}

async function send(id: number, values: boolean[]): Promise<void> {
  const payload = Buffer.from(JSON.stringify({ id, values }));
  requireCondition(payload.length <= MAX_REPLY);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
  writer.write(frame); await writer.flush();
}

async function main(): Promise<void> {
  await send(0, []);
  while (true) {
    const header = await exact(4, true); if (!header) return;
    const length = header.readUInt32BE(0); requireCondition(length > 0 && length <= MAX_FRAME);
    const payload = (await exact(length))!;
    const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    requireCondition(message && typeof message === "object" && !Array.isArray(message));
    requireCondition(Number.isSafeInteger(message.id) && message.id === previousId + 1);
    previousId = message.id;
    if (message.kind === "register") {
      requireCondition(Object.keys(message).length === 4 && validPath(message.scopeId, true) && typeof message.text === "string" && !scopes.has(message.scopeId));
      const snapshot = validateIgnoreSnapshot(message.text), size = Buffer.byteLength(message.text);
      requireCondition(scopes.size < MAX_SCOPES && bytes + size <= MAX_BYTES && rules + snapshot.rules <= MAX_RULES);
      // Parsing, add(), lazy regexp compilation, and every test() all run here.
      scopes.set(message.scopeId, ignore({ ignorecase: false }).add(message.text));
      bytes += size; rules += snapshot.rules;
      await send(message.id, []);
    } else {
      requireCondition(message.kind === "test" && Object.keys(message).length === 4 && Array.isArray(message.scopeIds) && message.scopeIds.length <= MAX_SCOPES && Array.isArray(message.candidates) && message.candidates.length <= MAX_BATCH);
      const selected: { path: string; rules: Ignore }[] = [];
      for (const path of message.scopeIds) {
        requireCondition(validPath(path, true) && scopes.has(path));
        const previous = selected.at(-1)?.path;
        requireCondition(previous === undefined || (path && path !== previous && (!previous || path.startsWith(previous + "/"))));
        // Public add(Ignore) reuses the rules, but creates fresh per-batch path
        // caches. Library caches cannot grow with every visited search entry.
        selected.push({ path, rules: ignore({ ignorecase: false }).add(scopes.get(path)!) });
      }
      const values: boolean[] = [];
      for (const candidate of message.candidates) {
        requireCondition(candidate && typeof candidate === "object" && Object.keys(candidate).length === 2 && validPath(candidate.path) && typeof candidate.directory === "boolean");
        let ignored = false;
        for (const scope of selected) {
          requireCondition(!scope.path || candidate.path.startsWith(scope.path + "/"));
          const local = (scope.path ? candidate.path.slice(scope.path.length + 1) : candidate.path) + (candidate.directory ? "/" : "");
          const match = scope.rules.test(local);
          if (match.ignored) ignored = true;
          else if (match.unignored) ignored = false;
        }
        values.push(ignored);
      }
      await send(message.id, values);
    }
  }
}

// Fail closed without serializing snapshots, diagnostics, paths or regexes.
try { await main(); } catch { process.exitCode = 1; }
finally { try { await reader.cancel(); } catch {} try { await writer.end(); } catch {} }

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function root(value: string | undefined) {
  if (!value || !isAbsolute(value)) throw new Error("An absolute PoC evidence directory is required");
  mkdirSync(value, { recursive: true, mode: 0o700 });
  return value;
}
const producer = randomUUID();
let sequence = 0;
export function record(dir: string, kind: string, data: Record<string, unknown>) {
  const id = randomUUID();
  const item = { id, kind, observedAt: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), producer, sequence: ++sequence, pid: process.pid, launchID: process.env.NATIVE_PROBE_LAUNCH_ID ?? null, ...data };
  const events = join(root(dir), "events");
  mkdirSync(events, { recursive: true, mode: 0o700 });
  const pending = join(events, `${id}.pending`);
  writeFileSync(pending, JSON.stringify(item) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(pending, join(events, `${id}.json`));
  return id;
}
export function fields(input: any, keys: string[]) {
  return Object.fromEntries(keys.map(key => [key, ["string", "number", "boolean"].includes(typeof input?.[key]) ? input[key] : null]));
}
export function taskFields(input: any, key: string, keys: string[]) {
  return Array.isArray(input?.[key]) ? input[key].map((v: any) => fields(v, keys)) : null;
}
export const identityKeys = ["session_id", "cwd", "prompt_id", "tool_use_id", "agent_id", "agent_type"];

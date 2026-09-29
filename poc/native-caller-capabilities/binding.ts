import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fields, hash, identityKeys, record } from "./evidence";

export const toolName = "mcp__native_probe__capture";
export function payload(input: any) {
  const wait = input?.wait_ms ?? 0;
  if (!Number.isInteger(wait) || wait < 0 || wait > 180000) throw new Error("Invalid wait_ms");
  return { wait_ms: wait };
}
export function mint(dir: string, hook: any, hookEvent: string) {
  const token = randomBytes(32).toString("hex");
  const fingerprint = hash(token);
  const identity = fields(hook, identityKeys);
  const body = payload(hook.tool_input);
  mkdirSync(join(dir, "bindings"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "bindings", `${fingerprint}.json`), JSON.stringify({
    identity, body, tool: toolName, hookEvent, issuedAt: Date.now(),
  }), { mode: 0o600, flag: "wx" });
  record(dir, "binding.issued", { fingerprint, identity, hookEvent });
  return token;
}
export function consume(dir: string, input: any, requestID: unknown) {
  const token = input?._invocation;
  const fingerprint = typeof token === "string" ? hash(token) : null;
  let status = "missing";
  let binding: any;
  if (typeof token === "string" && /^[a-f0-9]{64}$/.test(token)) {
    // Atomic rename makes a bearer single-use across concurrent MCP processes.
    const from = join(dir, "bindings", `${fingerprint}.json`);
    const used = join(dir, "bindings", `${fingerprint}.used-${randomUUID()}`);
    try {
      renameSync(from, used);
      binding = JSON.parse(readFileSync(used, "utf8"));
      status = "bound";
      if (Date.now() - binding.issuedAt > 300000) status = "expired";
      else if (binding.tool !== toolName || JSON.stringify(binding.body) !== JSON.stringify(payload(input))) status = "payload-mismatch";
      else if (!binding.identity.session_id || !binding.identity.cwd || !binding.identity.tool_use_id) status = "identity-incomplete";
    } catch { status = "unknown-tampered-or-replayed"; }
  } else if (token !== undefined) status = "malformed";
  const event = record(dir, "mcp.binding", {
    fingerprint, status, requestID: typeof requestID === "string" || typeof requestID === "number" ? requestID : null,
    identity: binding?.identity ?? null, hookEvent: binding?.hookEvent ?? null,
  });
  return { event, status, identity: status === "bound" ? binding.identity : null };
}

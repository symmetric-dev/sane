// Never return a permission decision or contaminate the hook's stdout.
import { appendFileSync } from "node:fs";
const { CC_WEB_HOOK_URL: url, CC_WEB_RUN_ID: runId, CC_WEB_HOOK_SECRET: secret, CC_WEB_HOOK_ERRORS: errors } = process.env;
const event = process.argv[2] ?? "";
try {
  if (!url || !runId || !secret) throw new Error("Missing hook forwarding environment");
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1") throw new Error(`Refusing non-loopback hook URL host ${target.hostname}`);
  const payload = JSON.parse(await Bun.stdin.text());
  const response = await fetch(`${url}/hooks/${encodeURIComponent(event)}`, {
    method: "POST", headers: { "content-type": "application/json", "x-cc-web-secret": secret },
    body: JSON.stringify({ runId, payload }), signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Bridge rejected hook: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
} catch (error) {
  // Observational, fail open without output; the run's evidence keeps the cause.
  try { if (errors) appendFileSync(errors, JSON.stringify({ time: new Date().toISOString(), event, error: error instanceof Error ? error.message : String(error) }) + "\n", { mode: 0o600 }); } catch {}
}
process.exit(0);

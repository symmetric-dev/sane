// Never return a permission decision or contaminate the hook's stdout.
export {};
const { CC_WEB_HOOK_URL: url, CC_WEB_RUN_ID: runId, CC_WEB_HOOK_SECRET: secret } = process.env;
if (url && runId && secret) {
  try {
    const target = new URL(url);
    if (target.hostname === "127.0.0.1") {
      const payload = JSON.parse(await Bun.stdin.text());
      await fetch(`${url}/hooks/${encodeURIComponent(process.argv[2] ?? "")}`, {
        method: "POST", headers: { "content-type": "application/json", "x-cc-web-secret": secret },
        body: JSON.stringify({ runId, payload }), signal: AbortSignal.timeout(1500),
      });
    }
  } catch { /* Observational, fail open without output. */ }
}
process.exit(0);

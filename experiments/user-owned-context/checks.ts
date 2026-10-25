/** Content-only checks, shared by the live runner and offline evidence review. */
export function checkContent(probe: { name: string; exact?: string; expected?: Record<string, unknown> }, response: string) {
  const checks: Record<string, boolean> = {};
  let format = "text";
  if (probe.exact) checks.exactResponse = response.trim() === probe.exact;
  else {
    let parsed: Record<string, unknown> | undefined;
    const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(response.trim());
    format = fenced ? "fenced-json" : "raw-json";
    try { parsed = JSON.parse(fenced?.[1] ?? response); } catch { format = "unparsed"; }
    checks.jsonObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    for (const [key, value] of Object.entries(probe.expected ?? {})) checks[key] = key === "role"
      ? typeof parsed?.[key] === "string" && (parsed[key] as string).toLowerCase() === value
      : parsed?.[key] === value;
    if (probe.name === "ordinary-after-update") checks.nextStepPresent = typeof parsed?.nextStep === "string" && parsed.nextStep.length > 0;
  }
  return { format, checks };
}

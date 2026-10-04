// Deliver the SANE framework once, as SessionStart context recorded in native history.
// Only the startup of a new session adds it; resume and compact add nothing.
export {};
const path = process.argv[2];
const input = JSON.parse(await Bun.stdin.text());
if (input?.source === "startup") {
  const file = path ? Bun.file(path) : undefined;
  if (!file || !(await file.exists())) {
    console.error(`SANE framework file is missing: ${path ?? "(no path)"}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: await file.text() } }));
}

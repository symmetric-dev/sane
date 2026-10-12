// Legacy startup or one canonical dynamic snapshot per App launch. Automatic
// continuations share the snapshot, so emit once for this run's unique file.
import { open } from "node:fs/promises";

const path = process.argv[2];
const input = JSON.parse(await Bun.stdin.text());
if (input?.hook_event_name === "UserPromptSubmit" && !input.agent_id) {
  const file = path ? Bun.file(path) : undefined;
  if (!file || !(await file.exists())) {
    console.error(`SANE Session context file is missing: ${path ?? "(no path)"}`);
    process.exit(2);
  }
  const text = await file.text();
  try {
    const marker = await open(`${path}.delivered`, "wx", 0o600);
    await marker.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") process.exit(0);
    throw error;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
}

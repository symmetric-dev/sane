import { start, parseOptions } from "./src/bridge.ts";
try {
  const bridge = await start(parseOptions(process.argv.slice(2)));
  console.log(`CC web listening on ${bridge.origin}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await bridge.close();
    process.exit(0);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
}

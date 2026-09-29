import { start, startupSummary, type Options } from "./src/bridge.ts";

export async function runServer(options: Options) {
  console.log(startupSummary(options));
  const bridge = await start(options);
  console.log(`SANE App listening on ${bridge.origin}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await bridge.close(); process.exit(0); }
    catch (error) { console.error(error instanceof Error ? error.message : "Shutdown failed; ownership retained"); process.exit(1); }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
  return bridge;
}
if (import.meta.main) {
  try { await (await import("./start")).runStart(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Startup failed"); process.exitCode = 1; }
}

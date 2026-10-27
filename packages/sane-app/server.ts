import type { Options } from "./src/bridge.ts";
import { startAppProfile } from "./src/app-profile.ts";

export async function runServer(options: Options) {
  const { start, startupSummary } = await import("./src/bridge.ts");
  console.log(startupSummary(options));
  const bridge = await start(options);
  console.log(`SANE App listening on ${bridge.origin}`);
  const profile = await startAppProfile();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await profile.stop(); await bridge.close(); process.exit(0); }
    catch (error) { console.error(error instanceof Error ? error.message : "Shutdown failed; ownership retained"); process.exit(1); }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
  return bridge;
}
if (import.meta.main) {
  try { await (await import("./start")).runStart(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Startup failed"); process.exitCode = 1; }
}

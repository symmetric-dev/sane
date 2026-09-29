import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

// Resolution anchors only: no App code or SDK query is imported or executed.
const app = fileURLToPath(new URL("../../packages/sane-app/", import.meta.url));
export async function clientModules() {
  return {
    ...(await import(pathToFileURL(Bun.resolveSync("@opencode/client", app)).href)),
    ...(await import(pathToFileURL(Bun.resolveSync("@opencode/client/service", app)).href)),
  };
}
export async function mcpModule(suffix: string) {
  const sdk = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", app));
  return import(pathToFileURL(Bun.resolveSync(`@modelcontextprotocol/sdk/${suffix}`, sdk)).href);
}
export const home = fileURLToPath(new URL("./", import.meta.url));

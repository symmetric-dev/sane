import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppConfigError, validateGrokConfig, type GrokConfig } from "./app-config";
import { grokSourceRecord, validateAgentProfiles } from "./app-store";
import { builtinProfiles, seedAgentProfiles, type AgentProfiles } from "./agent-profiles-contract";

const options = { "--grok-home": "homeRoot", "--grok-bin": "executable", "--grok-model": "model", "--grok-effort": "effort" } as const;
export type GrokSetupConfig = Required<GrokConfig>;

/** These options deliberately do not belong to the startup parser. */
export function parseGrokSetupOptions(args: string[]) {
  const appArgs: string[] = [], grok: Partial<GrokConfig> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!Object.hasOwn(options, flag)) { appArgs.push(flag); continue; }
    const key = options[flag as keyof typeof options];
    if (Object.hasOwn(grok, key)) throw new AppConfigError(`Duplicate option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new AppConfigError(`Missing value for ${flag}`);
    grok[key] = value;
  }
  return { appArgs, grok: Object.keys(grok).length ? grok : undefined };
}

/** No discovery, credentials provisioning, or native process execution. */
export function resolveGrokSetup(incoming: Partial<GrokConfig>, saved: GrokConfig | undefined, cwd: string): GrokSetupConfig {
  const candidate = { ...saved, ...incoming };
  if (incoming.homeRoot !== undefined) candidate.homeRoot = resolve(cwd, incoming.homeRoot);
  if (!candidate.homeRoot || !candidate.executable || !candidate.model || !candidate.effort) {
    throw new AppConfigError("Grok setup requires --grok-home, --grok-bin, --grok-model and --grok-effort (or their saved values)");
  }
  const settings = validateGrokConfig(candidate) as GrokSetupConfig;
  const source = grokSourceRecord(settings.homeRoot);
  if (!source.authorityId) throw new AppConfigError("Grok home must be an existing directory; select your already authenticated home explicitly");
  return { ...settings, homeRoot: source.descriptor.homeRoot };
}

/** Prepare and validate without writing, so a refused source repin cannot change profiles. */
export function prepareGrokProfile(dataDir: string, settings: GrokSetupConfig): AgentProfiles {
  const file = join(dataDir, "agents.json");
  let profiles: AgentProfiles;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AppConfigError("Agent profiles must be a regular unaliased file");
    profiles = validateAgentProfiles(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    profiles = seedAgentProfiles();
  }
  const existing = profiles.profiles.find(profile => profile.id === "base:gk");
  const base = existing ?? builtinProfiles().find(profile => profile.id === "base:gk")!;
  const exposed = { ...base, model: settings.model, effort: settings.effort, hidden: false, updatedAt: new Date().toISOString() };
  return validateAgentProfiles({ ...profiles, profiles: existing
    ? profiles.profiles.map(profile => profile.id === "base:gk" ? exposed : profile)
    : [...profiles.profiles, exposed] });
}

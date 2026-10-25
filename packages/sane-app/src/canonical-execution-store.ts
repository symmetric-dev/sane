import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKER_AGENT_IDS, UTILITY_AGENT_IDS, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import { contextHash } from "./context-package";
import { parseCanonicalAgentOperations, type CanonicalAgentOperations } from "./canonical-agent-operations";
import { loadAgentModelConfig } from "../../sane-cli/src/agent-model-config";
import { ASSISTANT_AGENT_IDS } from "sane-core/agent-catalog";

export type CanonicalExecutionRef = { schema: 1; revision: string };
export type CanonicalExecutionSnapshot = { schema: 1; policy: CanonicalAgentOperations; children: CanonicalAgentOperations[]; revision: string };
export type CanonicalExecutionProvider = (sessionId: string) => Promise<CanonicalExecutionSnapshot | null>;

/** Execution policy is pinned independently of instructional context. Profile
 * model/effort overrides remain the conversation's existing immutable fields. */
export class CanonicalExecutionStore {
  constructor(private readonly sourceRoot: string, private readonly directory: string, private readonly modelConfig?: string) {}
  async create(identity: StoredSaneAgentIdentity): Promise<CanonicalExecutionRef> {
    if (identity.role === "knowledge") throw new Error("Historical Knowledge requires its archived execution configuration");
    const names = [...ASSISTANT_AGENT_IDS.map(id => `sane/assistant/${id}`), ...WORKER_AGENT_IDS.map(id => `sane/worker/${id}`), ...UTILITY_AGENT_IDS.map(id => `sane/utility/${id}`)];
    const overrides = this.modelConfig ? await loadAgentModelConfig(this.modelConfig, names.map(name => `${name}.md`)) : undefined;
    const sourceRoot = await realpath(this.sourceRoot);
    const load = async (name: string) => {
      const path = join(sourceRoot, "context/agents", `${name}.md`);
      if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Execution definitions must be regular authored files");
      return parseCanonicalAgentOperations(await readFile(path, "utf8"), name, overrides?.get(name));
    };
    const policy = await load(`sane/${identity.kind}/${identity.role}`);
    const children = identity.kind === "utility" ? [] : await Promise.all(WORKER_AGENT_IDS.map(role => load(`sane/worker/${role}`)));
    const body = { schema: 1 as const, policy, children }, revision = contextHash(JSON.stringify(body));
    const snapshot = { ...body, revision }, text = JSON.stringify(snapshot);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== resolve(this.directory)) throw new Error("Execution store cannot contain symbolic links");
    const path = this.path(revision), temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text); await file.sync();
      try { await link(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await file.close(); await unlink(temporary); }
    const dir = await open(this.directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    await this.load({ schema: 1, revision });
    return { schema: 1, revision };
  }
  private path(revision: string) {
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid canonical execution revision");
    return join(this.directory, `${revision}.json`);
  }
  async load(ref: CanonicalExecutionRef): Promise<CanonicalExecutionSnapshot> {
    const path = this.path(ref.revision);
    if (await realpath(path) !== resolve(path)) throw new Error("Execution snapshot cannot contain symbolic links");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: CanonicalExecutionSnapshot;
    try {
      if (!(await file.stat()).isFile()) throw new Error("Invalid canonical execution file");
      value = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    if (!value || value.schema !== 1 || !value.policy || !Array.isArray(value.children)
      || value.revision !== ref.revision || contextHash(JSON.stringify({ schema: value.schema, policy: value.policy, children: value.children })) !== ref.revision) throw new Error("Canonical execution snapshot changed");
    return value;
  }
}

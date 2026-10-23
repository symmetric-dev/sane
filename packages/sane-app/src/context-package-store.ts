import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isAssistantAgentId, isWorkerAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import { workerProcedureSource } from "sane-core/sane-worker-procedures";
import { parseContextMarkdown } from "sane-core/context-markdown";
import { frameworkNames, frameworkSource } from "sane-core/sane-framework";
import { contextAsset, contextHash, createContextPackage, validateContextPackage, type ContextAsset, type ContextPackage, type ContextPackageRef } from "./context-package";

// Existing pinned packages retain their original source paths and hashes.
const skillSourcePrefix = /^(?:context\/)?skills\//;

async function pinnedText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Pinned context must be a regular file");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.readFile());
  } finally { await file.close(); }
}

/** Private assets are content-addressed. Existing bytes are verified, never overwritten. */
export class ContextPackageStore {
  private readonly publications = new Map<string, Promise<void>>();
  constructor(private readonly sourceRoot: string, private readonly storeRoot: string) {}
  private async source(path: string) {
    const root = await realpath(this.sourceRoot), target = join(root, path), actual = await realpath(target);
    if (actual !== target || !actual.startsWith(root + sep) || !(await lstat(target)).isFile()) throw new Error(`Context source must be a regular file inside the authored package: ${path}`);
    return pinnedText(target);
  }
  async create(identity: StoredSaneAgentIdentity): Promise<ContextPackageRef> {
    if (!identity || (identity.kind === "assistant" ? !isAssistantAgentId(identity.role) : identity.kind !== "worker" || !isWorkerAgentId(identity.role))) throw new Error("An archived role requires its original context package; current roles are not substitutes");
    const roleSource = `context/agents/sane/${identity.kind}/${identity.role}.md`;
    const role = parseContextMarkdown(await this.source(roleSource));
    const assets = [contextAsset(`role.${identity.kind}.${identity.role}`, roleSource, role.body, "role", role.description)];
    for (const name of frameworkNames(identity)) {
      const source = frameworkSource(name), parsed = parseContextMarkdown(await this.source(source));
      assets.push(contextAsset(`framework.${name}`, source, parsed.body.trimEnd(), "framework", parsed.description));
    }
    if (identity.kind === "worker") {
      const source = workerProcedureSource(identity.role), parsed = parseContextMarkdown(await this.source(source), false);
      assets.push(contextAsset(`worker-procedure.${identity.role}`, source, parsed.body, "procedure", parsed.description));
    } else for (const phase of ["pickup", "assistance", "delivery"]) {
      const id = `sane-assistant-${identity.role}-${phase}`, source = `context/skills/${id}/SKILL.md`, parsed = parseContextMarkdown(await this.source(source));
      assets.push(contextAsset(id, source, parsed.body, "procedure", parsed.description));
      const resources = join(this.sourceRoot, "context", "skills", id, "resources");
      try { await lstat(resources); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      await this.resources(resources, id, assets);
    }
    const bundle = createContextPackage(identity, assets);
    let publication = this.publications.get(bundle.revision);
    if (!publication) {
      publication = this.materialize(bundle);
      this.publications.set(bundle.revision, publication);
    }
    try { await publication; } finally { if (this.publications.get(bundle.revision) === publication) this.publications.delete(bundle.revision); }
    return { schema: 1, revision: bundle.revision, delivery: "standing-native-role" };
  }
  private async resources(directory: string, procedure: string, assets: ContextAsset[]) {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Context resource directories cannot be symbolic links");
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await this.resources(path, procedure, assets); continue; }
      if (!entry.isFile()) throw new Error("Context resources must be regular files");
      const source = relative(this.sourceRoot, path).split(sep).join("/");
      const suffix = source.slice(`context/skills/${procedure}/`.length);
      // IDs are logical names; materialized paths preserve authored relative links.
      assets.push(contextAsset(`${procedure}/${suffix.toLowerCase()}`, source, await this.source(source), "resource"));
    }
  }
  private async directory(revision: string, create = false) {
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid context package revision");
    if (create) await mkdir(this.storeRoot, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.storeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private context store must be a regular directory");
    // System aliases such as macOS /var are legitimate ancestors of the store.
    return join(await realpath(this.storeRoot), revision);
  }
  private assetPath(directory: string, asset: ContextAsset) {
    if (asset.kind === "resource" && (!skillSourcePrefix.test(asset.source) || asset.source.includes("\\") || asset.source.split("/").some(p => !p || p === "." || p === ".."))) throw new Error("Invalid private context resource source");
    const path = asset.kind === "procedure" ? asset.source.startsWith("context/worker-procedures/") ? `${asset.id}.md` : `${asset.id}/SKILL.md` : asset.kind === "resource" ? asset.source.replace(skillSourcePrefix, "") : `${asset.id}.md`;
    const target = resolve(directory, path);
    if (!target.startsWith(resolve(directory) + sep)) throw new Error("Context asset escapes private package");
    return target;
  }
  private async write(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (await realpath(dirname(path)) !== resolve(dirname(path))) throw new Error("Private context directory cannot contain symlinks");
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text); await file.sync();
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await file.close(); await unlink(temporary); }
    if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink() || await pinnedText(path) !== text) throw new Error("Private context bytes differ from their pinned revision");
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async materialize(bundle: ContextPackage) {
    const directory = await this.directory(bundle.revision, true);
    this.validatePaths(bundle, directory);
    for (const asset of bundle.assets) await this.write(this.assetPath(directory, asset), asset.text);
    await this.write(join(directory, "manifest.json"), JSON.stringify(bundle, null, 2) + "\n");
  }
  async load(ref: ContextPackageRef) {
    if (!ref || ref.schema !== 1 || ref.delivery !== "standing-native-role" || (ref.activation !== undefined && ref.activation !== "upgrade")) throw new Error("Invalid context package reference");
    const directory = await this.directory(ref.revision);
    if (await realpath(directory) !== resolve(directory)) throw new Error("Private context package cannot be a symlink");
    const manifest = join(directory, "manifest.json");
    if (!(await lstat(manifest)).isFile() || (await lstat(manifest)).isSymbolicLink()) throw new Error("Invalid context manifest file");
    const bundle: unknown = JSON.parse(await pinnedText(manifest));
    validateContextPackage(bundle);
    if (bundle.revision !== ref.revision) throw new Error("Context manifest revision mismatch");
    this.validatePaths(bundle, directory);
    const paths: Record<string, string> = {};
    for (const asset of bundle.assets) {
      const path = this.assetPath(directory, asset);
      if (await realpath(path) !== path || !(await lstat(path)).isFile() || contextHash(await pinnedText(path)) !== asset.sha256) throw new Error(`Pinned context resource changed: ${asset.id}`);
      paths[asset.id] = path;
    }
    return { bundle, paths };
  }
  private validatePaths(bundle: ContextPackage, directory: string) {
    const paths = new Set([resolve(directory, "manifest.json").toLowerCase()]);
    for (const asset of bundle.assets) {
      const path = this.assetPath(directory, asset);
      // Also reject portable case-folding aliases before publishing any bytes.
      const key = path.toLowerCase();
      if (paths.has(key)) throw new Error(`Colliding private context asset: ${asset.id}`);
      paths.add(key);
    }
    const sources = new Set(bundle.assets.map(a => a.source));
    for (const asset of bundle.assets.filter(a => skillSourcePrefix.test(a.source))) {
      // Only explicit authored relative resource references, not workstream templates.
      for (const match of asset.text.matchAll(/(`|\]\()(\.?\/?resources\/[^`\s)]+)(?:`|\))/g)) {
        const file = match[1] === "`" ? match[2] : match[2].split(/[?#]/, 1)[0];
        const source = join(dirname(asset.source), file).split(sep).join("/");
        if (!sources.has(source)) throw new Error(`Dangling context resource reference: ${asset.source} -> ${match[2]}`);
      }
    }
  }
}

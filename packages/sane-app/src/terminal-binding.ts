import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceError } from "./workspace";

export type TerminalBinding = { cwd: string; bindingRevision: string; protectedPaths: string[] };
export type TerminalBindingLease = {
  readonly binding: TerminalBinding;
  /** Unsupported config/layouts retain authoritative discovery on every validation. */
  readonly mode: "metadata" | "discovery";
  validate: () => Promise<void>;
};
type Identity = { dev: number; ino: number };
type Input = {
  binding: TerminalBinding;
  dataDir: string;
  rootIdentity: Identity;
  gitDir: string | null;
  gitIdentity: Identity | null;
  commonDir: string | null;
  commonIdentity: Identity;
  validateBinding: () => void;
  /** Full catalog discovery at acquisition, config changes or unsupported layouts. */
  rediscover: () => Promise<TerminalBinding>;
};
type Mapping = { path: string; signature: string | null; directory: boolean; opaque?: boolean };
type Snapshot = { mappings: Mapping[]; configs: Mapping[]; head: string | null; fences: Mapping[]; supported: boolean };
const MAX_METADATA_BYTES = 64 * 1024, MAX_ANCESTORS = 256;
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const changed = (): never => { throw new WorkspaceError(409, "binding-invalid", "Terminal filesystem binding changed"); };
class UnsupportedMapping extends Error {}
const unsupported = (): never => { throw new UnsupportedMapping(); };
// As in workspace-search-scope, directory times are NOT identity: index/ref and
// ordinary worktree writes must not revoke a shell. File signatures fence edits.
const signature = (s: Stats) => s.isDirectory()
  ? `directory:${s.dev}:${s.ino}`
  : `file:${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function optionalStat(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

/** Bounded, no-follow metadata read, including descriptor/path race checks.
 * These checks intentionally mirror search's safe acquisition, not its config
 * invalidation policy: a terminal may refresh a healthy config-only change. */
async function metadata(path: string, target: Mapping[], optional = false): Promise<string | null> {
  const info = await optionalStat(path);
  if (!info) {
    if (!optional) unsupported();
    target.push({ path, signature: null, directory: false }); return null;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_METADATA_BYTES) unsupported();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (signature(await handle.stat()) !== signature(info)) changed();
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = await handle.read(buffer, used, buffer.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const [after, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (used !== info.size || signature(after) !== signature(info) || signature(current) !== signature(info)) changed();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)); }
    catch { return unsupported(); }
    target.push({ path, signature: signature(info), directory: false }); return text;
  } finally { await handle.close(); }
}

// Not a general Git config parser. Includes, extensions, worktree overrides and
// ambiguous syntax use full discovery, with its sanitized Git environment.
function simpleConfig(text: string): boolean {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.includes("\0") || line.endsWith("\\")) return false;
    if (line.startsWith("[")) {
      const match = /^\[([a-z][a-z0-9-]*)(?:\s+"(?:[^"\\]|\\.)*"|\.[a-z0-9.-]+)?\]\s*(?:[#;].*)?$/i.exec(line);
      if (!match) return false;
      section = match[1]!.toLowerCase();
      if (["include", "includeif", "extensions"].includes(section)) return false;
      continue;
    }
    const match = /^([a-z][a-z0-9-]*)\s*(?:=\s*(.*))?$/i.exec(line);
    if (!section || !match) return false;
    if (section === "core") {
      const key = match[1]!.toLowerCase();
      if (key === "worktree") return false;
      if (key === "bare" && !/^(false|no|off|0)\s*(?:[#;].*)?$/i.test(match[2] ?? "")) return false;
    }
  }
  return true;
}

async function checkMappings(mappings: Mapping[]): Promise<boolean> {
  const matches = await Promise.all(mappings.map(async mapping => {
    const info = await optionalStat(mapping.path);
    if (mapping.signature === null) return !info;
    if (!info || signature(info) !== mapping.signature) return false;
    // Opaque fingerprints never follow/read unsupported local metadata. They
    // fence the authoritative discovery, not the mapping's interpretation.
    if (mapping.opaque) return true;
    return !info.isSymbolicLink() && (mapping.directory ? info.isDirectory() : info.isFile()) && (!mapping.directory || await realpath(mapping.path) === mapping.path);
  }));
  return matches.every(Boolean);
}

export async function createTerminalBindingLease(input: Input): Promise<TerminalBindingLease> {
  const binding = { ...input.binding, protectedPaths: [...input.binding.protectedPaths] };
  Object.freeze(binding.protectedPaths); Object.freeze(binding);
  const root = binding.cwd, data = await realpath(input.dataDir);
  const directories: Mapping[] = [];
  const directory = async (path: string, expected?: Identity, target = directories) => {
    const [canonical, info] = await Promise.all([realpath(path), lstat(path)]);
    if (canonical !== path || !info.isDirectory() || info.isSymbolicLink() || (expected && !same(info, expected))) changed();
    target.push({ path, signature: signature(info), directory: true });
  };
  input.validateBinding();
  await directory(root, input.rootIdentity); await directory(data);
  if (inside(data, root) || root.split(sep).some(p => [".git", ".sane"].includes(p.toLowerCase())) || binding.protectedPaths.some(path => inside(path, root))) changed();
  if (input.gitDir && input.commonDir && input.gitIdentity) {
    await directory(input.gitDir, input.gitIdentity); await directory(input.commonDir, input.commonIdentity);
  } else if (input.gitDir || input.commonDir || input.gitIdentity) changed();

  const checkPins = async () => {
    input.validateBinding();
    const [canonicalRoot, canonicalData, intact] = await Promise.all([realpath(root), realpath(input.dataDir), checkMappings(directories)]);
    if (canonicalRoot !== root || canonicalData !== data || !intact) changed();
    input.validateBinding();
  };
  const checkHead = async (path: string) => {
    const text = await metadata(path, []);
    // Git's repository recognizer uses HEAD too. Accept normal branch/commit
    // updates without discovery; unsupported HEAD syntax/layout uses fallback.
    if (!/^(?:ref: refs\/[^\0\r\n]+|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})\n?$/.test(text!)) unsupported();
  };
  const capture = async (): Promise<Snapshot> => {
    const mappings: Mapping[] = [], configs: Mapping[] = [];
    const fences: Mapping[] = [];
    let head: string | null = null, supported = true;
    // Capture every known local mapping input BEFORE interpretation can stop at
    // an unsupported shape. Even an unreadable/oversized/symlinked config keeps
    // its no-follow lstat fingerprint. Do not recurse includes or follow links.
    const paths = new Set<string>();
    if (input.gitDir && input.commonDir) {
      paths.add(join(root, ".git"));
      for (const name of ["commondir", "HEAD", "config.worktree"]) paths.add(join(input.gitDir, name));
      for (const name of ["config", "config.worktree", "objects", "refs"]) paths.add(join(input.commonDir, name));
    } else {
      let cursor = root, count = 0;
      while (true) {
        if (++count > MAX_ANCESTORS) { supported = false; break; }
        for (const name of [".git", "HEAD"]) paths.add(join(cursor, name));
        const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
      }
    }
    for (const path of paths) {
      const info = await optionalStat(path);
      fences.push({ path, signature: info ? signature(info) : null, directory: !!info?.isDirectory(), opaque: true });
    }
    try {
      if (input.gitDir && input.commonDir && input.gitIdentity) {
        const marker = join(root, ".git"), info = await optionalStat(marker);
        if (!info || info.isSymbolicLink()) return unsupported();
        if (info.isDirectory()) {
          if (marker !== input.gitDir || input.gitDir !== input.commonDir) unsupported();
          await directory(marker, input.gitIdentity, mappings);
        } else {
          const pointer = await metadata(marker, mappings);
          const match = /^gitdir: ([^\0\r\n]+)\n?$/.exec(pointer!);
          if (!match || resolve(root, match[1]!) !== input.gitDir) unsupported();
        }
        const pointer = await metadata(join(input.gitDir, "commondir"), mappings, true);
        if (pointer === null) { if (input.gitDir !== input.commonDir) unsupported(); }
        else if (!/^[^\0\r\n]+\n?$/.test(pointer) || resolve(input.gitDir, pointer.replace(/\n$/, "")) !== input.commonDir) unsupported();
        // Git also requires these administration directories to recognize a
        // repository. Their contents/timestamps, like HEAD content, are mutable.
        for (const name of ["objects", "refs"]) {
          const path = join(input.commonDir, name), stat = await optionalStat(path);
          if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) unsupported();
          await directory(path, undefined, mappings);
        }
        head = join(input.gitDir, "HEAD"); await checkHead(head);
        if (!simpleConfig((await metadata(join(input.commonDir, "config"), configs))!)) unsupported();
        if (await metadata(join(input.gitDir, "config.worktree"), configs, true) !== null) unsupported();
        if (input.gitDir !== input.commonDir && await metadata(join(input.commonDir, "config.worktree"), configs, true) !== null) unsupported();
      } else {
        let cursor = root, count = 0;
        while (true) {
          if (++count > MAX_ANCESTORS) unsupported();
          for (const name of [".git", "HEAD"]) {
            const path = join(cursor, name);
            if (await optionalStat(path)) unsupported();
            mappings.push({ path, signature: null, directory: false });
          }
          const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
        }
      }
    } catch (error: any) {
      // A readable lstat fingerprint still fences discovery when bounded content
      // reads are unsupported or denied. Unstatable metadata fails closed.
      if (error instanceof UnsupportedMapping || ["EACCES", "EPERM"].includes(error.code)) supported = false;
      else throw error;
    }
    if (!await checkMappings([...fences, ...mappings, ...configs])) changed();
    await checkPins();
    return { mappings, configs, head, fences, supported };
  };
  const rediscover = async () => {
    await checkPins();
    const current = await input.rediscover();
    if (current.cwd !== binding.cwd || current.bindingRevision !== binding.bindingRevision || JSON.stringify(current.protectedPaths) !== JSON.stringify(binding.protectedPaths)) changed();
    await checkPins();
  };
  // Catalog pins are only selectors until discovery confirms this exact local
  // metadata snapshot. This closes the discovery-before-capture startup race.
  let snapshot = await capture();
  await rediscover();
  if (!await checkMappings(snapshot.fences)) changed();
  await checkPins();
  let invalid = false, serial: Promise<void> = Promise.resolve();
  const validate = () => {
    const next = serial.then(async () => {
      if (invalid) changed();
      try {
        await checkPins();
        if (snapshot.supported) {
          if (!await checkMappings(snapshot.mappings)) changed();
          let refresh = !await checkMappings(snapshot.configs);
          if (snapshot.head) {
            try { await checkHead(snapshot.head); }
            catch (error) { if (!(error instanceof UnsupportedMapping)) throw error; refresh = true; }
          }
          if (refresh) {
            const refreshed = await capture();
            // Never follow a changed .git/commondir pointer during refresh.
            if (!await checkMappings(snapshot.mappings)) changed();
            // Discovery comes last for unsupported inputs: do not knowingly
            // accept a mapping override introduced after the discovery we used.
            await rediscover();
            if (!await checkMappings(snapshot.mappings)) changed();
            if (!await checkMappings(refreshed.fences)) changed();
            snapshot = refreshed;
          }
          if (snapshot.supported && !await checkMappings([...snapshot.mappings, ...snapshot.configs])) changed();
        } else {
          const refreshed = await capture();
          await rediscover();
          if (!await checkMappings(refreshed.fences)) changed();
          snapshot = refreshed;
        }
        await checkPins();
      } catch (error) {
        invalid = true;
        if (error instanceof WorkspaceError && ["binding-invalid", "catalog-storage", "unknown-worktree", "unknown-workspace"].includes(error.code)) throw error;
        changed();
      }
    });
    serial = next.catch(() => {}); return next;
  };
  return { binding, get mode() { return snapshot.supported ? "metadata" : "discovery"; }, validate };
}

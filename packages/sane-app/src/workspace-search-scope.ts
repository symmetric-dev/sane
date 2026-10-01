import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceError, workspaceOperationCheck, workspaceOperationWait } from "./workspace";
import type { WorkspaceOperationOptions } from "./workspace";

export type SearchBinding = { cwd: string; bindingRevision?: string; protectedPaths?: string[] };
export type WorkspaceSearchLease = {
  binding: SearchBinding;
  validate: (operation: WorkspaceOperationOptions) => Promise<void>;
  dispose?: () => Promise<void>;
};
export type WorkspaceSearchLeaseProvider = (id: string, operation: WorkspaceOperationOptions) => Promise<WorkspaceSearchLease | undefined>;

type Identity = { dev: number; ino: number };
type Input = {
  binding: SearchBinding;
  dataDir: string;
  rootIdentity: Identity;
  gitDir: string | null;
  gitIdentity: Identity | null;
  commonDir: string | null;
  commonIdentity: Identity;
  /** Synchronous, authoritative catalog/protection check; never runs Git. */
  validateBinding: () => void;
};
type Mapping = { path: string; signature: string | null; directory: boolean };
const MAX_METADATA_BYTES = 64 * 1024, MAX_ANCESTORS = 256;
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const changed = (): never => { throw new WorkspaceError(409, "binding-invalid", "Search filesystem binding changed"); };
class UnsupportedScope extends Error {}
const unsupported = (): never => { throw new UnsupportedScope(); };
// Directory mtimes change during ordinary writes and Git operations. Only their
// identity/type is a mapping input. Files additionally fence in-place edits.
const signature = (s: Stats) => s.isDirectory()
  ? `directory:${s.dev}:${s.ino}`
  : `file:${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function optionalStat(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

/** Deliberately not a Git config parser. Accept only unambiguous syntax and
 * reject mapping overrides/includes/extensions rather than inspecting their
 * potentially unbounded, external or blocking inputs. */
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

/** Capture mapping inputs after the caller's one full discovery. The captured
 * mapping must independently agree with that pinned discovery. Unsupported
 * shapes return undefined so the caller keeps the original per-path lookup.
 * Once admitted, any mapping change fails closed: never follow new pointers. */
export async function createWorkspaceSearchLease(input: Input, operation: WorkspaceOperationOptions): Promise<WorkspaceSearchLease | undefined> {
  workspaceOperationCheck(operation);
  input.validateBinding();
  const mappings: Mapping[] = [];
  const wait = <T>(action: () => Promise<T>) => workspaceOperationWait(action, operation);
  const directory = async (path: string, expected?: Identity) => {
    const [canonical, info] = await wait(() => Promise.all([realpath(path), lstat(path)]));
    if (canonical !== path || !info.isDirectory() || info.isSymbolicLink() || (expected && !same(info, expected))) changed();
    mappings.push({ path, signature: signature(info), directory: true });
    return info;
  };
  const metadata = async (path: string, optional = false): Promise<string | null> => {
    const info = await wait(() => optionalStat(path));
    if (!info) {
      if (!optional) unsupported();
      mappings.push({ path, signature: null, directory: false });
      return null;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_METADATA_BYTES) unsupported();
    // Do not race acquisition of a descriptor: a late open after cancellation
    // would otherwise lose its owner. NONBLOCK keeps special files harmless.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      workspaceOperationCheck(operation);
      const opened = await wait(() => handle.stat());
      if (signature(opened) !== signature(info)) changed();
      const buffer = Buffer.alloc(info.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const read = await wait(() => handle.read(buffer, used, buffer.length - used, used));
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      const [after, current] = await wait(() => Promise.all([handle.stat(), lstat(path)]));
      if (used !== info.size || signature(after) !== signature(info) || signature(current) !== signature(info)) changed();
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)); }
      catch { return unsupported(); }
      mappings.push({ path, signature: signature(info), directory: false });
      return text;
    } finally { await handle.close(); }
  };
  try {
    const root = input.binding.cwd;
    await directory(root, input.rootIdentity);
    const data = await wait(() => realpath(input.dataDir));
    await directory(data);
    if (inside(data, root) || root.split(sep).some(p => [".git", ".sane"].includes(p.toLowerCase())) || input.binding.protectedPaths?.some(path => inside(path, root))) changed();
    // Re-resolve the original data selector too, not just its canonical target.
    const dataSelector = input.dataDir;
    if (input.gitDir && input.commonDir && input.gitIdentity) {
      await directory(input.gitDir, input.gitIdentity);
      await directory(input.commonDir, input.commonIdentity);
      const marker = join(root, ".git"), info = await wait(() => optionalStat(marker));
      if (!info) throw new UnsupportedScope();
      if (info.isSymbolicLink()) unsupported();
      if (info.isDirectory()) {
        if (marker !== input.gitDir || input.gitDir !== input.commonDir) unsupported();
        await directory(marker, input.gitIdentity);
      } else {
        const pointer = await metadata(marker);
        const match = /^gitdir: ([^\0\r\n]+)\n?$/.exec(pointer!);
        if (!match || resolve(root, match[1]!) !== input.gitDir) unsupported();
      }
      const commonPointer = await metadata(join(input.gitDir, "commondir"), true);
      if (commonPointer === null) {
        if (input.gitDir !== input.commonDir) unsupported();
      } else {
        if (!/^[^\0\r\n]+\n?$/.test(commonPointer) || resolve(input.gitDir, commonPointer.replace(/\n$/, "")) !== input.commonDir) unsupported();
      }
      const config = await metadata(join(input.commonDir, "config"));
      if (!simpleConfig(config!)) unsupported();
      // Worktree config support needs a larger config contract. Do not guess.
      if (await metadata(join(input.gitDir, "config.worktree"), true) !== null) unsupported();
      if (input.gitDir !== input.commonDir && await metadata(join(input.commonDir, "config.worktree"), true) !== null) unsupported();
    } else if (!input.gitDir && !input.commonDir && !input.gitIdentity) {
      // Directory discovery can begin using a newly-created ancestor repository
      // (including a bare one). Capture absence all the way to the volume root.
      let cursor = root, count = 0;
      while (true) {
        if (++count > MAX_ANCESTORS) unsupported();
        for (const name of [".git", "HEAD"]) {
          const path = join(cursor, name);
          if (await wait(() => optionalStat(path))) unsupported();
          mappings.push({ path, signature: null, directory: false });
        }
        const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
      }
    } else unsupported();
    const binding: SearchBinding = { ...input.binding, protectedPaths: [...(input.binding.protectedPaths ?? [])] };
    Object.freeze(binding.protectedPaths); Object.freeze(binding);
    let invalid = false;
    const validate = async (next: WorkspaceOperationOptions) => {
      workspaceOperationCheck(next);
      if (invalid) changed();
      try {
        input.validateBinding();
        await workspaceOperationWait(async () => {
          const canonical = await Promise.all([realpath(root), realpath(dataSelector)]);
          if (canonical[0] !== root || canonical[1] !== data) changed();
          await Promise.all(mappings.map(async mapping => {
            const info = await optionalStat(mapping.path);
            if (mapping.signature === null) { if (info) changed(); return; }
            if (!info || info.isSymbolicLink() || (mapping.directory ? !info.isDirectory() : !info.isFile()) || signature(info) !== mapping.signature) changed();
            if (mapping.directory && await realpath(mapping.path) !== mapping.path) changed();
          }));
        }, next);
        input.validateBinding();
        workspaceOperationCheck(next);
      } catch (error) {
        if (error instanceof WorkspaceError && ["search-aborted", "search-time-limit"].includes(error.code)) throw error;
        invalid = true;
        if (error instanceof WorkspaceError) throw error;
        changed();
      }
    };
    await validate(operation);
    return { binding, validate };
  } catch (error) {
    if (error instanceof UnsupportedScope) { workspaceOperationCheck(operation); return undefined; }
    if (error instanceof WorkspaceError) throw error;
    return changed();
  }
}

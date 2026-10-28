import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Exact local existence probe, independent of App run exit status. Grok's
 * documented layout is sessions/<URL-encoded-cwd>/<UUID>/, with .cwd for long
 * hashed groups. An existing incomplete/corrupt session is resumed, never
 * recreated. Unknown filesystem state fails before spawning. */
export function grokNativeSessionExists(homeRoot: string, nativeId: string, cwd: string): boolean {
  if (!isAbsolute(homeRoot) || !isAbsolute(cwd) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(nativeId)) throw new Error("Invalid Grok session probe identity");
  const root = join(homeRoot, "sessions");
  let groups: string[];
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Grok sessions root is not a direct directory");
    groups = readdirSync(root);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  let found = false;
  for (const group of groups) {
    const groupPath = join(root, group), stat = lstatSync(groupPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const path = join(groupPath, nativeId);
    try {
      const session = lstatSync(path);
      if (!session.isDirectory() || session.isSymbolicLink()) throw new Error("Existing Grok session is not a direct directory");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let groupCwd: string;
    try {
      const fd = openSync(join(groupPath, ".cwd"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("Grok working-directory evidence is not a bounded direct file");
        groupCwd = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
      } finally { closeSync(fd); }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { groupCwd = decodeURIComponent(group); } catch { throw new Error("Existing Grok session has an unresolved working-directory group"); }
    }
    if (groupCwd !== cwd || found) throw new Error("Grok native session exists in a different or ambiguous working-directory group; refusing recreation");
    found = true;
  }
  return found;
}

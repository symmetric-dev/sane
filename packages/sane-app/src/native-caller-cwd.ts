import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Harness } from "sane-core/contracts";

/** Claude hooks report the mutable shell cwd, not the admitted checkout root.
 * Keep that directory distinct from session identity: only canonical directories
 * inside the same checkout qualify, never symlink escapes or nested checkouts.
 * Other harnesses continue to require their exact admitted directory. */
export function matchesNativeCallerCwd(harness: Harness, checkout: string, cwd: string): boolean {
  if (cwd === checkout) return true;
  if (harness !== "cc" || !isAbsolute(cwd)) return false;
  const path = relative(checkout, cwd);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return false;
  try {
    if (realpathSync(checkout) !== checkout || realpathSync(cwd) !== cwd) return false;
    let cursor = checkout;
    for (const part of path.split(sep)) {
      if (part.toLowerCase() === ".git") return false;
      cursor = join(cursor, part);
      const info = lstatSync(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      try {
        lstatSync(join(cursor, ".git"));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    return true;
  } catch { return false; }
}

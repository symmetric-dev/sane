import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve the existing parent before any fixture writes. Source aliases and
 * symlinked parents cannot redirect an output into the authored checkout. */
export function externalFixtureRoot(root: string, source: string): string {
  if (!isAbsolute(root)) throw new Error("Fixture output must be absolute");
  const sourceRoot = realpathSync(source), requested = resolve(root);
  let target = join(realpathSync(dirname(requested)), basename(requested));
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error("Fixture output cannot be a symbolic link");
    target = realpathSync(target);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const rel = relative(sourceRoot, target);
  if (!rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error("Fixture output must be outside the source checkout");
  if (dirname(target) === target) throw new Error("Filesystem root cannot be a fixture output");
  return target;
}

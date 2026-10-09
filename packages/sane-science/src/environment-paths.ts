import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { ScienceEnvironmentError, type ScienceEnvironmentPaths, type ScienceWorkspace } from "./contracts.ts"

export function scienceEnvironmentPaths(workspace: ScienceWorkspace): ScienceEnvironmentPaths {
  if (!workspace.repositoryId || !isAbsolute(workspace.primaryCheckout) || resolve(workspace.primaryCheckout) !== workspace.primaryCheckout
    || workspace.stateRoot !== join(workspace.primaryCheckout, ".sane") || workspace.primaryPin.path !== workspace.primaryCheckout) {
    throw new ScienceEnvironmentError("INVALID_WORKSPACE", "Expected an initialized canonical sane-core repository context.")
  }
  const root = join(workspace.stateRoot, "science")
  return {
    root, manifest: join(root, "pyproject.toml"), lockfile: join(root, "uv.lock"), pythonVersion: join(root, ".python-version"),
    venv: join(root, ".venv"), python: join(root, ".venv", "bin", "python"), marimo: join(root, ".venv", "bin", "marimo"),
    notebooks: join(root, "notebooks"), artifacts: join(root, "artifacts"), history: join(root, "history"),
  }
}

/** Cooperative confinement like sane-core's lifecycle FS, not a hostile-process sandbox.
 * Keep synchronous ancestor checks adjacent to IO; Node lacks directory-fd traversal.
 * Do not recursively admit .sane: unrelated state and venv interpreter links are valid.
 */
export class EnvironmentFileSystem {
  readonly paths: ScienceEnvironmentPaths
  private readonly pins = new Map<string, { dev: number; ino: number }>()
  constructor(private readonly workspace: ScienceWorkspace) {
    this.paths = scienceEnvironmentPaths(workspace)
    this.directory(workspace.primaryCheckout)
    const pin = this.pins.get(workspace.primaryCheckout)!
    if (pin.dev !== workspace.primaryPin.device || pin.ino !== workspace.primaryPin.inode) this.reject(workspace.primaryCheckout)
    // Initialization is the caller's core responsibility; never create .sane here.
    this.directory(workspace.stateRoot)
  }
  private reject(path: string): never { throw new ScienceEnvironmentError("UNSAFE_PATH", `Unsafe or replaced science environment path: ${path}`) }
  private directory(path: string): void {
    const stat = lstatSync(path), previous = this.pins.get(path)
    if (!stat.isDirectory() || realpathSync(path) !== path || previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) this.reject(path)
    this.pins.set(path, { dev: stat.dev, ino: stat.ino })
  }
  check(path: string): ReturnType<typeof lstatSync> | undefined {
    if (path !== this.paths.root && !path.startsWith(`${this.paths.root}/`) || resolve(path) !== path) this.reject(path)
    this.directory(this.workspace.primaryCheckout)
    this.directory(this.workspace.stateRoot)
    const parts = path.slice(this.paths.root.length).split("/").filter(Boolean)
    let cursor = this.paths.root
    for (let i = 0; i <= parts.length; i++) {
      let stat
      try { stat = lstatSync(cursor) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.pins.has(cursor)) return undefined
        throw error
      }
      if (stat.isDirectory()) this.directory(cursor)
      else if (i < parts.length || !stat.isFile() || stat.nlink !== 1) this.reject(cursor)
      if (i === parts.length) return stat
      cursor = join(cursor, parts[i]!)
    }
  }
  mkdir(path: string): void {
    const stat = this.check(path)
    if (!stat) { mkdirSync(path, { mode: 0o700 }); this.directory(path) }
    else if (!stat.isDirectory()) this.reject(path)
  }
  read(path: string): Buffer | undefined {
    const before = this.check(path)
    if (!before) return undefined
    if (!before.isFile() || before.size > 2 * 1024 * 1024) this.reject(path)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const actual = fstatSync(fd)
      if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > 2 * 1024 * 1024) this.reject(path)
      const bytes = readFileSync(fd)
      this.check(path)
      return bytes
    } finally { closeSync(fd) }
  }
  writeExclusive(path: string, bytes: Buffer | string): void {
    if (this.check(path)) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", `Refusing to replace ${path}`)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    this.check(path)
  }
}

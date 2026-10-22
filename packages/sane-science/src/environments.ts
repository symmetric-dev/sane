import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { EnvironmentFileSystem } from "./environment-paths.ts"
import { SCIENCE_RUNTIME_POLICY, ScienceEnvironmentError, type ProvisionScienceEnvironmentOptions, type ScienceEnvironmentStatus, type ScienceWorkspace } from "./contracts.ts"

const templateRoot = fileURLToPath(new URL("../", import.meta.url))
const templateNames = ["pyproject.toml", "uv.lock", ".python-version"] as const
const lockName = ".provision.lock"
const receiptName = ".environment.json"
const ownerName = ".environment-policy"
const outputLimit = 64 * 1024

function template() {
  const files = templateNames.map(name => ({ name, bytes: readFileSync(join(templateRoot, name)) }))
  const fingerprint = createHash("sha256")
  for (const file of files) fingerprint.update(file.name).update("\0").update(file.bytes).update("\0")
  return { files, fingerprint: fingerprint.digest("hex") }
}

interface Receipt { policy: string; fingerprint: string; provisionedAt: string; python: string; marimo: string }
function receipt(fs: EnvironmentFileSystem): Receipt | undefined {
  const bytes = fs.read(join(fs.paths.root, receiptName))
  if (!bytes) return undefined
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Receipt
    if (value.policy !== "default:1" || typeof value.fingerprint !== "string" || typeof value.provisionedAt !== "string"
      || !Number.isFinite(Date.parse(value.provisionedAt)) || value.python !== SCIENCE_RUNTIME_POLICY.python || value.marimo !== SCIENCE_RUNTIME_POLICY.marimo) throw new Error("Unknown receipt")
    return value
  } catch (cause) { throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "Unrecognized environment receipt; preserve it and explicitly reconcile the environment.", { cause }) }
}

function assertTemplates(fs: EnvironmentFileSystem, expected: ReturnType<typeof template>): number {
  let present = 0
  for (const file of expected.files) {
    const bytes = fs.read(join(fs.paths.root, file.name))
    if (bytes) {
      present++
      if (!bytes.equals(file.bytes)) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", `${file.name} differs from the default managed runtime. Existing configuration was preserved; an explicit policy migration is required.`)
    }
  }
  // uv.toml takes precedence over pyproject.toml's tool.uv; never accept it silently.
  if (fs.check(join(fs.paths.root, "uv.toml"))) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "An existing uv.toml would override the managed runtime policy.")
  const previous = receipt(fs)
  if (previous && previous.fingerprint !== expected.fingerprint) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "This environment was provisioned with a different runtime policy or lock revision.")
  const owner = fs.read(join(fs.paths.root, ownerName))
  if (owner && owner.toString("utf8") !== `default:1:${expected.fingerprint}\n`) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "Existing environment ownership records a different runtime policy.")
  if (fs.check(fs.paths.venv) && !owner) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "An unmanaged .venv already exists. Refusing to reuse or replace it.")
  return present
}

/** Read-only filesystem status: does not spawn Python/uv or install anything.
 * Ready records a successful explicit provision, not a continuous package-integrity audit.
 */
export function getScienceEnvironmentStatus(workspace: ScienceWorkspace): ScienceEnvironmentStatus {
  const fs = new EnvironmentFileSystem(workspace), expected = template()
  const base = { environment: "default" as const, paths: fs.paths, policy: SCIENCE_RUNTIME_POLICY, fingerprint: expected.fingerprint }
  if (!fs.check(fs.paths.root)) return { ...base, state: "missing" }
  if (fs.check(join(fs.paths.root, lockName))) return { ...base, state: "provisioning", message: "Provisioning lock exists. After an interrupted process, confirm no provisioner is running before removing it." }
  try {
    const count = assertTemplates(fs, expected), previous = receipt(fs)
    if (count !== templateNames.length) return { ...base, state: "scaffolded", message: "Runtime scaffold is incomplete; explicit provisioning can complete matching templates." }
    if (!previous || !fs.check(fs.paths.venv) || !fs.check(fs.paths.marimo)) return { ...base, state: "scaffolded" }
    if (!fs.check(fs.paths.marimo)?.isFile()) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "The Marimo entrypoint is not a regular file.")
    assertPython(fs)
    return { ...base, state: "ready", provisionedAt: previous.provisionedAt }
  } catch (error) {
    if (error instanceof ScienceEnvironmentError && error.code === "INCOMPATIBLE_ENVIRONMENT") return { ...base, state: "incompatible", message: error.message }
    throw error
  }
}

function acquire(fs: EnvironmentFileSystem): () => void {
  fs.mkdir(fs.paths.root)
  const path = join(fs.paths.root, lockName)
  fs.check(fs.paths.root)
  try { mkdirSync(path, { mode: 0o700 }) } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new ScienceEnvironmentError("ENVIRONMENT_BUSY", "Science provisioning is already locked. Interrupted locks require manual recovery after confirming no provisioner is running.")
    throw cause
  }
  fs.check(path)
  return () => { fs.check(path); rmdirSync(path) }
}

function scaffold(fs: EnvironmentFileSystem, expected: ReturnType<typeof template>): void {
  // Preflight all existing files before creating any missing template.
  assertTemplates(fs, expected)
  for (const path of [fs.paths.notebooks, fs.paths.artifacts, fs.paths.history]) fs.mkdir(path)
  for (const file of expected.files) if (!fs.read(join(fs.paths.root, file.name))) fs.writeExclusive(join(fs.paths.root, file.name), file.bytes)
}

/** Explicit local scaffold only; never invokes a package manager. Existing files are not replaced. */
export function scaffoldScienceEnvironment(workspace: ScienceWorkspace): ScienceEnvironmentStatus {
  const fs = new EnvironmentFileSystem(workspace), release = acquire(fs)
  try { scaffold(fs, template()) } finally { release() }
  return getScienceEnvironmentStatus(workspace)
}

function childEnvironment(fs: EnvironmentFileSystem): NodeJS.ProcessEnv {
  // uv configuration, project selection and active Python environments must not leak
  // from the supervising app into this independent workspace environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(UV_|PYTHON|PIP_|CONDA|VIRTUAL_ENV$)/.test(name)))
  return { ...env, UV_PROJECT_ENVIRONMENT: fs.paths.venv, UV_NO_PROGRESS: "1", PYTHONNOUSERSITE: "1" }
}

function run(executable: string, args: string[], fs: EnvironmentFileSystem, timeout: number): Promise<string> {
  fs.check(fs.paths.root)
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd: fs.paths.root, env: childEnvironment(fs), timeout, killSignal: "SIGKILL", maxBuffer: outputLimit, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new ScienceEnvironmentError("PROVISION_FAILED", `${executable} failed: ${error.message.slice(0, 2048)}\n${stderr.slice(-8192)}`, { cause: error }))
      else resolve(stdout.trim())
    })
  })
}

function assertPython(fs: EnvironmentFileSystem): void {
  if (!fs.check(join(fs.paths.venv, "bin"))?.isDirectory()) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "Missing virtual environment bin directory.")
  // uv intentionally links this executable to its managed interpreter outside .venv.
  try {
    const stat = lstatSync(fs.paths.python), target = lstatSync(realpathSync(fs.paths.python))
    if ((!stat.isSymbolicLink() && !stat.isFile()) || !target.isFile()) throw new ScienceEnvironmentError("UNSAFE_PATH", "Invalid virtual environment interpreter.")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "The virtual environment interpreter is missing or its target is unavailable.", { cause })
    throw cause
  }
}

/** Reject redirecting pre-existing venv trees before allowing uv to mutate them.
 * Interpreter links are expected; arbitrary external directory/file links are not.
 */
function admitVenv(fs: EnvironmentFileSystem): void {
  const root = fs.check(fs.paths.venv)
  if (!root) return
  if (!root.isDirectory()) throw new ScienceEnvironmentError("UNSAFE_PATH", "The virtual environment root must be a directory.")
  let entries = 0
  const visit = (path: string): void => {
    if (++entries > 100_000) throw new ScienceEnvironmentError("UNSAFE_PATH", "Virtual environment exceeds the admission traversal limit.")
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      if (dirname(path) === join(fs.paths.venv, "bin") && /^python(?:3(?:\.12)?)?$/.test(path.slice(path.lastIndexOf("/") + 1)) && lstatSync(realpathSync(path)).isFile()) return
      const target = relative(fs.paths.venv, realpathSync(path))
      if (target && target !== ".." && !target.startsWith("../") && !isAbsolute(target)) return
      throw new ScienceEnvironmentError("UNSAFE_PATH", `Virtual environment link escapes its root: ${path}`)
    }
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
    else if (!stat.isFile() || stat.nlink !== 1) throw new ScienceEnvironmentError("UNSAFE_PATH", `Virtual environment contains a shared or special file: ${path}`)
  }
  visit(fs.paths.venv)
}

/** Explicit provisioning only. All callers/worktrees sharing the canonical root
 * serialize via mkdir; policy/lock upgrades and stale-lock recovery are manual.
 * No automatic lock resolution, app-startup install, or science DB writes.
 */
export async function provisionScienceEnvironment(workspace: ScienceWorkspace, options: ProvisionScienceEnvironmentOptions = {}): Promise<ScienceEnvironmentStatus> {
  const timeout = options.timeoutMs ?? 300_000, uv = options.uvExecutable ?? "uv"
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 900_000 || !uv || uv.includes("\0") || (uv.includes("/") && !isAbsolute(uv))) {
    throw new ScienceEnvironmentError("PROVISION_FAILED", "Expected a bounded timeout and uv executable name or absolute path.")
  }
  const fs = new EnvironmentFileSystem(workspace), expected = template(), release = acquire(fs)
  try {
    scaffold(fs, expected)
    admitVenv(fs)
    const uvVersion = await run(uv, ["--version"], fs, 15_000)
    const version = /^uv (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(uvVersion)
    if (!version || !(Number(version[1]) > 0 || Number(version[2]) > 13 || Number(version[2]) === 13 && Number(version[3]) >= 5)) {
      throw new ScienceEnvironmentError("PROVISION_FAILED", `uv >=0.13.5 is required; found ${uvVersion}`)
    }
    const ownerPath = join(fs.paths.root, ownerName)
    if (!fs.read(ownerPath)) fs.writeExclusive(ownerPath, `default:1:${expected.fingerprint}\n`)
    // Recheck after the asynchronous version probe before permitting mutations.
    assertTemplates(fs, expected)
    admitVenv(fs)
    const receiptPath = join(fs.paths.root, receiptName)
    if (receipt(fs)) { fs.check(receiptPath); unlinkSync(receiptPath) }
    // The template's virtual source '.' is relocatable because package=false and
    // there are no editable/local dependencies. Keep all three templates together.
    await run(uv, ["sync", "--locked", "--project", fs.paths.root, "--no-config", "--python", SCIENCE_RUNTIME_POLICY.python,
      "--no-build", "--no-sources", "--prerelease", "disallow", "--index-strategy", "first-index", "--default-index", "https://pypi.org/simple",
      "--exclude-newer", "1 week", "--link-mode", "copy"], fs, timeout)
    if (assertTemplates(fs, expected) !== templateNames.length) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", "Runtime templates disappeared during provisioning.")
    admitVenv(fs)
    assertPython(fs)
    if (!fs.check(fs.paths.marimo)?.isFile()) throw new ScienceEnvironmentError("PROVISION_FAILED", "uv did not create the Marimo executable.")
    const versions = await run(fs.paths.python, ["-I", "-c", "import sys, importlib.metadata; print('.'.join(map(str, sys.version_info[:3]))); print(importlib.metadata.version('marimo'))"], fs, 15_000)
    if (versions !== `${SCIENCE_RUNTIME_POLICY.python}\n${SCIENCE_RUNTIME_POLICY.marimo}`) throw new ScienceEnvironmentError("INCOMPATIBLE_ENVIRONMENT", `Provisioned runtime versions do not match the default policy: ${versions}`)
    const result: Receipt = { policy: "default:1", fingerprint: expected.fingerprint, provisionedAt: new Date().toISOString(), python: SCIENCE_RUNTIME_POLICY.python, marimo: SCIENCE_RUNTIME_POLICY.marimo }
    fs.writeExclusive(receiptPath, `${JSON.stringify(result, null, 2)}\n`)
  } finally { release() }
  return getScienceEnvironmentStatus(workspace)
}

import { dirname, join } from "node:path"
import { EnvironmentFileSystem } from "./environment-paths.ts"
import type { ScienceWorkspace } from "./contracts.ts"
import { MarimoRuntimeError } from "./marimo-runtime-contracts.ts"

// Verified against 0.25.1 _config/{utils,reader,manager,config}.py. The cwd
// .marimo.toml stops user/ancestor discovery; the nearest notebook pyproject
// supplies dotenv=[] (UserConfigManager discards an empty user-layer dotenv).
const settings = `[runtime]
auto_instantiate = false
auto_reload = "off"
reactive_tests = false
on_cell_change = "lazy"
watcher_on_save = "lazy"
dotenv = []
pythonpath = []

[package_management]
manager = "pip"

[save]
autosave = "after_delay"
autosave_delay = 1000
format_on_save = false
`

/** Managed policy files are persistent and never overwrite user configuration. */
export function admitMarimoConfiguration(workspace: ScienceWorkspace, notebookPath: string, create = false): void {
  const fs = new EnvironmentFileSystem(workspace)
  if (dirname(notebookPath) !== fs.paths.notebooks) throw new MarimoRuntimeError("UNSAFE_NOTEBOOK", "Managed notebooks must be direct children of science/notebooks.")
  const source = fs.read(notebookPath)
  if (!source || /^\s*#\s*\/\/\//m.test(source.toString("utf8"))) throw new MarimoRuntimeError("CONFIGURATION_CONFLICT", "Inline script metadata is not supported by the managed notebook policy.")
  const files = [
    [join(fs.paths.root, ".marimo.toml"), settings],
    [join(fs.paths.notebooks, "pyproject.toml"), settings.replace(/^\[/gm, "[tool.marimo.")],
  ] as const
  for (const [path, expected] of files) {
    const existing = fs.read(path)
    if (existing ? existing.toString("utf8") !== expected : !create) throw new MarimoRuntimeError("CONFIGURATION_CONFLICT", "Managed Marimo configuration is missing or differs; existing files were preserved.")
  }
  if (create) for (const [path, expected] of files) if (!fs.read(path)) fs.writeExclusive(path, expected)
}

/** Shared by server and pair; no app credentials, active venv or config overrides. */
export function marimoProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return { ...env, PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", _MARIMO_CONFIG_OVERLOAD_RUNTIME_AUTO_INSTANTIATE: "false" }
}

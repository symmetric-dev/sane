import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SCIENCE_RUNTIME_POLICY } from "../src/contracts.ts"
import { getScienceEnvironmentStatus, provisionScienceEnvironment, scaffoldScienceEnvironment } from "../src/environments.ts"
import { isolatedWorkspace } from "./isolated-workspace.ts"

// Explicit opt-in: this invokes uv and can install the locked environment.
const integration = process.env.SCIENCE_RUN_PROVISION === "1" ? test : test.skip
integration("explicit provision relocates locked runtime and preserves templates on subsequent read/scaffold", async () => {
  const fixture = isolatedWorkspace()
  let retain = false
  try {
    expect(getScienceEnvironmentStatus(fixture.workspace).state).toBe("missing")
    const provisioned = await provisionScienceEnvironment(fixture.workspace)
    console.log("PROVISION_STATUS", JSON.stringify(provisioned))
    expect(provisioned.state).toBe("ready")
    const stdout = execFileSync(provisioned.paths.python, ["-I", "-c", `
import importlib.metadata, json, sys, tomllib
from pathlib import Path
names = ("marimo", "pandas", "matplotlib")
lock = tomllib.loads(Path("uv.lock").read_text())
print(json.dumps({
    "python": ".".join(map(str, sys.version_info[:3])),
    "executable": sys.executable,
    "installed": {name: importlib.metadata.version(name) for name in names},
    "locked": {p["name"]: p["version"] for p in lock["package"] if p["name"] in names},
}))
`], { cwd: provisioned.paths.root, encoding: "utf8", timeout: 15_000 })
    console.log("PROVISION_PYTHON_STDOUT", stdout.trim())
    const versions = JSON.parse(stdout)
    expect(versions.python).toBe(SCIENCE_RUNTIME_POLICY.python)
    expect(versions.executable).toBe(provisioned.paths.python)
    expect(versions.installed.marimo).toBe(SCIENCE_RUNTIME_POLICY.marimo)
    expect(versions.installed).toEqual(versions.locked)
    expect(Object.keys(versions.installed).sort()).toEqual(["marimo", "matplotlib", "pandas"])

    const paths = [provisioned.paths.manifest, provisioned.paths.lockfile, provisioned.paths.pythonVersion, join(provisioned.paths.root, ".environment.json")]
    const evidence = () => paths.map(path => ({ path, bytes: readFileSync(path).toString("base64"), inode: statSync(path).ino, modified: statSync(path).mtimeMs }))
    const before = evidence()
    expect(getScienceEnvironmentStatus(fixture.workspace)).toEqual(provisioned)
    expect(scaffoldScienceEnvironment(fixture.workspace)).toEqual(provisioned)
    expect(getScienceEnvironmentStatus(fixture.workspace)).toEqual(provisioned)
    expect(evidence()).toEqual(before)
    if (process.env.SCIENCE_KEEP_PROVISIONED === "1") {
      const contextPath = join(fixture.root, "verification-context.json")
      writeFileSync(contextPath, `${JSON.stringify({ workspace: fixture.workspace, environment: provisioned, versions }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      retain = true
      console.log("RETAINED_VERIFICATION_CONTEXT", contextPath)
      console.log("CANONICAL_WORKSPACE", JSON.stringify(fixture.workspace))
    }
  } finally {
    if (!retain) fixture.dispose()
  }
}, 360_000)

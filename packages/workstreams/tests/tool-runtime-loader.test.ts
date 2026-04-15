import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createResolvedWorkstreamsToolRuntimeInfo,
  loadWorkstreamsToolRuntime,
  resetWorkstreamsToolRuntimeCache,
  resolveWorkstreamsRuntimeModulePath,
} from "../src/tool-runtime-loader.ts"

async function createRuntimeFixture(layout: "dev" | "dist", runtimeSource?: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), `workstream-runtime-loader-${layout}-`))
  const packageRoot = join(tempRoot, "node_modules", "@agenv", "workstreams")

  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@agenv/workstreams", version: "9.9.9-test" }),
  )

  if (layout === "dev") {
    await mkdir(join(packageRoot, "bin"), { recursive: true })
    await mkdir(join(packageRoot, "src"), { recursive: true })
    await writeFile(join(packageRoot, "bin", "work.ts"), "export {}\n")
    await chmod(join(packageRoot, "bin", "work.ts"), 0o755)
    await writeFile(
      join(packageRoot, "src", "tool-runtime.ts"),
      runtimeSource ?? "export const runtimeMarker = 'dev-runtime'\n",
    )

    return {
      tempRoot,
      packageRoot,
      resolvedWorkCommandPath: join(packageRoot, "bin", "work.ts"),
    }
  }

  await mkdir(join(packageRoot, "dist", "bin"), { recursive: true })
  await mkdir(join(packageRoot, "dist", "src"), { recursive: true })
  await writeFile(join(packageRoot, "dist", "bin", "work.js"), "export {}\n")
  await chmod(join(packageRoot, "dist", "bin", "work.js"), 0o755)
  await writeFile(
    join(packageRoot, "dist", "src", "tool-runtime.js"),
    runtimeSource ?? "export const runtimeMarker = 'dist-runtime'\n",
  )

  return {
    tempRoot,
    packageRoot,
    resolvedWorkCommandPath: join(packageRoot, "dist", "bin", "work.js"),
  }
}

describe("tool-runtime-loader", () => {
  let tempRoots: string[] = []

  beforeEach(() => {
    resetWorkstreamsToolRuntimeCache()
    tempRoots = []
  })

  afterEach(async () => {
    resetWorkstreamsToolRuntimeCache()
    await Promise.all(tempRoots.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })))
  })

  test("resolves runtime module next to a dev work binary", async () => {
    const fixture = await createRuntimeFixture("dev")
    tempRoots.push(fixture.tempRoot)

    const modulePath = resolveWorkstreamsRuntimeModulePath({
      packageRoot: fixture.packageRoot,
      resolvedWorkCommandPath: fixture.resolvedWorkCommandPath,
    })
    const runtime = await loadWorkstreamsToolRuntime({
      packageRoot: fixture.packageRoot,
      resolvedWorkCommandPath: fixture.resolvedWorkCommandPath,
      cache: false,
    })

    expect(modulePath.endsWith(join("node_modules", "@agenv", "workstreams", "src", "tool-runtime.ts"))).toBe(true)
    expect((runtime as any).runtimeMarker).toBe("dev-runtime")
  })

  test("resolves runtime module next to a dist work binary", async () => {
    const fixture = await createRuntimeFixture("dist")
    tempRoots.push(fixture.tempRoot)

    const modulePath = resolveWorkstreamsRuntimeModulePath({
      packageRoot: fixture.packageRoot,
      resolvedWorkCommandPath: fixture.resolvedWorkCommandPath,
    })
    const runtime = await loadWorkstreamsToolRuntime({
      packageRoot: fixture.packageRoot,
      resolvedWorkCommandPath: fixture.resolvedWorkCommandPath,
      cache: false,
    })

    expect(modulePath.endsWith(join("node_modules", "@agenv", "workstreams", "dist", "src", "tool-runtime.js"))).toBe(true)
    expect((runtime as any).runtimeMarker).toBe("dist-runtime")
  })

  test("builds resolved runtime diagnostics from package-side helpers", async () => {
    const fixture = await createRuntimeFixture("dist")
    tempRoots.push(fixture.tempRoot)

    const info = createResolvedWorkstreamsToolRuntimeInfo({
      toolVersion: "tool-version-test",
      toolFilePath: "/tmp/workstream.ts",
      workCommandPath: "/tmp/bin/work",
      resolvedWorkCommandPath: fixture.resolvedWorkCommandPath,
      packageRoot: fixture.packageRoot,
    })

    expect(info.toolVersion).toBe("tool-version-test")
    expect(info.toolFilePath).toBe("/tmp/workstream.ts")
    expect(info.workCommandPath).toBe("/tmp/bin/work")
    expect(info.resolvedWorkCommandPath).toBe(fixture.resolvedWorkCommandPath)
    expect(info.workstreamsPackageRoot).toBe(fixture.packageRoot)
    expect(info.workstreamsPackageVersion).toBe("9.9.9-test")
    expect(info.resolvedRuntimeModulePath?.endsWith(join("node_modules", "@agenv", "workstreams", "dist", "src", "tool-runtime.js"))).toBe(true)
    expect(info.errors).toBeUndefined()
  })
})

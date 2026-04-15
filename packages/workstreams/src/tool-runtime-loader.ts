import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"

import {
  createWorkstreamsToolRuntimeInfo,
  type WorkstreamsToolRuntimeInfo,
} from "./lib/workstream-tool/runtime-info.ts"
import { logWorkstreamToolEvent } from "./lib/workstream-tool/debug-log.ts"

export interface WorkstreamsToolRuntimeModuleResolution {
  packageRoot: string
  resolvedWorkCommandPath: string
}

export interface WorkstreamsToolRuntimeLoadOptions extends WorkstreamsToolRuntimeModuleResolution {
  cache?: boolean
}

export type WorkstreamsToolRuntimeModule = typeof import("./tool-runtime.ts")

function preferDistRuntime(resolvedWorkCommandPath: string): boolean {
  return resolvedWorkCommandPath.includes(`${join("dist", "bin")}`)
}

export function resolveWorkstreamsRuntimeModulePath(
  options: WorkstreamsToolRuntimeModuleResolution,
): string {
  logWorkstreamToolEvent("workstream.runtime-loader", "resolveWorkstreamsRuntimeModulePath:before", {
    packageRoot: options.packageRoot,
    resolvedWorkCommandPath: options.resolvedWorkCommandPath,
  })
  const candidates = preferDistRuntime(options.resolvedWorkCommandPath)
    ? [
        join(options.packageRoot, "dist", "src", "tool-runtime.js"),
        join(options.packageRoot, "src", "tool-runtime.ts"),
      ]
    : [
        join(options.packageRoot, "src", "tool-runtime.ts"),
        join(options.packageRoot, "dist", "src", "tool-runtime.js"),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      logWorkstreamToolEvent("workstream.runtime-loader", "resolveWorkstreamsRuntimeModulePath:after", {
        candidate,
      })
      return candidate
    }
  }

  throw new Error(
    `Could not locate workstream tool runtime next to active work binary. Checked: ${candidates.join(", ")}`,
  )
}

let cachedWorkstreamsToolRuntimePromise: Promise<WorkstreamsToolRuntimeModule> | undefined

export function resetWorkstreamsToolRuntimeCache(): void {
  cachedWorkstreamsToolRuntimePromise = undefined
}

export async function loadWorkstreamsToolRuntime(
  options: WorkstreamsToolRuntimeLoadOptions,
): Promise<WorkstreamsToolRuntimeModule> {
  logWorkstreamToolEvent("workstream.runtime-loader", "loadWorkstreamsToolRuntime:before", {
    cache: options.cache,
    packageRoot: options.packageRoot,
  })
  const loadRuntime = async () => {
    const modulePath = resolveWorkstreamsRuntimeModulePath(options)
    return (await import(pathToFileURL(modulePath).href)) as WorkstreamsToolRuntimeModule
  }

  if (options.cache === false) {
    const runtime = await loadRuntime()
    logWorkstreamToolEvent("workstream.runtime-loader", "loadWorkstreamsToolRuntime:after", {
      cache: false,
    })
    return runtime
  }

  cachedWorkstreamsToolRuntimePromise ??= loadRuntime()
  const runtime = await cachedWorkstreamsToolRuntimePromise
  logWorkstreamToolEvent("workstream.runtime-loader", "loadWorkstreamsToolRuntime:after", {
    cache: true,
  })
  return runtime
}

export function readWorkstreamsPackageVersion(packageRoot: string): string | undefined {
  const packageJsonPath = join(packageRoot, "package.json")
  if (!existsSync(packageJsonPath)) {
    return undefined
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version?: string
  }

  return typeof packageJson.version === "string" && packageJson.version.trim().length > 0
    ? packageJson.version
    : undefined
}

export function populateResolvedWorkstreamsToolRuntimeInfo(
  info: WorkstreamsToolRuntimeInfo,
  options: {
    workCommandPath: string
    resolvedWorkCommandPath: string
    packageRoot: string
  },
): WorkstreamsToolRuntimeInfo {
  const nextInfo: WorkstreamsToolRuntimeInfo = {
    ...info,
    workCommandPath: options.workCommandPath,
    resolvedWorkCommandPath: options.resolvedWorkCommandPath,
    workstreamsPackageRoot: options.packageRoot,
  }

  try {
    nextInfo.workstreamsPackageVersion = readWorkstreamsPackageVersion(options.packageRoot)
  } catch (error) {
    nextInfo.errors = {
      ...nextInfo.errors,
      workstreamsPackageVersion: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    nextInfo.resolvedRuntimeModulePath = resolveWorkstreamsRuntimeModulePath({
      packageRoot: options.packageRoot,
      resolvedWorkCommandPath: options.resolvedWorkCommandPath,
    })
  } catch (error) {
    nextInfo.errors = {
      ...nextInfo.errors,
      resolvedRuntimeModulePath: error instanceof Error ? error.message : String(error),
    }
  }

  return nextInfo
}

export function createResolvedWorkstreamsToolRuntimeInfo(options: {
  toolVersion: string
  toolFilePath?: string
  workCommandPath: string
  resolvedWorkCommandPath: string
  packageRoot: string
}): WorkstreamsToolRuntimeInfo {
  return populateResolvedWorkstreamsToolRuntimeInfo(
    createWorkstreamsToolRuntimeInfo({
      toolVersion: options.toolVersion,
      toolFilePath: options.toolFilePath,
    }),
    {
      workCommandPath: options.workCommandPath,
      resolvedWorkCommandPath: options.resolvedWorkCommandPath,
      packageRoot: options.packageRoot,
    },
  )
}

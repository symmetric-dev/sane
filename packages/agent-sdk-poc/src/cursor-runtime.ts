import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type CursorRipgrepConfiguration = "CURSOR_RIPGREP_PATH" | "PATH" | "unavailable"

export interface CursorRuntimeDiagnostics {
  runtime: string
  sdkEntry: "@cursor/sdk/bundled"
  sdkVersion?: string
  nativeRipgrepPath?: string
  ripgrepConfiguration: CursorRipgrepConfiguration
  ripgrepWarningStatus: "fixed" | "fallback" | "unavailable"
  publicRipgrepConfigurator: false
}

interface PackageManifest {
  name?: unknown
  version?: unknown
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function platformBinaryName(): { packageName: string; binaryName: string } | undefined {
  const packageName = `sdk-${process.platform}-${process.arch}`
  if (process.platform === "win32" && process.arch !== "x64") return undefined
  if (!["darwin", "linux", "win32"].includes(process.platform)) return undefined
  if (!["arm64", "x64"].includes(process.arch)) return undefined
  return { packageName, binaryName: process.platform === "win32" ? "rg.exe" : "rg" }
}

function sdkPackageRoot(): string | undefined {
  try {
    let current = dirname(fileURLToPath(import.meta.resolve("@cursor/sdk/bundled")))
    while (true) {
      const manifestPath = join(current, "package.json")
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest
        if (manifest.name === "@cursor/sdk") return current
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  } catch {
    return undefined
  }
}

function sdkVersion(packageRoot: string | undefined): string | undefined {
  if (!packageRoot) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest
    return typeof manifest.version === "string" ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function platformBinaryPath(packageRoot: string | undefined): string | undefined {
  const platform = platformBinaryName()
  if (!platform || !packageRoot) return undefined

  // The published layout places the platform package beside @cursor/sdk. The
  // additional ancestor forms also cover npm/pnpm layouts without importing an
  // unexported SDK subpath.
  let current = packageRoot
  while (true) {
    const candidates = [
      join(current, platform.packageName, "bin", platform.binaryName),
      join(current, "node_modules", "@cursor", platform.packageName, "bin", platform.binaryName),
    ]
    for (const candidate of candidates) if (isExecutableFile(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function pathBinary(binaryName: string): string | undefined {
  const pathValue = process.env.PATH ?? ""
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, binaryName)
    if (isExecutableFile(candidate)) return resolve(candidate)
  }
  return undefined
}

function configuredPath(): string | undefined {
  const requested = process.env.CURSOR_RIPGREP_PATH
  if (!requested) return undefined
  const candidate = resolve(requested)
  return isExecutableFile(candidate) ? candidate : undefined
}

/**
 * Configure the native ripgrep executable before the first local Agent.create.
 *
 * `configureRipgrepPath()` exists inside the SDK's bundled implementation but
 * is not a public export in the installed package. The bundled implementation
 * reads CURSOR_RIPGREP_PATH during local executor startup, so setting that
 * documented-by-implementation environment input is the least invasive
 * fallback while retaining the SDK's own native-binary discovery behavior.
 */
export function configureCursorRuntime(): CursorRuntimeDiagnostics {
  const packageRoot = sdkPackageRoot()
  const requested = configuredPath()
  const platformPath = platformBinaryPath(packageRoot)
  const nativePath = requested ?? platformPath ?? pathBinary(process.platform === "win32" ? "rg.exe" : "rg")

  if (nativePath) process.env.CURSOR_RIPGREP_PATH = nativePath

  const configuration: CursorRipgrepConfiguration = nativePath
    ? requested
      ? "CURSOR_RIPGREP_PATH"
      : platformPath
        ? "CURSOR_RIPGREP_PATH"
        : "PATH"
    : "unavailable"

  return {
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
    sdkEntry: "@cursor/sdk/bundled",
    ...(sdkVersion(packageRoot) ? { sdkVersion: sdkVersion(packageRoot) } : {}),
    ...(nativePath ? { nativeRipgrepPath: nativePath } : {}),
    ripgrepConfiguration: configuration,
    ripgrepWarningStatus: nativePath ? "fixed" : configuration === "unavailable" ? "unavailable" : "fallback",
    publicRipgrepConfigurator: false,
  }
}

// Importing the runner is the PoC process startup boundary. Run calls await the
// same immutable diagnostic snapshot and therefore cannot race configuration.
export const CURSOR_RUNTIME_DIAGNOSTICS = configureCursorRuntime()

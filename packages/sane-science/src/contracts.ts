import type { RepositoryContext } from "../../sane-core/src/contracts.ts"

/** Obtain from sane-core's ready repository availability, never from the invocation cwd. */
export type ScienceWorkspace = Pick<RepositoryContext, "repositoryId" | "primaryCheckout" | "stateRoot" | "primaryPin">

export interface ScienceEnvironmentPaths {
  root: string
  manifest: string
  lockfile: string
  pythonVersion: string
  venv: string
  python: string
  marimo: string
  notebooks: string
  artifacts: string
  history: string
}

export const SCIENCE_RUNTIME_POLICY = {
  id: "default",
  revision: 1,
  python: "3.12.14",
  marimo: "0.25.1",
} as const

export interface ScienceEnvironmentStatus {
  environment: "default"
  state: "missing" | "scaffolded" | "ready" | "incompatible" | "provisioning"
  paths: ScienceEnvironmentPaths
  policy: typeof SCIENCE_RUNTIME_POLICY
  /** Hash of the exact managed manifest, lock, and interpreter pin. */
  fingerprint: string
  provisionedAt?: string
  message?: string
}

export interface ProvisionScienceEnvironmentOptions {
  /** Executable name on PATH or absolute executable path; never a shell command. */
  uvExecutable?: string
  /** Overall bound for uv sync; defaults to five minutes, maximum fifteen minutes. */
  timeoutMs?: number
}

export type ScienceEnvironmentErrorCode = "INVALID_WORKSPACE" | "UNSAFE_PATH" | "INCOMPATIBLE_ENVIRONMENT" | "ENVIRONMENT_BUSY" | "PROVISION_FAILED"

export class ScienceEnvironmentError extends Error {
  constructor(readonly code: ScienceEnvironmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ScienceEnvironmentError"
  }
}

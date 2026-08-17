/**
 * Model utilities
 */

import type {
  ModelRuntime,
  ModelSpec,
  ResolvedModelSpec,
} from "./types.ts"

/**
 * Runtimes understood by AgENV's model resolver.
 */
export const SUPPORTED_MODEL_RUNTIMES = ["opencode", "cursor"] as const

export interface ParsedModelReference {
  model: string
  variant?: string
  /** Runtime declared by the model reference itself, if any. */
  runtime?: ModelRuntime
}

export interface ModelResolutionOptions {
  /** Explicit runtime selected by a caller, such as a CLI option. */
  runtime?: string
  /** Alias that makes the CLI-overrides-default intent explicit. */
  runtimeOverride?: string
  /** Runtime used when neither the model nor the caller declares one. */
  defaultRuntime?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function runtimeError(value: unknown, source: string): Error {
  if (value === "") {
    return new Error(`Model ${source} cannot have an empty runtime`)
  }

  return new Error(
    `Unknown model runtime "${String(value)}" in ${source}; expected "opencode" or "cursor"`,
  )
}

function parseRuntime(value: unknown, source: string): ModelRuntime {
  if (value === "opencode" || value === "cursor") {
    return value
  }

  throw runtimeError(value, source)
}

function modelReferenceError(spec: unknown): Error {
  return new Error(
    `Model reference must be a string or an object with a string "model" field; received ${typeof spec}`,
  )
}

function parseStringModelReference(spec: string): ParsedModelReference {
  const runtimeSeparator = spec.indexOf("@")
  if (runtimeSeparator === -1) {
    return { model: spec }
  }

  const model = spec.slice(0, runtimeSeparator)
  const runtimeSuffix = spec.slice(runtimeSeparator + 1)

  if (runtimeSuffix.includes("@")) {
    throw new Error(`Model reference "${spec}" contains more than one runtime suffix`)
  }

  const runtime = parseRuntime(runtimeSuffix, `model reference "${spec}"`)
  return { model, runtime }
}

/**
 * Parse model syntax without applying a default runtime or provider rules.
 *
 * String references may use `model@runtime`. Structured references keep the
 * runtime as a sibling field; embedding `@runtime` in their model field is
 * rejected so a declaration cannot be accidentally interpreted twice.
 */
export function parseModelReference(spec: ModelSpec): ParsedModelReference {
  if (typeof spec === "string") {
    return parseStringModelReference(spec)
  }

  if (!isRecord(spec) || typeof spec.model !== "string") {
    throw modelReferenceError(spec)
  }

  if (spec.model.includes("@")) {
    throw new Error(
      `Structured model "${spec.model}" must not contain a runtime suffix; use the sibling "runtime" field`,
    )
  }

  if (spec.variant !== undefined && typeof spec.variant !== "string") {
    throw new Error(`Structured model "${spec.model}" has an invalid variant; expected a string`)
  }

  const runtime =
    spec.runtime === undefined
      ? undefined
      : parseRuntime(spec.runtime, `structured model "${spec.model}"`)

  return {
    model: spec.model,
    ...(spec.variant === undefined ? {} : { variant: spec.variant }),
    ...(runtime === undefined ? {} : { runtime }),
  }
}

/**
 * Validate OpenCode's provider/model identifier shape.
 *
 * This deliberately remains separate from the legacy `isValidModelFormat`,
 * whose permissive slash check is retained for compatibility.
 */
export function isValidOpenCodeModel(model: string): boolean {
  if (typeof model !== "string" || model.length === 0) {
    return false
  }

  const parts = model.split("/")
  return (
    parts.length >= 2 &&
    parts.every((part) => part.length > 0) &&
    !/\s/.test(model)
  )
}

/**
 * Validate a Cursor model identifier.
 *
 * Cursor accepts `auto` and provider-independent IDs. IDs are intentionally
 * not restricted to a fixed allow-list because Cursor adds model IDs without
 * requiring an AgENV release. Empty, slash-qualified, whitespace-containing,
 * runtime-qualified, and punctuation-only values are malformed.
 */
export function isValidCursorModel(model: string): boolean {
  if (typeof model !== "string" || model.length === 0 || model !== model.trim()) {
    return false
  }

  if (model === "auto") {
    return true
  }

  return (
    !model.includes("/") &&
    !model.includes("@") &&
    !/\s/.test(model) &&
    /[A-Za-z0-9]/.test(model)
  )
}

/**
 * Provider-specific model validator exposed as a boolean for callers that
 * need to validate without throwing.
 */
export function isValidModelForRuntime(model: string, runtime: ModelRuntime): boolean {
  return runtime === "opencode"
    ? isValidOpenCodeModel(model)
    : runtime === "cursor"
      ? isValidCursorModel(model)
      : false
}

// Verbose aliases make the provider-specific validation contract discoverable
// while keeping the conventional `isValid*` helpers available.
export const validateOpenCodeModel = isValidOpenCodeModel
export const validateCursorModel = isValidCursorModel
export const validateModelForRuntime = isValidModelForRuntime

function getModelValidationError(model: string, runtime: ModelRuntime): string | undefined {
  if (runtime === "opencode" && !isValidOpenCodeModel(model)) {
    return `OpenCode models must use a non-empty provider/model format; received "${model}"`
  }

  if (runtime === "cursor" && !isValidCursorModel(model)) {
    return `Cursor model "${model}" is empty or malformed; expected "auto" or a non-slash model ID`
  }

  return undefined
}

function getExplicitRuntime(options: ModelResolutionOptions): ModelRuntime | undefined {
  if (options.runtime !== undefined && options.runtimeOverride !== undefined) {
    const runtime = parseRuntime(options.runtime, "runtime override")
    const runtimeOverride = parseRuntime(options.runtimeOverride, "runtime override")
    if (runtime !== runtimeOverride) {
      throw new Error(
        `Conflicting runtime overrides: "${runtime}" and "${runtimeOverride}"`,
      )
    }
    return runtime
  }

  if (options.runtimeOverride !== undefined) {
    return parseRuntime(options.runtimeOverride, "runtime override")
  }

  if (options.runtime !== undefined) {
    return parseRuntime(options.runtime, "runtime override")
  }

  return undefined
}

/**
 * Resolve a model reference to the executor-friendly shape.
 *
 * Resolution precedence is an explicit caller override, then the model
 * declaration, then the configured default, then OpenCode. The explicit
 * override is intended for batch-wide CLI/runtime selection, so it forces the
 * runtime used to validate every model candidate in that batch.
 */
export function resolveModelSpec(
  spec: ModelSpec,
  options: ModelResolutionOptions = {},
): ResolvedModelSpec {
  const parsed = parseModelReference(spec)
  const explicitRuntime = getExplicitRuntime(options)
  const defaultRuntime =
    options.defaultRuntime === undefined
      ? "opencode"
      : parseRuntime(options.defaultRuntime, "default runtime")

  const runtime = explicitRuntime ?? parsed.runtime ?? defaultRuntime
  const validationError = getModelValidationError(parsed.model, runtime)
  if (validationError) {
    throw new Error(validationError)
  }

  return {
    model: parsed.model,
    ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
    runtime,
  }
}

/** Alias emphasizing that the returned value is fully normalized. */
export const normalizeModelReference = resolveModelSpec

/**
 * Validate that model follows provider/model format.
 */
export function isValidModelFormat(model: string): boolean {
  return model.includes("/")
}

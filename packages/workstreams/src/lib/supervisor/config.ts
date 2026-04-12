/**
 * Supervisor configuration loader and validator.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import {
  SUPERVISOR_CONFIG_FILE,
  SUPERVISOR_DIFFICULTY_VALUES,
  SUPERVISOR_EFFORT_VALUES,
  SUPERVISOR_OWNERSHIP_VALUES,
  SUPERVISOR_SEVERITY_VALUES,
  type SupervisorConfig,
  type SupervisorDifficulty,
  type SupervisorEffort,
  type SupervisorEscalationThreshold,
  type SupervisorOwnership,
  type SupervisorSeverity,
} from "./types.js"

const SUPERVISOR_TOP_LEVEL_KEYS = [
  "issue_taxonomy",
  "review_limits",
  "stage_completion",
  "escalation",
] as const

const SUPERVISOR_ISSUE_TAXONOMY_KEYS = ["severity", "difficulty", "ownership", "effort"] as const
const SUPERVISOR_ESCALATION_KEYS = ["contact_user_on"] as const
const SUPERVISOR_CONTACT_USER_KEYS = [
  "severity",
  "difficulty",
  "ownership",
  "effort",
  "review_fix_limit_reached",
  "stage_completion",
] as const
const SUPERVISOR_THRESHOLD_KEYS = ["values", "min_count"] as const
const SUPERVISOR_REVIEW_LIMIT_KEYS = ["max_fix_cycles_per_batch"] as const
const SUPERVISOR_STAGE_COMPLETION_KEYS = ["stop", "contact_user"] as const

/**
 * Returns the path to work/supervisor.json.
 */
export function getSupervisorConfigPath(repoRoot: string): string {
  return join(repoRoot, "work", "supervisor.json")
}

/**
 * Returns the conservative v1 default supervisor policy.
 */
export function getDefaultSupervisorConfig(): SupervisorConfig {
  return {
    issue_taxonomy: {
      severity: [...SUPERVISOR_SEVERITY_VALUES],
      difficulty: [...SUPERVISOR_DIFFICULTY_VALUES],
      ownership: [...SUPERVISOR_OWNERSHIP_VALUES],
      effort: [...SUPERVISOR_EFFORT_VALUES],
    },
    review_limits: {
      max_fix_cycles_per_batch: 1,
    },
    stage_completion: {
      stop: true,
      contact_user: true,
    },
    escalation: {
      contact_user_on: {
        severity: {
          values: [],
          min_count: 1,
        },
        difficulty: {
          values: ["complex"],
          min_count: 1,
        },
        ownership: {
          values: ["product"],
          min_count: 1,
        },
        effort: {
          values: ["revision", "workstream"],
          min_count: 1,
        },
        review_fix_limit_reached: true,
        stage_completion: true,
      },
    },
  }
}

/**
 * Validates and normalizes a supervisor config object.
 * Throws when the config shape or values are invalid.
 */
export function validateAndNormalizeSupervisorConfig(
  rawConfig: unknown,
  configPath = SUPERVISOR_CONFIG_FILE,
): SupervisorConfig {
  const defaults = getDefaultSupervisorConfig()
  const errors: string[] = []

  if (!isPlainObject(rawConfig)) {
    throw new Error(
      `Invalid supervisor config at ${configPath}: expected a JSON object at the top level.`,
    )
  }

  assertNoUnknownKeys(rawConfig, SUPERVISOR_TOP_LEVEL_KEYS, configPath, errors)

  const issueTaxonomy = getOptionalObject(rawConfig.issue_taxonomy, `${configPath}.issue_taxonomy`, errors)
  const reviewLimits = getOptionalObject(rawConfig.review_limits, `${configPath}.review_limits`, errors)
  const stageCompletion = getOptionalObject(
    rawConfig.stage_completion,
    `${configPath}.stage_completion`,
    errors,
  )
  const escalation = getOptionalObject(rawConfig.escalation, `${configPath}.escalation`, errors)
  const contactUserOn = getOptionalObject(
    escalation?.contact_user_on,
    `${configPath}.escalation.contact_user_on`,
    errors,
  )

  if (issueTaxonomy) {
    assertNoUnknownKeys(
      issueTaxonomy,
      SUPERVISOR_ISSUE_TAXONOMY_KEYS,
      `${configPath}.issue_taxonomy`,
      errors,
    )
  }

  if (reviewLimits) {
    assertNoUnknownKeys(
      reviewLimits,
      SUPERVISOR_REVIEW_LIMIT_KEYS,
      `${configPath}.review_limits`,
      errors,
    )
  }

  if (stageCompletion) {
    assertNoUnknownKeys(
      stageCompletion,
      SUPERVISOR_STAGE_COMPLETION_KEYS,
      `${configPath}.stage_completion`,
      errors,
    )
  }

  if (escalation) {
    assertNoUnknownKeys(escalation, SUPERVISOR_ESCALATION_KEYS, `${configPath}.escalation`, errors)
  }

  if (contactUserOn) {
    assertNoUnknownKeys(
      contactUserOn,
      SUPERVISOR_CONTACT_USER_KEYS,
      `${configPath}.escalation.contact_user_on`,
      errors,
    )
  }

  const normalizedConfig: SupervisorConfig = {
    issue_taxonomy: {
      severity: normalizeTaxonomyValues(
        issueTaxonomy?.severity,
        defaults.issue_taxonomy.severity,
        SUPERVISOR_SEVERITY_VALUES,
        `${configPath}.issue_taxonomy.severity`,
        errors,
      ),
      difficulty: normalizeTaxonomyValues(
        issueTaxonomy?.difficulty,
        defaults.issue_taxonomy.difficulty,
        SUPERVISOR_DIFFICULTY_VALUES,
        `${configPath}.issue_taxonomy.difficulty`,
        errors,
      ),
      ownership: normalizeTaxonomyValues(
        issueTaxonomy?.ownership,
        defaults.issue_taxonomy.ownership,
        SUPERVISOR_OWNERSHIP_VALUES,
        `${configPath}.issue_taxonomy.ownership`,
        errors,
      ),
      effort: normalizeTaxonomyValues(
        issueTaxonomy?.effort,
        defaults.issue_taxonomy.effort,
        SUPERVISOR_EFFORT_VALUES,
        `${configPath}.issue_taxonomy.effort`,
        errors,
      ),
    },
    review_limits: {
      max_fix_cycles_per_batch: normalizeInteger(
        reviewLimits?.max_fix_cycles_per_batch,
        defaults.review_limits.max_fix_cycles_per_batch,
        `${configPath}.review_limits.max_fix_cycles_per_batch`,
        errors,
        { minimum: 0 },
      ),
    },
    stage_completion: {
      stop: normalizeBoolean(
        stageCompletion?.stop,
        defaults.stage_completion.stop,
        `${configPath}.stage_completion.stop`,
        errors,
      ),
      contact_user: normalizeBoolean(
        stageCompletion?.contact_user,
        defaults.stage_completion.contact_user,
        `${configPath}.stage_completion.contact_user`,
        errors,
      ),
    },
    escalation: {
      contact_user_on: {
        severity: normalizeThreshold(
          contactUserOn?.severity,
          defaults.escalation.contact_user_on.severity,
          SUPERVISOR_SEVERITY_VALUES,
          `${configPath}.escalation.contact_user_on.severity`,
          errors,
        ),
        difficulty: normalizeThreshold(
          contactUserOn?.difficulty,
          defaults.escalation.contact_user_on.difficulty,
          SUPERVISOR_DIFFICULTY_VALUES,
          `${configPath}.escalation.contact_user_on.difficulty`,
          errors,
        ),
        ownership: normalizeThreshold(
          contactUserOn?.ownership,
          defaults.escalation.contact_user_on.ownership,
          SUPERVISOR_OWNERSHIP_VALUES,
          `${configPath}.escalation.contact_user_on.ownership`,
          errors,
        ),
        effort: normalizeThreshold(
          contactUserOn?.effort,
          defaults.escalation.contact_user_on.effort,
          SUPERVISOR_EFFORT_VALUES,
          `${configPath}.escalation.contact_user_on.effort`,
          errors,
        ),
        review_fix_limit_reached: normalizeBoolean(
          contactUserOn?.review_fix_limit_reached,
          defaults.escalation.contact_user_on.review_fix_limit_reached,
          `${configPath}.escalation.contact_user_on.review_fix_limit_reached`,
          errors,
        ),
        stage_completion: normalizeBoolean(
          contactUserOn?.stage_completion,
          defaults.escalation.contact_user_on.stage_completion,
          `${configPath}.escalation.contact_user_on.stage_completion`,
          errors,
        ),
      },
    },
  }

  if (errors.length > 0) {
    throw new Error(formatConfigErrors(configPath, errors))
  }

  return normalizedConfig
}

/**
 * Loads work/supervisor.json or returns conservative defaults when absent.
 */
export function loadSupervisorConfig(repoRoot: string): SupervisorConfig {
  const configPath = getSupervisorConfigPath(repoRoot)

  if (!existsSync(configPath)) {
    return getDefaultSupervisorConfig()
  }

  let rawConfig: unknown

  try {
    rawConfig = JSON.parse(readFileSync(configPath, "utf-8")) as unknown
  } catch (error) {
    throw new Error(
      `Failed to parse supervisor config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return validateAndNormalizeSupervisorConfig(rawConfig, configPath)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getOptionalObject(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return undefined
  }

  return value
}

function assertNoUnknownKeys(
  object: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowedKeySet = new Set<string>(allowedKeys)

  for (const key of Object.keys(object)) {
    if (!allowedKeySet.has(key)) {
      errors.push(`${path} contains unknown key ${JSON.stringify(key)}.`)
    }
  }
}

function normalizeTaxonomyValues<TValue extends string>(
  value: unknown,
  defaults: TValue[],
  allowedValues: readonly TValue[],
  path: string,
  errors: string[],
): TValue[] {
  return normalizeEnumArray(value, defaults, allowedValues, path, errors, {
    allowEmpty: false,
  })
}

function normalizeThreshold<TValue extends string>(
  value: unknown,
  defaults: SupervisorEscalationThreshold<TValue>,
  allowedValues: readonly TValue[],
  path: string,
  errors: string[],
): SupervisorEscalationThreshold<TValue> {
  const objectValue = getOptionalObject(value, path, errors)

  if (objectValue) {
    assertNoUnknownKeys(objectValue, SUPERVISOR_THRESHOLD_KEYS, path, errors)
  }

  return {
    values: normalizeEnumArray(
      objectValue?.values,
      defaults.values,
      allowedValues,
      `${path}.values`,
      errors,
      { allowEmpty: true },
    ),
    min_count: normalizeInteger(
      objectValue?.min_count,
      defaults.min_count,
      `${path}.min_count`,
      errors,
      { minimum: 1 },
    ),
  }
}

function normalizeEnumArray<TValue extends string>(
  value: unknown,
  defaults: TValue[],
  allowedValues: readonly TValue[],
  path: string,
  errors: string[],
  options: { allowEmpty: boolean },
): TValue[] {
  if (value === undefined) {
    return [...defaults]
  }

  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings.`)
    return [...defaults]
  }

  const normalized = new Set<TValue>()

  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]

    if (typeof entry !== "string") {
      errors.push(`${path}[${index}] must be a string.`)
      continue
    }

    const normalizedValue = entry.trim().toLowerCase()

    if (normalizedValue.length === 0) {
      errors.push(`${path}[${index}] must not be empty.`)
      continue
    }

    if (!allowedValues.includes(normalizedValue as TValue)) {
      errors.push(
        `${path}[${index}] must be one of: ${allowedValues.join(", ")}. Received ${JSON.stringify(entry)}.`,
      )
      continue
    }

    normalized.add(normalizedValue as TValue)
  }

  if (normalized.size === 0 && !options.allowEmpty) {
    errors.push(`${path} must contain at least one value.`)
    return [...defaults]
  }

  return [...normalized]
}

function normalizeInteger(
  value: unknown,
  defaultValue: number,
  path: string,
  errors: string[],
  options: { minimum: number },
): number {
  if (value === undefined) {
    return defaultValue
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${path} must be an integer >= ${options.minimum}.`)
    return defaultValue
  }

  if (value < options.minimum) {
    errors.push(`${path} must be >= ${options.minimum}. Received ${value}.`)
    return defaultValue
  }

  return value
}

function normalizeBoolean(
  value: unknown,
  defaultValue: boolean,
  path: string,
  errors: string[],
): boolean {
  if (value === undefined) {
    return defaultValue
  }

  if (typeof value !== "boolean") {
    errors.push(`${path} must be a boolean.`)
    return defaultValue
  }

  return value
}

function formatConfigErrors(configPath: string, errors: string[]): string {
  return `Invalid supervisor config at ${configPath}:\n- ${errors.join("\n- ")}`
}

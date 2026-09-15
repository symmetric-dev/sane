export const SUPPORTED_WORKSTREAM_TYPES = ["feature", "foundation"] as const

export type WorkstreamType = (typeof SUPPORTED_WORKSTREAM_TYPES)[number]

export class WorkstreamTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkstreamTypeError"
  }
}

export function isSupportedWorkstreamType(value: string): value is WorkstreamType {
  return (SUPPORTED_WORKSTREAM_TYPES as readonly string[]).includes(value)
}

/** Validate a workstream type supplied by a script API or CLI. */
export function validateWorkstreamType(value: string): WorkstreamType {
  if (!isSupportedWorkstreamType(value)) {
    throw new WorkstreamTypeError(
      `Unsupported workstream type "${value}". Supported types: ${SUPPORTED_WORKSTREAM_TYPES.join(", ")}.`,
    )
  }
  return value
}

/** Parse the exact one-line workstream type metadata file format. */
export function parseWorkstreamType(content: string): WorkstreamType {
  if (!content.endsWith("\n") || content.slice(0, -1).includes("\n")) {
    throw new WorkstreamTypeError(
      "Workstream type file must contain exactly one supported lower-case value followed by a trailing newline.",
    )
  }
  return validateWorkstreamType(content.slice(0, -1))
}

import type { DomainErrorCode } from "./contracts.ts"
export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string) { super(message); this.name = "DomainError" }
}
export function fail(code: DomainErrorCode, message: string): never { throw new DomainError(code, message) }
export function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("INVALID_INPUT", `${name} must be nonempty text.`)
}
export function storageError(error: unknown): never {
  if (error instanceof DomainError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/busy|locked/i.test(message)) fail("BUSY", message)
  if (/constraint|UNIQUE|FOREIGN KEY/i.test(message)) fail("CONFLICT", message)
  fail("STORAGE_ERROR", message)
}

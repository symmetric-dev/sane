/** Unavailable APIs are tombstones, not adapters to another writable authority. */
export function unavailable(..._args: unknown[]): never {
  throw Object.assign(new Error("FEATURE_UNAVAILABLE: use the explicit core-backed ordinary CLI."), { code: "FEATURE_UNAVAILABLE" })
}
export async function unavailableCli(_args: string[]): Promise<number> {
  console.error("FEATURE_UNAVAILABLE: This entrypoint is unavailable.")
  return 1
}

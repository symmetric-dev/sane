import { parentPort, workerData } from "node:worker_threads"
import { discoverRepository, inspectRepositoryStore } from "./repository.ts"
import { DomainError } from "./errors.ts"

// One request, no native operations or mutations, and no persistent handles.
try {
  const value = workerData.operation === "discover" ? discoverRepository(workerData.path) : inspectRepositoryStore(workerData.discovery)
  parentPort!.postMessage({ value })
} catch (error) {
  parentPort!.postMessage({ error: { code: error instanceof DomainError ? error.code : "UNAVAILABLE", message: error instanceof Error ? error.message : String(error) } })
} finally { parentPort!.close() }

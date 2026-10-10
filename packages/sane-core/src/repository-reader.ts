import { Worker } from "node:worker_threads"
import type { RepositoryDiscovery, StoreAvailability } from "./contracts.ts"
import { DomainError } from "./errors.ts"

export type RepositoryReadOptions = { signal?: AbortSignal; timeoutMs?: number }
type Request = { operation: "discover"; path: string } | { operation: "inspect"; discovery: RepositoryDiscovery }
type Job = { start: () => void; cancel: () => void }

/** Bounded, read-only evidence service. Results are snapshots, never dispatch or
 * mutation capabilities. Consumers must retain their synchronous final fences.
 * Workers own and close their own read-only SQLite handles; none cross threads. */
export class RepositoryReader {
  private readonly concurrency: number
  private readonly capacity: number
  private readonly jobs = new Set<Job>()
  private readonly queue: Job[] = []
  private readonly exits = new Set<Promise<void>>()
  private active = 0
  private closed = false
  constructor(options: { concurrency?: number; capacity?: number } = {}) {
    this.concurrency = options.concurrency ?? 2
    this.capacity = options.capacity ?? 64
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8 || !Number.isSafeInteger(this.capacity) || this.capacity < this.concurrency || this.capacity > 256) throw new DomainError("INVALID_INPUT", "Invalid repository reader bounds.")
  }
  discover(path: string, options?: RepositoryReadOptions): Promise<RepositoryDiscovery> { return this.read({ operation: "discover", path }, options) }
  inspect(discovery: RepositoryDiscovery, options?: RepositoryReadOptions): Promise<StoreAvailability> { return this.read({ operation: "inspect", discovery }, options) }
  private read<T>(request: Request, options: RepositoryReadOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return Promise.reject(new DomainError("INVALID_INPUT", "Repository read deadline must be 1–30000ms."))
    if (this.closed || options.signal?.aborted) return Promise.reject(new DomainError("UNAVAILABLE", "Repository read cancelled or reader closed."))
    if (this.jobs.size >= this.capacity) return Promise.reject(new DomainError("BUSY", "Repository reader capacity exhausted."))
    // Snapshot caller-owned objects before queueing; later mutations cannot
    // silently alter which persisted binding this request inspects.
    request = structuredClone(request)
    return new Promise<T>((resolve, reject) => {
      let worker: Worker | undefined, settled = false
      const finish = (error?: Error, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer); options.signal?.removeEventListener("abort", job.cancel)
        const index = this.queue.indexOf(job)
        if (index !== -1) this.queue.splice(index, 1)
        if (error) reject(error); else resolve(value!)
        if (worker) {
          // Keep the slot occupied until exit: cancellation cannot oversubscribe
          // a still-running synchronous Git child or SQLite reader.
          void worker.terminate().catch(() => {})
        } else { this.jobs.delete(job); this.pump() }
      }
      const job: Job = {
        cancel: () => finish(new DomainError("UNAVAILABLE", "Repository read cancelled or reader closed.")),
        start: () => {
          this.active++
          try {
            worker = new Worker(new URL("./repository-reader-worker.ts", import.meta.url), { workerData: request, env: { ...process.env } })
            worker.once("message", message => {
              if (message.error) finish(new DomainError(message.error.code, message.error.message))
              else finish(undefined, message.value)
            })
            worker.once("error", error => finish(new DomainError("UNAVAILABLE", `Repository reader failed: ${String(error)}`)))
            const exited = new Promise<void>(resolve => worker!.once("exit", () => {
              finish(new DomainError("UNAVAILABLE", "Repository reader exited before returning evidence."))
              this.active--; this.jobs.delete(job); this.pump(); resolve()
            }))
            this.exits.add(exited)
            void exited.then(() => this.exits.delete(exited))
          } catch (error) {
            this.active--; finish(new DomainError("UNAVAILABLE", `Cannot start repository reader: ${String(error)}`))
          }
        },
      }
      const timer = setTimeout(() => finish(new DomainError("UNAVAILABLE", "Repository read deadline exceeded.")), timeoutMs)
      options.signal?.addEventListener("abort", job.cancel, { once: true })
      this.jobs.add(job); this.queue.push(job); this.pump()
    })
  }
  private pump() { while (!this.closed && this.active < this.concurrency && this.queue.length) this.queue.shift()!.start() }
  close(): Promise<void> {
    this.closed = true
    for (const job of this.jobs) job.cancel()
    return Promise.all([...this.exits]).then(() => {})
  }
}

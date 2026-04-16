import type {
  CurrentWorkstreamDashboardLiveUpdateEvent,
  CurrentWorkstreamDashboardObservabilitySnapshot,
  CurrentWorkstreamDashboardSnapshot,
  DashboardLiveErrorEvent,
} from "../../workstreams/src/internal/dashboard-contracts.ts"

export type LiveRefreshEvent = CurrentWorkstreamDashboardLiveUpdateEvent
export type LiveRefreshEventType = LiveRefreshEvent["event"]

export interface LiveRefreshHub {
  createResponse(signal?: AbortSignal): Response
  getSubscriberCount(): number
  publishSnapshot(snapshot: CurrentWorkstreamDashboardSnapshot): void
  publishObservability(
    observability: CurrentWorkstreamDashboardObservabilitySnapshot,
  ): void
  publishError(error: DashboardLiveErrorEvent["data"]): void
  close(): void
}

export interface LiveRefreshHubOptions {
  heartbeatIntervalMs?: number
  now?: () => Date
}

interface LiveRefreshSubscriber {
  close(): void
  emit(event: LiveRefreshEvent): void
}

function toSseChunk(event: LiveRefreshEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export function createLiveRefreshHub(
  options: LiveRefreshHubOptions = {},
): LiveRefreshHub {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
  const now = options.now ?? (() => new Date())
  const encoder = new TextEncoder()
  const subscribers = new Set<LiveRefreshSubscriber>()
  let closed = false

  const createHeartbeatEvent = (): LiveRefreshEvent => ({
    event: "heartbeat",
    data: {
      generated_at: now().toISOString(),
    },
  })

  const broadcast = (event: LiveRefreshEvent) => {
    if (closed) {
      return
    }

    for (const subscriber of subscribers) {
      subscriber.emit(event)
    }
  }

  return {
    createResponse(signal?: AbortSignal): Response {
      let subscriber: LiveRefreshSubscriber | undefined

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let connectionClosed = false
          let heartbeatTimer: ReturnType<typeof setInterval> | undefined
          let removeAbortListener: (() => void) | undefined

          const cleanup = () => {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = undefined
            }

            removeAbortListener?.()
            removeAbortListener = undefined

            if (subscriber) {
              subscribers.delete(subscriber)
            }
          }

          const closeConnection = () => {
            if (connectionClosed) {
              return
            }

            connectionClosed = true
            cleanup()

            try {
              controller.close()
            } catch {
              // Ignore stream-close races on disconnect.
            }
          }

          subscriber = {
            close: closeConnection,
            emit(event) {
              if (connectionClosed || closed) {
                return
              }

              try {
                controller.enqueue(encoder.encode(toSseChunk(event)))
              } catch {
                closeConnection()
              }
            },
          }

          if (signal) {
            if (signal.aborted) {
              closeConnection()
              return
            }

            const onAbort = () => {
              closeConnection()
            }

            signal.addEventListener("abort", onAbort, { once: true })
            removeAbortListener = () => {
              signal.removeEventListener("abort", onAbort)
            }
          }

          subscribers.add(subscriber)
          subscriber.emit(createHeartbeatEvent())

          heartbeatTimer = setInterval(() => {
            subscriber?.emit(createHeartbeatEvent())
          }, heartbeatIntervalMs)
        },
        cancel() {
          subscriber?.close()
        },
      })

      return new Response(stream, {
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        },
      })
    },
    getSubscriberCount(): number {
      return subscribers.size
    },
    publishSnapshot(snapshot): void {
      broadcast({
        event: "snapshot",
        data: snapshot,
      })
    },
    publishObservability(observability): void {
      broadcast({
        event: "observability",
        data: observability,
      })
    },
    publishError(error): void {
      broadcast({
        event: "error",
        data: error,
      })
    },
    close(): void {
      if (closed) {
        return
      }

      closed = true
      for (const subscriber of [...subscribers]) {
        subscriber.close()
      }

      subscribers.clear()
    },
  }
}

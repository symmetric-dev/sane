import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DomainError, normalizeNativeSource } from "../../sane-core/src/server.ts"
import type { NativeCaller } from "./native-caller.ts"

export const nativeBrowserToolNames = ["browser_status", "browser_snapshot", "browser_screenshot", "browser_console_logs", "browser_network_requests", "browser_navigate", "browser_click", "browser_type", "browser_scroll"] as const
export type NativeBrowserToolName = (typeof nativeBrowserToolNames)[number]

export const nativeBrowserDescriptions: Record<NativeBrowserToolName, string> = {
  browser_status: "Read the explicitly granted host browser tab and its control state. Check grantedScope ('observe' or 'control') and canMutate (boolean) to see if this session can run mutations: when grantedScope is 'control' and canMutate is true, you MAY immediately call browser_navigate, browser_click, browser_type, and browser_scroll even if control.mode is currently 'human-owned' (calling any mutation tool automatically acquires the 'agent-owned' lease). Pass generation and control.leaseGeneration from this response to mutation tools.",
  browser_snapshot: "Read a bounded accessibility snapshot of the granted tab. Returns generation, documentId, and element ref IDs such as e1. Use documentId and refs for browser_click, browser_type, and browser_scroll; use generation plus browser_status control.leaseGeneration for all mutations including browser_navigate. Navigation invalidates documentId and refs. Requires Observe or Control.",
  browser_screenshot: "Capture the granted tab as an image plus target/document metadata and savedArtifactPath, which can be passed to read to view the image. Accepts optional fullPage, format (png or jpeg), and saveArtifact (defaults to true). Defaults to a viewport PNG; full-page captures are bounded to 16,384 pixels, 5 MB, and 10 seconds. Requires Observe or Control.",
  browser_console_logs: "Read bounded console and exception history for the granted tab, with sequence cursors, collection start, and truncation metadata. Requires Observe or Control.",
  browser_network_requests: "Read bounded network request metadata for the granted tab, including sanitized URLs, failures, sequence cursors, and truncation metadata. No request/response bodies or headers. Requires Observe or Control.",
  browser_navigate: "Navigate the granted tab to an HTTP(S) URL (provide url when action is 'url'), back, forward, or reload. Requires Control and current generation/leaseGeneration from browser_status. Navigation invalidates snapshot documentId and element refs; take a new snapshot afterward. Human takeover preempts the agent and cannot be undone by this tool.",
  browser_click: "Click a current snapshot ref (provide ref and documentId), scrolling it into view, OR logical viewport x/y coordinates (provide x and y). Requires Control and current generation/leaseGeneration from browser_status. Stale references or human takeover reject the operation.",
  browser_type: "Type into the focused element or focus a current snapshot ref first. clear selects and removes existing text; submit presses Enter. Requires Control, snapshot documentId, and current generation/leaseGeneration from browser_status. Human takeover preempts typing.",
  browser_scroll: "Scroll the viewport or a current snapshot ref by deltaX/deltaY OR by direction/amount in logical pixels. Requires Control, snapshot documentId, and current generation/leaseGeneration from browser_status. Human takeover preempts scrolling.",
}

type ToolInputSchema = { type: "object"; properties: Record<string, object>; required: string[]; additionalProperties: false }
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const mutation = {
  generation: { ...integer, description: "Current generation from browser_status or the last mutation result." },
  leaseGeneration: { ...integer, description: "Current control.leaseGeneration from browser_status or the last mutation result." },
}
const document = { documentId: { ...integer, description: "Current documentId from browser_snapshot; refresh after navigation." } }
const ref = { type: "string", pattern: "^e[1-9][0-9]*$", description: "Element ref such as e1 from the current browser_snapshot." }
const cursor = { afterSeq: integer, limit: { type: "integer", minimum: 0, maximum: 500 } }
const schema = (properties: Record<string, object>, required: string[] = []): ToolInputSchema => ({ type: "object", properties, required, additionalProperties: false })

export const nativeBrowserSchemas: Record<NativeBrowserToolName, ToolInputSchema> = {
  browser_status: schema({}),
  browser_snapshot: schema({ limit: { type: "integer", minimum: 1, maximum: 500 } }),
  browser_screenshot: schema({ fullPage: { type: "boolean" }, format: { type: "string", enum: ["png", "jpeg"] }, saveArtifact: { type: "boolean" } }),
  browser_console_logs: schema({ ...cursor, severity: { type: "string", enum: ["log", "info", "warn", "error", "exception"] } }),
  browser_network_requests: schema({ ...cursor, onlyFailed: { type: "boolean" } }),
  browser_navigate: schema({ ...mutation, action: { type: "string", enum: ["url", "back", "forward", "reload"] }, url: { type: "string", maxLength: 8192 } }, ["generation", "leaseGeneration", "action"]),
  browser_click: schema({ ...mutation, ...document, ref, x: { type: "number" }, y: { type: "number" } }, ["generation", "leaseGeneration"]),
  browser_type: schema({ ...mutation, ...document, ref, text: { type: "string", maxLength: 65536 }, submit: { type: "boolean" }, clear: { type: "boolean" } }, ["generation", "leaseGeneration", "documentId", "text"]),
  browser_scroll: schema({ ...mutation, ...document, ref, deltaX: { type: "number" }, deltaY: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", minimum: 0 } }, ["generation", "leaseGeneration", "documentId"]),
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)

export async function browserNativeCaller(caller: NativeCaller, tool: NativeBrowserToolName, input: unknown, connectionFile: string, signal?: AbortSignal): Promise<unknown> {
  const source = normalizeNativeSource(caller.source)
  if (source.authorityId !== caller.authorityId || !text(caller.nativeId) || !text(caller.cwd) || !isAbsolute(caller.cwd)) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Incomplete or changed native browser caller.")
  let url: URL, token: string
  try {
    if (typeof connectionFile !== "string" || !isAbsolute(connectionFile)) throw new Error()
    const stat = lstatSync(connectionFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error()
    const connection = JSON.parse(readFileSync(connectionFile, "utf8"))
    url = new URL(connection.url)
    const endpoint = typeof connection.url === "string" && /^http:\/\/127\.0\.0\.1:([0-9]+)\/native\/handoffs$/.exec(connection.url)
    if (connection.version !== 1 || !endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535 || typeof connection.token !== "string" || !connection.token || /\s/.test(connection.token) || !Number.isSafeInteger(connection.pid) || connection.pid < 1) throw new Error()
    process.kill(connection.pid, 0)
    token = connection.token
    url.pathname = "/native/browser"
  } catch { throw new DomainError("UNAVAILABLE", "Configure a valid private local App native handoff connection file for host browser tools.") }
  const request = {
    version: 1,
    tool,
    arguments: input && typeof input === "object" && !Array.isArray(input) ? input : {},
    caller: { source: source.descriptor, authorityId: source.authorityId, nativeId: caller.nativeId, cwd: caller.cwd },
  }
  const timeout = AbortSignal.timeout(20000), transportSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response, result: unknown
  try {
    response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(request), signal: transportSignal })
    result = await response.json()
  } catch { throw new DomainError("UNAVAILABLE", "Host browser transport was interrupted or returned an invalid reply. No automatic retry was attempted; inspect browser status before retrying a mutation.") }
  const reply = result && typeof result === "object" && !Array.isArray(result) ? result as { ok?: boolean; result?: unknown; error?: string; code?: string } : {}
  if (!response.ok || reply.ok !== true) throw new DomainError("UNAVAILABLE", `${reply.code ? `[${reply.code}] ` : ""}${reply.error ?? `Host browser request rejected (HTTP ${response.status})`}`)
  if (tool === "browser_screenshot" && reply.result && typeof reply.result === "object" && !Array.isArray(reply.result)) {
    const screenshot = { ...reply.result } as Record<string, unknown>
    if (typeof screenshot.savedArtifactPath === "string" && screenshot.savedArtifactPath) {
      delete screenshot.data
      return screenshot
    }
  }
  return reply.result
}

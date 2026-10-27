import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { BROWSER_MCP_TOOLS, type BrowserMcpCredentialFile, type BrowserMcpToolName, type BrowserNativeBrokerRequest, type BrowserScreenshotResult } from "../../shared/browser-host-contract";

type ToolInputSchema = { type: "object"; properties: Record<string, object>; required: string[]; additionalProperties: false };
type ToolDefinition = { description: string; inputSchema: ToolInputSchema };

const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const mutation = {
  generation: { ...integer, description: "Current generation from browser_status or the last mutation result." },
  leaseGeneration: { ...integer, description: "Current control.leaseGeneration from browser_status or the last mutation result." },
};
const document = { documentId: { ...integer, description: "Current documentId from browser_snapshot; refresh after navigation." } };
const ref = { type: "string", pattern: "^e[1-9][0-9]*$", description: "Element ref such as e1 from the current browser_snapshot." };
const cursor = { afterSeq: integer, limit: { type: "integer", minimum: 0, maximum: 500 } };
const schema = (properties: Record<string, object>, required: string[] = []): ToolInputSchema => ({ type: "object", properties, required, additionalProperties: false });
const definitions: Record<BrowserMcpToolName, ToolDefinition> = {
  browser_status: {
    description: "Read the explicitly granted host browser tab and its control state. Check grantedScope ('observe' or 'control') and canMutate (boolean) to see if this session can run mutations: when grantedScope is 'control' and canMutate is true, you MAY immediately call browser_navigate, browser_click, browser_type, and browser_scroll even if control.mode is currently 'human-owned' (calling any mutation tool automatically acquires the 'agent-owned' lease). Pass generation and control.leaseGeneration from this response to mutation tools.",
    inputSchema: schema({}),
  },
  browser_snapshot: {
    description: "Read a bounded accessibility snapshot of the granted tab. Returns generation, documentId, and element ref IDs such as e1. Use documentId and refs for browser_click, browser_type, and browser_scroll; use generation plus browser_status control.leaseGeneration for all mutations including browser_navigate. Navigation invalidates documentId and refs. Requires Observe or Control.",
    inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 500 } }),
  },
  browser_screenshot: {
    description: "Capture the granted tab as an image plus target/document metadata and savedArtifactPath, which can be passed to read to view the image. Accepts optional fullPage, format (png or jpeg), and saveArtifact (defaults to true). Defaults to a viewport PNG; full-page captures are bounded to 16,384 pixels, 5 MB, and 10 seconds. Requires Observe or Control.",
    inputSchema: schema({ fullPage: { type: "boolean" }, format: { type: "string", enum: ["png", "jpeg"] }, saveArtifact: { type: "boolean" } }),
  },
  browser_console_logs: {
    description: "Read bounded console and exception history for the granted tab, with sequence cursors, collection start, and truncation metadata. Requires Observe or Control.",
    inputSchema: schema({ ...cursor, severity: { type: "string", enum: ["log", "info", "warn", "error", "exception"] } }),
  },
  browser_network_requests: {
    description: "Read bounded network request metadata for the granted tab, including sanitized URLs, failures, sequence cursors, and truncation metadata. No request/response bodies or headers. Requires Observe or Control.",
    inputSchema: schema({ ...cursor, onlyFailed: { type: "boolean" } }),
  },
  browser_navigate: {
    description: "Navigate the granted tab to an HTTP(S) URL (provide url when action is 'url'), back, forward, or reload. Requires Control and current generation/leaseGeneration from browser_status. Navigation invalidates snapshot documentId and element refs; take a new snapshot afterward. Human takeover preempts the agent and cannot be undone by this tool.",
    inputSchema: schema({ ...mutation, action: { type: "string", enum: ["url", "back", "forward", "reload"] }, url: { type: "string", maxLength: 8192 } }, ["generation", "leaseGeneration", "action"]),
  },
  browser_click: {
    description: "Click a current snapshot ref (provide ref and documentId), scrolling it into view, OR logical viewport x/y coordinates (provide x and y). Requires Control and current generation/leaseGeneration from browser_status. Stale references or human takeover reject the operation.",
    inputSchema: schema({ ...mutation, ...document, ref, x: { type: "number" }, y: { type: "number" } }, ["generation", "leaseGeneration"]),
  },
  browser_type: {
    description: "Type into the focused element or focus a current snapshot ref first. clear selects and removes existing text; submit presses Enter. Requires Control, snapshot documentId, and current generation/leaseGeneration from browser_status. Human takeover preempts typing.",
    inputSchema: schema({ ...mutation, ...document, ref, text: { type: "string", maxLength: 65536 }, submit: { type: "boolean" }, clear: { type: "boolean" } }, ["generation", "leaseGeneration", "documentId", "text"]),
  },
  browser_scroll: {
    description: "Scroll the viewport or a current snapshot ref by deltaX/deltaY OR by direction/amount in logical pixels. Requires Control, snapshot documentId, and current generation/leaseGeneration from browser_status. Human takeover preempts scrolling.",
    inputSchema: schema({ ...mutation, ...document, ref, deltaX: { type: "number" }, deltaY: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", minimum: 0 } }, ["generation", "leaseGeneration", "documentId"]),
  },
};

async function readCredential(path: string): Promise<BrowserMcpCredentialFile> {
  const info = await lstat(path);
  const uid = process.getuid?.();
  const safe = (stat: typeof info) => stat.isFile() && !stat.isSymbolicLink() && uid !== undefined && stat.uid === uid && (stat.mode & 0o077) === 0;
  if (!safe(info)) throw new Error("Browser credential must be a private regular file owned by the current user, not a symlink");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let credential: BrowserMcpCredentialFile;
  try {
    const current = await file.stat();
    if (!safe(current) || current.dev !== info.dev || current.ino !== info.ino) throw new Error("Browser credential file changed during validation");
    credential = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  if (!credential || credential.version !== 1 || typeof credential.url !== "string" || typeof credential.token !== "string" || !credential.token || /\s/.test(credential.token)
    || !Number.isSafeInteger(credential.pid) || credential.pid <= 0) throw new Error("Invalid version 1 browser credential");
  const endpoint = /^http:\/\/127\.0\.0\.1:([0-9]+)\/native\/browser$/.exec(credential.url);
  if (!endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535) throw new Error("Browser credential URL must be http://127.0.0.1:<port>/native/browser");
  process.kill(credential.pid, 0);
  return credential;
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function createBrowserMcpServer(credentialFile: string) {
  const listTools = () => ({ tools: BROWSER_MCP_TOOLS.map(name => ({ name, ...definitions[name] })) });
  const callTool = async (params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    try {
      const tool = typeof params.name === "string" ? params.name : "";
      if (!(BROWSER_MCP_TOOLS as readonly string[]).includes(tool)) throw new Error("Unknown browser tool");
      const credential = await readCredential(credentialFile);
      const rawArgs = params.arguments;
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
      const input: BrowserNativeBrokerRequest = { version: 1, tool: tool as BrowserMcpToolName, arguments: args };
      const response = await fetch(credential.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.token}` }, body: JSON.stringify(input), redirect: "error", signal });
      const reply = await response.json() as { ok?: boolean; result?: unknown; error?: string; code?: string };
      if (!response.ok || reply.ok !== true) throw new Error(`${reply.code ? `${reply.code}: ` : ""}${reply.error ?? `Browser broker returned HTTP ${response.status}`}`);
      if (tool === "browser_screenshot") {
        const result = reply.result as BrowserScreenshotResult;
        const { workspaceId, tabId, targetId, generation, documentId, capturedAt, mimeType, viewport, fullPage, savedArtifactPath } = result;
        return { content: [
          { type: "image", data: result.data, mimeType: result.mimeType },
          { type: "text", text: JSON.stringify({ workspaceId, tabId, targetId, generation, documentId, capturedAt, mimeType, viewport, fullPage, savedArtifactPath }, null, 2) },
        ] };
      }
      return { content: [{ type: "text", text: JSON.stringify(reply.result, null, 2) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Browser tool failed" }] }; }
  };
  const handleMessage = async (msg: JsonRpcMessage): Promise<Record<string, unknown> | null> => {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg?.id !== undefined ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid Request" } } : null;
    }
    if (msg.id === undefined) return null;
    switch (msg.method) {
      case "initialize": {
        const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05";
        return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "sane-browser", version: "1.0.0" } } };
      }
      case "ping":
        return { jsonrpc: "2.0", id: msg.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: msg.id, result: listTools() };
      case "tools/call":
        return { jsonrpc: "2.0", id: msg.id, result: await callTool(msg.params) };
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };
  const connectStdio = () => new Promise<void>(resolve => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      void (async () => {
        let parsed: JsonRpcMessage;
        try { parsed = JSON.parse(trimmed) as JsonRpcMessage; }
        catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); return; }
        const response = await handleMessage(parsed);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })();
    });
    rl.on("close", () => resolve());
  });
  return { listTools, callTool, handleMessage, connectStdio };
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--credential-file");
  const credentialFile = flag !== -1 ? process.argv[flag + 1] : process.argv[2] ?? process.env.SANE_BROWSER_MCP_CREDENTIAL_FILE;
  if (!credentialFile || credentialFile.startsWith("--")) throw new Error("Browser MCP credential file required");
  await createBrowserMcpServer(credentialFile).connectStdio();
}

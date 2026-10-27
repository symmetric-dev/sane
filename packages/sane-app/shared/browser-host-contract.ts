export const BROWSER_LIMITS = {
  maxWorkspaceContexts: 8,
  maxTabsPerWorkspace: 8,
  maxAttachmentsPerTab: 8,
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 as const },
  supportedDeviceScaleFactors: [1, 2] as const,
  idleContextReclaimMs: 30 * 60 * 1000,
  consoleMaxEntries: 500,
  consoleMaxBytes: 1024 * 1024,
  consoleEntryMaxBytes: 8 * 1024,
  networkMaxEntries: 500,
  networkMaxBytes: 1024 * 1024,
  networkUrlMaxBytes: 2 * 1024,
  screenshotMaxBytes: 5 * 1024 * 1024,
  fullPageMaxDimension: 16384,
  fullPageTimeoutMs: 10000,
  savedArtifactsMaxFiles: 50,
  savedArtifactsMaxBytes: 100 * 1024 * 1024,
  deniedPermissions: ["geolocation", "camera", "microphone", "notifications", "midi", "clipboard-read"] as const,
  redactedQueryParams: ["token", "access_token", "auth", "key", "api_key", "password", "secret", "code", "signature", "sig"] as const,
} as const;

export type BrowserCapability = { available: boolean; reason?: string; executablePath?: string };
export type BrowserTabStatus = "absent" | "starting" | "running" | "crashed" | "closed";
export type BrowserControlMode = "human-owned" | "agent-owned" | "paused" | "stopped";
export type BrowserViewport = { width: number; height: number; deviceScaleFactor: 1 | 2 };
export type BrowserDialogBanner = {
  type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string;
  url: string; dismissedAt: string;
};
export type BrowserBlockedPopup = { openerTabId: string; url: string; blockedAt: string };
export type BrowserControlState = {
  mode: BrowserControlMode; controllerAttachmentId: string | null; agentSessionId: string | null;
  leaseGeneration: number; pausedByHuman?: boolean; updatedAt: string;
};
export type BrowserDiagnosticsSummary = {
  collectionStartedAt: string | null; consoleNextSeq: number; consoleTruncatedCount: number;
  networkNextSeq: number; networkTruncatedCount: number;
};
export type BrowserTabState = {
  capability: BrowserCapability; workspaceId: string; tabId: string;
  browserContextId: string | null; targetId: string | null; status: BrowserTabStatus;
  generation: number; documentId: number; url: string; title: string; viewport: BrowserViewport;
  control: BrowserControlState; diagnostics: BrowserDiagnosticsSummary;
  viewerCount: number; screencastActive: boolean;
  lastDialog?: BrowserDialogBanner | null; lastBlockedPopup?: BrowserBlockedPopup | null; reason?: string;
};
export type BrowserGrantScope = "observe" | "control";
export type BrowserSessionGrant = {
  workspaceId: string; tabId: string; sessionId: string; harness: string;
  authorityId: string; nativeSessionId: string; scope: BrowserGrantScope;
  grantedAt: string; updatedAt: string;
};

export type BrowserConsoleSeverity = "log" | "info" | "warn" | "error" | "exception";
export type BrowserConsoleEntry = {
  seq: number; timestamp: string; severity: BrowserConsoleSeverity; text: string;
  url?: string; lineNumber?: number; columnNumber?: number; truncated?: boolean;
};
export type BrowserNetworkEntry = {
  seq: number; requestId: string; timestamp: string; method: string; url: string;
  resourceType?: string; status?: number; durationMs?: number; failed: boolean; failureText?: string;
};
export type BrowserDiagnosticsPage<T> = {
  tabId: string; targetId: string | null; generation: number; collectionStartedAt: string | null;
  earliestAvailableSeq: number; nextSeq: number; truncatedCount: number; entries: T[];
};

export type BrowserPointerEventInput = {
  type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number;
  button?: "none" | "left" | "middle" | "right" | "back" | "forward";
  buttons?: number; clickCount?: number; modifiers?: number; pointerType?: "mouse" | "pen";
};
export type BrowserWheelEventInput = { x: number; y: number; deltaX: number; deltaY: number; modifiers?: number };
export type BrowserKeyEventInput = {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key?: string; code?: string;
  text?: string; unmodifiedText?: string; modifiers?: number; windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number; autoRepeat?: boolean; isKeypad?: boolean; location?: number;
};
export type BrowserTouchEventInput = {
  type: "touchStart" | "touchEnd" | "touchMove" | "touchCancel";
  touchPoints: { x: number; y: number; id?: number; radiusX?: number; radiusY?: number; rotationAngle?: number; force?: number }[];
  modifiers?: number;
};
export type BrowserClientMessage =
  | { type: "ack"; seq: number }
  | { type: "claim" | "take" | "release" | "pause-agent" | "resume-agent"; generation: number; agentSessionId?: string }
  | { type: "navigate"; generation: number; action: "url" | "back" | "forward" | "reload"; url?: string }
  | { type: "pointer"; generation: number; event: BrowserPointerEventInput }
  | { type: "wheel"; generation: number; event: BrowserWheelEventInput }
  | { type: "key"; generation: number; event: BrowserKeyEventInput }
  | { type: "touch"; generation: number; event: BrowserTouchEventInput }
  | { type: "visibility"; visible: boolean };
export type BrowserServerMessage =
  | { type: "hello"; attachmentId: string; state: BrowserTabState }
  | { type: "frame"; seq: number; generation: number; documentId: number; format: "jpeg" | "png"; data: string; metadata: {
      offsetTop: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number;
      scrollOffsetX: number; scrollOffsetY: number; timestamp?: number;
    } }
  | { type: "state"; state: BrowserTabState }
  | { type: "dialog"; generation: number; dialog: BrowserDialogBanner }
  | { type: "popup-blocked"; generation: number; popup: BrowserBlockedPopup }
  | { type: "error"; code: string; message: string };

export type BrowserSnapshotNode = {
  ref: string; role: string; name: string; value?: string; description?: string; disabled?: boolean;
  focused?: boolean; checked?: boolean | "mixed"; bounds?: { x: number; y: number; width: number; height: number };
};
export type BrowserSnapshotResult = {
  workspaceId: string; tabId: string; targetId: string; generation: number; documentId: number;
  url: string; title: string; viewport: BrowserViewport; elements: BrowserSnapshotNode[]; truncated: boolean;
};
export type BrowserScreenshotResult = {
  workspaceId: string; tabId: string; targetId: string; generation: number; documentId: number;
  capturedAt: string; viewport: BrowserViewport; mimeType: "image/png" | "image/jpeg";
  data: string; fullPage: boolean; savedArtifactPath?: string;
};
export type BrowserStatusInput = Record<string, never>;
export type BrowserStatusResult = BrowserTabState;
export type BrowserSnapshotInput = { limit?: number };
export type BrowserScreenshotInput = { fullPage?: boolean; format?: "png" | "jpeg"; saveArtifact?: boolean };
export type BrowserConsoleLogsInput = { afterSeq?: number; limit?: number; severity?: BrowserConsoleSeverity };
export type BrowserConsoleLogsResult = BrowserDiagnosticsPage<BrowserConsoleEntry>;
export type BrowserNetworkRequestsInput = { afterSeq?: number; limit?: number; onlyFailed?: boolean };
export type BrowserNetworkRequestsResult = BrowserDiagnosticsPage<BrowserNetworkEntry>;
export type BrowserAgentMutationInput = { generation: number; leaseGeneration: number };
export type BrowserNavigateInput = BrowserAgentMutationInput & { action: "url" | "back" | "forward" | "reload"; url?: string };
export type BrowserClickInput = BrowserAgentMutationInput & ({ ref: string; documentId: number } | { x: number; y: number });
export type BrowserTypeInput = BrowserAgentMutationInput & { documentId: number; ref?: string; text: string; submit?: boolean; clear?: boolean };
export type BrowserScrollInput = BrowserAgentMutationInput & { documentId: number; ref?: string } & (
  { deltaX: number; deltaY: number } | { direction: "up" | "down" | "left" | "right"; amount: number }
);
export type BrowserMutationResult = BrowserTabState;

export const BROWSER_MCP_TOOLS = ["browser_status", "browser_snapshot", "browser_screenshot", "browser_console_logs", "browser_network_requests", "browser_navigate", "browser_click", "browser_type", "browser_scroll"] as const;
export type BrowserMcpToolName = (typeof BROWSER_MCP_TOOLS)[number];
export type BrowserMcpCredentialFile = {
  version: 1; url: string; token: string; pid: number; sessionId?: string; workspaceId?: string; tabId?: string;
};
export type BrowserNativeCaller = { source: unknown; authorityId: string; nativeId: string; cwd: string };
export type BrowserNativeBrokerRequest = { version: 1; tool: BrowserMcpToolName; arguments?: Record<string, unknown>; caller?: BrowserNativeCaller };

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let bytes = 0, result = "";
  for (const character of value) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}

export function sanitizeBrowserDiagnosticUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.href === "about:blank" ? "about:blank" : "[unsupported URL]";
    url.username = ""; url.password = "";
    const sensitive: readonly string[] = BROWSER_LIMITS.redactedQueryParams;
    const query = new URLSearchParams();
    for (const [key, value] of url.searchParams) query.append(key, sensitive.includes(key.toLowerCase()) ? "[REDACTED]" : value);
    url.search = query.toString();
    return truncateUtf8(url.href.replace(/%5BREDACTED%5D/gi, "[REDACTED]"), BROWSER_LIMITS.networkUrlMaxBytes);
  } catch { return "[invalid URL]"; }
}

const browserHost = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "");
const browserPort = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");
export function validateBrowserNavigationUrl(rawUrl: string, blockedOrigins: readonly string[]): { ok: true; url: string } | { ok: false; code: string; reason: string } {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, code: "browser-url", reason: "Expected an absolute browser URL" }; }
  if (url.href === "about:blank") return { ok: true, url: url.href };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "browser-scheme", reason: "Only HTTP, HTTPS, and about:blank are allowed" };
  if (url.username || url.password) return { ok: false, code: "browser-credentials", reason: "Browser navigation URLs must not contain credentials" };
  for (const origin of blockedOrigins) {
    let blocked: URL;
    try {
      blocked = new URL(origin.includes("://") ? origin : `http://${origin}`);
      if (!["http:", "https:"].includes(blocked.protocol) || blocked.username || blocked.password || blocked.pathname !== "/" || blocked.search || blocked.hash) throw 0;
    } catch { return { ok: false, code: "browser-origin-config", reason: "Browser navigation confinement contains an invalid origin" }; }
    if (url.origin === blocked.origin || browserHost(url) === browserHost(blocked) && browserPort(url) === browserPort(blocked)) {
      return { ok: false, code: "browser-origin", reason: "Navigation to the App control origin is blocked" };
    }
  }
  return { ok: true, url: url.href };
}

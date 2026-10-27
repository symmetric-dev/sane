# Shared local browser implementation plan

Status: decisions closed; ready for Phase 0 spike. Implementation and runtime verification have not started.

## Outcome

Run a supervised Chromium instance on the SANE host and expose an interactive
view in SANE over its existing authenticated Tailscale-facing connection. A user
on a laptop, iPad, or phone and an authorized agent operate the **same live
browser tab**. Screenshots, page observations, console output, and network
diagnostics come from that exact tab.

The client device needs no browser extension, debugging port, or agent runtime.
Browser infrastructure remains on user-owned hardware; using a cloud model is a
separate choice that can send page content outside that hardware.

## Current implementation and consequences

- [`browser-view.tsx`](../../../packages/sane-app/frontend/browser-view.tsx)
  renders sandboxed target-site iframes inside the client browser. These are not
  host-owned Chromium tabs, so the server cannot control their live DOM/session.
- [`browser-tabs.ts`](../../../packages/sane-app/frontend/browser-tabs.ts)
  stores tab IDs, URLs, aliases, and layout in device-local storage. This is not
  a shared browser-session registry.
- [`browser-pair-contract.ts`](../../../packages/sane-app/shared/browser-pair-contract.ts)
  explicitly defines passive pairing metadata, not browser-access authorization.
- [`bridge-auth.ts`](../../../packages/sane-app/src/bridge-auth.ts) provides the
  existing App authentication and Host/Origin boundary. New streaming and control
  endpoints must extend that boundary, not bypass it.
- [`terminal.ts`](../../../packages/sane-app/src/terminal.ts) and
  [`terminal-contract.ts`](../../../packages/sane-app/src/terminal-contract.ts)
  establish the repository pattern for self-contained host resource supervision,
  authenticated WebSocket upgrades, application-level ACK flow control, and
  generation-checked single-controller ownership.

Opening an existing Device Preview iframe URL in host Chromium starts a **new
live session**. It does not transfer client cookies, unsaved forms, JavaScript
state, or history. Host-mode `localhost` also resolves on the SANE host, not the
viewing phone or laptop.

## Closed architectural decisions

### 1. Viewer transport and Chromium supervision

- **Custom Bun CDP provider:** Implement a minimal, self-contained CDP
  screencast and input provider in Bun rather than adopting a heavyweight external
  browser server stack. Borrow viewer interaction lessons from Steel where useful,
  while keeping noVNC strictly as a contingency if Phase 0 proves CDP streaming
  insufficient on mobile.
- **Process model:** Supervise **one headless/offscreen Chromium process** per
  SANE host (discovering system Chrome/Chromium or a pinned local Chromium binary
  on macOS/Linux), attached over a private debugging pipe or loopback WebSocket
  (`127.0.0.1:0`). Never borrow or unlock the user's personal Chrome profile.
- **Authoritative viewport:** Each host tab uses a fixed logical viewport
  (default `1280×800`, configurable `deviceScaleFactor: 1 | 2` for bandwidth vs.
  Retina sharpness). Client viewers scale/letterbox the stream and translate
  pointer/touch coordinates into that logical space so one viewer's window resize
  never reflows the page for another viewer or agent.
- **Latency and readability targets (to verify in Phase 0):**
  - Local/LAN capture-to-display: `< 100 ms` p50, `< 200 ms` p95.
  - Tailscale remote input-to-visible-frame: `< 150 ms` p50, `< 300 ms` p95.
  - ACK-paced frame delivery: server sends `Page.screencastFrameAck` only after
    the client acknowledges frame receipt/render, preventing unbounded frame
    queues on slow mobile links.

### 2. Decoupled service boundary and harness-agnostic MCP adapter

Because `bridge.ts` is being reworked and additional CLI harnesses (such as Grok
Build and Antigravity CLI, alongside Claude Code and OpenCode) are planned:

- **Self-contained host service:** All browser supervision, target registration,
  streaming, diagnostics, and control brokering live in a dedicated module tree
  (`packages/sane-app/src/browser/`), exposing a narrow HTTP/WebSocket surface
  and an internal broker API with minimal glue in `bridge.ts`.
- **Standalone Browser MCP adapter (`sane-browser-mcp`):** Expose agent tools
  through a dedicated, harness-agnostic MCP server (supporting standard `stdio`
  and/or local Streamable HTTP) instead of coupling browser tools to
  harness-specific `PreToolUse` argument-rewriting hooks.
- **Transport-bound session credentials (no caller-supplied IDs):**
  - Never trust LLM-supplied `sessionId`, `workspaceId`, or `tabId` tool
    arguments for authorization.
  - Instead, bind identity at the MCP launch/transport boundary: when SANE
    launches or attaches a harness session, it provisions a session-scoped
    capability credential (or per-session local endpoint/token file) tied to the
    verified `(sessionId, harness, authorityId, nativeSessionId, workspaceId)`.
  - Every MCP tool call authenticates to the host Browser Broker using that
    transport credential.
  - Even with a valid transport credential, access is **deny-by-default** until
    the user explicitly enables an **Observe** or **Control** grant for that
    paired conversation in the SANE UI.

### 3. Resource quotas, timeouts, and buffer bounds

- **Process & context limits:** 1 supervised Chromium process per host; 1
  isolated in-memory `BrowserContext` per active workspace (up to 8 concurrent
  workspace contexts).
- **Tab limits:** Up to `MAX_BROWSER_TABS` (8) host tabs per workspace; 1
  actively streamed tab per viewer attachment (hidden/unviewed tabs pause
  `Page.startScreencast` immediately).
- **Idle policy:** Pause screencasting immediately when 0 viewers are attached;
  reclaim idle `BrowserContext`s after 30 minutes of zero viewer attachments and
  zero active agent grants (transitioning tabs to an explicit stopped/reclaimed
  state, never silently re-navigating).
- **Diagnostics bounds per tab generation:**
  - Console/exception ring buffer: max `500` entries or `1 MB` serialized text
    (individual entries truncated at `8 KB`).
  - Network metadata ring buffer: max `500` requests or `1 MB` (URLs sanitized
    and capped at `2 KB`; no request/response headers or bodies collected by
    default).
  - Screenshots: transient binary/base64 payloads capped at `5 MB` per capture;
    explicit full-page captures bounded to `16,384 px` max dimension and a `10 s`
    timeout.
  - Saved exports: stored only on explicit user action under ignored local App
    storage (`<dataDir>/browser-artifacts/`), capped at `50` files or `100 MB`
    total with explicit UI deletion.

### 4. Ephemeral profiles for v1

- Use **ephemeral in-memory `Target.createBrowserContext`** instances per
  workspace for the first release. Login state lives only in memory for the
  lifetime of that workspace context.
- Persistent per-workspace profile directories (`user-data-dir` isolation,
  locking, encryption/redaction, and explicit deletion UX) are deferred to a
  post-v1 follow-up.

### 5. Explicit first-release deferrals and safety blocks

- **Device Preview retained:** Keep today's iframe-based **Device preview** as
  the default mode; add **Host browser** as an explicit mode per workspace/tab.
- **Disabled browser surfaces in v1:**
  - Deny all browser permission requests (`geolocation`, `camera`, `microphone`,
    `notifications`, `midi`, `clipboard-read`).
  - Deny file downloads (`Browser.setDownloadBehavior({ behavior: "deny" })`) and
    intercept/cancel native file-chooser dialogs (`Page.setInterceptFileChooserDialog`).
  - Automatically dismiss and log JavaScript `alert`/`confirm`/`prompt`/`beforeunload`
    dialogs (`Page.javascriptDialogOpening`) while surfacing a banner in the
    viewer so neither the stream nor an agent tool call hangs indefinitely.
  - Intercept new window/popup targets (`Target.targetCreated` with `openerId`):
    do not silently expose background popups; either block or surface an explicit
    "Open popup as tab" prompt within the same workspace tab quota.
- **Origin & scheme confinement:**
  - Allow only `http:` and `https:` navigations (plus `about:blank` initial state).
  - Block navigation, redirects, and subresource framing targeting SANE's own
    authenticated control origin (`publicOrigin` and the bridge's loopback
    listener `host:port`) so host Chromium can never exercise SANE App cookies or
    internal endpoints.

---

## Architecture and module layout

```text
Laptop / iPad / phone
  SANE browser pane: canvas viewer + input capture + control & grant bar
                         |
             authenticated HTTPS / WSS over Tailscale
                         |
SANE host (packages/sane-app)
  BridgeAuth boundary (Host + Origin + sane_app cookie / local token)
    +-- BrowserService (src/browser/browser-service.ts)
          +-- ChromiumSupervisor       (src/browser/chromium-supervisor.ts)
          +-- CdpClient                (src/browser/cdp-client.ts)
          +-- BrowserContextRegistry   (src/browser/browser-context-registry.ts)
          +-- BrowserControlBroker     (src/browser/browser-control-broker.ts)
          +-- BrowserDiagnostics       (src/browser/browser-diagnostics.ts)
          +-- BrowserGrantRegistry     (src/browser/browser-grant-registry.ts)
                         |
             private local CDP pipe / loopback WS
                         |
       supervised Chromium -> workspace BrowserContext -> exact Page target

Any MCP-capable harness (Claude Code, OpenCode, Grok Build, Antigravity CLI)
  -> sane-browser-mcp (transport-bound session credential)
  -> local authenticated broker endpoint (/native/browser/*)
  -> BrowserControlBroker & BrowserDiagnostics -> same exact Page target
```

### Proposed repository files

```text
packages/sane-app/
  shared/
    browser-host-contract.ts        # State, WS protocol, grant, diagnostics, and tool schemas
    browser-pair-contract.ts        # (Existing) Passive conversation-to-tab pairing links
  src/
    browser/
      cdp-client.ts                 # Multiplexed CDP session client over private pipe/WS
      chromium-supervisor.ts        # Binary discovery, spawn, health check, process-group cleanup
      browser-context-registry.ts   # Workspace context lifecycle, tab->targetId mapping, navigation guards
      browser-control-broker.ts     # Human/agent ownership state machine & lease generation checks
      browser-diagnostics.ts        # Pre-navigation Runtime/Log/Network ring buffers & URL redaction
      browser-grant-registry.ts     # Session-scoped Observe/Control grants & revocation hooks
      browser-service.ts            # HTTP/WebSocket handlers + local broker ingress for MCP
      browser-mcp-server.ts         # Standalone harness-agnostic MCP server (stdio / HTTP)
  frontend/
    browser-view.tsx                # Mode selector (Device preview vs Host browser), toolbar, takeover UI
    browser-host-client.ts          # WebSocket frame renderer, ACK pacing, pointer/touch/IME forwarding
    browser-diagnostics-panel.tsx   # Console, exception, network inspector & screenshot export UI
```

---

## Core subsystem contracts

### 1. Identity and lifecycle (`browser-context-registry.ts`)

- **Distinct identifiers:**
  - `workspaceId`: Catalog workspace UUID.
  - `tabId`: Workspace-scoped browser tab ID.
  - `browserContextId`: Ephemeral CDP `BrowserContextID` isolated per workspace.
  - `targetId`: CDP page `TargetID`.
  - `generation`: Monotonic integer incremented on target creation, crash,
    restart, or control/lease transition.
  - `documentId`: Monotonic navigation/frame document token; invalidates any
    previously issued DOM/accessibility element references (`refId`) on
    top-level navigation or reload.
- **Explicit lifecycle transitions:**
  - `absent` -> `starting` -> `running` -> `crashed` | `closed`.
  - Client disconnects or route changes in SANE never close a `running` host tab.
  - Crashes (`Inspector.targetCrashed` or Chromium exit) transition affected tabs
    to `crashed` with a clear reason; reconnecting clients see the `crashed`
    state until the user triggers **Restart tab**.

### 2. Human and agent control broker (`browser-control-broker.ts`)

- **Control states:**
  - `human-owned`: One attached viewer (`controllerAttachmentId`) owns input;
    other human viewers are read-only until they click **Take control**.
  - `agent-owned`: An authorized conversation with an active `control` grant holds
    the mutation lease (`agentSessionId`, `leaseGeneration`).
  - `paused`: Human paused or interrupted the agent; neither agent mutations nor
    unclaimed viewer inputs run until the human types/clicks (transitioning to
    `human-owned`) or clicks **Resume agent** (minting a new `agent-owned`
    `leaseGeneration`).
  - `stopped`: Tab is not running (`absent`, `crashed`, or `closed`).
- **Preemptive human takeover:**
  - Any deliberate human action (`mousePressed`, touch start, wheel scroll, key
    press, navigation bar submit, or **Take over / Pause** button) on the
    controlling viewer atomically:
    1. Increments `leaseGeneration`.
    2. Aborts any queued or awaiting agent action in the broker.
    3. Transitions state to `human-owned` (or `paused`) **before** dispatching
       the human event to CDP.
  - Mere pointer movement (`mouseMoved`) does not revoke an agent lease.
  - Once interrupted, the agent cannot self-resume; the user must explicitly
    click **Resume agent** in SANE.

### 3. Captures and diagnostics (`browser-diagnostics.ts`)

- **Pre-navigation attachment:** Enable `Page`, `Runtime`, `Log`, and `Network`
  domains on the target session before initial `Page.navigate`, with
  `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true })`
  so child frames are captured from first byte.
- **Cursor-based querying:** Every console/exception and network record receives
  a per-generation monotonic `seq` and `timestamp`. Responses include:
  - `tabId`, `targetId`, `generation`, `collectionStartedAt`
  - `earliestAvailableSeq`, `nextSeq`, `truncatedCount`
  - `entries` filtered by optional `afterSeq`, `limit`, and `severity` / `onlyFailed`.
- **Sanitization:** Strip userinfo (`user:pass@`) and redact sensitive query
  parameters (`token`, `access_token`, `auth`, `key`, `api_key`, `password`,
  `secret`, `code`, `signature`, `sig`) before storing URLs in the network ring
  buffer.

### 4. Agent MCP tools (`browser-mcp-server.ts`)

All tools resolve the target exclusively through the caller's verified session
grant—never via arbitrary URL lookup or raw CDP attachment.

| Tool | Required Grant | Purpose & Behavior |
|---|---|---|
| `browser_status` | `observe` | Returns authorized `(workspaceId, tabId, generation, documentId, url, title, viewport)`, control state (`human-owned`, `agent-owned`, `paused`), and diagnostics cursor summary. |
| `browser_snapshot` | `observe` | Returns a bounded accessibility/DOM interactive element tree for the current `documentId`, assigning stable `ref` IDs (`e1`, `e2`, …) bound to `(targetId, generation, documentId)`. |
| `browser_screenshot` | `observe` | Captures viewport (default) or bounded full-page PNG/JPEG from the exact target, returning image content plus `(tabId, generation, documentId, capturedAt, viewport)`. |
| `browser_console_logs` | `observe` | Queries bounded console/exception history by `afterSeq`, `severity`, and `limit`, including truncation metadata. |
| `browser_network_requests` | `observe` | Queries sanitized network request metadata (method, redacted URL, status, resourceType, durationMs, failureText) by `afterSeq`, `onlyFailed`, and `limit`. |
| `browser_navigate` | `control` | Navigates (`url`, `back`, `forward`, or `reload`) under a valid agent lease; updates `documentId` and invalidates prior element `ref`s. |
| `browser_click` | `control` | Clicks an element by `ref` (verifying `documentId` and scrolling into view) or logical `(x, y)` coordinates, checking `leaseGeneration` at dispatch. |
| `browser_type` | `control` | Focuses target `ref` (if provided) and types/fills text with optional `submit`/`clear`, checking `leaseGeneration` before each step. |
| `browser_scroll` | `control` | Scrolls the viewport or a scrollable `ref` by `(deltaX, deltaY)` or direction/amount under lease verification. |

---

## Delivery phases

### Phase 0 — Viewer and CDP transport spike

- Build a minimal prototype of `chromium-supervisor.ts`, `cdp-client.ts`, and a
  test viewer surface using `Page.startScreencast` + ACK pacing and `Input.*`
  forwarding.
- Test coordinate mapping, Retina scaling, touch scrolling, virtual keyboard /
  IME text entry, and modifier key release on disconnect across desktop and
  mobile/iPad over Tailscale.
- Verify that a site blocking iframe embedding (`X-Frame-Options: DENY` or CSP
  `frame-ancestors`) renders and interacts cleanly, and that transient unsaved
  input state is shared across two viewers and a CDP snapshot.
- **Gate:** Laptop and iPad/phone meet the latency/interaction targets on the
  same target without creating extra pages. (Browser/runtime verification runs
  only when explicitly requested by the user.)

### Phase 1 — Supervised browser, registry, and navigation confinement

- Implement `shared/browser-host-contract.ts`, `chromium-supervisor.ts`,
  `cdp-client.ts`, and `browser-context-registry.ts`.
- Enforce workspace `BrowserContext` isolation, scheme/origin guards (blocking
  SANE's own origin and non-HTTP(S) schemes), download/file-chooser/permission
  blocks, and crash/close state transitions.
- **Gate:** Reconnecting or switching clients resolves the exact live target and
  generation; crashes and blocked navigations produce explicit states rather than
  silent recreation.

### Phase 2 — Interactive SANE viewer and human/agent control broker

- Implement `browser-control-broker.ts`, `browser-service.ts` WebSocket streaming,
  and `frontend/browser-host-client.ts`.
- Update `frontend/browser-view.tsx` with the **Device preview** vs. **Host
  browser** mode switch, live address/navigation bar, locality badge, single-human
  claim/takeover controls, and Pause / Take over / Resume agent bar.
- Implement visibility-aware screencast pausing when no active viewers are
  watching.
- **Gate:** Remote human input drives the host tab; non-owning viewers cannot
  type or resize; deliberate human input immediately revokes an active agent
  lease.

### Phase 3 — Screenshots and pre-navigation diagnostics

- Implement `browser-diagnostics.ts` with pre-navigation `Runtime`, `Log`, and
  `Network` collectors, child-frame auto-attach, URL sanitization, and bounded
  cursor ring buffers.
- Add native target screenshot capture and explicit local artifact export under
  `<dataDir>/browser-artifacts/`.
- Build `frontend/browser-diagnostics-panel.tsx` so the user can inspect console
  logs, uncaught exceptions, failed network requests, and saved captures in the
  App.
- **Gate:** Console messages, exceptions, failed requests, and screenshots map to
  the exact `(tabId, generation)` and explicitly report buffer truncation or
  collection start boundaries.

### Phase 4 — Session-scoped grants and standalone MCP integration

- Implement `browser-grant-registry.ts` and add explicit **Observe** / **Control**
  grant controls to the Browser Pair toolbar/dialog without altering the passive
  meaning of `browser-pairs.json`.
- Build `browser-mcp-server.ts` with transport-bound session credentials and
  brokered read/mutation tools (`browser_status`, `browser_snapshot`,
  `browser_screenshot`, `browser_console_logs`, `browser_network_requests`,
  `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`).
- Wire the first harness end-to-end, then enable additional harnesses through the
  same MCP server and credential handshake.
- **Gate:** User and agent observe the same transient DOM state; agent mutations
  stream live to the viewer; human click/keypress immediately preempts the agent
  lease; revoked or wrong-workspace sessions are rejected.

### Phase 5 — Hardening, quota enforcement, and opt-in rollout

- Connect `BridgeAuth.logout` to disconnect all browser viewer WebSockets and
  revoke active session grants.
- Enforce the 30-minute idle context reclamation policy, saved-artifact storage
  quotas, and bounded process-group shutdown on bridge exit.
- Add an explicit **"Open URL in Host Browser"** action from Device Preview with
  clear disclosure that it starts a fresh host session without transferring
  client cookies or DOM state.
- Document Tailscale HTTPS/WSS setup, host `localhost` semantics, and the rollback
  flag (`SANE_HOST_BROWSER=0`) that disables new host sessions while preserving
  Device Preview.

---

## Validation plan and definition of done

Follow repository policy: run or write tests and perform browser verification
**only when explicitly asked**, using focused checks rather than a full suite.

- **Remote Tailscale UX:** Laptop, iPad, and phone typing, touch scrolling, focus,
  virtual keyboard/IME, coordinate scaling, background/resume, and reconnect.
- **Exact-target identity:** Unsaved form state survives a client switch;
  screenshots, snapshots, diagnostics, and both input paths report identical
  `(tabId, targetId, generation)`.
- **Control races:** Human click during an agent action, queued agent mutations,
  expired/revoked grants, two human viewers competing for control, disconnected
  owners, and explicit **Resume agent**.
- **Isolation and security:** Wrong workspace/session, forged tool arguments,
  unauthenticated WebSocket or missing Origin, logout revocation, blocked SANE
  control-origin navigation (direct, redirect, popup), and zero tailnet exposure
  of raw CDP.
- **Lifecycle and bounds:** Navigation invalidates element `ref`s (`documentId`
  mismatch); target crash invalidates leases; slow viewers trigger ACK
  backpressure without memory growth; log buffers report `truncatedCount`.

Done means an authorized user on another device can interact with a host-owned
Chromium tab inside SANE, grant observation or control to a paired agent across
any supported harness via the standalone Browser MCP, take control back
instantly by clicking or typing, and inspect captures and diagnostics from that
exact live tab.

## References

- [Repository research and alternatives](../../../reports/Local%20shared%20browser%20control.md)
- [Terminal service reference pattern](../../../packages/sane-app/src/terminal.ts)
- [CDP Page APIs](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
  and [Input APIs](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [Playwright CDP attachment](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Steel local browser](https://github.com/steel-dev/steel-browser)
- [noVNC](https://github.com/novnc/noVNC)

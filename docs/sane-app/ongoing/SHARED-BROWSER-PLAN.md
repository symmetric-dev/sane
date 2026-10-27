# Shared local browser implementation plan

Status: proposed; implementation and runtime verification have not started.

## Outcome

Run Chromium on the SANE host and expose an interactive view in SANE over its
existing authenticated Tailscale-facing connection. A user on a laptop, iPad, or
phone and an authorized agent operate the **same live browser tab**. Screenshots,
page observations, console output, and network diagnostics come from that tab.

The client device needs no browser extension, debugging port, or agent runtime.
Browser infrastructure remains on user-owned hardware; using a cloud model is a
separate choice that can send page content outside that hardware.

## Current implementation and consequences

- [`browser-view.tsx`](../../../packages/sane-app/frontend/browser-view.tsx)
  renders sandboxed target-site iframes inside the client browser. These are not
  host-owned Chromium tabs, so the server cannot control their live DOM/session.
- [`browser-tabs.ts`](../../../packages/sane-app/frontend/browser-tabs.ts)
  stores tab IDs, URLs, aliases, and layout in device-local storage. This is not a
  shared browser-session registry.
- [`browser-pair-contract.ts`](../../../packages/sane-app/shared/browser-pair-contract.ts)
  explicitly defines passive pairing metadata, not browser-access authorization.
- [`bridge-auth.ts`](../../../packages/sane-app/src/bridge-auth.ts) provides the
  existing App authentication and Host/Origin boundary. New streaming and control
  endpoints must extend that boundary, not bypass it.

Opening the old iframe URL in host Chromium starts a **new live session**. It does
not transfer client cookies, unsaved forms, JavaScript state, or history. Host-mode
`localhost` also means the SANE host, not the viewing phone or laptop.

## Scope and initial decisions

1. Add an explicit **host browser** mode; retain **device preview** as the existing
   iframe mode during rollout. Label the execution location and capabilities.
2. Start with one supervised Chromium process and isolated workspace browser
   contexts. Keep login state in memory initially; persistent profiles are a
   follow-up with an explicit storage/isolation design. Never borrow a personal
   Chrome profile.
3. Prefer CDP page screencasting plus input forwarding behind a small provider
   interface. Evaluate an existing local viewer, including Steel, before choosing
   a dependency. Keep noVNC as a fallback if the viewer cannot meet interaction
   requirements. Do not build both transports for the first release.
4. Begin with one active streamed tab and one human input owner; other clients
   can view. Add broader tab/grid support after correctness and mobile input.
5. Ship one session-scoped agent adapter first, then connect other harnesses to
   the same control service. Do not launch a second browser for the adapter.
6. Require explicit authorization separate from Browser Pair. All agent mutations
   must pass through the control broker so human takeover actually works.

Non-goals for the first release: attaching to arbitrary client browsers, native
Electron/CEF embedding, whole-desktop access, cloud browser services, continuous
video recording, arbitrary JavaScript evaluation, unrestricted network bodies,
and seamless migration of existing iframe state.

## Architecture

```text
Laptop / iPad / phone
  SANE browser pane: page pixels + input + control status
                         |
             authenticated HTTPS / WSS over Tailscale
                         |
SANE host
  App boundary / browser gateway
    +-- workspace/tab registry and authorization
    +-- human/agent control broker
    +-- viewer stream and input forwarding
    +-- screenshot / observation / diagnostics service
                         |
             private local CDP connection
                         |
       supervised Chromium -> context -> exact live target

Agent harness -> scoped local tool adapter -> same broker and target
```

The browser UI, screenshot tools, diagnostics, and agent actions resolve through
one authoritative mapping. Never find the target by URL or select the first page
returned by an automation library.

### Identity and lifecycle

- Use server-owned browser session and tab IDs, scoped to a workspace. Associate
  each tab with a browser context, target ID, and process/session generation.
- Distinguish SANE/native conversation IDs, browser session IDs, CDP target IDs,
  and MCP adapter page IDs. They are not interchangeable.
- Scope an agent grant to the verified harness conversation, workspace, browser
  session, permitted tabs, capabilities, and expiry. Caller-supplied IDs alone
  must not grant access. Revocation invalidates active tool connections.
- Preserve live tabs across client disconnects and frontend view changes. Close
  them only on an explicit lifecycle action or a disclosed idle/resource policy.
- Invalidate stale targets, document references, and action leases on closure,
  replacement, or browser crash. Reconnection must not silently create another
  page or replay input. Navigation invalidates document-bound element references.
- Track actual navigation/title/back-forward state on the host. Device-local
  active-tab/layout preferences can remain local; host tab identity cannot.
- Treat popups as new targets requiring explicit registration and authorization;
  do not accidentally expose another workspace's page.

### Human and agent interaction

- Model control as explicit states: human-owned, agent-owned, paused, and stopped.
  One viewer may own human input; additional viewers are read-only until takeover.
- A deliberate human click, touch, keypress, or takeover action revokes the agent's
  mutation lease before human input is dispatched. Pointer movement alone should
  not interrupt the agent. Require explicit **Resume agent** afterward.
- Check a lease generation at action dispatch, not just when a request starts.
  Cancel queued actions and avoid long opaque action batches. An already sent
  browser action cannot necessarily be undone; display takeover as pending until
  the current dispatch boundary is safe.
- Route navigation, clicks, typing, scrolling, uploads, and any future evaluation
  through the same broker. Raw CDP access would bypass these guarantees.
- Keep one authoritative viewport per target. Initially use a fixed logical
  viewport, scale/letterbox on clients, and translate input to that coordinate
  space. A viewer resize must not unexpectedly reflow the page for another user.
- Handle touch scrolling, browser focus, virtual keyboards, composition/IME,
  modifiers, wheel events, and key/button release on disconnect. Do not assume
  mouse-coordinate support is sufficient for mobile.
- Expose user-visible back/forward, reload, connection state, execution location,
  current controller, and Pause / Take over / Resume controls.

### Captures and diagnostics

- Use native page screenshots from the registered target for viewport/full-page
  captures. These capture the target page, not the outer SANE interface or browser
  toolbar. Full-page capture is an explicit operation with size/time limits.
- Return capture time, browser session/tab ID, generation, and viewport metadata.
  A stream frame and a later screenshot are not guaranteed to be the same instant.
- Treat screenshots as sensitive. Saving/exporting them is explicit; transient
  agent captures still require observation permission and model-egress disclosure.
  Do not claim complete secret redaction from images.
- Subscribe to console, exceptions, and network events before initial navigation.
  Cover relevant child frames and report any worker/target collection limits.
- Maintain bounded, timestamped per-session buffers with sequence cursors, severity
  filters, truncation/drop indicators, request correlation, and collection start
  time. State clearly when earlier history is unavailable.
- Network metadata includes method, sanitized URL, status, duration, and failures.
  Do not collect headers or request/response bodies by default. Redact sensitive
  URL fields and structured values before buffering; console strings can still
  contain secrets, so bound access and warn users.
- Keep live diagnostics ephemeral initially. Explicit saved captures/exports use
  ignored local App artifact storage, scoped access, retention, and deletion.
  Do not put page data, credentials, or profiles in version-controlled workstreams.
- Browser console output is not backend application logs. Integrate backend logs
  separately if requested. A live viewer is not a retained video recording.

### Agent tools

Proposed operations, with final names determined during implementation:

| Operation | Purpose |
|---|---|
| `browser_status` | Identify the authorized tab, generation, and control owner |
| `browser_snapshot` | Get bounded DOM/accessibility observations |
| `browser_screenshot` | Capture the same live target |
| `browser_console_logs` | Query bounded console/exception history by cursor |
| `browser_network_requests` | Query sanitized request metadata by cursor |
| `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll` | Brokered mutations under a valid agent lease |

Expose tools in the authorized agent's native session through a local MCP adapter
or equivalent harness integration. Tool availability must follow actual grant
state; a saved pair link or a general-purpose Chrome DevTools MCP does not prove
access. Read tools are on-demand, not an unbounded log feed into model context.
Browser-use or an existing MCP can be reused only if its target selection and
mutation path respect the broker; direct unrestricted attachment is not the MVP.

### Security and deployment

- Keep raw CDP on a private pipe or loopback endpoint never forwarded by Tailscale.
  Loopback is not authentication; protect the local tool gateway too.
- Authenticate viewer connections, validate WebSocket Origin, authorize session
  subscriptions and every operation, and disconnect viewers/tools on revocation
  or logout. Avoid long-lived secrets in stream URLs, browser history, or logs.
- Maintain Chromium sandboxing and updates. Do not use `--no-sandbox` as a default.
- Isolate workspace cookie/storage contexts. Treat browsing as access to the
  host's network: disclose access to local development services, restrict schemes
  and sensitive destinations, and do not grant arbitrary file access. Context
  isolation is not a hostile-site OS security boundary.
- Deny navigation to SANE's authenticated control origin and avoid leaking App
  credentials into the automated browser. Account for redirects/popups as well
  as address-bar input. Never expose control tokens to the preview page.
- Disable unattended permission grants, downloads, file uploads, clipboard reads,
  and device access until their consent and transfer flows exist. Never accept an
  arbitrary host filesystem path from a remote client or unscoped agent.
- Keep artifacts, profiles, and telemetry local by default. Disclose cloud-model
  egress separately; local browser execution is not a promise of local inference.

## Delivery phases

### Phase 0 — choose and prove the viewer path

- Evaluate a minimal native host Chromium + CDP stream against a reusable local
  viewer. Review licensing, dependencies, telemetry, and macOS operation. Inspect
  noVNC only as a fallback, including its Linux VM/container cost on macOS.
- Propose desktop and mobile latency/readability budgets before implementation;
  record measured capture-to-display and input-to-visible-update results later.
- Prove that one transient form value is visible to both the viewer and an agent
  observation on the same target. Include one site that rejects target-site iframe
  embedding to distinguish streaming from today's iframe mode.
- Gate: laptop and iPad/phone can click, type, and scroll without creating another
  browser target. If mobile input or latency fails, settle the transport before
  expanding the implementation. This validation requires explicit permission.

### Phase 1 — supervised browser and shared registry

- Add the browser supervisor/provider, isolated contexts, target registry, resource
  limits, crash handling, and server-owned workspace/tab metadata.
- Introduce contracts separately from the passive Browser Pair contract. Follow
  current App service/lifecycle conventions rather than growing inline route logic.
- Implement authorized session/tab lifecycle and actual navigation state.
- Gate: reconnecting another client resolves the same live target; closure and
  crash produce explicit states, not silent recreation of an equivalent URL.

### Phase 2 — interactive SANE viewer and control broker

- Integrate the selected transport into Browser View behind an opt-in host-mode
  flag. Preserve aliases/tab navigation and distinguish device-preview behavior.
- Add authenticated streaming, bounded frame queues/backpressure, visibility-aware
  streaming, reconnect state, mobile input, and viewport ownership.
- Implement single-human ownership and human-priority agent lease cancellation.
  Include the broker now so later agent integrations cannot bypass takeover.
- Gate: remote human input affects the registered target; stale/replayed input is
  rejected and another viewer cannot resize or type without ownership.

### Phase 3 — screenshots and diagnostics

- Add pre-navigation collectors, bounded buffers, filtering/redaction, cursors,
  screenshot capture, and explicit local artifact export.
- Expose an App diagnostics view so the user can inspect what tools can retrieve.
- Gate: a known console message, exception, failed request, and screenshot are
  attributable to the same tab/generation; missing history and buffer loss are
  visible rather than reported as an empty clean session.

### Phase 4 — session-scoped agent integration

- Add explicit observation/control grants to the pairing UX without reinterpreting
  existing pair links as permission. Show authorized tab and current controller.
- Connect one harness adapter to the broker and diagnostics; then add the other
  supported harness through the same contracts. No context/skill edits are assumed.
- Support grant expiry, revocation, native-session end, stale-reference errors,
  bounded tool responses, and explicit resume after human takeover.
- Gate: the user and agent observe the same transient page state, agent actions
  appear in the viewer, and revoked/wrong-workspace sessions cannot observe or act.

### Phase 5 — hardening and opt-in rollout

- Cover lifecycle failures, logout, authorization, hostile navigation, multiple
  viewers, background tabs, long sessions, quotas, and browser update handling.
- Keep file transfer, clipboard, dialogs, and permission requests visibly disabled
  until implemented; document any limitations that remain in the first release.
- Import device-preview URLs only through an explicit action. Never copy client
  cookies or imply that URL import preserves live state.
- Ship operator instructions for Tailscale HTTPS/WSS, host-local URL resolution,
  profile/artifact deletion, resource limits, and browser restart behavior.
- Roll back by disabling new host-mode sessions while retaining device previews.
  Warn before terminating active host sessions; never delete artifacts/profiles
  implicitly during rollback.

## Validation plan and definition of done

These are future acceptance checks, not authorization to run or write tests now.
Follow repository policy: tests and browser verification only when requested;
use focused checks rather than a full suite.

- Remote laptop, iPad, and phone interaction over Tailscale: typing, scrolling,
  focus, virtual keyboard, viewport mapping, background/resume, reconnect.
- Exact-target identity: unsaved state survives a client switch; screenshot,
  snapshot, diagnostics, and both input paths identify the same tab/generation.
- Control races: takeover during an action, queued mutations, expired leases,
  two human viewers, disconnected owners, and explicit agent resume.
- Isolation/security: wrong workspace/session, forged IDs, unauthorized WebSocket,
  logout/revocation, App-origin navigation, popup registration, and no tailnet CDP.
- Lifecycle/limits: navigation invalidates element references; crash invalidates
  targets; slow clients do not create unbounded queues; logs expose truncation.
- Honest locality: host versus device URL resolution is clear; external model
  access is disclosed; secrets/artifacts are not written into the repository.

Done means an authorized user on another device can interact with a host browser,
hand control to an agent in its actual conversation, take control back, and inspect
captures/logs from that exact browser without a second hidden automation session.

## Decisions to close before implementation

1. Viewer transport/dependency, supported host platforms, and measurable latency
   targets. CDP streaming is the preferred hypothesis, not verified UX quality.
2. First harness integration and how its trusted native-session identity reaches
   the tool adapter without relying on caller-provided IDs.
3. Idle timeout, tab/process quotas, log-buffer bounds, and saved-artifact retention.
4. Whether persistent logins are required for the first release; if so, decide
   isolated persistent-profile ownership, storage, locking, and deletion first.
5. Required first-release file transfer/dialog behavior versus explicit deferral.

## References

- [Repository research and alternatives](../../../reports/Local%20shared%20browser%20control.md)
- [CDP Page APIs](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
  and [Input APIs](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [Playwright CDP attachment](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Steel local browser](https://github.com/steel-dev/steel-browser)
- [noVNC](https://github.com/novnc/noVNC)

Upstream capabilities must be checked against pinned versions during Phase 0.

# Terminal performance — remaining gaps

Status as of **2026-10-05**. Investigation is paused at the user's request.
Typing is better, but intermittent freezes remain. Terminal performance diagnostics
are now **disabled by default**; the performance changes remain in place.

## Implemented mitigations

- Terminal binding leases avoid Git discovery on stable supported input paths.
  Unsupported or changed metadata still requires authoritative discovery.
- Output uses independent bounded windows per attachment: 32 frames / 256 KiB,
  instead of stop-and-wait delivery. Parser acknowledgements and ownership fences
  remain intact. These first two changes are committed as `863cc84`.
- Automatic workstream overview fetching pauses in Terminal view, preserves cached
  sidebar data, and refreshes on leaving. Explicit refreshes remain available.
- Failed server background handoff polls use per-workspace backoff:
  **5 → 10 → 20 → 30 seconds**, rather than retrying every 500 ms. Registration
  changes trigger immediate retry; success clears backoff. Explicit operations
  and validation safety are unchanged.

The overview pause, backoff, and opt-in diagnostics are grouped with this gap
document. Notification work and existing stores were not changed for this fix.

## Evidence and limits

Read-only probes of the production polling path using the saved catalog found:

- `console` failed with `CORRUPT_STORE` / unexpected or missing v1 schema objects.
  Each repeated failed poll took **283–319 ms** overall.
- Healthy repositories took approximately **2–4 ms** once warm. Cold acquisition
  took approximately **596–650 ms** per healthy repository.
- No active handoffs were found in the inspected ready stores. Expensive active
  handoff reconciliation is therefore not an explanation for those observations.
- A trivial live HTTP request normally responded in **0.2–0.4 ms**, but repeatedly
  rose to **106–130 ms** before backoff. This demonstrates server responsiveness
  delays independently of React; it is not terminal end-to-end latency.

The latest terminal session, starting at `2026-10-05T22:02:28.699Z`, recorded:

| Metric | Average | Maximum |
| --- | ---: | ---: |
| Input/control queue wait | 19.8 ms | 53.6 ms |
| Binding validation elapsed time | 16.4 ms | 901.8 ms |
| Server output-parser completion | 20.0 ms | 1,831.2 ms |
| PTY write call | approximately 0 ms | approximately 0 ms |

Binding validation averaged 109.6 ms in the preceding session. The user reported
some improvement after backoff, but still described occasional sticking. These
are different usage samples, not a controlled benchmark or proof of complete
resolution. Binding mode stayed `metadata`.

Elapsed validation/parser timings include waiting to resume; a long timer does
not prove filesystem validation or parser computation itself consumed that time.
Five-second aggregates cannot correlate an individual freeze with a particular
background operation. Browser timings and actual key-to-visible-echo latency
were not captured. PTY write timing measures the write call, not shell response.

## G1 — Blocking background work still shares the terminal server thread

Backoff reduces frequency, not blocking duration. Background handoff polling
still performs synchronous repository Git/SQLite validation in the bridge
process. Cached read validation can fall back to full guards when evidence
changes or cannot safely be reused. Other synchronous bridge work may also
contribute; the operation behind each remaining spike is **not established**.

Next investigation: correlate event-loop lag with background request/task
durations and individual validation stages during a freeze. Prefer isolating
blocking read-only repository work in a worker/process without weakening
binding, corruption, or mutation checks. A frontend render optimization cannot
remove a server-thread stall.

## G2 — Handoff scheduling is polling-based

The server's handoff consumer checks registered repositories every 500 ms,
independently of frontend overview polling. It discovers queued deliveries and
reconciles delivery-run status. Durable handoff records remain the authority.

A future design should use submission/run-change wakeups, startup reconciliation,
and slower bounded fallback polling for missed or external events. Wakeups are
hints, not replacements for durable records. Run blocking observations off the
terminal thread and retain full dispatch/mutation validation.

Failure backoff is capped at 30 seconds. Recovery without a registration change
can wait that long plus polling cadence/work duration; a successful explicit
operation does not currently clear background backoff. The invalid `console`
store was not repaired, reset, upgraded, or removed.

## G3 — Input and output processing share one FIFO

`TerminalService` queues input/control operations and server headless output
parsing on the same resource tail. Input can wait behind parser work; Ctrl-C has
no separate priority path. The latest measured queue maximum was only 53.6 ms,
so this alone does not establish the cause of the 1.83-second parser wait.

Consider separating interactive work from output bookkeeping after measuring,
while preserving resize/snapshot ordering, generation fences, and cleanup.

## G4 — End-to-end attribution and verification remain incomplete

- Event-loop delay and exact slow background operations are not logged yet.
- Browser parser completion is not screen paint; React's contribution has not
  been measured or ruled out as an additional source of delay.
- The control-generation warning is a separate deferred issue. Diagnostics record
  an error code but not the rejected operation or expected/received generation.
  The user explicitly chose not to address it during this performance work.
- The initial lease/window implementation passed 74 focused tests across seven
  files. Later diagnostics, overview-pause, and backoff changes were typechecked
  and whitespace-checked, but not tested or browser-verified. New log opt-in gates
  likewise have no focused tests or browser verification.

Resume with correlated measurements, then a bounded isolation change. Run/write
focused tests and perform browser verification only when explicitly requested,
per repository instructions. Do not claim the freezes are fixed from typecheck.

## Re-enable diagnostics temporarily

Server diagnostics require an explicit environment flag on the normal launch:

```sh
SANE_TERMINAL_DIAGNOSTICS=1 bun run start:app
```

Keep the installation's usual launch arguments, including origin/reconciliation
options. Restart normally to apply server changes; restarting interrupts live
terminal resources. Enabled server records appear as `[terminal:server]` on the
console and append to `<dataDir>/terminal-performance.log`. The saved installation
uses `packages/sane-app/.data-fresh/terminal-performance.log`.

Browser diagnostics are independently opt-in on the App origin:

```js
localStorage.setItem("sane.terminalDiagnostics", "1");
```

Refresh afterward to create a new client session. Browser aggregates appear as
`[terminal:client]` in its console, not in the server file. Disable again by
removing that key and refreshing; omit/unset `SANE_TERMINAL_DIAGNOSTICS` on the
next server launch. Unavailable browser storage leaves diagnostics disabled.

Disabled diagnostics create no aggregators, performance-summary timers, console
records, or file appends. Existing log history is retained. Enabled diagnostics
aggregate timings, sizes, and queue counts without keystrokes, terminal content,
paths, or tokens. The file is append-only with no rotation; enable temporarily.

## Code map

- [`terminal.ts`](../../../packages/sane-app/src/terminal.ts): lifecycle, shared
  queue, validation and server instrumentation.
- [`terminal-binding.ts`](../../../packages/sane-app/src/terminal-binding.ts):
  metadata leases and discovery fallback.
- [`terminal-client.ts`](../../../packages/sane-app/frontend/terminal-client.ts):
  imperative xterm session, control, parser queue and client opt-in.
- [`terminal-diagnostics.ts`](../../../packages/sane-app/shared/terminal-diagnostics.ts):
  bounded five-second aggregates.
- [`bridge.ts`](../../../packages/sane-app/src/bridge.ts): diagnostic file sink,
  handoff consumer and failure backoff.
- [`workstreams.ts`](../../../packages/sane-app/src/workstreams.ts) and
  [`server.ts`](../../../packages/sane-core/src/server.ts): polling reuse and
  authoritative domain guards.
- [`workstream-overview.ts`](../../../packages/sane-app/frontend/workstream-overview.ts):
  Terminal-view automatic fetching pause.

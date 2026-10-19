# Migration + backward-compat audit — Option A (hook removal, 2026-10-14)

Read-only inventory. Companion to `cc-injection.md` / `shared-context.md`.

## 1. Legacy sessions (no `saneContext.package`): delivery today, resume = no redelivery

- CC framework: creation run only. `frameworkPath` set iff `!resume && saneContext && !package`
  (`claude-run-service.ts:463`); sidecar write + `SessionStart` hook push (`:489-493`);
  hook fires only when `input.source === "startup"` (`hooks/session-start.ts:6`);
  intent comment "resume and compact add nothing" (`hooks/session-start.ts:1-2`).
- CC session block: only when `saneSession !== null`, which for legacy is only `!resume`
  (`claude-run-service.ts:508-514`); `UserPromptSubmit` hook + `.sane-session.md` + `.delivered`
  once-marker (`hooks/session-context.ts:7-22`).
- OC framework: synthetic message once at creation (`opencode.ts:310-313`), called from
  `bridge.ts:806` (handoff recipient) and `:1663` (create); skipped when `context.package`
  (`bridge.ts:474-475`). In-memory ack map lost if App restarts before first run journal
  (`docs/sane-context/pending.md:42-47`).
- OC session block: first non-resume run only, iff no package (`opencode-run-service.ts:585-593`).
- Resume (both harnesses): zero redelivery; context survives via native history only.
  Pre-v3 sessions never got framework and get only the session block; "no migration"
  (`docs/sane-context/pending.md:68-72`).

## 2. Activation upgrade path (`package.activation === "upgrade"`)

- What: pre-canonical session (no stored agent, native Base role) pins a canonical pair on
  first canonical run; marker set at `bridge.ts:1648`, `:3135` (branch migration).
  Validated (`bridge.ts:1649`), installed onto session (`:1706-1713`).
- Why: CC would otherwise restore the pre-upgrade Base snapshot on next resume.
  Every later launch with an append-file adds `--system-prompt-snapshot off`
  (`claude-run-service.ts:527`; receipt `snapshot:"off"` at `:544`;
  `docs/sane-context/native-context-injection.md:62`; negative control in
  `tests/canonical-claude-capture.integration.test.ts:248` proves staleness without it).
- Under Option A the flag dies with `--append-system-prompt-file` (no second channel to
  snapshot). Replacement: re-prepend composed standing only on package-revision change;
  existing sessions pin revisions and never refresh on restart/compact
  (`native-context-injection.md:72`). Open: whether CC snapshots of composed *prompt* text
  need any equivalent suppression.

## 3. In-flight sessions at cutover

- State at risk: native history already holding hook-delivered standing (SessionStart
  additionalContext / synthetic framework / append-file bytes) + journals holding
  `prepared` (`context-delivery.ts:33`), `configured` (CC `:544` / OC `stored-readback`
  `:602`), `hook-accepted` (CC `:390`) receipts.
- If hooks stop mid-session: canonical CC loses dynamic (ack gate `:384-397` fail-fasts
  runs without `dynamicAccepted` — must be removed jointly); canonical OC loses
  standing+dynamic instruction entry (`opencode-run-service.ts:597-602`). Legacy
  in-flight sessions break nothing (their resume path is already hook-free).
- Duplicate-standing risk: a next-run full re-prepend repeats standing already in
  history. Cutoff options: (a) version-gate — pre-cutover sessions finish on hooks,
  post-cutover compose; (b) next-run re-prepend — standing only on revision change,
  dynamic always; (c) per-session migration flag, branch as the supported migration
  route (`native-context-injection.md:100`).
- RECOMMENDED: (a) version-gate hung on the existing mode switch (item 5), with (c)
  branch as the opt-in migration path. It avoids mid-history duplication and keeps the
  ack fail-fast semantics intact for old sessions.

## 4. `.data-fresh` compatibility (no history rewrite)

- Journal schema is additive-tolerant: `decodeLog` accepts `kind:"context"` with opaque
  `data` (`history.ts:158`); session validation accepts `saneContext` with or without
  `package`, `activation` absent or `"upgrade"` (`history.ts:91-95`).
- Review tooling already treats missing `saneContext` as era, not failure
  (`review.ts:685-688`); per-run sidecars are retained evidence (`pending.md:35-40`).
- Confirm: NOTHING in Option A requires rewriting history. Old receipts stay readable;
  new composer emits a new receipt shape alongside, never a migration of old events.

## 5. `contextDelivery` mode switch — exists, use it

- `Options.contextDelivery?: "startup" | "canonical"` (`bridge.ts:97`); default
  `"canonical"` (`app-config.ts:101`); startup banner (`bridge.ts:112`).
- Gates only NEW activations (`prepareSaneContext`, `bridge.ts:431-434`); existing
  sessions retain recorded delivery (`native-context-injection.md:70`). Rollout hook:
  add a third value (e.g. `"composed"`) or repurpose the flag so `canonical` = legacy
  hook path for old sessions, new value = prompt composition for new sessions.

## Open questions

1. Composer home + steady-state resume scope (dynamic-only vs nothing) — cf. Q3 in `cc-injection.md`.
2. Duplicate-standing dedup rule if (b) is ever chosen.
3. Queued-followup turn-complete signal after `stoppedTurns` removal (Q1 in `cc-injection.md`).
4. Sidecar/`.delivered` file lifecycle: stop writing only, or also stop reading/GC?
5. OC compact path under composition (prompt must carry what it needs).

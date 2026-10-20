# CC context delivery — removal inventory

Apply the [shared context contract](shared-context.md) under the [plan's blank-slate scope](PLAN.md#scope-and-blank-slate-decision). This document owns Claude-specific changes, not placement rules or coverage.

## REMOVE — context delivery

Unless otherwise noted, execution/stream handling below is in `src/claude-run-service.ts` (`execute` / `consume`).

| Mechanism / source symbol | Required removal |
| --- | --- |
| `frameworkPath` / `framework`, `hooks/session-start.ts` | Delete `*.session-start.md` writes, the context-returning SessionStart command, and its registration/file. |
| `saneSession` / `sessionPath`, `hooks/session-context.ts` | Delete `*.sane-session.md` and `.delivered` writes, the context-returning UserPromptSubmit command, and its registration/file. Reuse pure context producers in shared composition. |
| `hookContextLimit` | Delete limits specific to those injectors; prompt transport limits remain adapter concerns. |
| `appendPath`, `--append-system-prompt-file` | Delete `*.canonical-context.md` writes and system append-file delivery. |
| `package.activation === "upgrade"`, `--system-prompt-snapshot off` | Delete the append-file upgrade workaround and migration-only state, not native resume. |
| `result.canonical`, `dynamicAccepted`, `hook-accepted` | Delete context-ack parsing, missing-ack termination, and post-exit rejection jointly with the injector. |
| `result.framework`, `framework-rejected`; `shared/conversation/cc-result.ts` `rejectUndeliveredClaudeFramework` | Delete framework delivery enforcement and obsolete replay branches; retain result identity/index/integrity checks. |
| Context `contextReceipt` calls, `--include-hook-events` | Remove context-only receipts/event-visibility usage; preserve any independently required operational visibility. |

Remove corresponding context-only readers via [consumers.md](consumers.md). Update `hooks/settings.example.json` where it describes injection; retain operational forwarding examples.

## KEEP — operational infrastructure

- `hookEvents`, forward.ts registrations, `hooks/forward.ts`, `ingestHook`, secrets/authentication, hook URL/route, `CC_WEB_HOOK_URL/RUN_ID/SECRET/ERRORS`, and operational error logging. A forwarded SessionStart/UserPromptSubmit observation is not a context injector.
- Per-run settings, `--settings`, permissions/`--permission-mode`, agent/model selection, execution-policy/version gates, and native-child definitions. Resolve main-role ownership under the shared contract, including noncanonical/native-selected profiles.
- `stoppedTurns` / `turnHooks`, task-notification invalidation, `canQueueFollowup` / `drainQueuedFollowup`, supervision, termination, group liveness, and result processing. No new turn-complete signal is needed.
- Launch/submission/status evidence and native compact transport/process handling. Remove compact-path append-file context without adding compact-time reinjection.

Operational activity, worker evidence, and route consumers are listed in [consumers.md](consumers.md); test dispositions are in [tests.md](tests.md). Pruning operational event volume is a separate performance investigation.

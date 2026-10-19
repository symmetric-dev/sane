# CC injection path — hook-removal audit (Option A, read-only, 2026-10-14)

Scope: `src/claude-run-service.ts` (638), `hooks/forward.ts`, `hooks/session-start.ts`, `hooks/session-context.ts`, `hooks/settings.example.json`.

## REMOVE (delivery) — 22 items
1. `claude-run-service.ts:23` `hookEvents` 13-event list (SessionStart…CwdChanged) — delete or shrink to none.
2. `claude-run-service.ts:487` forward.ts hook table built for every event (`--settings` hooks) — remove whole block.
3. `claude-run-service.ts:487` per-run settings file `writeSettings(settingsPath)` carrying hook commands — hook section goes; file may shrink to permissions-only or vanish.
4. `claude-run-service.ts:520` `--settings settingsPath` CLI arg — remove if settings file deleted.
5. `claude-run-service.ts:489-493` framework sidecar: `*.session-start.md` write + `hooks.SessionStart.push(session-start.ts…)` — remove both.
6. `claude-run-service.ts:490` `hookContextLimit` guard on framework length — remove with #5.
7. `claude-run-service.ts:492,583,591` `result.framework` / `rejectUndeliveredClaudeFramework` / `framework-rejected` cause — remove framework-delivery failure branch.
8. `claude-run-service.ts:510-514` session sidecar: `*.sane-session.md` write + `hooks.UserPromptSubmit.push(session-context.ts…)` — remove both.
9. `claude-run-service.ts:512` `hookContextLimit` guard on session length — remove with #8.
10. `claude-run-service.ts:508-509` `result.canonical` init + `canonical.dynamic` selection (excl. compact/resume logic) — remove dynamic-via-hook half; static half moves to prompt composition (open Q3).
11. `claude-run-service.ts:521,544` `--include-hook-events` + `contextReceipt(...configured...)` "append-system-prompt-file + UserPromptSubmit" emit — remove hook half of receipt.
12. `claude-run-service.ts:524,527` `--append-system-prompt-file` + `--system-prompt-snapshot off` (upgrade) — remove; standing context becomes prompt text (open Q3).
13. `claude-run-service.ts:484-485` `*.canonical-context.md` sidecar write — remove with #12.
14. `claude-run-service.ts:384-397` stdout `hook_response/UserPromptSubmit` acceptance (`dynamicAccepted`, `hook-accepted` emit, fail-fast terminate on unacked dynamic) — remove block.
15. `claude-run-service.ts:584-587` post-exit `dynamicAccepted/rejected` failure gate — remove with #14.
16. `claude-run-service.ts:345-366` `ingestHook` (auth, association, `hook` journal emit, stoppedTurns/turnHooks publication) — remove method + `secrets` map (`:130,486,630`).
17. `claude-run-service.ts:359-364,379` `stoppedTurns`/`turnHooks` (Stop/UserPromptSubmit/PreToolUse/task_notification tracking, `canQueueFollowup` gate `:242`) — remove; queued-followup readiness needs new signal (open Q1).
18. `claude-run-service.ts:557` spawn env `CC_WEB_HOOK_URL/RUN_ID/SECRET/ERRORS` + `hookUrl()` option (`:32`) — remove.
19. `hooks/forward.ts:1-19` entire forwarder (loopback check, POST, `.hook-errors.jsonl` fail-open log) — delete file.
20. `hooks/session-start.ts:1-13` SessionStart framework injector — delete file.
21. `hooks/session-context.ts:1-22` UserPromptSubmit injector + `.delivered` once-marker (`open wx`, EEXIST→exit 0) — delete file (+ orphan `.delivered` cleanup).
22. `hooks/settings.example.json:1-17` example hook commands — delete or replace with empty/permissions-only example.

## RESUME/COMPACT branches touching context
- `claude-run-service.ts:424` resume without preallocated native id → `nativeSessionId=null` (creation uses runId); unchanged by hook removal.
- `claude-run-service.ts:463-464,508` framework only when `!resume` + legacy saneContext (no package); resume adds nothing — branch deleted with #5.
- `claude-run-service.ts:508,520` static canonical pinned across resumes; dynamic via UserPromptSubmit — both deleted; resume then inherits prompt text only (open Q3).
- `claude-run-service.ts:53-63,592-595` upgrade `snapshot off` persists across resume/compact — deleted with #12.
- `claude-run-service.ts:506-507,544` compact: no dynamic, standing still appended today — under removal, compact prompt must carry what it needs (open Q3).

## KEEP — 7 items
- K1 `claude-run-service.ts:505,523` agent selection (`installed`/privateExecution `ccAgent`, `--agent`) — unrelated to delivery.
- K2 `claude-run-service.ts:505,517,531` `permissions` in settings + `--permission-mode bypassPermissions` — enforcement, not context.
- K3 `claude-run-service.ts:495-503` execution-policy gate + version check — role binding, not delivery.
- K4 `claude-run-service.ts:462,468,533-541,543,622` launch/submission/status journal + `executionContext` evidence — audit trail survives; hook/context fields dropped.
- K5 `claude-run-service.ts:237-311` queued-followup admission/drain — user-prompt path, but needs new turn-complete signal after #17.
- K6 `claude-run-service.ts:155-230,320-341,565-568,581` supervision/termination/group-liveness — process ownership, not delivery.
- K7 `claude-run-service.ts:368-407` stdout/stderr consumers minus hook-response branch — result intake stays; `ClaudeActivity` (`:246-254,363,404`) keeps last-value usefulness without hooks.

## TESTS pinning delivery (`claude-run-service.test.ts`)
- T1 `:9` authored-parent delivered once; T2 `:28` pins bytes/configured-vs-hook-accepted incl. `--append-system-prompt-file`, snapshot flag, session-context.ts hook, `.sane-session.md`, receipts `prepared/configured/hook-accepted`; T3 `:53` upgrade snapshot-off on resume/compact; T4 `:67` missing/mismatched/foreign hook never accepted; T5 `:79` cannot spawn/claim configured; T6 `:95` Base never consults provider; T7 `:106` trusted-validator gate.
- T8 `:199` settings/flags/credentials order; T9 `:209-210` `settings.hooks` keys + forward.ts Stop command; T10 `:327,345,353` ingestHook auth/lifetime/journal-error/secret-retirement; T11 `:505,516,560` framework SessionStart indexed supervision + rejection cause; T12 `:835` source-validation stages `framework-file/session-file/session-context/settings`.

## OPEN QUESTIONS
- Q1 After `stoppedTurns` removal, what signals queued-followup eligibility (stdout result record only)?
- Q2 Does anything outside this path (bridge HTTP route, other harnesses) call `ingestHook`/`hookEvents`?
- Q3 Where does user-authored prompt composition live (standing+dynamic+framework concat, limits replacing `hookContextLimit`, compact handling)?
- Q4 Delete `*.session-start.md` / `*.sane-session.md` / `*.canonical-context.md` / `*.delivered` writers only, or also readers/GC elsewhere?

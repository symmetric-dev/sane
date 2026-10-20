# Context/prompt consumers — selective delivery, retained operational evidence

Integration inventory for the [shared context contract](shared-context.md). Scope and implementation order are in [PLAN.md](PLAN.md); coverage is in [tests.md](tests.md).

## Prompt preparation — select context, do not prefix every dispatch

Bridge callers select the operation's context; run-service adapters send composed bytes. Update these sites without adding another composition layer:

| Source / call site | Required behavior |
| --- | --- |
| `src/bridge.ts`, role-prefix / `prepared.prompt` dispatch | Select activation vs ordinary input before composing. |
| `src/bridge.ts`, worker `launch(w)` / `workerAssignment` | Supply worker activation and structured assignment. |
| `src/bridge.ts`, `workerReportPrompt` / `workerExchangePrompt` dispatch | Supply attributed body and selected sharing payload. |
| `src/bridge.ts`, handoff body / `h.input.message` | Distinguish an existing recipient from one needing activation. |
| `src/bridge.ts`, branch `firstMessage` | Account for inherited context and branch-specific content. |
| `src/worker-outbox.ts`, `workerReportPrompt` / `workerExchangePrompt` | Keep body builders pure. |

## Titles, classification, excerpts, and display

- `src/bridge.ts` `titleFromPrompt` and `src/session-list-response.ts` `sessionDisplayTitle`: use the authored body, not activation/context headings.
- `scripts/review.ts` `submissionKind` and submission excerpt: use a shared body-extraction helper or explicit message-kind/body data before regex/truncation.
- `shared/conversation/cc-reducer.ts` consumes submission text directly as the user message; OC normalized/native messages also contain transmitted text. Account for body vs context presentation without altering raw audit bytes.
- Use the shared body-extraction contract rather than independent stripping regexes.

## Evidence builders and journals

- `src/opencode-run-service.ts` `launchEvidence`: retire new `framework-delivered` and `session-block` emits plus `takeFrameworkDelivery`; keep lifecycle evidence.
- `src/claude-run-service.ts` framework/session paths, context-only hook registrations, append-file fields, and acknowledgment gates: retire as context delivery is replaced. Keep operational hook settings/events.
- Both run services' submission journals: wire the shared composition/body/operation evidence to actual dispatched bytes, not the pre-composition body.
- `src/context-delivery.ts` and `src/context-package.ts`: implement the shared composition/validation contract; keep checks unrelated to the retired sinks.
- `src/worker-outbox.ts` `exchangeDeliveryEvidence` / `workerDeliveryEvidence`: preserve content-independent acceptance/uncertainty semantics and no automatic retries.

## Operational hook consumers — KEEP

Current code also uses hooks outside context delivery:

- `src/claude-run-service.ts`: authenticated ingestion, turn-stop eligibility, task-notification invalidation, and queued-followup handling.
- `src/claude-activity.ts`: running/waiting/background observations from hooks plus stdout.
- `src/bridge.ts`: worker invocation evidence accepts root PreToolUse hooks or matching stdout tool use; permission/post-tool observations provide worker waiting-state fallback.
- `src/native-subagent-projection.ts`: hook and stdout evidence for native child observation.
- `src/transcript-service.ts`, `shared/conversation/cc-reducer.ts`, `context-usage.ts`, and `compaction-evidence.ts`: operational hook-derived evidence. Remove branches used only to interpret retired context injection, not operational events.
- `frontend/thread.tsx`: hook event presentation. Context-only payload presentation may change, but operational events remain valid.
- The listener called `hookServer` also serves `/native/workers` and `/native/handoffs`. Keep both those routes and the operational hook route/authentication.

## Review tooling — one context model

Original `scripts/review.ts` context-specific checks include SessionStart delivery, framework/session sidecar paths, `hook_additional_context` / prompt snapshots, OC synthetics/metadata, and framework/session-block missing/repeated/stale checks. Replace these rather than adding compatibility branches:

- Delete old context receipt stages, context sidecar readers, SANE synthetic/metadata context checks, and era-based delivery interpretations.
- Check SANE's intended activation/update/sharing placement and actual submitted payload; ordinary turns need no repeated context.
- Separate context-delivery failures from operational hook/process/background failures. Do not demote all hook errors to informational.
- Native compact transport, guards, and evidence remain. Compaction preservation/recovery, including any future summaries or pointers, is explicitly separate work.

## Follow-on documentation references

Update context-delivery descriptions when implementation lands; preserve operational-hook guidance. Skill/context edit authorization follows `PLAN.md`.

- Repository root: `docs/sane-context/pending.md`, `docs/sane-context/native-context-injection.md`, `docs/sane-context/explicit-worker-protocol-plan.md`, `.opencode/skills/review-sane-sessions/SKILL.md`.
- App package: `scripts/context-report/README.md`.

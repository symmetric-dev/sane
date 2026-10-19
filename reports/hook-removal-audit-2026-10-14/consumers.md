# Hook-removal audit (Option A) — context/prompt consumers
Scope: everything that READS context artifacts or prompts. Read-only inventory; no changes made.

## Prompt composers (must ADD the delimited standing block)
- `bridge.ts:1722-1723` role-prefix precedent (`[SANE role: …]` + `prepared.prompt`, OC only). Reads `prepared.prompt`. A: extend this pattern — standing block + delimiter + prompt, both harnesses.
- `bridge.ts:2055` worker launch (`w.input.prompt` + context). A: prepend standing block w/ delimiter.
- `bridge.ts:2221-2222,2313` worker report/exchange dispatch (`workerReportPrompt`, `workerExchangePrompt`). A: accept history-presence (first-run assignment carries block); do NOT re-prepend per report.
- `bridge.ts:2445-2459` handoff prompt (`SANE handoff …` + `h.input.message`). A: standing block + delimiter + handoff body.
- `bridge.ts:3156` branch firstMessage (+ role prefix). A: same standing-block prefix rule.
- `worker-outbox.ts:6,16` `workerReportPrompt` / `workerExchangePrompt` builders. A: pure body builders stay; prefixing happens at dispatch site.

## Title / classification readers (must STRIP the delimiter first)
- `bridge.ts:1015` `titleFromPrompt` (first line ≤200ch). A: strip standing block or titles become `# SANE Context…`.
- `session-list-response.ts:51-62` `sessionDisplayTitle` (earliest submission text). A: same strip rule — HIGHEST title blast radius (every list row).
- `review.ts:323-329` `submissionKind` (`^SANE handoff`, `^Worker Outcome` regexes). A: strip block before classify or every run misclassifies as `prompt`.
- `review.ts:348-351` submission excerpt. A: strip before truncate/display.

## Evidence builders / launch pipeline (RETIRE or repurpose)
- `opencode-run-service.ts:308-323` `launchEvidence` + `framework-delivered` event (`takeFrameworkDelivery`). A: delete delivery; keep event kind as historical only.
- `opencode-run-service.ts:585-593` `deliverSaneSession` + `session-block` context event. A: delete; block moves into prompt text.
- `claude-run-service.ts:463,489-493` `frameworkPath` + SessionStart hook registration. A: delete; framework text moves into prompt composition.
- `claude-run-service.ts:508-515` `sessionPath` + UserPromptSubmit hook. A: delete; dynamic block moves into prompt.
- `claude-run-service.ts:468`, `opencode-run-service.ts:568` `submission` journal event stores full prompt. A: text now contains block — downstream readers strip (see above).
- `claude-run-service.ts:534-544`, `opencode-run-service.ts:317-322` `launch` event (`framework`/`sessionBlock` paths+sha). A: replace with prompt-composition receipt (standing revision + hashes).
- `context-delivery.ts:19-58` `prepareContextDelivery`/`contextReceipt`; `context-package.ts:71-97` standing/dynamic composer. A: composer becomes THE prompt-prefix source; `deliverContextEntry`/`append-system-prompt-file` channels retired.
- `worker-outbox.ts:24-47` `exchangeDeliveryEvidence`/`workerDeliveryEvidence` (+ `bridge.ts:2075,2163,2232` call sites). A: NOTHING (acceptance signals content-agnostic).

## Snapshot / transcript readers (mostly NOTHING)
- `shared/conversation/transcript.ts` `transcriptMessages`, `opencode.ts:613-647` `compactionSnapshot`/`normalizeMessage`, `opencode.ts:410` `history`, run-service `readCommand`, `transcript-service.ts:109-143` `evidence()`. A: nothing — native history shape unchanged. Only text-scanning uses (titles/classification) strip.
- Compaction guards `claude-run-service.ts:124,465`, `opencode-run-service.ts:63,564`, `bridge.ts:1333`. A: nothing, except summaries must preserve the block pointer via history-presence.

## review.ts hook-assuming checks → all become "present once in early history"
`367` SessionStart outcome read; `406-411` framework file/event/hookOutcome; `414-425` block file/event/launch; `458-500` `claudeNative` (`prompt_snapshot`, `hook_additional_context`, `sessionBlockInSystemPrompt`); `509,529` OC synthetic framework + expected id; `528` `saneContextMetadata`; `606-623` framework-missing/hook-failed/repeated/not-in-transcript/id-mismatch; `642,647,649-655` framework-repeated/session-block-stale+missing (OC metadata check); `403,637,661` hook-error plumbing (informational only post-removal).

## Stale docs/skills paths (no template hits)
`docs/sane-context/pending.md:36-38,63`; `docs/sane-context/native-context-injection.md:19,60,64,106,116`; `docs/sane-context/explicit-worker-protocol-plan.md:192,339,376,409` (partial); `.opencode/skills/review-sane-sessions/SKILL.md:45,77,83,86-88,97,99`; `scripts/review.ts` (lines above). `templates/**`: no matches.

# Inline Image History Cleanup

## Status and scope

- Status: immediate SANE fixes implemented and independently reviewed in the current checkout; broader image externalization, expiration, and migration remain proposed. See the implementation checkpoint below.
- Date: 2026-11-01. Revised the same day after a review of repository code and the pinned OpenCode V2 SDK type declarations (`@opencode/plugin` 2.2.4, root `package.json`).
- Initial target: OpenCode V2 sessions used through SANE, including Base (unmanaged) sessions. SANE compaction restoration runs only for managed sessions (`opencode/plugins/sane/compaction-context.ts:101`), so managed and Base sessions have different compatibility constraints. Do not limit coverage to either by accident.
- Mandatory OpenCode coverage includes parent sessions, native subagents, SANE workers (which are separate native sessions), and nested descendants. Capture, artifact resolution, and exposure policy must work in each session; a successful parent-only implementation is not complete.
- UI/backend loading hardening also covers the shared worker viewer and legacy event route across harnesses. This does not authorize changing other harnesses' native image storage or model-context behavior; those remain outside the initial externalization rollout.
- Three separable workstreams, each gated on its own:
  1. **SANE hardening (no OpenCode gate):** bounded compaction observation, bounded history import, and journal projection that does not copy inline image payloads. Land this first; it would have prevented the incident stall without any change to image handling.
  2. **Externalization:** persist durable references instead of inline image bytes for covered producers, and hydrate them for model requests. No age-based eviction.
  3. **Expiration:** omit aged image pixels from later model requests under a versioned retention policy.
- Start with structured image tool results: built-in `read`, `grok_image_generate`/`grok_image_edit`, and Code Mode `execute` aggregates. Screenshots are in scope only through `read` (see evidence). Direct user attachments and other producers need a separately verified ingestion path. Report uncovered producers; do not claim universal coverage.
- Authorization for the immediate fixes covers repository source changes only. It does not authorize modifying running services, native databases, installed plugins, user image files, old journals, skills, or context files. The affected incident session has already been repaired; it is not an input to this work.

### Current-checkout implementation checkpoint

The approved immediate slice consists of native-child summary/refresh performance, paged SANE worker viewing, and exact bounded compaction observation. It does not include artifact storage, image externalization, age-based expiration, legacy-journal indexing/migration, or a general legacy-event API redesign.

- Backend implementation and independent review are complete: child summary/lifecycle paths avoid full-body hashing, selected-child details retain their full revisions, and compaction observation fetches the exact admitted message through a streamed 16 MiB response bound. Valid queued move entries remain recognized without weakening exact input-type/identity checks.
- The existing isolated read-only load profile measured the complete warmed child-summary route at **2.3 ms**, compared with **12.7 seconds** before the change, using the same large session records. The five-child summary response remained 110,111 bytes. This is not a browser or live-server timing claim.
- Worker viewing now uses latest-first transcript pages, explicit older/gap loading, and paged run/compaction metadata, preserving the dedicated Grok path. Metadata churn retries only metadata traversal, preserving loaded message coverage. Lightweight run/compaction status polling is independent of loaded-message refresh work, with identity/disposal fencing and current-state publication.
- Independent backend and worker-viewer reviews are complete, including re-review of the queued-move and metadata-concurrency corrections. No remaining actionable findings were reported in their scoped reviews.
- No tests or browser verification were run or written. The standard TypeScript check reports the same 12 pre-existing diagnostics in unrelated test fixtures; those were left outside this slice. Production-source typechecking passes with a temporary external configuration excluding test fixtures, and scoped whitespace checks pass. Remaining focused runtime/browser coverage is not implied by these static checks and reviews.
- The running App/services are not restarted by this implementation. Deployment and later work in a separate checkout remain explicit follow-up decisions.

## Problem and evidence

### Incident observations (reported; not re-verified in this revision)

The session **NTE characters with generation sheets** stalled after a successful native compaction because SANE could not observe its result:

- Native history contained 170 inline image entries: 48 from `read` and 122 from `execute` results.
- Approximately 104.6 million characters of image data accounted for 98% of the 107.2 million-character history.
- Grok saved generated images to disk and also returned inline image copies. Image reads introduced another source of inline payloads.
- SANE's tool-output normalization copied these payloads into its journals.
- The compaction observer fetched the newest 100 messages, accumulated about 16.3 MiB, and rejected the page against a 16 MiB limit before checking the exact compaction message.
- Replacing inline images with generic text in a backed-up, idle native session reduced history to approximately 2.6 million characters. The existing observer then completed the App run without a restart.

That was an explicitly authorized manual repair, not a safe model for an automatic database-rewriting service. SANE's journal writer pins file identity and bytes (`packages/sane-app/src/run-journal.ts`). Changing those files behind the running writer can fail closed.

### Code-verified amplifiers

- `compactionSnapshot` (`packages/sane-app/src/opencode.ts:686-711`) accumulates 100-message pages. It enforces the 16 MiB budget (line 695) *before* checking whether the page contains the admitted compaction ID (line 696), so unrelated image history fails the observation. The adapter already fetches exact messages through `/message/{id}` elsewhere (lines 524, 725).
- `history()` enforces the same accumulate-then-reject 16 MiB import budget (line 584), so image-heavy sessions also fail import and reconciliation. `snapshot()` has no byte budget, but it walks 100-message pages under the default 10-second request timeout (`requestEncodedAt`, line 319), which very large pages can exceed. Ordinary `request()` reads the full body with no byte cap (lines 333-338).
- `normalizeMessage` copies the tool part's `state.content` verbatim into `output` (line 836), including `file` parts whose `uri` is a `data:` URL. User messages are projected as text only (line 840): user attachments do not reach SANE journals through this path, but they still inflate the native pages SANE fetches.
- Grok tools return one text metadata part and one `file` part per image with a `data:` URI (`opencode/plugins/grok-imagine/index.ts:439-445`, `563-569`). Their `metadata` has paths and receipts, not bytes. Images whose disk save failed or is uncertain are still delivered inline (line 436), so for those images the inline copy may be the only complete copy.
- SANE `browser_screenshot` returns JSON text, not a structured image part. When an artifact is saved it deletes `data`, and the agent views the image through `read` (`packages/sane-cli/src/native-browser.ts:76-83`). With `saveArtifact: false`, base64 `data` stays inside JSON text. This is a text-embedded producer that this plan does not clean heuristically (see decisions).
- Managed-session restoration hashes `JSON.stringify` of the request-message prefix for each recorded window entry (up to 64) on every primary and compaction request (`compaction-context.ts:117-122`, `134`). With inline images, every request re-hashes the image payload.

`share_media` is not the source of this problem: it stores immutable snapshots on disk, serves binary content separately, and returns only compact JSON receipts to the agent. Its independent storage quotas still apply.

### Additional loading incident: native child histories

Read-only investigation of **NTE Night Portrait Generation Pipeline** (App `cb616a39-65ed-4ab0-9f49-32183fd8e7fc`) found approximately 45 MB of parent native history and a 646 MB SANE run journal. Five final native-child captures accounted for 597 MB of that journal, including one 300 MB child capture. These were one final capture per child, not repeated full-history polling snapshots.

An isolated profile of the existing backend with the real records measured the cached child-summary list at 0.4 ms, but the complete list route at 12.7 seconds. `conversation-evidence-routes.ts:57-59` calls recorder refresh for every summary; `opencode-subagent-recorder.ts:23` projects and hashes every child's full history before filtering the requested tool or recognizing an already sealed terminal capture. Five children therefore trigger five expensive whole-run projections even on a warm list. This synchronous work can delay unrelated transcript responses on the same event loop.

Coverage and scale criteria must include native child capture and listing, not just parent transcript pagination. Independently harden summary loading so sealed children and unchanged summaries do not require full child-message serialization/hashing. Native externalization prevents future payload growth; it does not retroactively shrink these protected audit records.

## Baseline loading behavior and desired boundaries

"Downloading the session" means different things at different boundaries:

This table describes the investigation baseline. The implementation checkpoint above records the immediate fixes already landed in the working tree; the remaining improvements are still proposed.

| Boundary | Baseline behavior verified in code | Required improvement |
| --- | --- | --- |
| Browser: normal parent transcript | Uses paged transcript APIs. The response budget is soft for message content: one oversized message can be returned whole. | Keep paging, but send image descriptors rather than inline pixels, including for individually oversized messages. Fetch binary media only on demand. |
| Backend: cold native observation | `OpenCodeObservationService.read` walks native 100-message pages to obtain complete history (bounded by message count and time). Warm reads fetch the newest page until overlap, and refresh unfinished records. Native images are included before normalization. | Make native ingress media-reference-aware and byte-bounded. A small browser page is not enough if generating it requires fetching all native image bytes. Native API/source support is a feasibility gate, not something the frontend can solve. |
| Backend: deferred App journal | `materializeDeferred` synchronously reads and decodes the whole run journal when first needed, including embedded child captures. | Introduce bounded/incremental read projections and a derived index/checkpoint for new and legacy records without rewriting protected journals. Move unavoidable large legacy indexing off the main request/event-loop path and expose progress. |
| Browser: native-subagent summaries | Fetches summary listings on parent open; child detail pages are fetched when a child is opened. | Listing must use summary-only state and never require reserializing/hashing child image bodies or eagerly fetching child details. |
| Browser: SANE worker viewer | `session-viewer.tsx:57-95` lists the worker's runs and reads `/events?after=<cursor>` for each. First-open cursors start at zero. | Migrate worker transcript display to paged latest/older/refresh APIs, not replay of every raw event. Preserve worker identity, run grouping, compactions, and nested navigation. |
| Backend: legacy raw event API | `conversation-evidence-routes.ts:145-152` returns every event after the cursor, without count/byte pagination. A worker's initial request can therefore download its entire run, including native-child captures. | Remove this route from normal display paths. Bound routine event reads with explicit continuation semantics; an oversized legacy event needs an explicit descriptor/detail mechanism, not silent truncation. Keep raw audit export an explicit, separate operation. |

Normal parent opening does **not** recursively download every worker/child transcript into the browser. However, the backend can load and process those bodies. The worker viewer's formerly unbounded initial event replay is now replaced by paged transcript reads in the immediate slice. These distinctions must be retained in implementation claims and metrics.

The current 512 KiB transcript message budget is soft, so "paginated" does not imply a strict wire-byte bound. A descriptor-based presentation schema should preserve message/part identity and declare omitted image content explicitly rather than changing or truncating the source evidence.

## Verified facts, assumptions, and unknowns

"Verified shape" means a type declaration or repository code shows the API or field exists. It does not prove runtime ordering, persistence timing, or provider behavior. SDK paths are relative to `node_modules/.bun/@opencode+{plugin,schema,ai}@2.2.4*/node_modules/@opencode/*/dist/`.

| Topic | Status | Basis and what remains open |
| --- | --- | --- |
| `execute.after` exposes a mutable `result` for completed calls; error calls expose `error` only | Verified shape | `plugin/promise/tool.d.ts:38-51`. **Unverified:** whether the mutated result is the one native persists, streams, and lowers, and whether an earlier record already contains the bytes. |
| Persisted tool error states can carry `content` | Verified shape | `ToolStateError.content`, `schema/session-message.d.ts:615-649`. No hook exposes error content for rewriting; which producers emit it is unknown. |
| Tool-result images are `{type:"file", uri, mime, name?}` in the same array as text parts | Verified shape | `schema/tool.d.ts:48-65`; request-side `ToolResultValue` `content` variant, `ai/schema/messages.d.ts:71-91`. A same-index text placeholder is representable. |
| Providers lower non-`data:` tool-result URIs (`file://`, custom schemes) | **Unknown** | No type or code shows tool-result URI resolution. `data:` is the only form known to work, from current Grok behavior. |
| `context` receives mutable `messages`; `compaction`, `generate`, and `title` have separate hooks; `model.request` and `http.*` expose `kind` | Verified shape | `plugin/promise/session.d.ts:22-61`, `171-185`. **Assumption:** `context` fires only for primary requests (it carries no `kind`). |
| Hook execution order across registrations and plugins | Documented; installed behavior still to qualify | The V2 server-plugin guide says hooks run in plugin order and later hooks see earlier changes. SDK declarations alone do not establish runtime behavior. Compose SANE's dependent transformations in one callback and qualify interactions with other installed plugins. |
| Inner Code Mode calls share the outer `execute` tool-call ID | Verified (repository comment) | `packages/sane-cli/src/native-opencode.ts:18-25`. SANE knows no durable per-inner-call identity. |
| `execute.after` fires for inner Code Mode calls | **Unknown** | SANE tracks only the outer `execute`. Double capture is possible if it does. |
| Native blob store suitable for session evidence | Exists; suitability and supported write seam unknown | The live native database has `blob` and `blob_ref` tables, and the current V2 API documents `GET /api/experimental/media/{hash}`. That does not prove a supported plugin ingestion/resolution/lifetime contract. `ctx.experimental.artifact` is a publishing facility, and `ctx.storage` is JSON-only; putting base64 there merely relocates bloat. `MediaUser`/`experimental-media-uri` may provide a useful native seam. Investigate these before choosing a separate store; do not write native blob tables directly. |
| Request media sources include `bytes`, `base64`, `url` (with `expiresAt`), and provider `ref` | Verified shape | `MediaPart`, `ai/schema/messages.d.ts:32-53`. Tool results use the narrower `file` part, so these sources cannot be assumed inside tool results. |
| Restoration offsets are message indices; hashes cover every preceding request message, image payloads included | Verified | `compaction-context.ts:117-140`. |
| Provider-native compaction replays `native.messages` instead of the summary | Verified shape | `SessionCompactionResult.native` (`plugin/promise/session.d.ts:40-46`). Plugins cannot safely rewrite image content inside those windows. |
| Signed reasoning tolerates edits to earlier tool-result content | **Assumption** | Provider-specific; test per supported provider mode. Expect prompt-cache misses after any prefix edit. |

## Goals and non-goals

### Goals

1. Persist references instead of inline image bytes for covered producers.
2. Preserve immediate visual inspection: a reference in storage must not mean the model receives only text on its first inspection.
3. Retain exact image bytes for explicit re-reading and auditability, independent of source-file moves or modifications.
4. Stop retransmitting aged images while preserving the agent's existing descriptions, reasoning, and decisions.
5. Keep SANE history APIs, journals, and compaction completion independent of image size.
6. Make behavior deterministic across retries, restarts, concurrent tools, and compaction.

### Non-goals

- Caption generation or inference that any reasoning text is an adequate image summary.
- Deleting original images, artifact garbage collection, or retroactive reclamation of all existing audit storage.
- Cleaning arbitrary strings that look like base64, or changing unrelated non-image tool output.
- Silently rewriting live SQLite rows, sealed journals, signed reasoning, or provider checkpoints.
- Changing Claude Code or other harnesses in the initial rollout.
- Removing Grok's inline outputs without providing an equivalent immediate image-delivery path.

## Architecture and invariants

### A. Capture once, before canonical persistence

Capture points, in order of preference:

1. **SANE-owned producers (Grok):** the tool writes the artifact and emits the reference itself. Capture then needs no hook-persistence guarantee, only a verified hydration path (Gate 1, item 4).
2. **Built-in and third-party producers (`read`, Code Mode `execute`):** rewrite `result.content` in `execute.after`, but only after Gate 1 proves this is the result native persists and streams.
3. **Native ingestion (user attachments, anything persisted before hooks run):** a native change or a supported native media facility. Excluded from the pilot until proven.

Capture steps: parse only structured `file` parts with `data:` URIs and image MIME types. Decode under a per-image byte cap no lower than the producer's (Grok allows 16 MiB per image) and a per-result total cap. Verify the image signature, not just the claimed MIME (Grok's `imageType` check is the local precedent). Compute SHA-256. Write to a temp file, fsync, rename to a content-addressed path, fsync the directory. Commit the occurrence record. Only then replace the part. Nothing referenced may point at a blob that is not yet durable.

**Occurrence identity:** (native session ID, assistant message ID, tool-call ID, content index) of the persisted top-level tool part. For Code Mode, the unit is the outer `execute` part: inner calls share its ID (verified), so occurrences are indexed by position in the aggregated `execute` content. Do not invent per-inner-call identities.

**Reference encoding (decision D1).** Prefer keeping the persisted part `type: "file"` with a valid `mime` and a `uri` that native validation accepts. This is a design choice, not a requirement established by the SDK. A text descriptor plus trusted occurrence metadata is another candidate if reliable request-time mapping and hydration are proven. File-reference options:

- (a) Opaque scheme, e.g. `sane-image://<artifactId>`. Every request must be hydrated by the plugin. If the plugin is disabled or a request skips hydration, an unknown URI reaches lowering, with unknown behavior.
- (b) `file://` URL of the private artifact. Viable only if Gate 1 proves native lowers it for tool results and its permission semantics are acceptable. History stays usable without the plugin.

Recommendation: use (b) only if verified. Otherwise use (a), with a mandatory resolver and a supported export/materialization path before rollout.

Authoritative attributes (SHA-256, byte length, provenance, policy version) live in the plugin's occurrence record, keyed by occurrence identity. They are never parsed out of a URI or text that a model or another tool could forge. Mirror a bounded copy in tool `metadata` only if Gate 1 shows metadata is persisted and bounded.

**Storage (decision D2).** First qualify the existing native media/blob facility (see facts table). If no suitable supported integration is available, use a plugin-owned store outside the checkout, not under the worktree's `.opencode/` where Grok writes. That avoids accidental commits, loss on worktree deletion, and checkout-relative permissions. Use 0700 directories and 0600 files, namespaced by native location. Small occurrence records may use `ctx.storage`, which `compaction-context.ts` already uses for durable JSON records. Re-check native media support at each OpenCode upgrade. Do not repurpose `share_media` snapshots: publishing to the human and retaining model evidence have different lifecycles and quotas.

Conceptual occurrence record (not a committed API schema):

```json
{
  "version": 1,
  "artifactId": "image_<random-opaque-id>",
  "sha256": "<hash-of-exact-bytes>",
  "mimeType": "image/png",
  "byteLength": 123456,
  "originalPath": "data/images/outputs/example.png",
  "policyVersion": 1,
  "source": {
    "sessionId": "<native-session-id>",
    "messageId": "<native-message-id>",
    "toolCallId": "<native-tool-call-id>",
    "tool": "read",
    "contentIndex": 0
  }
}
```

- Artifact IDs are random, not derived from the hash, so an ID reveals nothing about content and cannot be guessed from known bytes.
- Artifact ownership and exposure are per native session. Parent and worker/native-subagent lifecycles must not share age counters. A child's model response never advances a parent's retention clock, and a child's access to an artifact is explicit rather than inferred from a guessed ID. Apply the same rule recursively to grandchildren.
- Original paths are optional provenance. They are never the sole recovery mechanism and never authorize reading arbitrary files.
- Deduplicate identical bytes, but keep separate chronological occurrence records. A repeated read must not reactivate every older occurrence of the same image.
- Blob deduplication must not bypass per-session access control. Knowing a hash or artifact ID is not permission to retrieve a blob.
- Image result arrays and order, tool IDs, statuses, text output, errors, and usage remain intact.
- A `file` part is resolvable only if a capture-created occurrence record exists for that exact occurrence identity and artifact. Artifact-looking strings in user text, tool text, other tools' `file` parts, or references copied into another session are never resolved by URI alone.
- Strip binary copies from result metadata only for producers whose schema is known to duplicate them (none observed for Grok). Use explicit producer schemas, not destructive string heuristics.
- If saving fails, keep the original inline part and emit a bounded diagnostic. Never report successful externalization, and never regenerate images automatically. Capacity exhaustion needs an explicit policy (D7) before default rollout.

### B. Hydrate only outbound model requests

Hydration happens in one SANE-owned request-projection step. Its ordering relative to compaction restoration is mandatory; see "Compaction, request prefixes, and provider state". Persisted records and history responses keep carrying references.

- Map each resolvable active reference to a `data:` URI, the only form currently known to reach models from tool results. Read with a byte cap, verify length and SHA-256, and on mismatch emit an unavailable-image diagnostic.
- Never add, remove, or reorder messages, and never touch restoration messages (`metadata.saneCompactionRestoration`). Replace parts in place only.
- Hydrated bytes must not reach SANE journals, metrics, diagnostics, or tool metadata. Other plugins' `http.request` or `experimental.ws.send` hooks can observe request bodies; SANE cannot prevent this, so document it.
- The compaction summarizer and `generate`/`title` requests need explicit treatment (D5). Proposed: the summarizer gets the same projection as the primary request, bounded by the aggregate budget. Title and generate get placeholders only. None of these requests mark an occurrence as exposed or advance its age.

For expired occurrences, emit a deterministic plain-text placeholder at the same content position:

```text
[Previously viewed image; pixels omitted from current context.
Artifact: image_<opaque-id>
Original path: data/images/outputs/example.png
Read the artifact again if visual details are needed.]
```

Omit unknown paths. The placeholder is a pure function of the occurrence record and policy version, so it is byte-identical on every request. Missing or corrupt artifacts produce an explicit unavailable-image diagnostic; never fall back silently to a possibly changed original file.

**Re-read operation:** a SANE-registered tool, registered through `ctx.tool.transform` like the existing SANE tools (`opencode/plugins/sane/index.ts:42-146`). It takes an artifact ID, checks that the calling session owns or inherited the occurrence, and returns a `file` part. Its result is captured like any other, so it creates a new occurrence pointing at the same blob, and it works after the original path is gone. Its name, permission action, and Code Mode exposure are part of D1.

### C. Separate evidence from presentation

Persist references and retention decisions, not hydrated payloads. SANE can offer a separate authenticated binary route for UI inspection, analogous to `share_media`. Keep binary fetches bounded and session-scoped, and do not embed data URLs in transcript listings. Native UIs (TUI, web) will not render option (a) references; record this as an accepted UX cost or a native change.

## Image retention policy

Proposed initial policy: configurable, versioned, and persisted per session.

### Definitions (verify against durable native records in Phase 0)

- **Occurrence:** one captured image `file` part at one occurrence identity.
- **Primary response:** an assistant message in the current native session's primary loop with `time.completed` set and no `error`. Compaction, title, generate, and responses from other sessions are excluded. Workers and native subagents have their own primary loops and apply the same policy independently; excluding their responses from the parent's clock must not exclude their images from cleanup. The assistant schema has `finish: "tool-calls"`, which suggests V2 records one assistant message per model step; this is **unverified**. If it holds, a "response" is a model step, not a user turn, and three responses can pass inside one tool loop. Decision D3: keep per-step counting (recommended, because it tracks how many requests actually carried the pixels) or count only turn-final responses.
- **Exposure response:** the first successful primary response whose actual request demonstrably included that occurrence's pixels. Chronological completion after a tool result alone does not prove exposure, especially with budgets, compaction, or provider-state reuse.
- **Subsequent tool call:** a completed (not errored or interrupted) top-level tool part in an assistant message strictly after the one that contains the occurrence. Siblings in the same parallel batch do not count. A Code Mode `execute` counts once unless native exposes durable inner-call identities (D4).

### Rule

After a successful exposure, an occurrence remains hydrated while **subsequentResponses < 3 and subsequentToolCalls < 12**. The exposure response itself does not count toward the three subsequent responses. Example: R0 first sees the image; R1, R2, and R3 are three subsequent successful primary responses. R4 receives a placeholder. The twelve-call threshold can expire it sooner, but never before successful first exposure. D3 determines whether a response is a model step or a whole turn.

**Prefer derived age, but prove exposure first.** Derive age from durable native history where completion/ordering semantics are qualified. Pure chronology is insufficient if a request can omit a stored image. Retain a durable request-inclusion record, linked to accepted response identity, unless an existing native record proves which occurrence actually reached the successful request. A pre-dispatch record alone is not exposure. Budget-deferred images must remain unseen, not acquire age from unrelated completions. Qualify retry, abort, compaction, and provider-state behavior in Gate 1; do not claim counters are deterministic merely because history exists.

| Condition | Behavior |
| --- | --- |
| Newly captured image | Hydrate in every primary request until the thresholds are reached. |
| No exposure yet (failures, aborts, retries) | Counts stay at 0; keep hydrating. |
| Age threshold | Placeholder from the first request where responses ≥ 3 or toolCalls ≥ 12. |
| Re-reading an artifact | A new occurrence with its own age; historical occurrences are never rewritten or reactivated. |
| Explicit pin | Hydrate while a bounded pin is valid. There is no native pin API: a pin would be a SANE tool recording a durable pin, with a count limit and its own expiry, e.g. N responses. Optional; Phase 2 or later. |
| Compaction, title, generate | Never advance age and never count as exposure. |
| Pre-existing inline `data:` parts (no occurrence record) | Hydrate as-is and never expire, because no exact re-read path exists (D8). |
| Revert or fork | Age is recomputed from the history that the session now has. Forks inherit records only under D10. |

### Aggregate budgets

Cap the active image count and encoded bytes per request. Defaults need measurement against supported models and real comparison workloads. The budget must be deterministic too. Over budget, expire the oldest already-exposed, unpinned occurrences first. Never silently drop unexposed images. If the unexposed images alone exceed the budget, enforce it at capture time: store all of them, deliver the ones that fit, and add a bounded text part naming the artifact IDs that were stored but not delivered. Requires decision D6.

Existing agent descriptions remain as written. There is no requirement to inspect hidden reasoning or generate captions. This is a heuristic tradeoff: an agent may need to re-read visual evidence later.

## Compaction, request prefixes, and provider state

### What restoration does today (verified, `compaction-context.ts:100-156`)

- `restore` runs in SANE's `context` hook and its `compaction` hook (lines 143-156), only for managed sessions that have a completed compaction checkpoint.
- For each recorded window entry, it checks `sha256(JSON.stringify(messages.slice(0, offset)))` and then splices the restoration message in at `offset`. A new context version appends an entry whose hash covers the whole current `messages` array.
- So any change, as seen by `restore`, to a message before the latest entry's offset throws "Native compacted prefix changed" and blocks the request. Messages after the last offset are not hashed until another entry is appended.

### Consequence: projection must run after restore, in the same callback

- **Projection before restore** is incompatible. Hashes would cover hydrated bytes, which are expensive, and any expiration inside a hashed prefix would throw.
- **Projection after restore** is compatible with SANE's checks by construction. Hashes cover the persisted reference form, which is stable if native history is stable. Offsets stay valid because placeholders replace parts in place without changing the message count. Hashing also gets cheaper, since references replace image bytes.
- Implement both steps as **one** registered callback that runs `restore` first, then the image projection, for both the `context` and `compaction` hooks. Do not register an independent image hook. Other plugins can transform messages before or after this composite callback; qualify those interactions as B4. Do not claim another callback can run between these two steps merely because they use hooks.
- This holds only if native passes persisted references unchanged into `event.messages` (Gate 1, item 4). If native pre-resolves references, or OpenCode later moves resolution before hooks, the analysis must be repeated.
- Existing window hashes already cover legacy inline `data:` parts. The projection leaves those parts unchanged (D8), so existing windows stay valid.

### Constraints SANE's checks do not cover

- **Prompt cache:** each expiration edits an earlier prefix and causes a cache miss from that point. Measure this. If needed, batch expirations (for example, expire at most once every K responses) under a policy-version knob, rather than expiring each image at its exact threshold.
- **Signed reasoning:** whether providers accept edited earlier tool results next to signed thinking is an assumption. Test it per provider mode, and never alter signed reasoning itself.
- **Server-side provider state:** if a driver sends deltas against stored provider state (stored responses, `experimental.ws.*` socket reuse), edits to earlier messages may be ignored or may contradict server state. For each mode, verify that the edited prefix is what the provider receives; otherwise disable expiration for that mode and publish the gap.
- **Provider-native compaction windows** (`native.messages`) are replayed verbatim. Do not rewrite them; images inside them are out of scope and must be reported.

Do not delete prefix checks, alter signed reasoning, or discard native checkpoints to make validation pass. Externalization stays useful without expiration, as long as hydration is deterministic.

## Integration points and feasibility gates

### Existing repository surfaces

- `opencode/plugins/sane/index.ts`: tool registration (`ctx.tool.transform`), `execute.before`/`execute.after` hooks, and Code Mode wrapper tracking (lines 28-33, 152).
- `opencode/plugins/sane/compaction-context.ts`: the single `context`/`compaction` callback that the image projection must compose with (lines 143-156).
- `opencode/plugins/grok-imagine/index.ts`: disk saves under `<checkout>/.opencode/grok-imagine/<uuid>/` and inline `data:` results.
- `packages/sane-cli/src/native-browser.ts`: `browser_screenshot` text output.
- `packages/sane-cli/src/install-sane-agent-context-packages.ts`: installed plugin file list and vendored closure (lines 69-80, 213-233). New plugin modules and any shared contracts must be added here; never edit installed copies.
- `packages/sane-app/src/opencode.ts`: `history()`, `snapshot()`, `compactionSnapshot()`, and `normalizeMessage`.
- `packages/sane-app/src/opencode-run-service.ts`: compaction completion monitor (calls `compactionSnapshot`, line 495).
- `packages/sane-app/src/run-journal.ts`: the integrity-pinned journal lifecycle. Do not bypass it.
- `packages/sane-app/src/opencode-observation-service.ts`: native paging and normalized-history caching; frontend pagination alone does not bound native ingress.
- `packages/sane-app/src/opencode-subagent-recorder.ts`, `native-subagent-service.ts`, `native-subagent-projection.ts`, and `conversation-evidence-routes.ts`: child capture, cached summaries, full-history hashing, and legacy event responses.
- `packages/sane-app/frontend/session-viewer.tsx`, `worker-client.ts`, and `cc-client.ts`: SANE worker navigation, state listings, and the initial raw-event replay path.

### Gate 0: environment

Record the OpenCode runtime version actually installed, not only the SDK pinned in `package.json`; the Grok plugin rejects runtimes below 2.2 (`grok-imagine/index.ts:158-167`). Record the provider modes in use and which of them use server-side state or WebSockets. Every later gate result is tied to this version and is re-run on upgrade.

### Gate 1: persistence, identity, and lowering

Run all probes in a disposable OpenCode home with throwaway sessions. Never use the user's live database, running services, or installed plugins. A hook's existence proves only that the shape exists. Each item needs observed evidence, or native source, for the recorded version.

1. **Persistence point:** after `execute.after` rewrites `result.content`, the persisted `ToolStateCompleted`, the native event stream, and any running/progress records contain only the reference. No earlier record or event carries the bytes. SANE's reply observer consumes the event stream, so a pre-hook event copy would still reach SANE.
2. **Coverage and duplication:** the hook fires for built-in `read`, both Grok tools, and the outer `execute`. Determine whether it also fires for inner Code Mode calls (double-capture risk) and how parallel calls interleave. Repeat for Base/managed sessions, native children, SANE workers, and nested descendants; do not assume plugin activation or a managed-session predicate covers all of them.
3. **Validation:** native accepts and persists the chosen reference URI, and history routes return it unchanged.
4. **Request path and lowering:** the reference reaches `event.messages` unchanged, i.e. native does not pre-resolve it. Replacing it with a `data:` URI yields a provider request that actually contains the image, for each supported provider. Capture this at a local recording endpoint, not from UI rendering. For option (b), also test native lowering of `file://` with the plugin disabled.
5. **Durable signals:** identify the assistant-message fields for completion, error, and interruption; tool-part statuses; and the effects of retry, revert, fork, and model switch. Confirm that per-step assistant messages exist (D3).
6. **User attachments:** characterize `MediaUser`/`experimental-media-uri` storage and lowering, or explicitly exclude user attachments.

On failure, narrow the pilot to producers that pass, or move the boundary into OpenCode or a supported native API. A request hook alone cannot reduce persisted history. Never substitute a background SQLite mutation job.

### Gate 2: compaction and provider compatibility

Pass criteria, per supported provider mode:

- With restore-then-project in one callback, manual, automatic, and provider-native compaction followed by several expirations never raises the prefix-changed error. Restoration text stays at its recorded offset.
- Requests with expired earlier images are accepted alongside signed reasoning.
- Server-state and WebSocket modes either demonstrably send the edited prefix, or have expiration disabled and the gap published.
- Prompt-cache effect is measured and acceptable, or a batching policy is approved.

Until a mode passes, keep expiration off for that mode. Externalization and hydration can still ship.

## Implementation phases

Each phase has an exit gate. SANE-only Phase 1a quick wins can proceed independently of the OpenCode externalization probes. Phase 1b requires its Gate 1 cells; expiration in Phase 2 additionally requires Gate 2. Native-ingress changes that require a new native API are separately gated and must not delay the confirmed summary-loading fix.

### Phase 0 — Feasibility and contract (read-only plus disposable environment)

- Record Gate 0 and qualify Gate 1 before externalization. Qualify Gate 2 before expiration, using an externalization prototype if needed. Maintain a producer × transport × provider-mode coverage matrix, marking each cell verified, excluded, or blocked; this discovery does not block independent SANE-only quick wins.
- Resolve D1, D2, D3, D4, D7, and D10 at minimum. Write the versioned occurrence-record contract.
- Exit: a short go/no-go memo listing required native changes. Do not claim a plugin-only solution until Gate 1 passes.

### Phase 1a — SANE hardening (no OpenCode gate; can start immediately)

- `compactionSnapshot`: fetch the admitted message directly via `/message/{id}` (the route pattern already used at `opencode.ts:524`, and confirmed for the completed incident compaction during repair). Keep the existing session, active, and inbox checks before releasing ownership. Bound the read of that single response, because `request()` has no byte cap. Still qualify the still-queued/not-yet-visible case. Keep paging only as a bounded fallback that checks for the ID before the budget.
- `history()`: decide whether import needs image bytes at all (D9). Make import descriptor-aware instead of raising the 16 MiB cap.
- `normalizeMessage` for **new** events: replace `file` parts carrying `data:` URIs with a bounded descriptor (`mime`, `name`, `byteLength`, `sha256`, `omitted: "inline-image"`), and keep text parts unchanged. Do not rewrite existing journals.
- Native-child summary loading: skip sealed terminal captures before expensive full-history projection, share/reuse projection work per run, and keep summary listing independent of serialized child image contents. Include native-child capture in descriptor coverage.
- Native-child refresh: resolve the exact requested child before expensive work, coalesce refreshes per run/child, and derive summary revisions from summary state rather than hashing complete child bodies just to list them. Active children still require qualified observation; do not fabricate terminal status from the parent or skip a missing final capture.
- SANE worker viewer: use paged latest/older/refresh transcript reads instead of initial `/events?after=0` replay. Do not fetch sibling or descendant transcripts until opened. Keep state/summary reads distinct from transcript detail.
- Native ingress: negotiate/reference a supported media-free history representation when possible and apply actual byte limits as well as message limits. If the native API cannot avoid transferring image bodies, state the remaining gap and required native change; stripping bytes after downloading them only fixes SANE persistence and later responses.
- App journal ingress: derive a summary/message index without altering journal bytes. An optional background/off-main-thread legacy index can make subsequent opens cheap; it must be revision/source-bound, disposable, and never grant append/ownership authority. Do not claim a strict cold-load bound while whole-file synchronous materialization remains.
- Routine response bounds: use image descriptors for parent/child/worker transcript output, with authenticated on-demand media reads. Specify pagination/oversized-event semantics for the legacy event API and keep raw audit export outside routine worker display.
- Exit: the scale fixture's completed compaction is observable, new journal entries are independent of image size, warm parent/child-summary opens avoid child-body hashing, and initial worker display is bounded rather than an entire-run download.

### Phase 1b — Externalization without expiration

- Grok first (producer-side capture), then `read` and outer `execute` via `execute.after`, each only after its Gate 1 cell passes.
- Every occurrence is hydrated, which keeps current visual behavior. Add the re-read tool. Make the SANE UI reference-aware through a separate bound binary route.
- Compose the projection into the existing restoration callback (restore, then project) now, even with no expiration, so that Phase 2 changes no ordering.
- Exit: acceptance criteria 1–3, 6, and 8 pass for covered producers.

### Phase 2 — Retention and controlled expiration

- Add the derived-age projection, policy-version persistence, aggregate budgets, and optional bounded pins.
- Enable per provider mode only after its Gate 2 cell passes.
- Exit: acceptance criteria 4, 5, and 7 pass, with measured cache impact.

### Phase 3 — Coverage and old-history migration

- Extend ingestion to direct user attachments and other transports only after proving their persistence behavior.
- Offer a separately authorized, previewable migration for existing sessions. Require an idle native session, no pending input, complete backups, and a supported mutation mechanism or an explicit offline maintenance procedure. Migration also has to deal with restoration windows whose hashes cover the inline bytes being replaced: migrate only sessions with no active window, or re-checkpoint first.
- Never mutate sealed SANE journals behind a live integrity-pinned writer. Any audit migration needs its own supported lifecycle.
- Artifact garbage collection stays a separate proposal. Never delete evidence just because its pixels expired from model context.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Artifact write fails (I/O, disk full, quota) | Keep the original inline part, append a bounded diagnostic text part, and emit a metric. Never report externalization. |
| Crash after blob write, before native persists | An orphan blob; harmless; left for the future GC proposal. |
| Crash after native persisted a reference | Cannot reference a non-durable blob if fsync-before-substitute holds. If the blob is missing anyway, emit an unavailable diagnostic. |
| Hash or length mismatch at hydration | Unavailable-image diagnostic. No fallback to the original path; no regeneration. |
| Unknown, forged, or foreign-session reference | A fixed "unresolvable image reference" text part. Never read any path derived from it. |
| Plugin disabled | Option (a): behavior is unknown until Gate 1 tests it; blocks rollout without an export/materialization path. Option (b): native lowering, if verified. |
| Restoration throws | Existing fail-closed behavior is preserved. Acceptance requires that the image projection never causes it. |
| Policy version change | Applies to subsequent requests only. Disabling expiration rehydrates retained occurrences (a cache cost, not a correctness issue). |
| Capture exceeds per-image or per-result caps | Treat it as a capture failure and keep the original. Grok's own caps bound its inputs. |

## Security

- Store artifacts with private permissions outside the checkout, under random artifact IDs. Store hashes internally and never use them as capabilities.
- Authorize by session ownership of the occurrence. Forks get access only through native fork lineage (SANE already sees `fork.sessionID` from `/fork`, `opencode.ts:545`), under D10. Exports and deletions follow D10 as well.
- Resolve only structured `file` parts at known occurrence identities (section A).
- The re-read tool needs its own permission action and the same session checks inside Code Mode as outside it, following the existing SANE handler pattern.
- Decode under byte caps and verify signatures to bound memory and reject non-images.
- Never write hydrated bytes to logs, journals, metrics, or diagnostics. Artifacts may hold sensitive screenshots; treat them as having the session's sensitivity.

## Validation and acceptance criteria

These are planned checks, not authorization to write or run tests. Follow repository rules: no tests, test files, or browser verification unless explicitly requested; if approved, use focused checks rather than the full suite.

1. **First-look equivalence:** `read` (including of screenshot artifacts), both Grok tools, and Code Mode `execute`, including parallel calls, deliver real image parts on the first request, as captured at a recording endpoint. Canonical history contains references only.
2. **No binary leaks:** native message and event storage, event stream, tool metadata, SANE journals and APIs, and pagination contain no inline payloads for covered producers. Gaps for uncovered producers are listed explicitly.
3. **Exact recovery:** after the source image is moved or modified, the re-read tool returns the captured bytes. Corruption and missing blobs produce explicit diagnostics.
4. **Retention boundaries:** exact 3-response and 12-call thresholds hold under the D3/D4 definitions, including parallel batches, pins, aborts, retries, restarts, reverts, forks, and repeated identical images. Compaction, title, and generate requests never age or expose images. Results are identical after a process restart.
5. **Compaction compatibility:** the Gate 2 pass criteria hold for each enabled provider mode, and restoration text and offsets are unchanged.
6. **Failure safety:** every row of the failure table behaves as specified. No evidence loss, no cross-session access, no automatic regeneration.
7. **Completion independence:** a completed compaction is observable when unrelated history exceeds 16 MiB (Phase 1a).
8. **Scale:** replaying a fixture comparable to the incident (170 images, about 100 MiB inline) records stored-history size, blob-store size, history-response size, request size, hydration latency, restoration hashing time, and cache impact. History JSON scales with references, not image bytes.
9. **Worker/descendant coverage:** exercise a parent with native children, separate SANE workers, and grandchildren. Capture/externalization applies in every covered OpenCode session, age remains per session, and inheritance/re-read authorization cannot leak artifacts between siblings.
10. **Loading regression:** include the five-child/646 MB legacy journal case. Measure native ingress bytes, journal bytes decoded, projection/hash bytes, event-loop blocking time, cold/warm summary latency, browser response bytes, and peak memory separately. A warm summary request must do no full child-message serialization/hash or native refresh for already sealed children. Set a hardware-qualified latency target before rollout; the observed 12.7-second handler is the regression baseline, not an acceptable target.
11. **Bounded worker opening:** opening one worker loads its latest transcript page and lightweight state, not all events from cursor zero and not other descendants' details. Earlier pages load explicitly. A single legacy event/message containing hundreds of megabytes must not bypass routine wire limits through an oversized-record exception; return a declared descriptor/detail reference while preserving source evidence for explicit inspection/export.

## Rollout and recovery

- Opt in per session or location first, and publish producer and provider-mode coverage.
- Track bounded metrics: captured and externalized bytes, dedup hits, hydrated and omitted occurrences, active image count and bytes, capture and hydration failures, and history-page sizes. Never log image bytes or unbounded prompts.
- Persist the policy version per session; behavior stays deterministic across reloads.
- Disabling expiration rehydrates retained references. Disabling the whole plugin must not strand reference-only history (see failure table).
- Keep capture failures visible. A silent fallback to inline storage must not appear to satisfy the no-base64 guarantee.
- Keep the one-off incident backup intact; it is not an automated migration input.

## Blockers and decisions

### Implementation blockers (cannot be resolved from repository code)

- **B1 Persistence point:** is the `execute.after` result the canonical persisted and streamed result? This blocks Phase 1b for `read` and `execute`, but not for Grok.
- **B2 Lowering:** which tool-result URI forms do providers actually receive and use? This blocks D1 and Phase 1b.
- **B3 Code Mode inner hooks:** does `execute.after` fire per inner call (double capture)?
- **B4 Hook interactions:** the documentation specifies plugin ordering; qualify the installed runtime and callbacks before/after SANE's composite transformation. Also verify native processing between hooks and dispatch does not invalidate the reference or restoration model.
- **B5 Provider state:** signed-reasoning tolerance and server-state/WebSocket behavior per provider mode. Blocks Phase 2 for each mode.
- **B6 Durable exposure/completion signals:** the fields that distinguish completed, failed, interrupted, and retried assistant messages, whether assistant messages are per step, and how an accepted response is tied to the actual image occurrences included in its request.
- **B7 Disable path:** native behavior for unresolved references when the plugin is absent.
- **B8 Pending compaction lookup semantics:** fetching the incident's completed compaction by exact message ID was confirmed against the running native API during repair. Still qualify queued/not-yet-visible input behavior, identity/type checks, and bounded response handling for the implementation version.

### Decisions

- **D1** Reference encoding (option a or b) and the re-read tool name and permission.
- **D2** Artifact store location and namespacing.
- **D3** Per-step versus per-turn response counting.
- **D4** Code Mode `execute` counted once or per inner call.
- **D5** Pixels for the compaction summarizer; placeholders for title and generate.
- **D6** Budgets, pin limits, and pin lifetime.
- **D7** Capture-failure and capacity policy.
- **D8** Legacy inline `data:` parts: never expire (proposed) or expire only after an approved migration.
- **D9** Which SANE consumers (import, continuation, UI) need pixels from journals, and how they reach the artifact store instead.
- **D10** Authorization and lifetime for forks, exports and imports, session deletion, and copied references.
- **D11** `browser_screenshot` with `saveArtifact: false`: keep base64 in JSON text (it is not model-visible pixels), or change that SANE-owned producer to omit or bound it.

### References

Use current V2 documentation for the supported API contract and version-qualified runtime/source evidence for actual behavior. Record discrepancies rather than treating SDK declarations as proof of runtime ordering, persistence, or lowering.

- [OpenCode V2 server plugins and hooks](https://opencode.ai/v2/docs/build/plugins/server/).
- [OpenCode V2 attachments and image normalization](https://opencode.ai/v2/docs/attachments/).
- [OpenCode V2 compaction](https://opencode.ai/v2/docs/compaction/): stored older messages survive compaction even when attachment data is omitted from subsequent model context.

# App-owned user-role context delivery

Claude Code and OpenCode use one shared selective composer and submission
coordinator. SANE context travels in the normal user-role prompt, not a parallel
hook, system-prompt file or native instruction entry. Canonical App sessions use
pinned context/execution packages rather than installed SANE agent/skill Markdown.
Runtime plugins, authenticated hooks and MCP integrations remain necessary.

## What is sent

- **Explicit activation:** selected role, framework, pinned procedure index,
  initial Pickup and current Session context, composed once. Worker activation
  selects its applicable procedure, structured assignment and protocol context.
- **Ordinary Base or SANE follow-up:** the authored body only, without recurring
  standing or Session context. Resume, process restart, missing evidence and
  package revision changes do not independently authorize activation or resend.
- **Explicit selection:** Session updates select current authoritative roots;
  science messages share selected frozen snapshots with the authored comment.
  They do not automatically repeat standing context. The Session-update backend
  has no dedicated App update control.

Bootstrap validates its pinned context/execution pair once during explicit
preparation. Selected content is composed once, with retained
`assertSelectionCurrent` checks for mutable intent/source, binding and body
currency. SANE ordinary preparation checks paired lifecycle metadata, original ready
admission and known unsupported states; it does not reconstruct activation from
journals/native history or validate context packages/execution policy in the
generic message engine. Policy loading and pinned integrity remain separate
execution-configuration duties. Do not modify pinned revision directories.

## Transport and execution remain distinct

Both adapters bind exact encoded outgoing bytes to the original request/run and
source. Existing ownership, cancellation, admission, durable publication and
no-replay fences remain; composing a message grants none of that authority.

### Claude Code

The composed text is encoded in a retained user JSON message and written unchanged
to stdin. Pipe flush establishes submitted, with native acceptance unknown.
Canonical resumes disable restoration of old system-prompt snapshots with
`--system-prompt-snapshot off`. Standing `--append-system-prompt-file` delivery
and `UserPromptSubmit` additional-context delivery/acknowledgment gates are retired.
Operational/authentication hooks, MCP caller bindings, native-child definitions
and supported permission/model translation remain separate execution concerns.

### OpenCode

The composed text is encoded once into the actual HTTP prompt body and sent
unchanged. Acceptance requires the exact command acknowledgment; an ambiguous
response stays unknown. The App no longer writes `sane.context` instruction
entries or framework/Session synthetic messages. Legacy owned entries are not
silently deleted or adopted.

The installed `sane-execution/configure` RPC still configures generated root
execution agents with empty instruction text and retains native-child policy,
permission and model handling. Prompt setup reuses its full resolved execution
context for launch metadata: the shared prompt path has two timed
`execution.resolve` steps rather than three. The separate post-policy binding
lookup remains, as does fresh final preflight after configuration effects;
compaction retains its independent lookup fallback. This is not a global cache
or a performance qualification.

## Limits and inspection

There is no automatic legacy migration, SANE branch inheritance or qualified SANE
compaction/reset recovery. Known unsupported legacy, branch and recorded
reset/compaction states refuse without silent bootstrap, adoption or resend.
Base branching and dedicated native compaction retain their existing paths.
Ordinary sends do not continuously inspect native history, so out-of-band edits
or resets are not guaranteed to be detected. Lifecycle metadata is not proof of
historical delivery, Session-root provenance continuity or current retention.

The legacy `contextDelivery` values are compatibility aliases, not alternate
transports. Runtime installation does not itself migrate sessions, delete native
history or authorize installed-asset retirement.

**View SANE context** explicitly reads protected recorded outgoing evidence.
Historical activation/native-source/reader modules remain read-only inspection
tools, not ordinary send gates. Inspection never repairs logs, substitutes current
files or resends messages. App **Message receipts** record admission separately
from native outcomes; exact-status recovery never replays the request. Neither
recorded acceptance nor a successful run proves model consumption.

See the [operator guide](../../packages/sane-app/HUMAN-OPERATOR-GUIDE.md#sane-context-and-message-receipts)
and [current cutover contract](../../reports/context-message-cutover-2026-10-26/README.md).
Dated verification captures describe their checkpoint, not a current full-App,
browser/native workflow or crash/retention qualification. Source changes do not
imply runtime deployment.

## Implementation entry points

- [Shared composer freshness](../../packages/sane-app/src/context-message-engine.ts)
  and [owned preparation](../../packages/sane-app/src/owned-message-preparation.ts).
- [Shared submission coordinator](../../packages/sane-app/src/run-submission-preparation.ts)
  and [execution preparation](../../packages/sane-app/src/execution-preparation-service.ts).
- [Claude adapter](../../packages/sane-app/src/claude-run-service.ts),
  [OpenCode adapter](../../packages/sane-app/src/opencode-run-service.ts) and
  [protected read-only evidence routes](../../packages/sane-app/src/conversation-evidence-routes.ts).

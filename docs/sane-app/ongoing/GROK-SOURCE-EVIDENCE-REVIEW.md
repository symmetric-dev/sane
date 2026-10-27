# Grok source, evidence, and storage review

Reviewed 2026-10-27 against `3c157d8`. This review decides the contract.
Storage implementation was later authorized. There are no ongoing workstreams
and no backwards-compatibility requirement, so schema v6 is the current
schema. Opening a v5 repository requires explicit `sane upgrade`; open does
not migrate. Frozen v1–v5 SQL is unchanged. App v1 files are still read so
Claude Code and OpenCode start. A Grok pin is source-record v2, written only
by an explicit publish. This still does not authorize a profile, adapter,
receipt change, or native trial.

The one existing trial is Grok Build 1.0.70 in
`experiments/user-owned-context/GROK.md`. It is a starting observation, not
runtime qualification. Local captures under `reports/user-context-grok-*` stay
local and are not part of this decision's stored bytes.

## Decision

Grok is a third native source, not a Claude profile and not an OpenCode
registration. Its native token is `gk`. Its session-facing name, when a later
implementation adds it, is `grok`. Do not put the word `grok` in an authority
hash. Renaming that token later would reidentify every Grok conversation.

Unconfigured Grok must not change Claude Code or OpenCode defaults, hashes,
records, or startup. No open, refresh, or installed-binary discovery publishes
a new format. An old reader refuses a newer file or database outright. It must
not skip the new key and continue, and it must not downgrade.

## Source descriptor and hash

Current identity is `sane-native-v1:${harness}:${sha256(JSON.stringify(descriptor))}`.
Descriptor key order is part of that hash. Claude Code and OpenCode
serialization stays byte-identical. Do not invent `sane-native-v2` for the
hash, and do not rehash an existing descriptor.

The Grok descriptor, when implemented, is:

```text
{ version: 1, harness: "gk", kind: "local-home", homeRoot: <canonical absolute directory> }
```

`homeRoot` is the explicit `GROK_HOME` directory. It follows the Claude profile
rule: absolute, no symlink leaf, `realpath` of an existing directory. A missing
or unreadable home is `authorityId: null`. Unlike OpenCode, do not hash a
missing leaf. There is no parent-file identity to preserve.

These are not descriptor fields and must not enter the hash:

- The executable path, `NATIVE_GROK_BIN`, or a PATH lookup. That is launch
  configuration. An upgrade must not reidentify the source.
- OAuth tokens, `models_cache.json`, account ids, session files, and logs.
  The trial reported `apiKeySource: "oauth"`. That is not a source pin.
- The requested model or effort. The trial requested `grok-4.7` and the result
  usage reported `grok-4.7-build`. Requested model is not backend identity.

`authorityId: null` still means configured but unresolved. It does not mean
unconfigured. Absence of the pin means unconfigured.

## Source record

`sources.json` v1 is exactly `{ version: 1, cc, oc }`. `exact()` already
rejects an extra key, and `version !== 1` is already unsupported. Never write
`gk` into a v1 file.

v2, when an explicit configuration action publishes it, is:

```text
{ version: 2, cc: SourceRecord, oc: SourceRecord, gk?: SourceRecord }
```

The `cc` and `oc` pins are copied unchanged. A missing `gk` means unconfigured.
`gk.authorityId: null` means configured but unresolved. Do not use `gk: null`
as a third meaning.

Publication rules:

- A new binary reads v1 and runs Claude Code and OpenCode. It does not rewrite
  v1 because `grok` is on PATH.
- v2 is written only by an explicit Grok source configuration. The write uses
  the existing atomic record helper. An uncertain write is retained and refused.
  It is not repaired by downgrading to v1.
- An old reader refuses v2 as an unsupported source version. It does not ignore
  `gk` and keep serving.
- No downgrade. Unconfiguring Grok is not authorized here. A later removal must
  not rehash `cc` or `oc`.

## Repository schema

Implementation override, 2026-10-27: there are no ongoing workstreams and no
backwards-compatibility requirement. v6 is the current schema. A v5 store does
not open until explicit `sane upgrade`. Open still does not migrate. The notes
below are the earlier opt-in design; they are not the implementation.

v5 remains a valid operating schema. Do not make v6 the version required to
open a store. Current `repository.ts` refuses any database whose version is not
the current schema and demands an explicit upgrade. Bumping that current
version to 6 would block every Claude Code and OpenCode repository. That is
rejected.

v6 is opt-in. It exists so a Grok authority can be inserted. A binary that
understands v6 may open v5 without rewriting it. A binary that understands only
v5 refuses v6 with `UNSUPPORTED_SCHEMA` and does not downgrade. Opening a v5
store does not migrate it. The upgrade runs only when an operator explicitly
requests it, or when an authorized configuration must declare a Grok authority
in that repository.

Frozen v1–v5 SQL stays frozen. v6 is a new definition, not an edit of v5. The
only authority-shape change is the check:

```text
harness IN ('cc','oc','gk')
(cc AND local-profile) OR (oc AND local-registration) OR (gk AND local-home)
```

`conversations` references `native_authorities`. A check change that drops the
parent must use the existing child-preserving rebuild: copy `conversations`
rows unchanged, restore triggers, keep foreign keys enforced, and abort without
deleting history if the copy is not equal. Do not rewrite harness or authority
columns. Existing handoff JSON stays `cc`/`oc`. Widening the table check does
not accept a Grok handoff.

`conversations.harness` has no check of its own today. Do not add one that
would reject historical rows. After v6, a `gk` conversation still requires a
matching authority row.

An interrupted upgrade keeps the existing `upgrading.json` /
`.complete-upgrade.json` refusal. Do not add a second recovery protocol, and
do not replay a native create.

## App files, one by one

| Format | Decision |
| --- | --- |
| Manifest v1 | Keep. Grok needs no manifest field. A version bump would refuse the whole store. |
| Config v1 | Do not add `native.grok`. Unknown keys already refuse startup. A Grok home is config v2, written only by the explicit configuration action. A new binary still reads v1 with Grok unconfigured. An old binary refuses v2. |
| Metadata v1 | Do not store a Grok session here. The validator already requires `claude-code` or `opencode`, then treats any other authority as `cc`. Metadata v2 is required before the first Grok session row. Copy existing rows. Do not fill or recanonicalize them. |
| Admissions v1 | Do not store a Grok admission here. An unknown harness already corrupts the whole file. Admissions v2 is required first. Copy existing rows. Grok rows are `create` only. |
| Public receipts v1 | Cannot represent Grok. Do not widen `checkSourceFields`. Do not bump the receipt version until a per-turn message id is proven. |
| Private ledger v2 | Keep. It must not wrap a Grok target. No ledger bump until that proven receipt exists. |
| Catalog, navigation | Keep. No Grok field. |
| Pending input, activation journal, prepared-input codec | Keep closed. The first slice does not use restart recovery or role activation. Do not version them in advance. |
| Browser and resource pairs | Stay `claude-code` \| `opencode`. Pairing grants neither control nor Grok support. |
| Retirement, workers, questions, code share, science, handoffs | Stay ineligible. A new namespace must not fall through into a Claude or OpenCode adapter. |

Metadata v2, when later implemented, requires `harness: "grok"`, a UUID native
session id, and a `sane-native-v1:gk:` authority on Grok rows. Do not validate
Grok effort with the Claude effort enum. The first persisted session may omit
effort. A requested model string is not `modelUsage`.

Admission native-id bounds stay separate from history and from qualified
references. Do not collapse them. For a future Grok admission only: the native
session id is a UUID, the same character rule as a Claude admission, but the
harness is `gk`, so it is not a Claude row. Qualified references keep their
wider non-empty, no-NUL rule. History uses its own v2 rule and must not call
the admission validator to mean the same thing.

`native_creation_unknown` remains non-replayable. Attach and enroll stay
unavailable, so admissions v2 does not accept those operations for `gk`.

## Message evidence

The trial's session id is a caller-allocated UUID, passed as `--session-id`
and resumed with `--resume`. Stream `session_id` matched it. That is the
allocation strategy for the first slice. It is not OpenCode's native-created
`ses_` id, and it is not a message id.

What the same streams showed, and what must not be used as acceptance:

- `message.id` was `msg_0` on every sampled turn. It is not unique.
- Each stream event has its own `uuid`. The result uuid is not the session id
  and was not shown to be the durable history row id.
- Native history correlates authored user text by `prompt_index` and session
  path. That is capture evidence, not an admission receipt.
- `result.subtype: "success"` together with process exit 0 is not cancellation
  proof and is not a message id. Wrapper exit still does not prove the
  underlying work stopped.

Receipt v1 distinguishes a Claude UUID message id, with `nativeCommandId`
null, from an OpenCode command id that equals `nativeMessageId`. Grok has
neither. A session UUID alone does not establish acceptance.

Until a later adapter proves a stable per-turn native message id against
native history, Grok has no admitted receipt target. A future slice may journal
the submitted bytes and the stream as non-receipt evidence. Acceptance stays
unproven. Live input stays Claude-only. Do not version receipts speculatively.

## What this review does not select

No SANE role workflow is selected. Phase 5 stays closed. Caller qualification,
shell provenance, execution-policy translation, handoffs, workers, tools,
forms, sharing, science, pairing, and utilities are not decided by a source
pin. Storage is implemented. Base remains the next slice, and it still needs
its own authorization.

`dispatchHarness` stays a two-arm switch. A third arm is adapter work. It is
not part of publishing v2 or v6.

## Implementation bar, not this change

No tests are added by this review. When a storage implementation is
authorized, its offline tests are:

- A v1 source, config, metadata, and admissions file still loads, and its
  Claude Code and OpenCode bytes are unchanged.
- Publishing v2 or v6 is explicit. Open does not migrate.
- A missing `gk` pin is unconfigured and does not block Claude Code or
  OpenCode.
- `authorityId: null` is unresolved, not unconfigured.
- An old-reader check refuses v2, metadata v2, admissions v2, config v2, and
  schema v6 instead of treating them as Claude or OpenCode.
- A Grok session UUID is not accepted as a v1 receipt message id.
- `msg_0` is not accepted as a message id.
- An interrupted schema upgrade does not delete history and does not replay
  native creation.

Storage later landed. Offline tests are
`packages/sane-core/tests/grok-storage.test.ts` and
`packages/sane-app/src/grok-storage.test.ts`. The old-reader refusal was not
implemented; there is no backwards-compatibility requirement. An aborted copy
is proven by rolling back the caller transaction after the copy, not by a
second recovery protocol. This still does not authorize the adapter, profile,
or receipt bump.

# Accepted PoC baseline

## Acceptance

The owner reports the CC/OC integrations, workspace experience, and terminal working
well for the PoC. Feature scope is closed. Workstream state formalization and artifact
UI are post-PoC. This is functional owner acceptance, not exhaustive recovery evidence.

Runtime reported by owner: Bun 1.4.2. Other native harness versions, exact source
revision, and backup location have not been captured in this document.

## Preserve

- Chat with CC CLI and managed OC discovery/authentication; application-created
  conversations, native identity mapping, durable history, explicit interactions.
- Repository catalog with main/linked worktrees, fixed conversation cwd, independent
  browsing context, backend navigation bookmark, one implicit owner.
- CodeMirror editing, conflict detection, read-only staged/unstaged/untracked diffs.
- Contextual trees, compact context switcher, warm-light responsive UI.
- Per-worktree Bun PTY terminals, explicit keyboard ownership, reconnect snapshots.
- Current execution limit: one harness run globally; terminals independent.

Dependency versions are recorded in package.json and bun.lock; preserve both.
Native harness storage is independently required for actual continuation.

## Optional operator preservation record

The new App starts with fresh data: no migration or backup/restore exercise is
required to begin C1/C2. The accepted PoC remains running untouched. The following
are optional future operator records, not prerequisites or actions already performed:

1. Review and commit the accepted implementation plus closure/preparation documents.
   Record the commit below; optionally create an annotated `poc-baseline` tag after
   checking that the name is unused. Do not include private runtime data in Git.
2. If a backup is independently desired later, arrange an owner-controlled window. Preserve the configured
   bridge data directory (default `.data`), native CC/OC storage, workspace files,
   and SANE management `.sane` state using appropriate stopped/native backup methods.
   Do not assume copying live database files alone is a consistent backup.
3. Record actual data/config paths, native versions, and backup/restore instructions
   privately as needed. Do not put credentials or transcript contents in this record.
4. Keep the accepted PoC running while the new app package is developed in a separate
   checkout/worktree using copied tracked source, fresh data and independent assets,
   port and auth cookie. Do not reuse its writable data or native conversation IDs.

Capture fields:

```text
Accepted source commit: pending operator capture
Optional tag: pending
Native CC version: pending
Native OC version: pending
Private backup reference and timestamp: pending
Restore procedure confirmed by owner: pending
```

## Known boundaries carried forward

See LIMITS.md for detailed evidence. In particular, editing has optimistic conflict
detection/in-place writes; terminal state is bridge-lifetime only; detached process
cleanup is best-effort; moved catalog bindings lack a reassociation workflow; dirty
buffers are browser-memory only. Workstream membership is not yet integrated.

## Start command retained

```sh
cd /Users/beto/sane/poc/cc-web
bun run start --host 127.0.0.1 --port 18879 \
  --public-origin https://server.gecko-halibut.ts.net:18879
```

Managed OpenCode runs separately under the same owner/home environment. Preserve
the existing Tailscale mapping to localhost:18879. See HUMAN-OPERATOR-GUIDE.md.

No repository checks, commits/tags, backups, harness calls, or runtime verification
were performed to create this record.

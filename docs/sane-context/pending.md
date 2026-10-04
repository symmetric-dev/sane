# SANE Context: Pending Issues

Open items for SANE context delivery: the framework delivered once when SANE
creates a session, and the SANE Session block applied on every turn. Each item
states the current behavior and what a fix needs to cover. Installation gaps
are tracked separately in [installation/pending.md](../installation/pending.md).

## Claude ignores tool-level denies for read-only workers

The Scout, Scout Crew, and Reviewer workers declare `edit: deny`; Scout and
Scout Crew also declare `webfetch: deny`, and every worker declares `ask: deny`.
The serializer (`packages/sane-cli/src/agent-serialization.ts`) emits only
named skill and subagent denies, and the App launches Claude with
`--permission-mode bypassPermissions`, so these workers can still use Edit,
Write, WebFetch, and AskUserQuestion in Claude. A fix should emit tool-level
denies (`Edit` and `Write`, `WebFetch`, `AskUserQuestion`) unless the same tool
has a narrower allow.

## Assistants can still launch native subagents

Assistants must delegate through SANE workers (`sane_worker_start`), but their
agent files still allow native `task` launches: Execution allows the
implementer, tester, reviewer, fixer, and grounder; Planning allows scout-crew,
scout, and grounder; Research allows researcher; Design and Engineering ask.
A fix should deny native `task` launches for every assistant.

## "Phase slot" wording in agent files

Every assistant agent file says "use `sane_link` with your phase slot". Research,
Curation, and Experimentation link support-track slots, so "your slot" is the
accurate term.

## Per-run files are never removed

Each Claude run writes files to the App data directory: `<runId>.settings.json`,
`<runId>.sane-session.md` when the session has a workstream,
`<runId>.session-start.md` on the run that creates a SANE session, and
`<runId>.hook-errors.jsonl` when hook forwarding fails. They are kept as
debugging evidence and referenced by hash from each run's `launch` record, so a
retention policy must keep them as long as the run journal.

## Framework delivery record can be lost on OpenCode

The `context` record for an acknowledged OpenCode framework synthetic is held
in memory until the session's first run journal exists. If the App restarts
between session creation and that run, the record is lost; the synthetic
message itself remains in OpenCode.

## Handoff problem history is partial

Each new handoff problem is written once as a `handoff_problem` audit event,
but clearing a problem is not recorded, and the live problem display is
rebuilt by polling after a restart rather than reloaded from the audit log.

## Claude system prompt snapshot has no automated coverage

SANE Claude runs pass `--system-prompt-snapshot off` so the per-run Session
block reaches resumed runs. The existing argv test runs without a Session
block, so no test exercises the flag.

## Session review checks for new records are unvalidated

`.opencode/skills/review-sane-sessions/scripts/review.ts` checks the `launch`
and `context` records and the new failure fields from their specification
only; no live run had written them when it was built. Run it once against a
session created after these records were added and fix any mismatch.

## Sessions created before context version 3 have no framework

Sessions created before the framework moved into history were never given it
in their history. When resumed, they receive only the SANE Session block. There
is no migration.

## `sane sessions` cannot be used for operator review

`sane sessions --workstream <id>` fails with `NATIVE_CONTEXT_UNAVAILABLE` when
run from inside an agent session, so session review reads `.sane/sane.db`
directly. A fix should provide a read-only operator mode for the session and
assignment listing, or document the direct store queries it replaces.

## Inert workstream README copies

The shared workstream `README.md` template was removed when the framework
became system-provided. Existing workstreams still contain a `README.md` copy
that nothing reads.

# Native Grok Build context probe

Standalone experiment only; no production adapter. `grok.ts` directly reuses
unchanged `buildProbes` and `checkContent`. Earlier CC/OC/Antigravity captures and
source manifests are historical and are not rewritten by this addition.

## Selection and preflight

Discovered installed Grok Build 1.0.70 via `grok --help`, `grok --version`,
`grok models`, and local `~/.grok/docs/user-guide/{14-headless-mode,17-sessions,
22-permissions-and-safety,26-config-reference}.md`.

Authenticated default **grok-4.7**, supported **low** reasoning effort. The local
catalog explicitly says `grok-4.7-build-fast` is twice the price, so it is not used.
No exact dollar pricing, dollar cap, or cheapest-model claim. The runner refuses
changed authentication/default/unsupported effort; no silent fallback. Requested
model and effort are separate from native reported model/usage; neither is
independent backend verification.

## Commands

Input-only dry run (no CLI discovery or model calls):

```sh
TMPDIR=/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode \
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-grok-2026-10-25" \
  bun experiments/user-owned-context/grok.ts
```

Authorized live trial, five serial submissions maximum, no automatic retries:

```sh
TMPDIR=/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode \
SANE_RUN_LIVE_NATIVE_TESTS=I_ACCEPT_REAL_MODEL_CALLS \
NATIVE_CLEANUP=close-and-remove \
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-grok-2026-10-25" \
  bun experiments/user-owned-context/grok.ts --live
```

Optional `NATIVE_GROK_BIN` selects the installed executable, not a model fallback.
Each live process has an external 180-second timeout and `--max-turns 1`.
There is no CLI-native request-timeout flag in installed help.

## Transport and isolation

- One fresh UUID via `--session-id`, then four explicit `--resume <UUID>` calls.
  No fork, history reconstruction, latest-session selection, or bootstrap turn.
- Exact bodies/prompts and durable intent precede native submission. `--prompt-file`
  keeps prompt contents off process argv; `--verbatim` requests unchanged user text.
  Raw stdout/stderr go directly to private files before parsing.
- Activation+topic only on turn 1, selected Session update on turn 3; turns 2/4/5
  are body-only. No SANE system append, hooks, synthetics, or instruction entries.
- `--deny '*' --permission-mode dontAsk --no-subagents --disable-web-search`
  gates tools, and the shared first prompt suspends Pickup/all tools. This does not
  remove every tool schema or replace the native system prompt. Observed calls
  stop subsequent sends. `--no-plan` avoids plan/build automatic follow-up.
- Process-only documented compatibility flags suppress imported Claude/Cursor
  rules/agents/hooks/skills/MCP; managed MCP and cross-session memory are disabled.
  `inspect --json` must show no active project instructions/hooks/plugins/MCP before
  send (explicitly disabled compatibility discoveries may still be listed).
  Native/bundled instructions and skills still differ from other harnesses.
- Captures only selected files from the uniquely owned native session. Native
  chat/history inspection is stronger than model assertions, but does not prove
  model consumption or provider/backend identity.
- On complete capture, optional native deletion removes only the owned session.
  Its cwd prompt-history is captured and removed only if all five rows match the
  owned UUID and exact probe texts; an empty owned cwd group is removed afterward.
  Shared metadata/logs/caches are not reset. Submitted incomplete runs retain
  state for inspection; the runner has no replay/recovery mode. Any manual recovery
  must inspect saved successful responses offline and send only proven-unsent
  turns within the same cumulative five-submission cap.

Offline content review (zero model calls):

```sh
bun experiments/user-owned-context/review.ts /absolute/path/to/run-directory
python3 experiments/user-owned-context/grok-history.py /absolute/path/to/run-directory
```

The completed trial's native history also contained an initial user-info/rules
message and one bundled-skills `system_reminder` synthetic user message, even with
import compatibility disabled. These native additions carried no SANE context;
the experiment did not add another submission or replace native system behavior.

See the [dated report](../../reports/user-context-grok-2026-10-25/REPORT.md) for
actual results, exact native evidence, cleanup and limitations.

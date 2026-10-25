# Grok Build: user-owned context transport

2026-10-25 · `experiment/user-context-delivery` · standalone behavior experiment.

## Finding

**Five native submissions in one real resumed conversation passed all shared
content checks.** Grok retained user-role activation on ordinary body-only turns,
applied the selected roots update, and accepted/recalled the user's preference
override. This supports short-sequence transport portability, not production
readiness or general reliability.

| Probe | Observed response |
| --- | --- |
| Activation | `engineering`, `probe-alpha`, exact alpha roots, `additive-only` |
| Ordinary follow-up | Alpha workstream `design/solutions/retries.md`, `additive-only` |
| Selected roots update | `probe-beta`, exact beta artifact/implementation roots, `additive-only` |
| User override | Exactly `MIGRATION=phased-replacement` |
| Ordinary recall | Engineering, beta paths, `phased-replacement`, next useful step |

All four JSON replies were raw JSON. The final next step was:

> Draft the retry solution specification with you from the approved design and
> the solution template before any implementation.

No tool call or completed-work claim was observed. The fixture contained no
approved design/template; this is a proposed step, not verification of readiness,
actual Pickup, or document existence. Full exact responses and individual checks
are in [responses.md](fb4219d1-2c3e-474b-b1d0-3369c12994ab/responses.md).

## Discovery and model selection

- Installed executable: `/Users/beto/.local/bin/grok` → `~/.grok/bin/grok` →
  `~/.grok/downloads/grok-1.0.70-macos-aarch64`.
- `grok --version`: **1.0.70 (f50904eaee6c), stable**. Used actual installed
  `--help`, `models --help`, `agent --help`, `sessions --help`,
  `sessions delete --help`, `export --help`, `usage --help`, and `inspect --help`.
  Relevant local documentation was `~/.grok/docs/user-guide/14-headless-mode.md`,
  `17-sessions.md`, `22-permissions-and-safety.md`, `26-config-reference.md`, plus
  targeted configuration/MCP/memory documentation searches. No web research.
- `grok models` reported **logged in with grok.com**, default **grok-4.7**, and
  available `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`.
- Selected **grok-4.7 / low effort** explicitly. The allowlisted local catalog
  fields confirm supported `low`; the fast variant's description says **2x the
  price**, so “fast” was not interpreted as cheap. Exact dollar pricing was not
  locally available: selection used the authenticated baseline and low effort,
  not an assertion that it is the cheapest model. Five submissions/time limits,
  no CLI dollar cap and no fallback.
- Every init reported `grok-4.7`; every native assistant row reported
  **`model_id: grok-4.7-build`**, **`reasoning_effort: low`**, fingerprint
  `fp_5719f1aec35dd73c`. Every result's `modelUsage` used `grok-4.7-build`.
  These are native harness/provider-reported labels, not independently verified
  backend identity. The label difference is retained, not treated as an unobserved
  fallback or silently normalized.
- Sum of five reported result costs: **$0.063730**. This is the headless outputs'
  reported total, not an audited account bill or proof all auxiliary harness
  activity is included. Each result reported one agent turn and zero web searches.

## Native continuation and evidence strength

Native UUID: **`7d5dd369-f257-4895-bc31-9b7720d03c18`**.

The first invocation used `--session-id <new UUID>`; four subsequent invocations
used `--resume <same UUID>`. There was no `--continue` latest-session lookup,
fork, history reconstruction, extra context-only submission, or replay.

Per-turn native command shape (exact argv is saved for every turn):

```sh
grok --model grok-4.7 --reasoning-effort low \
  --output-format streaming-messages-json --verbatim \
  --no-plan --no-subagents --disable-web-search \
  --permission-mode dontAsk --deny '*' --max-turns 1 \
  --session-id <UUID> --prompt-file <activation-prompt-file>
# Turns 2–5 replace --session-id with --resume <UUID> and select only that turn's file.
```

- Shared unchanged `buildProbes` composes real Engineering/framework/Pickup/Session
  text; shared unchanged `checkContent` assesses responses. No production runtime,
  skills, or context assets were edited.
- Activation plus the topic was submitted once as an ordinary user message.
  Turns 2/4/5 were exact authored bodies; turn 3 contained only the selected Session
  roots update plus its topic, without repeating role/framework/initial Pickup.
- Intent, exact authored body/prompt files, text hashes, and command metadata were
  durable before send. Prompt contents were passed by file, not embedded in argv
  or printed by the runner. Raw stdout/stderr were written directly to private
  evidence files before parsing. No model assertion is used as admission evidence.
- Each stream's init/result agreed on the native UUID. Native persisted
  `chat_history.jsonl` contained the five exact authored user messages at prompt
  indices **0–4**, rows **3, 6, 9, 12, 15**. Each per-turn snapshot matched the
  complete expected history prefix; ACP `user_message_chunk` updates also matched
  exact texts. The activation marker appeared only in the first authored message,
  the update only in the third. This is decoded persisted-message evidence,
  stronger than response-only claims, but not independent admission or consumption
  attestation. [Offline native inspection](fb4219d1-2c3e-474b-b1d0-3369c12994ab/history-review.json)
  records the checks and source-file hashes.

## Isolation and native additions

The shared first body explicitly suspended tools/Pickup for the entire conversation.
`--deny '*'` is documented as a catch-all execution denial; `dontAsk`, disabled
web search/subagents, `--max-turns 1`, and `--no-plan` were additional bounds.
Tool schemas remained advertised: this was not a tool-free system prompt or an
independent enforcement test. Native streams and saved chat/ACP logs show no tool
calls. Each model process had an external 180-second timeout; none timed out.
Installed help exposed no native request-timeout flag.

Process-local documented compatibility environment flags disabled imported
Claude/Cursor agents/rules/hooks/skills/MCP, and managed MCP and cross-session
memory were disabled. Preflight inspection showed no active project instructions,
hooks, plugins, or MCP; it still listed an explicitly disabled SANE pre-tool hook
and MCP server. Every init had empty `mcp_servers`. No SANE hook, system append,
instruction-entry write, or SANE synthetic-context channel was used.

**The model-facing transcript was not synthetic-free.** Grok itself prepended an
initial user-info/native-user-rules message and a bundled-skills `system_reminder`
synthetic user message before the authored activation. These remained part of
native history; neither carried SANE context. Native user preferences were still
present despite compatibility flags. The native system prompt was also retained
and contained no SANE text. This limits isolation and comparisons with CC/OC/AGY;
the experiment neither replaced that system prompt nor added an extra bootstrap
model submission. Saved native evidence includes these native additions for review.

## Runs, commands, and failures

Common command prefix:

```sh
TMPDIR=/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode \
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-grok-2026-10-25" \
  bun experiments/user-owned-context/grok.ts
```

Live adds `SANE_RUN_LIVE_NATIVE_TESTS=I_ACCEPT_REAL_MODEL_CALLS`,
`NATIVE_CLEANUP=close-and-remove`, and the trailing `--live`. Full reproducible
commands and isolation flags are in [GROK.md](../../experiments/user-owned-context/GROK.md).

| Directory | Outcome |
| --- | --- |
| [45e1ca96…](45e1ca96-28b1-45ea-a77e-05370c89b4cb/evidence.json) | Initial focused input-only dry run, zero submissions; five probes/single activation/update/body-only turns and fixture removal verified |
| [a68fd5ba…](a68fd5ba-95fd-4eff-882c-774074e38b7c/evidence.json) | Live preflight stopped, **zero** submissions; disabled discoveries misclassified as active |
| [861c1ebd…](861c1ebd-cea6-421c-a00d-3b956c13ca8b/evidence.json) | Corrected preflight runner input-only dry run, zero submissions |
| [fb4219d1…](fb4219d1-2c3e-474b-b1d0-3369c12994ab/evidence.json) | Authorized live run, **five total submissions**, all five responses passed, complete; no recovery/replay |
| [1e1f66ef…](1e1f66ef-cedd-4dd5-ab15-585903b15403/evidence.json) | Final runner input-only dry run after owned cwd cleanup enhancement, zero submissions |

The preflight correction allowed entries only when both `disabled: true` and
`compatibilityStatus: disabled` were explicit. No native response was lost or
resent; the one failure preceded all five actual submissions. The live run's
original evidence remains unchanged.

Offline commands, both passing with zero additional calls:

```sh
bun experiments/user-owned-context/review.ts "$PWD/reports/user-context-grok-2026-10-25/fb4219d1-2c3e-474b-b1d0-3369c12994ab"
python3 experiments/user-owned-context/grok-history.py "$PWD/reports/user-context-grok-2026-10-25/fb4219d1-2c3e-474b-b1d0-3369c12994ab"
git diff --check
```

No broad suite, benchmark, browser verification, nested subagent, or commit.

## Capture, cleanup, and manifest scope

Each live turn retained exact prompts/bodies, argv, raw streams, parsed events,
and selected files from the uniquely owned session. Final native capture includes
history/updates, system prompt, tool schemas, summary and signals. No credentials,
account cache, or unrelated conversation were copied.

After capture, `grok sessions delete <owned UUID>` exited successfully and removed
that session directory. Fixture removed. Native deletion left one owned cwd-level
`prompt_history.jsonl`: offline checks confirmed all five rows exactly matched the
UUID and probe texts, then captured/removed it and removed the empty cwd group.
[Post-run cleanup](fb4219d1-2c3e-474b-b1d0-3369c12994ab/post-run-cleanup.json)
records this separate step. The final runner now includes that narrow cleanup;
the live run's `executed-runner.ts` preserves its earlier version, before the
cleanup enhancement. The final source only received an additional zero-call dry
run, not another live trial.

[Read-only residual inspection](fb4219d1-2c3e-474b-b1d0-3369c12994ab/residual-check.json)
confirmed the session, cwd group and fixture absent, and no owned UUID in active
sessions. Shared `~/.grok/logs/unified.jsonl` still held 141 references to the UUID
at inspection time. It was neither copied nor rewritten. Other shared caches,
indices and remote metadata were not exhaustively inventoried or reset; normal
native CLI maintenance may have updated them. Existing user sessions and global
configuration were not deliberately changed.

[MANIFEST.json](MANIFEST.json) inventories **only new Grok source/evidence**, plus
read-only dependency hashes. All **171** file entries in the earlier Antigravity
manifest were independently rehashed and still matched. Shared experiment sources,
CC/OC evidence, Antigravity evidence, and their manifests were not modified.

One short response-only sequence does not establish full Pickup/handoffs/workers,
long-history/compaction safety, cost/performance superiority, or dispatch/admission
guarantees. Tool denial was requested using native permissions; actual execution
enforcement was not adversarially exercised.

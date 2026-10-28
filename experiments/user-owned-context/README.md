# User-role context behavior experiment

An isolated, manual experiment, not a runtime delivery implementation. It sends
the existing Engineering role, core/assistant framework, initial Pickup, and
Session text inside the **first ordinary user message** to native Claude Code
and OpenCode. Later ordinary messages carry no automatic context prefix.

Five serial turns per harness (ten submissions maximum; no automatic retries):

1. Activation: identify the role, roots, and a user-owned migration preference.
2. Ordinary follow-up: derive a solution-spec path using remembered conventions.
3. Explicit update: supersede Session roots without repeating role/framework.
4. User override: change the earlier preference and override JSON formatting.
5. Ordinary continuation: apply the updated roots and preference; suggest a step.

Models: CC `sonnet --effort medium` (record actual resolved model); OC
`opencode-go/deepseek-v4.1-flash#high` (verify catalog and response metadata).
There is no model fallback. CC has a $0.50 per-invocation budget. OC uses the
existing authenticated service and has a submission/time cap, not a dollar cap;
provider-internal retries are not counted as additional experiment submissions.

## Run

Requires Bun and authenticated `claude`/`opencode` CLIs. No package install needed.

Dry-run (builds and retains inputs; no native discovery or model calls):

```sh
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-experiment-2026-10-25" \
  bun experiments/user-owned-context/run.ts
```

Live (real model calls; run only with user authorization):

```sh
SANE_RUN_LIVE_NATIVE_TESTS=I_ACCEPT_REAL_MODEL_CALLS \
NATIVE_CLEANUP=close-and-remove \
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-experiment-2026-10-25" \
  bun experiments/user-owned-context/run.ts --live
```

Optional `NATIVE_CLAUDE_PROFILE` and `NATIVE_CLAUDE_BIN` select existing CC
credentials/executable. Never save credentials in this experiment or its evidence.
Use `TMPDIR` for the disposable native working directory if needed.

Use `--harness=cc` or `--harness=oc` to run only that harness (five submissions).

Each run has a unique evidence directory: exact authored/composed inputs, source
hashes, native responses/history, checks, and cleanup results. Inspect
`responses.md` and `evidence.json`; a nonzero exit may indicate behavior checks,
transport failures, or incomplete cleanup. Do not automatically replay failures.

Reassess saved responses offline after changing the checker (writes a separate
`review.json`, preserving original evidence and incomplete-run status):

```sh
bun experiments/user-owned-context/review.ts /absolute/path/to/run-directory
```

## Controls and limits

- Existing context assets are read unchanged; no application, skill, or context
  edits. Prompt wrappers are experimental, not the final composition contract.
- Native sessions run outside the repository in a unique disposable directory.
  CC safe mode suppresses ambient customizations/hooks; its built-in system
  instructions remain. No SANE system append, hooks, synthetics, or instruction
  entries are used. OC instruction entries are inspected read-only.
- This is response-only: the user's first body explicitly suspends tool-based
  Pickup for the conversation. CC tools/MCP are disabled; OC session permissions
  deny tool operations. The experiment checks for attempted tool calls as well.
- Exact native user text is checked, not just the assistant's claim that it read
  context. Role/path/preference checks are deterministic; the suggested next step
  still needs human review. Raw output is never changed: raw vs Markdown-fenced
  JSON is reported separately, and role labels compare case-insensitively.
  Neither presentation difference is treated as a context-content failure.
- CC resumes the same native session in a new process per turn. OC submits to
  one fresh session. Their native system contexts differ; this is not a controlled
  model-quality comparison or a system-vs-user placement A/B test.
- OC disposable session and CC's unique fixture-project transcripts are removed
  after capture. The main checkout, active sessions, global configuration, and
  existing SANE data are not reset. Evidence is retained.
- No claims about full Pickup/workers/handoffs, long-history reliability,
  compaction, token savings, performance, or production dispatch safety follow
  from these short probes. Those require separate experiments.

The opt-in gate, serial turn budget, disposable roots, and durable evidence
patterns reuse `tests/native-live-gate.ts` and the former live-native suites
(see `git show 3b14d57^:packages/sane-app/tests/agent-session-smoke.test.ts`).

## Additional native harness: Antigravity CLI

`antigravity.ts` is a standalone experimental transport, not a production adapter.
It shares `probes.ts` and `checks.ts` with the CC/OC runner above: identical
Engineering/framework/Pickup/Session activation and five-turn semantics. It does
not change historical captures or the CC/OC model selections.

Requires authenticated `agy`. The only requested model is
`gemini-3.8-flash-high`; no fallback. Dry run (no CLI discovery/model calls):

```sh
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-antigravity-2026-10-25" \
  bun experiments/user-owned-context/antigravity.ts
```

Authorized live trial (five serial submissions maximum, no automatic retries):

```sh
SANE_RUN_LIVE_NATIVE_TESTS=I_ACCEPT_REAL_MODEL_CALLS \
NATIVE_CLEANUP=close-and-remove \
NATIVE_EVIDENCE_DIR="$PWD/reports/user-context-antigravity-2026-10-25" \
  bun experiments/user-owned-context/antigravity.ts --live
```

- First process uses `--new-project -p <composed activation + authored body>`;
  later processes use `--conversation <returned ID> -p <selected turn text>`.
  There is no history reconstruction, extra activation turn, context hook,
  system append, or native instruction-entry write.
- Uses `--output-format stream-json`, `--disable-slash-commands`, native
  `--print-timeout 150s`, and a 180-second process timeout. Intent/argv and exact
  body/prompt files precede sending; raw streams/stderr precede parsing.
- Installed help exposes no disable-all-tools switch. Response-only instructions
  are **not** a permission sandbox. Native `request-review` remained enabled;
  tools were available, but no calls were emitted in this trial. Unexpected
  tool/unknown step types stop subsequent submissions. Native `system_message`
  steps are retained separately, not mislabeled as tool calls.
- `init.model` reporting the requested slug is checked, but not represented as
  independent backend model resolution. Stream events do not acknowledge exact
  admitted prompt bytes. SQLite snapshots allow narrower offline byte checks.
- Successful cleanup captures/removes only the owned conversation DB/brain/sidecars,
  the exact fixture-bound generated project file, and temporary fixture. Shared
  CLI history/cache/summary stores are not rewritten; stale references may remain.
  Incomplete submitted runs retain state for inspection, never automatic replay.
- An explicit `--continue-observed-run=/absolute/evidence/directory` is only for
  the recorded post-response parser/classification failures. It requires live
  opt-in, hash-verified successful saved results and unchanged inputs, rechecks
  prior streams offline, then submits **only unsent turns**, still capped at five
  across the lineage. It refuses timeout/nonzero/unknown/tool-bearing histories.
  It creates separate evidence; original failed runs remain unchanged.

Offline checks (zero model calls):

```sh
bun experiments/user-owned-context/review.ts /absolute/path/to/completed-run
python3 experiments/user-owned-context/antigravity-history.py /absolute/path/to/completed-run
```

The history checker correlates stream user-step indices with exact UTF-8 prompt
substrings in opaque native protobuf payloads; it does not decode an admission
field or establish model consumption. See the
[Antigravity report and evidence lineage](../../reports/user-context-antigravity-2026-10-25/REPORT.md).

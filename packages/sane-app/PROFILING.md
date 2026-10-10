# Opt-in App CPU capture

Stop the current App normally, then run your usual command with one extra environment variable:

```sh
SANE_APP_PROFILE=1 SANE_APP_PASSWORD=... bun run start:app --public-origin https://server.gecko-halibut.ts.net:6700 --reconcile-interrupted
```

Keep your existing password value/environment setup. Nothing records or prints the environment or command arguments. Wait for `App CPU capture:` and immediately reproduce the slow science interaction. Sampling runs in the actual server process, across all App JavaScript, for approximately 60 seconds after listening. The App remains running afterward. The console prints the local temporary `profile.jsonl` path. Each run uses a new private directory and a mode-0600 file; no telemetry is sent.

The capture uses the async `profile` API from `bun:jsc`, documented in the installed `node_modules/bun-types/jsc.d.ts`, with 5ms native stack sampling. It does not assume Node's inspector protocol works in Bun. Unsupported runtimes emit a diagnostic and continue serving.

Each roughly one-second window contains native sampled stacks, hot-function and bytecode summaries, process CPU deltas, and up to 64 UTC-stamped 25ms event-loop timer observations. Compare the window UTC bounds with `science-timing.jsonl` timestamps and span offsets. `startedMs`/`endedMs` use the App's `performance.now()` clock, like science spans. Native sample timestamps use a separate monotonic clock in seconds: only their differences are meaningful; the enclosing window brackets their wall-clock location. Do not infer an exact shared epoch or attribute the callback's own stack to the preceding stall. CPU-heavy sampled stacks overlapping a delayed window are leads; scheduling pauses, native blocking, GC, and contention may require further evidence. CPU deltas cover the process, including other threads.

At most 60 windows are saved, each capped at 256KiB (under 16MiB total). Oversized windows retain summaries and timer evidence and mark `rawSamplesOmitted`. Only one native window is retained at a time; timer samples and output are bounded. Native sampling memory is owned by Bun, and the one-second/60-second deadlines are cooperative: a blocked event loop can overshoot them. They are not hard native-memory or wall-clock limits. Serialization and profiler start/stop add overhead between windows and are not sampled; this is a diagnostic run, not a latency benchmark.

SIGINT/Ctrl-C or SIGTERM resolves the active sampling window and awaits its write/close before normal App shutdown. Completed windows are written incrementally; SIGKILL or a crash can lose the active window. No restart is required after capture; omit `SANE_APP_PROFILE` on your next launch to disable it. To capture another run, restart with the flag. Review before sharing: profiles contain source paths/URLs, function names, and runtime-generated names, which can be sensitive even though the helper does not collect request bodies, notebook contents, or credentials. Remove captures manually when finished; separate launches create separate artifacts.

For a standard Chrome/VS Code CPU profile instead, Bun documents its native CLI flags in `node_modules/bun-types/docs/project/benchmarking.mdx`:

```sh
SANE_APP_PASSWORD=... bun --cpu-prof --cpu-prof-dir /path/to/private/profiles packages/sane-app/start.ts --public-origin https://server.gecko-halibut.ts.net:6700 --reconcile-interrupted
```

Use a private existing output directory and stop the server normally after a short reproduction: this alternative profiles the process lifetime and writes on exit, with no duration/size cap. Do not combine it with `SANE_APP_PROFILE=1` because both use Bun's sampling profiler.

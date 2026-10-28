# App performance capture

Stop the App normally. Start your usual configuration with opt-in profiling:

```sh
SANE_APP_PROFILE=1 bun run start:app
```

Keep any required password in your existing secure environment setup. Wait for
`App CPU capture:`, then reproduce the slowdown. The App samples its server
process for approximately 60 seconds and remains running afterward. The console
prints a new private temporary `profile.jsonl` path; no telemetry is sent.

Captures contain sampled stacks, hot-function summaries, CPU deltas, and
event-loop timer observations. Collection is bounded, but cooperative deadlines
can overrun when the event loop blocks. Sampling and serialization add overhead;
this is diagnostic evidence, not a latency benchmark or proof of causation.

Stop normally to finish the current write. SIGKILL or a crash can lose the active
window. Omit `SANE_APP_PROFILE` on the next launch to disable capture; restart to
capture another run.

## Correlate science runs

Science run-attempt timings are appended to `<dataDir>/science-timing.jsonl`, with
one rotated `.1` file. Correlate UTC timestamps and attempt/request IDs with the
CPU capture. Spans may overlap or nest; do not sum them. Compare like operations,
keep initial opens separate from repeated runs, and check dropped-span counts.
Timing logs are metadata, not notebook output or proof of kernel execution.

## Alternative: standard CPU profile

For a Chrome/VS Code-compatible CPU profile, use Bun's CLI profiler instead:

```sh
bun --cpu-prof --cpu-prof-dir /absolute/path/to/private/profiles packages/sane-app/start.ts
```

Create the private output directory first and stop after a short reproduction.
This profiles the process lifetime and writes on exit, without the opt-in helper's
duration/size bounds. Do not combine it with `SANE_APP_PROFILE=1`.

Review all captures before sharing: source paths, URLs, function names, and
runtime-generated names can be sensitive. Remove captures when finished.

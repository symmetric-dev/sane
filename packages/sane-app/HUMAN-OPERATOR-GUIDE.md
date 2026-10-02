# SANE App operator guide

## Setup and launch

From a cloned installation checkout, install workspace dependencies with `bun install`, then:

```sh
bun run setup:app --cwd /path/to/project --port 6700
bun run start:app
```

Setup explicitly initializes fresh App history/catalog in `packages/sane-app/.data`
and saves `packages/sane-app/.config.json`. Repeating a matching setup preserves
existing state. Partial, incompatible, or source-mismatched stores are rejected;
there is no reset, import, or migration. Setup does not initialize a project's
`.sane`. Project initialization is a separate explicit action in the selected Git
repository; linked worktrees share its project authority. Projects need not be
inside the SANE installation.

`bun run start`, `bun run start:app`, package `bun run start`, and direct
`bun packages/sane-app/server.ts` use the same config-driven launch. No installer,
background App service, or global App configuration is required. One server owns
each installation checkout, regardless of port or selected data directory.

## Configuration

Use `bun run start:app --help` for options. `--config PATH` selects another saved
config; setup can create that file in an existing parent directory. CLI settings
override saved settings. CLI paths resolve against invocation cwd; saved paths
resolve against the config directory. Setup saves absolute paths. Without a saved
execution cwd, the default is invocation cwd, not the App package directory.

Setup will not overwrite an existing config with changed settings. Edit that
config explicitly, or choose a new config file. Launch overrides are temporary.
Native source changes must still match the store's source pins.

Local Claude uses `claude` on PATH by default; `--claude-bin` and
`--claude-profile` select its executable and profile. OpenCode uses managed-local
discovery via `--opencode-registration`. Endpoint and credentials come from that
registration together; explicit remote endpoints are unsupported. Setup and launch
do not install, start, or reconfigure native services. Contradictory native selector
environment variables are rejected. Unavailable native sources do not require
discarding App history.

The listener defaults to `127.0.0.1:8787`. For an existing HTTPS reverse proxy, set
`--public-origin https://YOUR-HOST` and `SANE_APP_PASSWORD`. A non-loopback listener
additionally requires `--allow-remote`. These settings do not configure proxies.
Use `--no-allow-remote` or `--clear-public-origin` to override saved values.

## Assets and ownership

Launch explicitly builds a complete versioned asset generation, then serves that
selected generation. `bun run build:app` performs a standalone guarded build.
`--no-build` validates the current generation against source/build inputs and
output hashes before serving; stale or missing assets require rebuilding.
The server snapshots its HTML at startup. Builds cannot replace assets beneath a
running installation owner.

Installation ownership is acquired before data ownership and held across build,
startup, serving, and shutdown. Ctrl-C or SIGTERM drains App work before releasing
ownership. OpenCode shutdown stops observation, not native execution. Failed drains
retain ownership and exit unsuccessfully. After a crash, verify any surviving
App-owned Claude processes have stopped before using `--reconcile-interrupted`.
Reclamation requires proven-dead owner evidence; live, malformed, or unverifiable
ownership is not silently removed. Never delete state to clear a busy indicator.

## Working with projects

Open a directory and select its workspace/worktree. That selection chooses new
conversations' execution checkout; existing conversations retain their recorded
checkout. Finish external work in a conversation before sending from the App.
Native linking and handoffs are separate work, not part of App setup.

### Compact conversation context

SANE never initiates automatic compaction or changes the harness's compaction
threshold. When Claude Code or OpenCode compacts during an App-owned run, SANE
shows the native lifecycle and retains a compaction marker. Compaction performed
outside the App appears after **Refresh native history**; external sessions are
not continuously monitored.

For explicit manual compaction, open an existing idle conversation and use
**Compact now** beside its context indicator, or send `/compact`. Claude Code
also accepts `/compact <instructions>`; OpenCode does not accept custom
compaction instructions. Compaction uses the same native conversation and
checkout without applying a pending agent upgrade. The button preserves your
message draft. Attached Claude conversations require confirmation that external
execution has stopped. Managed worker conversations cannot be compacted manually
from the App.

Request acceptance is not completion. If acceptance or the outcome is
unconfirmed, inspect the operation and native history before starting another
request. Reconnecting or repeating the same recorded request never automatically
resends a native compaction. A successful compaction can remain successful even
if the containing assistant run is later interrupted.

Context percentage is the last reported usage of the full model window, not the
harness's auto-compaction threshold. A running compaction makes that reading
stale; after confirmed completion, SANE waits for new usage rather than displaying
an invented zero percent. Skipped or failed compaction does not prove a context
reset.

### Search files

In Files or Git view, press **Cmd+Shift+F** on macOS or **Ctrl+Shift+F** on Windows/Linux,
or use the visible search action. Search runs across the selected browsing
worktree, independently of a conversation's execution checkout.

Search is embedded in the Files workspace rather than a dialog. The Search
sidebar shows only matching files, grouped by folder, with match counts; the
main panel shows grouped matching lines. Opening a result keeps the search
controls and filtered sidebar visible beside the existing file editor. Use
**All results** to return to the matching lines, or **Files** to restore the
normal file tree. Previous/next match controls navigate within the open file.

This first version searches **saved file contents**, not unsaved editor buffers.
Opening a result preserves local edits; save explicitly to include those edits
in a subsequent search. Matching is literal, with case-sensitive and whole-word
options and include/exclude path filters. Regular expressions, Quick Open
(`Cmd+P`), and the Command Palette are not included yet.

Filters are comma-separated, case-sensitive workspace-relative globs: `*.ts`
matches basenames at any depth, `src/**/*.ts` matches paths, and `docs/` matches
that directory's descendants. Supported wildcards are `*`, `?`, and `**` as a
complete path segment; negation, brace expansion, and character classes are not
supported. Searches honor safely readable `.gitignore` files inside the worktree,
including nested rules and negation, even in non-Git directories. Global ignore
settings, ignore files outside the browsing root, and `.git/info/exclude` are not
read. Unsafe or oversized ignore files supply no rules. Dependency/generated folders named
`node_modules`, `dist`, `build`, `coverage`, or `vendor` are always excluded.

Search retains the file-access restrictions: protected App/project/Git data,
symlink traversal, and hard-linked files are not searchable. Binary, unsupported,
and oversized files are skipped. Large searches are bounded; check the results
for skipped-file or truncation notices and narrow your query when necessary.

Ordinary repositories, standard linked worktrees, and ordinary directories can
reuse a validated search-scoped binding while retaining filesystem checks on
every read. Uncertain Git mappings or complex configuration use the original
full-validation path instead; these searches may be slower. Results remain
atomic: matches appear only after the final workspace validation succeeds.
Search reads at most four files concurrently and admits at most two active
search requests across the App. A busy response can be retried shortly. Ignore
parsing and matching run outside the App process so their CPU work can be
stopped on cancellation or deadline expiry.

After updating App source, stop the running App gracefully and launch again with
your usual `bun run start:app` command, then reload the browser. A running server
does not adopt newly built assets or backend code automatically.

To smoke-test the feature:

1. Select a worktree, open Files, and invoke the search shortcut with the editor
   focused. Search for text in a nested file whose folder is still collapsed.
2. Toggle case-sensitive/whole-word matching and narrow the include/exclude
   filters. Open a match and check the selected text and editor position.
3. Leave unsaved edits in a file, search again, and open a result for that file.
   Verify the local edits remain intact and search still reports saved contents.
4. Switch worktrees while a search is pending. Results from the old worktree
   must not appear or open files in the new one.
5. Open a matching file from the filtered sidebar, navigate its matches, and
   return with All results. Verify the query and results remain available and
   switching to Files restores the ordinary tree.
6. Verify Escape moves focus out of the search controls without discarding the
   search, and unrelated editor, chat, and terminal shortcuts retain their behavior.

# Installation

This page covers two different installation modes:

1. **Published `work` CLI only**
2. **Full AgEnv Root-Agent / Opencode workflow**

If you want the full branching, supervision, tools, and skills workflow documented in this repo, use the **full repo install**.

## Do I need to clone the repo?

### Short answer

- **If you only need the `work` CLI:** global package install is enough.
- **If you want the full Opencode workflow from this repo:** **yes, clone the repo**.

### Why

The published package gives you:

- `@agenv/workstreams`
- the `work` CLI

But the full workflow in this repo also depends on repo-managed assets such as:

- `agent/tools/workstream.ts`
- `agent/skills/*`
- `ag install ...` commands used to install tools/skills into Opencode
- local docs, test helpers, and debugging workflows

So:

- **published package only** = enough for plain `work` usage
- **repo clone** = needed for the full Root Agent / supervision / Opencode tooling workflow

## Prerequisites

- Bun
- Git
- macOS/Linux/WSL shell

## External Tools

- `opencode` CLI (required for execution commands like `work execute`, `work multi`, and branch supervision flows)
- `tmux` (required for `work multi` and supervision observability)
- `gh` GitHub CLI (required for `work github` flows)
- `terminal-notifier` and `say` on macOS (optional; for notifications)

## Option A: Published package only

Use this if you only want the `work` CLI and do **not** need the repo-managed tools/skills workflow.

Example:

```bash
bun add -g @agenv/workstreams
```

Then verify:

```bash
work --help
```

### What this mode does **not** give you

- `ag` helper CLI from this repo
- repo-managed Opencode tools installation
- repo-managed skills installation
- local development/test/docs workflow

## Option B: Full repo install (recommended for this workflow)

Use this if you want:

- `work`
- `ag`
- Opencode tool installs
- skill installs
- Root Agent branching/supervision workflow
- local tests/docs/debugging

### 1. Clone the repo

```bash
git clone https://github.com/AlbertoV5/agenv.git
cd agenv
```

### 2. Install dependencies and local commands

```bash
bun install
./install.sh
```

This sets up `ag` and `work` in the repo's `bin/` directory and adds that directory to your shell `PATH`.

If you want to use the commands immediately in the current shell after install, run:

```bash
source ~/.zshrc
rehash
```

### 3. Install Opencode tools and skills

For the Root Agent / supervision workflow, install the repo-managed tools and skills into Opencode.

Recommended:

```bash
ag install tools --opencode
ag install skills --opencode
```

If you want to inspect available install modes:

```bash
ag install tools --help
ag install skills --help
```

### 4. Verify installation

```bash
ag --help
work --help
```

And for stale-tool debugging inside Opencode, call:

```text
workstream_tool_runtime_info({})
```

### 5. Optional: install all repo skills / alternate targets

Examples:

```bash
./install.sh --with-skills
./install.sh --skills-all
./install.sh --skills-only

ag install skills --all
ag install tools --list
```

## Recommended new-environment setup for the full workflow

For a fresh machine where you want everything needed for the branching/supervision workflow:

1. Install:
   - Bun
   - Git
   - `opencode`
   - `tmux`
   - optionally `gh`
2. Clone this repo
3. Run:

```bash
bun install
./install.sh
ag install tools --opencode
ag install skills --opencode
```

4. Restart your shell / Opencode session
5. Verify with:

```bash
ag --help
work --help
```

## Notes for future environments

- If you update the tool entrypoint or installed skills, restart Opencode so the new tool/skill registry is loaded.
- For branch/supervision debugging, also see:
  - `docs/SUPERVISOR.md`
  - `docs/ROOT_AGENT_BRANCHING_ARCHITECTURE.md`
  - `docs/supervision-tmux-e2e-testing.md`

# Installation: Pending Issues

Known gaps in `sane install` / `sane install context-packages` found during
install verification. Each item states the observed behavior and what a fix
needs to cover.

## Retired roles are not removed

The installer writes the current agents and skills but does not remove files
for roles that no longer exist in the source. The archived Knowledge assistant
remained installed until it was removed by hand:

- `~/.config/opencode/agents/sane/assistant/knowledge.md`
- `~/.claude/agents/sane-assistant-knowledge.md`
- `~/.claude/sane-agent-settings/sane-assistant-knowledge.settings.json`
- `sane-assistant-knowledge-{pickup,assistance,delivery}` in both
  `~/.agents/skills/` and `~/.claude/skills/`

Retirement exists only for the old `*-assistant-role` skills
(`RETIRED_ROLE_SKILL_NAMES` in
`packages/sane-cli/src/install-sane-agent-context-packages.ts`), and only under
`~/.agents/skills/`. A fix should retire agents, Claude agent settings, and
skills in both skill directories for every removed role.

## Claude MCP server depends on OpenCode-installed modules

The Claude MCP server (`native-claude-mcp.ts`) resolves
`@modelcontextprotocol/sdk` from `~/.config/opencode/plugins/sane/node_modules`.
The installer only declares the SDK in `~/.config/opencode/package.json`, so the
module exists only after OpenCode has installed the plugin's dependencies. On a
fresh home without a prior OpenCode run, the Claude MCP server cannot start.

## Claude enforces only named denies

The serializer (`packages/sane-cli/src/agent-serialization.ts`) emits Claude
deny rules only for named skill and subagent entries: `"<prefix>*": deny`
skill patterns become `Skill(<prefix>:*)`, exact skill names become
`Skill(<name>)`, and named task denies become `Agent(<name>)`. Other skill
patterns fail serialization. Wildcard `"*"` denies and tool-level denies (for
example `edit: deny`) are still dropped, because Claude evaluates deny before
allow and would block specifically allowed entries. The App launches Claude
runs with `--permission-mode bypassPermissions`, so restrictions expressed only
as wildcard or tool-level denies are not enforced in Claude.

Claude enforces deny rules in bypass mode. Verified with Claude Code 2.1.288:
`Skill(<prefix>:*)` is a prefix match (a trailing `-` in the prefix is kept),
`Skill(<prefix>*)` without `:` matches nothing, and `Agent(<name>)` denies one
subagent.

## Temporary install homes must not have a symlinked parent

Installing into an alternate home through `SANE_HOME` fails with
`Destination parent is not a directory` when the path passes through a
symlink, such as macOS `/var` → `/private/var`. Use the resolved path
(`realpath`). This is intentional destination validation; scripted installs
into temporary homes need to resolve the path first.

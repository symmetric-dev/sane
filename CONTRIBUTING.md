# Contributing

Thanks for your interest in improving Sane.

## Development Setup

```bash
bun install
./install.sh
```

## Project Structure

- `packages/workstreams`: core workstream library and `work` CLI
- `packages/cli`: `sane` CLI wrapper
- `agent/`: agent skills, commands, and tooling

## Before Opening a PR

Run checks locally:

```bash
bun run typecheck
bun run test
```

For package-specific validation:

```bash
cd packages/workstreams
bun run typecheck
bun run test
```

## Pull Request Guidelines

- Keep changes focused and scoped.
- Include tests for behavior changes.
- Update docs when commands or behavior change.
- Use clear commit messages.

## Reporting Issues

- Use GitHub Issues for bugs and feature requests.
- For security issues, follow `SECURITY.md`.

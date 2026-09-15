# SANE Alpha

SANE Alpha is a documentation and agent-context prototype for validating the
SANE product, research, design, execution, and implementation workflow.

See [the Alpha guide](docs/README.md) for the operating model, installation,
commands, templates, and pilot workflow.

## Development

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run typecheck
bun run test
```

The project is currently marked private in `package.json` to prevent accidental
package publication. This does not prevent the Git repository from being public.

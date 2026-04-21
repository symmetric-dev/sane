/**
 * Default configuration files for work init
 *
 * These files are embedded at build time using Bun's text import syntax.
 * Edit the corresponding .yaml/.json files to change defaults.
 */

// @ts-ignore - Bun text import returns string, but TS doesn't understand import attributes
import _DEFAULT_AGENTS_YAML from "./agents.yaml" with { type: "text" }
// @ts-ignore - Bun text import returns string, but TS sees JSON type
import _DEFAULT_GITHUB_JSON from "./github.json" with { type: "text" }
// @ts-ignore - Bun text import returns string, but TS sees JSON type
import _DEFAULT_NOTIFICATIONS_JSON from "./notifications.json" with { type: "text" }

// Re-export with explicit string types for TypeScript compatibility
// The `as unknown as string` is needed because TS infers JSON types, but Bun's
// `with { type: "text" }` import attribute makes these actual strings at runtime
export const DEFAULT_AGENTS_YAML: string = _DEFAULT_AGENTS_YAML as unknown as string
export const DEFAULT_GITHUB_JSON: string = _DEFAULT_GITHUB_JSON as unknown as string
export const DEFAULT_NOTIFICATIONS_JSON: string = _DEFAULT_NOTIFICATIONS_JSON as unknown as string

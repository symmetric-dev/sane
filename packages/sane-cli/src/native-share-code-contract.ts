import type { NativeSourceDescriptor } from "../../sane-core/src/contracts.ts"

export const CODE_SHARE_LIMITS = { path: 4096, lines: 500, bytes: 64 * 1024, highlights: 64, comment: 2000, snippets: 16, totalBytes: 256 * 1024, inputBytes: 256 * 1024 } as const
export interface CodeShareHighlight { startLine: number; endLine: number; comment?: string }
export interface CodeShareSnippetInput { path: string; startLine: number; endLine: number; format?: string; highlights?: CodeShareHighlight[] }
export interface CodeShareSnippetsInput { snippets: CodeShareSnippetInput[] }
export type CodeShareInput = CodeShareSnippetInput | CodeShareSnippetsInput
export type CodeShareLanguage = "javascript" | "jsx" | "typescript" | "tsx" | "json" | "css" | "html" | "markdown" | "python" | "plaintext"
export interface NativeCodeShareRequest {
  version: 1
  caller: { source: NativeSourceDescriptor; authorityId: string; nativeId: string; cwd: string }
  invocation: { toolCallId: string; messageId?: string; invocationId: string; wrapper?: "execute" }
  input: CodeShareInput
}
export type CodeShareSnippetRange = Pick<CodeShareSnippetInput, "path" | "startLine" | "endLine">
export type CodeShareReceipt = { type: "sane.code-share"; version: 1; shareId: string } & CodeShareSnippetRange
  | { type: "sane.code-share"; version: 2; shareId: string; snippets: CodeShareSnippetRange[] }

export const nativeShareCodeDescription = "Show read-only code snippets as pages in one App chat card, with syntax highlighting and optional highlighted line ranges and comments. Prefer the snippets array, and consider splitting code into several focused snippets, even from the same file, so it is easier for the user to review with Previous/Next navigation. Up to 16 snippets, 500 lines and 64 KiB of code each, and 256 KiB of code total. Paths are relative to the conversation's execution checkout. Lines are 1-based and inclusive; comments appear before their highlighted range. Each snippet can override its syntax format. The App saves frozen snapshots, not live file links. Legacy single-snippet path/startLine/endLine arguments remain supported; do not combine them with snippets. Available only in App-admitted conversations; does not require workstream enrollment."
const snippetSchema = {
  type: "object", additionalProperties: false, required: ["path", "startLine", "endLine"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: CODE_SHARE_LIMITS.path, pattern: "^(?![A-Za-z]:)(?![\\s\\S]*[\\u0000-\\u001f\\\\])(?!(?:[\\s\\S]*/)?\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$(?![\\s\\S])", description: "File path relative to the conversation's execution checkout. No absolute paths, traversal, empty segments, or backslashes." },
    startLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "First source line, inclusive." },
    endLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Last source line, inclusive. Share at most 500 lines." },
    format: { type: "string", minLength: 1, maxLength: 32, pattern: "^[.a-zA-Z0-9_+-]{1,32}$(?![\\s\\S])", description: "Syntax override, e.g. .md, .json, .py, typescript, or plaintext. Defaults to the file extension; unknown formats use plaintext. Does not transform source." },
    highlights: { type: "array", maxItems: CODE_SHARE_LIMITS.highlights, items: {
      type: "object", additionalProperties: false, required: ["startLine", "endLine"], properties: {
        startLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, endLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        comment: { type: "string", minLength: 1, maxLength: CODE_SHARE_LIMITS.comment, allOf: [{ pattern: "\\S" }, { not: { pattern: "\\u0000" } }], description: "Plain-text annotation displayed immediately before the first highlighted line." },
      },
    } },
  },
} as const
export const nativeShareCodeSchema = {
  type: "object", additionalProperties: false, required: [],
  properties: {
    snippets: { type: "array", minItems: 1, maxItems: CODE_SHARE_LIMITS.snippets, description: "Ordered snippets to review as pages. Multiple snippets may reference the same file.", items: snippetSchema },
    ...snippetSchema.properties,
  },
  oneOf: [
    { required: ["snippets"], not: { anyOf: Object.keys(snippetSchema.properties).map(key => ({ required: [key] })) } },
    { required: [...snippetSchema.required], not: { required: ["snippets"] } },
  ],
} as const

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) { return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)) }
const line = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1
// JSON Schema maxLength counts Unicode code points, not UTF-16 code units.
function withinLength(value: string, maximum: number): boolean {
  if (value.length > maximum * 2) return false
  let length = 0
  for (const _ of value) if (++length > maximum) return false
  return true
}

export function parseCodeShareSnippet(input: unknown): CodeShareSnippetInput {
  const invalid = (): never => { throw new Error("Invalid code share: use a relative file path, an inclusive range of at most 500 lines, and contained highlight ranges with bounded comments.") }
  if (!object(input) || !exact(input, ["path", "startLine", "endLine"], ["format", "highlights"])) return invalid()
  const { path, startLine, endLine, format, highlights } = input
  if (typeof path !== "string" || !path.length || !withinLength(path, CODE_SHARE_LIMITS.path) || /[\u0000-\u001f\\]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(segment => !segment || segment === "." || segment === "..")) return invalid()
  if (!line(startLine) || !line(endLine) || endLine < startLine || endLine - startLine + 1 > CODE_SHARE_LIMITS.lines) return invalid()
  if (format !== undefined && (typeof format !== "string" || !/^[.a-zA-Z0-9_+-]{1,32}$(?![\s\S])/.test(format))) return invalid()
  if (highlights !== undefined && (!Array.isArray(highlights) || highlights.length > CODE_SHARE_LIMITS.highlights)) return invalid()
  const parsed: CodeShareHighlight[] = []
  for (const item of (highlights ?? []) as unknown[]) {
    if (!object(item) || !exact(item, ["startLine", "endLine"], ["comment"]) || !line(item.startLine) || !line(item.endLine) || item.startLine < startLine || item.endLine < item.startLine || item.endLine > endLine || item.comment !== undefined && (typeof item.comment !== "string" || !item.comment.trim().length || !withinLength(item.comment, CODE_SHARE_LIMITS.comment) || item.comment.includes("\0"))) return invalid()
    parsed.push({ startLine: item.startLine, endLine: item.endLine, ...(typeof item.comment === "string" ? { comment: item.comment } : {}) })
  }
  return { path, startLine, endLine, ...(typeof format === "string" ? { format } : {}), ...(highlights !== undefined ? { highlights: parsed } : {}) }
}

export function parseCodeShareInput(input: unknown): CodeShareInput {
  if (object(input) && Object.hasOwn(input, "snippets")) {
    if (!exact(input, ["snippets"]) || !Array.isArray(input.snippets) || input.snippets.length < 1 || input.snippets.length > CODE_SHARE_LIMITS.snippets) throw new Error("Share between 1 and 16 snippets; do not combine snippets with legacy single-snippet arguments.")
    const result = { snippets: input.snippets.map(parseCodeShareSnippet) }
    const serialized = JSON.stringify(result)
    if (serialized.length > CODE_SHARE_LIMITS.inputBytes || new TextEncoder().encode(serialized).length > CODE_SHARE_LIMITS.inputBytes) throw new Error("Code share snippet arguments and comments exceed 256 KiB.")
    return result
  }
  return parseCodeShareSnippet(input)
}

export function codeShareInputSnippets(input: CodeShareInput): readonly CodeShareSnippetInput[] {
  return "snippets" in input ? input.snippets : [input]
}

export function resolveCodeShareLanguage(path: string, format?: string): CodeShareLanguage {
  const extension = path.slice(path.lastIndexOf("/") + 1).split(".").slice(1).at(-1) ?? ""
  const name = (format ?? extension).toLowerCase().replace(/^\./, "")
  const aliases: Record<string, CodeShareLanguage> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript", jsx: "jsx",
    ts: "typescript", mts: "typescript", cts: "typescript", typescript: "typescript", tsx: "tsx",
    json: "json", css: "css", html: "html", htm: "html", md: "markdown", markdown: "markdown",
    py: "python", python: "python", txt: "plaintext", text: "plaintext", plaintext: "plaintext",
  }
  return Object.hasOwn(aliases, name) ? aliases[name]! : "plaintext"
}

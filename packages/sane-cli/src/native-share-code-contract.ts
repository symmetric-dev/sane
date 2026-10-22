import type { NativeSourceDescriptor } from "../../sane-core/src/contracts.ts"

export const CODE_SHARE_LIMITS = { path: 4096, title: 256, lines: 500, bytes: 64 * 1024, highlights: 64, comment: 2000, snippets: 16, totalBytes: 256 * 1024, inputBytes: 256 * 1024 } as const
export interface CodeShareHighlight { startLine: number; endLine: number; comment?: string }
export interface CodeShareSnippetInput { path: string; startLine: number; endLine: number; title?: string; format?: string; highlights?: CodeShareHighlight[] }
export interface CodeShareInlineSnippetInput { kind: "inline"; title: string; code: string; format?: string; highlights?: CodeShareHighlight[] }
export type CodeSharePageInput = CodeShareSnippetInput | CodeShareInlineSnippetInput
export interface CodeShareSnippetsInput { snippets: CodeSharePageInput[] }
export type CodeShareInput = CodeShareSnippetInput | CodeShareSnippetsInput
export type CodeShareLanguage = "javascript" | "jsx" | "typescript" | "tsx" | "json" | "css" | "html" | "markdown" | "python" | "plaintext"
export interface NativeCodeShareRequest {
  version: 1
  caller: { source: NativeSourceDescriptor; authorityId: string; nativeId: string; cwd: string }
  invocation: { toolCallId: string; messageId?: string; invocationId: string; wrapper?: "execute" }
  input: CodeShareInput
}
export type CodeShareSnippetRange = Pick<CodeShareSnippetInput, "path" | "startLine" | "endLine">
export type CodeSharePageRange = CodeShareSnippetRange | { kind: "inline"; title: string; startLine: number; endLine: number }
export type CodeShareReceipt = { type: "sane.code-share"; version: 1; shareId: string } & CodeShareSnippetRange
  | { type: "sane.code-share"; version: 2; shareId: string; snippets: CodeShareSnippetRange[] }
  | { type: "sane.code-share"; version: 3; shareId: string; snippets: CodeSharePageRange[] }

export const nativeShareCodeDescription = "Show read-only code snippets as pages in one App chat card, with syntax highlighting and optional highlighted line ranges and comments. Prefer the snippets array, which can mix file references (path/startLine/endLine) and supplied code (kind: inline, title, code, optional format/highlights). Use inline snippets to show suggestions alongside existing code without writing or executing anything; they are labeled as suggested code, not saved files. Consider several focused snippets for Previous/Next navigation. Up to 16 snippets, 500 lines and 64 KiB of code each, 256 KiB of code total, and 256 KiB of serialized arguments including comments. Paths are relative to the conversation's execution checkout, except .sane/... paths read SANE state from the repository's primary checkout (also in a linked worktree). Lines are 1-based and inclusive; inline lines start at 1, with the end derived from code. Comments appear before their highlighted range. Each snippet can override its syntax format. The App saves frozen snapshots, not live file links. Legacy single-snippet path/startLine/endLine arguments remain supported; do not combine them with snippets. Available only in App-admitted conversations; does not require workstream enrollment."
const snippetSchema = {
  type: "object", additionalProperties: false, required: ["path", "startLine", "endLine"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: CODE_SHARE_LIMITS.path, pattern: "^(?![A-Za-z]:)(?![\\s\\S]*[\\u0000-\\u001f\\\\])(?!(?:[\\s\\S]*/)?\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$(?![\\s\\S])", description: "File path relative to the conversation's execution checkout, or .sane/... relative to the repository's primary checkout. No absolute paths, traversal, empty segments, or backslashes." },
    startLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "First source line, inclusive." },
    endLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Last source line, inclusive. Share at most 500 lines." },
    title: { type: "string", minLength: 1, maxLength: CODE_SHARE_LIMITS.title, allOf: [{ pattern: "\\S" }, { not: { pattern: "[\\u0000-\\u001f\\u007f]" } }], description: "Optional display title for this file snippet, e.g. Current implementation. Defaults to the filename in tabs; the source path remains visible in the header." },
    format: { type: "string", minLength: 1, maxLength: 32, pattern: "^[.a-zA-Z0-9_+-]{1,32}$(?![\\s\\S])", description: "Syntax override, e.g. .md, .json, .py, typescript, or plaintext. Defaults to the file extension; unknown formats use plaintext. Does not transform source." },
    highlights: { type: "array", maxItems: CODE_SHARE_LIMITS.highlights, items: {
      type: "object", additionalProperties: false, required: ["startLine", "endLine"], properties: {
        startLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, endLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        comment: { type: "string", minLength: 1, maxLength: CODE_SHARE_LIMITS.comment, allOf: [{ pattern: "\\S" }, { not: { pattern: "\\u0000" } }], description: "Plain-text annotation displayed immediately before the first highlighted line." },
      },
    } },
  },
} as const
const inlineSnippetSchema = {
  type: "object", additionalProperties: false, required: ["kind", "title", "code"],
  properties: {
    kind: { type: "string", const: "inline", description: "Supplied code, not a file reference. Never written to a source file or executed as code." },
    title: { type: "string", minLength: 1, maxLength: CODE_SHARE_LIMITS.title, allOf: [{ pattern: "\\S" }, { not: { pattern: "[\\u0000-\\u001f\\u007f]" } }], description: "Display title, e.g. Suggested replacement. Not a filesystem path." },
    code: { type: "string", maxLength: CODE_SHARE_LIMITS.bytes, not: { pattern: "\\u0000" }, description: "Literal code to display, up to 64 KiB UTF-8 and 500 lines. CRLF/CR normalize to LF; an empty EOF line counts. Line numbers start at 1." },
    format: { ...snippetSchema.properties.format, description: "Syntax format, e.g. typescript, .json, or .py. Defaults to plaintext for inline code; does not transform source." },
    highlights: snippetSchema.properties.highlights,
  },
} as const
export const nativeShareCodeSchema = {
  type: "object", additionalProperties: false, required: [],
  properties: {
    snippets: { type: "array", minItems: 1, maxItems: CODE_SHARE_LIMITS.snippets, description: "Ordered pages mixing file references and inline suggestions. Multiple snippets may reference the same file.", items: { oneOf: [snippetSchema, inlineSnippetSchema] } },
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
function validTitle(value: unknown): value is string { return typeof value === "string" && !!value.trim() && withinLength(value, CODE_SHARE_LIMITS.title) && !/[\u0000-\u001f\u007f]/.test(value) }

export function parseCodeShareSnippet(input: unknown): CodeShareSnippetInput {
  const invalid = (): never => { throw new Error("Invalid code share: use a relative file path, an inclusive range of at most 500 lines, and contained highlight ranges with bounded comments.") }
  if (!object(input) || !exact(input, ["path", "startLine", "endLine"], ["title", "format", "highlights"])) return invalid()
  const { path, startLine, endLine, title, format, highlights } = input
  if (typeof path !== "string" || !path.length || !withinLength(path, CODE_SHARE_LIMITS.path) || /[\u0000-\u001f\\]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(segment => !segment || segment === "." || segment === "..")) return invalid()
  if (!line(startLine) || !line(endLine) || endLine < startLine || endLine - startLine + 1 > CODE_SHARE_LIMITS.lines) return invalid()
  if (title !== undefined && !validTitle(title)) return invalid()
  return { path, startLine, endLine, ...(typeof title === "string" ? { title } : {}), ...parseCodeShareAnnotations(format, highlights, startLine, endLine) }
}

function parseCodeShareAnnotations(format: unknown, highlights: unknown, startLine: number, endLine: number): Pick<CodeShareSnippetInput, "format" | "highlights"> {
  const invalid = (): never => { throw new Error("Invalid code share format or highlight ranges/comments.") }
  if (format !== undefined && (typeof format !== "string" || !/^[.a-zA-Z0-9_+-]{1,32}$(?![\s\S])/.test(format))) return invalid()
  if (highlights !== undefined && (!Array.isArray(highlights) || highlights.length > CODE_SHARE_LIMITS.highlights)) return invalid()
  const parsed: CodeShareHighlight[] = []
  for (const item of (highlights ?? []) as unknown[]) {
    if (!object(item) || !exact(item, ["startLine", "endLine"], ["comment"]) || !line(item.startLine) || !line(item.endLine) || item.startLine < startLine || item.endLine < item.startLine || item.endLine > endLine || item.comment !== undefined && (typeof item.comment !== "string" || !item.comment.trim().length || !withinLength(item.comment, CODE_SHARE_LIMITS.comment) || item.comment.includes("\0"))) return invalid()
    parsed.push({ startLine: item.startLine, endLine: item.endLine, ...(typeof item.comment === "string" ? { comment: item.comment } : {}) })
  }
  return { ...(typeof format === "string" ? { format } : {}), ...(highlights !== undefined ? { highlights: parsed } : {}) }
}

export function normalizeCodeShareText(code: string): string { return code.replace(/\r\n|\r/g, "\n") }
export function isInlineCodeShareSnippet(input: CodeSharePageInput): input is CodeShareInlineSnippetInput { return "kind" in input && input.kind === "inline" }
export function codeShareSnippetRange(input: CodeSharePageInput): CodeSharePageRange {
  return isInlineCodeShareSnippet(input)
    ? { kind: "inline", title: input.title, startLine: 1, endLine: normalizeCodeShareText(input.code).split("\n").length }
    : { path: input.path, startLine: input.startLine, endLine: input.endLine }
}

export function parseCodeSharePage(input: unknown): CodeSharePageInput {
  if (!object(input) || !Object.hasOwn(input, "kind")) return parseCodeShareSnippet(input)
  if (!exact(input, ["kind", "title", "code"], ["format", "highlights"]) || input.kind !== "inline"
    || !validTitle(input.title)
    || typeof input.code !== "string" || input.code.length > CODE_SHARE_LIMITS.bytes || input.code.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.code)
    || new TextEncoder().encode(input.code).length > CODE_SHARE_LIMITS.bytes) throw new Error("Invalid inline code share: use kind: inline, a title of at most 256 characters, and UTF-8 code of at most 64 KiB without NUL characters.")
  const endLine = normalizeCodeShareText(input.code).split("\n").length
  if (endLine > CODE_SHARE_LIMITS.lines) throw new Error("Inline code shares must be at most 500 lines, including an empty EOF line.")
  return { kind: "inline", title: input.title, code: input.code, ...parseCodeShareAnnotations(input.format, input.highlights, 1, endLine) }
}

export function parseCodeShareInput(input: unknown): CodeShareInput {
  if (object(input) && Object.hasOwn(input, "snippets")) {
    if (!exact(input, ["snippets"]) || !Array.isArray(input.snippets) || input.snippets.length < 1 || input.snippets.length > CODE_SHARE_LIMITS.snippets) throw new Error("Share between 1 and 16 snippets; do not combine snippets with legacy single-snippet arguments.")
    const result = { snippets: input.snippets.map(parseCodeSharePage) }
    const serialized = JSON.stringify(result)
    if (serialized.length > CODE_SHARE_LIMITS.inputBytes || new TextEncoder().encode(serialized).length > CODE_SHARE_LIMITS.inputBytes) throw new Error("Code share snippet arguments, inline code, and comments exceed 256 KiB.")
    return result
  }
  return parseCodeShareSnippet(input)
}

export function codeShareInputSnippets(input: CodeShareInput): readonly CodeSharePageInput[] {
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

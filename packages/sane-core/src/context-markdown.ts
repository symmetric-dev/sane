export function parseContextMarkdown(text: string, requireFrontmatter = true): { body: string; description: string } {
  text = text.replace(/^\uFEFF/, "")
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) {
    if (requireFrontmatter || /^---(?:\r?\n|$)/.test(text)) throw new Error("Context Markdown requires valid frontmatter")
    return { body: text, description: "" }
  }
  const metadata = Bun.YAML.parse(match[1]!) as Record<string, unknown> | null
  if (!metadata || typeof metadata !== "object" || typeof metadata.description !== "string" || !metadata.description.trim()) throw new Error("Context Markdown requires a nonempty description")
  return { body: text.slice(match[0].length), description: metadata.description }
}

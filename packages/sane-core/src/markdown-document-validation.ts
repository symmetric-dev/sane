export interface DocumentDiagnostic {
  path: string
  line: number
  message: string
}

export interface DocumentSection {
  title: string
  optional?: boolean
}

export function markdownLines(content: string): { text: string; line: number; code: boolean }[] {
  let fence: { char: string; length: number } | undefined
  return content.split(/\r?\n/).map((text, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text)
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      return { text, line: index + 1, code: true }
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length }
      return { text, line: index + 1, code: true }
    }
    return { text, line: index + 1, code: false }
  })
}

/** Structural checks only: valid Markdown does not establish a successful outcome. */
export function validateMarkdownDocument(content: string, path: string, options: {
  sections: readonly DocumentSection[]
  title?: string
  label: string
}): DocumentDiagnostic[] {
  const errors: DocumentDiagnostic[] = []
  const error = (line: number, message: string) => errors.push({ path, line, message })
  const headings: { level: number; title: string; line: number }[] = []
  const lines = markdownLines(content)
  let paragraph = false
  let list = false
  for (const { text, line, code } of lines) {
    if (code || /^(?: {4}|\t)/.test(text)) { paragraph = false; list = false; continue }
    // Literal code examples and prose about TODO markers are evidence, not unfinished sections.
    const prose = text.replace(/(`+)[\s\S]*?\1/g, "")
    if (/<!--|<id>|<job name>/i.test(prose) || /^\s*(?:[-*+]\s+(?:\[[ x]\]\s+)?)?(?:TODO|TBD|FIXME)(?:\s*[:.!-]\s*.*)?\s*$/i.test(prose)) error(line, `Replace unresolved placeholder or guidance comment with actual ${options.label} content.`)
    const heading = /^ {0,3}(#{1,6})(?:\s+(.+?)\s*|\s*)$/.exec(text)
    if (heading) headings.push({ level: heading[1]!.length, title: (heading[2] ?? "").replace(/\s+#+$/, ""), line })
    // A setext underline needs an open paragraph, not a preceding list/block.
    const underline = /^ {0,3}(?:=+|-+)\s*$/.test(text)
    if (underline && paragraph && !list) error(line, `Use the required ATX (# / ##) ${options.label} headings; remove this extra setext heading.`)
    const listItem = /^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(text)
    const block = heading || underline || /^ {0,3}(?:>|<|(?:\*\s*){3,}|(?:_\s*){3,})/.test(text)
    if (!text.trim()) { paragraph = false; list = false }
    else if (listItem) { paragraph = false; list = true }
    else if (block) { paragraph = false; list = false }
    else if (!list) paragraph = true
  }
  const h1 = headings.filter(h => h.level === 1)
  if (h1.length !== 1) error(h1[1]?.line ?? 1, `Retain exactly one H1 ${options.label} title.`)
  if (options.title !== undefined && h1[0]?.title !== options.title) error(h1[0]?.line ?? 1, `Expected title: # ${options.title}`)
  const h2 = headings.filter(h => h.level === 2)
  for (const section of options.sections) {
    const matches = h2.filter(h => h.title === section.title)
    if (!matches.length && !section.optional) error(1, `Missing section: ## ${section.title}`)
    for (const duplicate of matches.slice(1)) error(duplicate.line, `Duplicate section: ## ${section.title}`)
  }
  for (const heading of h2) if (!options.sections.some(section => section.title === heading.title)) error(heading.line, `Unexpected section: ## ${heading.title}`)
  const expected = options.sections.filter(section => !section.optional || h2.some(h => h.title === section.title)).map(section => section.title)
  if (h2.map(h => h.title).join("|") !== expected.join("|")) error(h2[0]?.line ?? 1, `Required H2 order: ${expected.join(" → ")}`)
  for (let i = 0; i < h2.length; i++) {
    const section = h2[i]!
    const end = h2[i + 1]?.line ?? lines.length + 1
    const body = lines.filter(l => l.line > section.line && l.line < end && !headings.some(h => h.line === l.line) && !/^ {0,3}(?:`{3,}|~{3,})/.test(l.text)).map(l => l.text).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim()
    if (!body) error(section.line, `Empty section: ## ${section.title}; record an outcome or an explicit absence such as None.`)
  }
  for (const heading of headings) {
    if (heading.level > 1 && (!h1[0] || heading.line < h1[0].line)) error(heading.line, `Place the ${options.label} title before all sections.`)
    if (heading.level > 2 && (!h2[0] || heading.line < h2[0].line)) error(heading.line, "Nested headings must appear inside a required H2 section.")
  }
  return errors
}

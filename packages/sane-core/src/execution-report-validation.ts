/** Shared structural validation: an honestly recorded failed outcome is valid. */
import { markdownLines, validateMarkdownDocument, type DocumentDiagnostic } from "./markdown-document-validation.ts"

export const REPORT_SECTIONS = ["Outcome", "Unresolved Issues", "Recommendations"] as const
export const REPORT_SECTION_ORDER = ["Outcome", "Unresolved Issues", "Operational Findings", "Recommendations"] as const

export type ReportDiagnostic = DocumentDiagnostic

export function jobSpecTitle(content: string, jobId: string): string | null {
  for (const { text, code } of markdownLines(content)) {
    if (code) continue
    const match = /^ {0,3}#\s+Job Spec ([^:]+):\s*(.+?)(?:\s+#+)?\s*$/.exec(text)
    if (match && match[1] === jobId) return match[2]!.trim()
  }
  return null
}

/** Template slots are prose; inline, fenced, and indented code may quote literal evidence. */
export function validateJobPlaceholders(content: string, path: string): ReportDiagnostic[] {
  const prose = markdownLines(content).map(({ text, code }) =>
    code || /^(?: {4}|\t)/.test(text) ? "" : text.replace(/(`+)[\s\S]*?\1/g, ""),
  ).join("\n")
  return Array.from(prose.matchAll(/\{\{[^}]*\}\}/g), (match) => ({
    path,
    line: prose.slice(0, match.index).split("\n").length,
    message: "Replace unresolved {{...}} placeholder with authored content.",
  }))
}

export function validateExecutionReport(content: string, path: string, jobId: string, title: string): ReportDiagnostic[] {
  return [
    ...validateJobPlaceholders(content, path),
    ...validateMarkdownDocument(content, path, {
      title: `Job ${jobId}: ${title} Report`,
      label: "report",
      sections: REPORT_SECTION_ORDER.map(section => ({ title: section, optional: section === "Operational Findings" })),
    }),
  ]
}

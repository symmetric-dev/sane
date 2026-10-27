import { basename } from "node:path"
import { jobSpecTitle, validateJobPlaceholders } from "./execution-report-validation.ts"
import { validateMarkdownDocument, type DocumentDiagnostic } from "./markdown-document-validation.ts"

export const JOB_SPEC_SECTIONS = ["Goal and Scope", "Context", "Operational Readiness", "Instructions", "Report Requirements"] as const
export const VERIFICATION_SPEC_SECTIONS = ["Scope", "Review Focus", "Test Work"] as const

export function validateJobSpec(content: string, path: string): DocumentDiagnostic[] {
  const jobId = basename(path, ".md").split("-")[0]!
  const title = jobSpecTitle(content, jobId)
  const errors = [
    ...validateJobPlaceholders(content, path),
    ...validateMarkdownDocument(content, path, {
      label: "Job Spec",
      ...(title !== null ? { title: `Job Spec ${jobId}: ${title}` } : {}),
      sections: JOB_SPEC_SECTIONS.map(section => ({ title: section })),
    }),
  ]
  if (title === null) errors.push({ path, line: 1, message: `Expected Job Spec title: # Job Spec ${jobId}: <job name>` })
  return errors
}

export function validateVerificationSpec(content: string, path: string): DocumentDiagnostic[] {
  return [
    ...validateJobPlaceholders(content, path),
    ...validateMarkdownDocument(content, path, {
      label: "Verification Spec",
      sections: VERIFICATION_SPEC_SECTIONS.map(section => ({ title: section })),
    }),
  ]
}

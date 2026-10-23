import type { NativeSourceDescriptor } from "../../sane-core/src/contracts.ts"
import { parsePresentQuestionsInput, type PresentQuestionsInput } from "../../sane-app/shared/user-questions-contract.ts"

export { parsePresentQuestionsInput }
export type { PresentQuestionsInput, UserQuestion, UserQuestionsReceipt } from "../../sane-app/shared/user-questions-contract.ts"

export interface NativeUserQuestionsRequest {
  version: 1
  caller: { source: NativeSourceDescriptor; authorityId: string; nativeId: string; cwd: string }
  invocation: { toolCallId: string; messageId?: string; invocationId: string; wrapper?: "execute" }
  input: PresentQuestionsInput
}

export const nativeUserQuestionsDescription = "Present a nonblocking, paged question form in this App conversation. Returns promptly with {form_id, status: presented}; it does not wait for answers. Chat remains usable while the form is open. Submitted answers arrive later as a new conversation message, not a native question-reply response. Continue independent work rather than waiting on this tool. Supply a title and 1–32 pages, each with a question, optional context and reference strings. Omit options for a textarea answer; otherwise supply 1–32 distinct options. multiple and allow_other are only valid with options. Limits: title 256 characters, question 2000, context 16000, up to 16 references of 4096 characters each, options 2000 characters each, and 128 KiB of serialized input. Available in App-admitted Base/Free conversations without workstream enrollment. This tool only presents a form; it does not read, edit, or manage existing forms."

const requiredText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength, allOf: [{ pattern: "\\S" }, { not: { pattern: "\\u0000" } }] } as const)
export const nativeUserQuestionsSchema = {
  type: "object", additionalProperties: false, required: ["title", "pages"],
  properties: {
    title: { ...requiredText(256), description: "Title of the question form." },
    pages: {
      type: "array", minItems: 1, maxItems: 32,
      items: {
        type: "object", additionalProperties: false, required: ["question"],
        properties: {
          question: requiredText(2000),
          context: { type: "string", maxLength: 16000, not: { pattern: "\\u0000" }, description: "Optional context displayed with this question." },
          references: { type: "array", maxItems: 16, uniqueItems: true, items: requiredText(4096), description: "Optional reference strings; not instructions to fetch or read files." },
          options: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: requiredText(2000), description: "Distinct answer choices. Omit for a textarea." },
          multiple: { type: "boolean", description: "Allow multiple choices; only valid when options is supplied." },
          allow_other: { type: "boolean", description: "Allow an additional free-text answer; only valid when options is supplied." },
        },
        allOf: [
          { if: { required: ["multiple"] }, then: { required: ["options"] } },
          { if: { required: ["allow_other"] }, then: { required: ["options"] } },
        ],
      },
    },
  },
} as const

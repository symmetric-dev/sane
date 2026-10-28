import { Plugin } from "@opencode/plugin"
import { resolve } from "node:path"
import { OpenCodeWorkerInvocations, qualifyOpenCodeCaller, qualifyOpenCodeAppCaller, assertOpenCodeCodeSharePermissions, assertOpenCodeUserQuestionsPermissions, type OpenCodeToolCaller } from "../../../packages/sane-cli/src/native-opencode.ts"
import { linkNativeCaller, nativeCallerContext, nativeShellCaller, nativeLinkSchema } from "../../../packages/sane-cli/src/native-caller.ts"
import { handoffNativeCaller, nativeHandoffSchema, nativeHandoffStatusSchema } from "../../../packages/sane-cli/src/native-handoff.ts"
import { nativeWorkerDescriptions, nativeWorkerOperations, nativeWorkerSchemas, SANE_MANAGED_ONLY } from "../../../packages/sane-cli/src/native-worker-contract.ts"
import { workerNativeCaller } from "../../../packages/sane-cli/src/native-worker.ts"
import { codeShareInputSnippets, isInlineCodeShareSnippet, nativeShareCodeDescription, nativeShareCodeSchema, parseCodeShareInput } from "../../../packages/sane-cli/src/native-share-code-contract.ts"
import { shareCodeNativeCaller } from "../../../packages/sane-cli/src/native-share-code.ts"
import { nativeUserQuestionsDescription, nativeUserQuestionsSchema, parsePresentQuestionsInput } from "../../../packages/sane-cli/src/native-user-questions-contract.ts"
import { presentQuestionsNativeCaller } from "../../../packages/sane-cli/src/native-user-questions.ts"
import { browserNativeCaller, nativeBrowserDescriptions, nativeBrowserSchemas, nativeBrowserToolNames } from "../../../packages/sane-cli/src/native-browser.ts"
import { registerExecutionOperations } from "./execution.ts"
import { createSaneVisibility } from "./visibility.ts"

export const SanePlugin = Plugin.define({
  id: "sane",
  async setup(ctx) {
    const execution = await registerExecutionOperations(ctx)
    const registration = ctx.options.registrationFile
    // Per-session visibility via session permission rules (see visibility.ts).
    // Tools stay registered (Code Mode); hiding never replaces handler checks.
    const visibility = createSaneVisibility(ctx, { registrationFile: registration, managed: execution.managed })
    const visibilityPrompt = await ctx.session.hook("prompt", async event => { await visibility.prompt(event.sessionID) })
    const visibilityContext = await ctx.session.hook("context", event => { visibility.context(event.sessionID) })
    const workerInvocations = new OpenCodeWorkerInvocations()
    // The App delivers framework and Session context separately into startup history.
    await ctx.tool.hook("execute.before", event => { workerInvocations.before(event) })
    await ctx.tool.hook("execute.after", event => { workerInvocations.after(event) })
    const qualify = (tool: OpenCodeToolCaller) => {
      if (typeof registration !== "string" || !registration.startsWith("/")) throw new Error("NATIVE_CONTEXT_UNAVAILABLE: configure an explicit absolute registrationFile plugin option.")
      return qualifyOpenCodeCaller(registration, ctx, tool)
    }
    const qualifyWorker = async (tool: OpenCodeToolCaller, operation: (typeof nativeWorkerOperations)[number]) => {
      const invocation = workerInvocations.callback(tool, operation)
      return { ...await qualify(tool), invocation }
    }
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "sane", description: "SANE App interactions and workstream coordination" })
      // A shared namespace gets one Code Mode catalog group. Short names keep
      // existing sane_* effective IDs; questions retain their permission action.
      const addSaneTool: typeof editor.add = tool => editor.add({
        ...tool,
        options: { ...tool.options, namespace: "sane", codemode: true, pinned: false },
      })
      // App-only, not managed-only: keep this registered for Base/Free and
      // Code Mode. App admission and attachment are checked by the endpoint.
      addSaneTool({
        name: "present_questions_to_user",
        description: nativeUserQuestionsDescription,
        input: nativeUserQuestionsSchema,
        options: { permission: "present_questions_to_user" },
        execute: async (input, tool) => {
          // Each inner Code Mode callback needs a distinct invocation UUID.
          const invocation = workerInvocations.userQuestionsCallback(tool)
          const args = parsePresentQuestionsInput(input)
          if (typeof registration !== "string" || !registration.startsWith("/")) throw new Error("NATIVE_CONTEXT_UNAVAILABLE: configure an explicit absolute registrationFile plugin option.")
          const { caller, client } = await qualifyOpenCodeAppCaller(registration, ctx, tool)
          const signal = (tool as typeof tool & { signal?: AbortSignal }).signal
          await assertOpenCodeUserQuestionsPermissions(ctx, { ...tool, signal }, client)
          return { content: JSON.stringify(await presentQuestionsNativeCaller(caller, args, ctx.options.appConnectionFile as string, invocation, signal)) }
        },
      })
      addSaneTool({
        name: "share_code",
        description: nativeShareCodeDescription,
        input: nativeShareCodeSchema,
        execute: async (input, tool) => {
          // Allocate before any await: concurrent Code Mode callbacks have the
          // same visible tool ID, but must bind different frozen snapshots.
          const invocation = workerInvocations.codeShareCallback(tool)
          const args = parseCodeShareInput(input)
          if (typeof registration !== "string" || !registration.startsWith("/")) throw new Error("NATIVE_CONTEXT_UNAVAILABLE: configure an explicit absolute registrationFile plugin option.")
          const { caller, client } = await qualifyOpenCodeAppCaller(registration, ctx, tool)
          const signal = (tool as typeof tool & { signal?: AbortSignal }).signal
          const snippets = codeShareInputSnippets(args)
          for (const path of new Set(snippets.flatMap(snippet => isInlineCodeShareSnippet(snippet) ? [] : [resolve(caller.cwd, snippet.path)]))) {
            await assertOpenCodeCodeSharePermissions(ctx, { ...tool, signal }, path, client)
          }
          // Inline content needs share permission, but has no filesystem read.
          if (snippets.some(isInlineCodeShareSnippet)) await assertOpenCodeCodeSharePermissions(ctx, { ...tool, signal }, "inline", client, "inline")
          return { content: JSON.stringify(await shareCodeNativeCaller(caller, args, ctx.options.appConnectionFile as string, invocation, signal)) }
        },
      })
      for (const toolName of nativeBrowserToolNames) addSaneTool({
        name: toolName,
        description: nativeBrowserDescriptions[toolName],
        input: nativeBrowserSchemas[toolName],
        execute: async (input, tool) => {
          if (typeof registration !== "string" || !registration.startsWith("/")) throw new Error("NATIVE_CONTEXT_UNAVAILABLE: configure an explicit absolute registrationFile plugin option.")
          const { caller } = await qualifyOpenCodeAppCaller(registration, ctx, tool)
          const signal = (tool as typeof tool & { signal?: AbortSignal }).signal
          return { content: JSON.stringify(await browserNativeCaller(caller, toolName, input, ctx.options.appConnectionFile as string, signal)) }
        },
      })
      for (const operation of nativeWorkerOperations) addSaneTool({
        name: `worker_${operation}`,
        description: nativeWorkerDescriptions[operation],
        input: nativeWorkerSchemas[operation],
        execute: async (input, tool) => ({ content: JSON.stringify(await workerNativeCaller(await qualifyWorker(tool, operation), operation, input, ctx.options.appConnectionFile as string)) }),
      })
      for (const status of [false, true]) addSaneTool({
        name: status ? "handoff_status" : "handoff",
        description: status ? `${SANE_MANAGED_ONLY} Read durable handoff status by the sender's requestId.` : `${SANE_MANAGED_ONLY} Use only when the user explicitly asks for a SANE handoff or kickoff. Durably queue an asynchronous handoff through the running App. Reuse requestId for admission recovery. Returns without waiting for recipient execution or reply. Exact target selects a linked recipient; createNew uses the destination assistant's configured harness and requires explicit checkout or validated default. Kickoff (the only way to bring a session under SANE): a sender without a workstream passes kickoff with to: design and createNew to enroll, create the workstream and start Design without joining it; kickoff defaults checkout to the caller's validated execution checkout.`,
        input: status ? nativeHandoffStatusSchema : nativeHandoffSchema,
        execute: async (input, tool) => {
          const result = await handoffNativeCaller(await qualify(tool), input, ctx.options.appConnectionFile as string, status)
          // A kickoff may have enrolled the caller: reveal its managed tools.
          if (!status && input && typeof input === "object" && (input as Record<string, unknown>).kickoff !== undefined) visibility.refresh(tool.sessionID)
          return { content: JSON.stringify(result) }
        },
      })
      addSaneTool({
        name: "link",
        description: `${SANE_MANAGED_ONLY} Change workstream membership or phase for an already SANE-managed conversation; never enrolls. slot assigns a phase; explicit workstream selects membership; reassign permits replacement.`,
        input: nativeLinkSchema,
        execute: async (input, tool) => ({ content: JSON.stringify(linkNativeCaller(await qualify(tool), input)) }),
      })
      addSaneTool({
        name: "context",
        description: `${SANE_MANAGED_ONLY} Read this managed conversation's compact context: workstream, phase, harness and execution checkout.`,
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, tool) => ({ content: JSON.stringify(nativeCallerContext(await qualify(tool))) }),
      })
    })
    // Deliberately NOT scoped to eligible sessions: without SANE_CALLER_CONTEXT
    // the `sane` CLI classifies the shell as a local/human actor (create,
    // approve, upgrade...). Unenrolled sessions get the bootstrap form (init and
    // inspect only) or "unavailable" (every command fails closed); enrolled ones
    // get the compact reference. nativeShellCaller already keys on enrollment.
    await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "shell" || !event.input || typeof event.input !== "object") return
      const input = event.input as Record<string, unknown>
      if (typeof input.command !== "string") return
      let reference: string
      try {
        const caller = await qualify({ sessionID: event.sessionID, messageID: event.messageID, id: event.id, agent: event.agent })
        reference = JSON.stringify(nativeShellCaller(caller))
      } catch (error) {
        // Refusal carries the cause (e.g. a stale runtime rejecting a newer schema)
        // instead of a generic caller error; it is never an identity.
        const code = (error as { code?: unknown })?.code
        reference = JSON.stringify({ version: 1, unavailable: `${typeof code === "string" ? `${code}: ` : ""}${error instanceof Error ? error.message : "qualification failed"}` })
      }
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      event.input = { ...input, command: `export SANE_CALLER_CONTEXT=${quote(reference)}\nunset SANE_SESSION_ID OPENCODE_SESSION_ID\n${input.command}` }
    })
    return async () => { workerInvocations.clear(); visibility.clear(); await visibilityPrompt.dispose(); await visibilityContext.dispose(); await execution.dispose() }
  },
})

export default SanePlugin

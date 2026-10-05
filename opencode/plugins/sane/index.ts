import { Plugin } from "@opencode/plugin"
import { OpenCodeWorkerInvocations, qualifyOpenCodeCaller, type OpenCodeToolCaller } from "../../../packages/sane-cli/src/native-opencode.ts"
import { linkNativeCaller, nativeCallerContext, nativeShellCaller, nativeLinkSchema } from "../../../packages/sane-cli/src/native-caller.ts"
import { handoffNativeCaller, nativeHandoffSchema, nativeHandoffStatusSchema } from "../../../packages/sane-cli/src/native-handoff.ts"
import { nativeWorkerDescriptions, nativeWorkerOperations, nativeWorkerSchemas } from "../../../packages/sane-cli/src/native-worker-contract.ts"
import { workerNativeCaller } from "../../../packages/sane-cli/src/native-worker.ts"

export const SanePlugin = Plugin.define({
  id: "sane",
  async setup(ctx) {
    const registration = ctx.options.registrationFile
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
      for (const operation of nativeWorkerOperations) editor.add({
        name: `sane_worker_${operation}`,
        description: nativeWorkerDescriptions[operation],
        input: nativeWorkerSchemas[operation],
        execute: async (input, tool) => ({ content: JSON.stringify(await workerNativeCaller(await qualifyWorker(tool, operation), operation, input, ctx.options.appConnectionFile as string)) }),
      })
      for (const status of [false, true]) editor.add({
        name: status ? "sane_handoff_status" : "sane_handoff",
        description: status ? "Read durable handoff status by the sender's requestId." : "Durably queue an asynchronous handoff through the running App. Reuse requestId for admission recovery. Returns without waiting for recipient execution or reply. Exact target selects a linked recipient; createNew uses the destination assistant's configured harness and requires explicit checkout or validated default. A sender without a workstream may pass kickoff with to: design and createNew to enroll, create the workstream and start Design without joining it; kickoff defaults checkout to the caller's validated execution checkout.",
        input: status ? nativeHandoffStatusSchema : nativeHandoffSchema,
        execute: async (input, tool) => ({ content: JSON.stringify(await handoffNativeCaller(await qualify(tool), input, ctx.options.appConnectionFile as string, status)) }),
      })
      editor.add({
        name: "sane_link",
        description: "Enroll this native conversation in its repository. Empty arguments enroll without claiming a phase; slot optionally assigns a phase. Membership is inherited only from an enrolled repository-local parent. Explicit workstream selects membership; reassign permits replacement.",
        input: nativeLinkSchema,
        execute: async (input, tool) => ({ content: JSON.stringify(linkNativeCaller(await qualify(tool), input)) }),
      })
      editor.add({
        name: "sane_context",
        description: "Read this enrolled native conversation's compact context: workstream, phase, harness and execution checkout.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, tool) => ({ content: JSON.stringify(nativeCallerContext(await qualify(tool))) }),
      })
    })
    await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "shell" || !event.input || typeof event.input !== "object") return
      const input = event.input as Record<string, unknown>
      if (typeof input.command !== "string") return
      let reference: string
      try {
        const caller = await qualify({ sessionID: event.sessionID, messageID: event.messageID, id: event.id, agent: event.agent })
        reference = JSON.stringify(nativeShellCaller(caller))
      } catch { reference = "unavailable" }
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      event.input = { ...input, command: `export SANE_CALLER_CONTEXT=${quote(reference)}\nunset SANE_SESSION_ID OPENCODE_SESSION_ID\n${input.command}` }
    })
    return () => workerInvocations.clear()
  },
})

export default SanePlugin

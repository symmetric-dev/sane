import type { NativeConversationCreation } from "./conversation-creation";
import type { OpenCodeAdapter, OpenCodeLaunch } from "./opencode";

export function claudeConversationCreation(
  allocate: () => string = () => crypto.randomUUID(),
): NativeConversationCreation {
  return { harness: "cc", kind: "allocated", allocate };
}

export function openCodeConversationCreation(
  oc: Pick<OpenCodeAdapter, "createResolved">,
  cwd: string,
  launch: () => OpenCodeLaunch,
): NativeConversationCreation {
  return {
    harness: "oc",
    kind: "created",
    create: async () => (await oc.createResolved(cwd, launch())).id,
  };
}

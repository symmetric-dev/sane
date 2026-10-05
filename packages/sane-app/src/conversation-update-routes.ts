import { CONVERSATION_UPDATE_MAX_PAGE, isConversationUpdateFeedRequest, isConversationUpdatePage, type ConversationUpdateFeedRequest, type ConversationUpdatePage } from "../shared/conversation/conversation-updates";
import { json } from "./bridge-http";

/** The caller must apply the browser boundary and authentication BEFORE this route. */
export type ConversationUpdateRoutes = {
  bootstrap(limit: number): Promise<ConversationUpdatePage>;
  page(request: ConversationUpdateFeedRequest): Promise<ConversationUpdatePage>;
};

function integer(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error("Invalid update cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid update cursor");
  return number;
}

export async function conversationUpdateRoute(req: Request, service: ConversationUpdateRoutes): Promise<Response | null> {
  const url = new URL(req.url), bootstrap = url.pathname === "/api/conversation-updates/bootstrap";
  if (!bootstrap && url.pathname !== "/api/conversation-updates") return null;
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
  let input: ConversationUpdateFeedRequest;
  try {
    const allowed = bootstrap ? ["limit"] : ["epoch", "after", "through", "limit"];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error("Invalid update parameters");
    const limit = integer(url.searchParams.get("limit")) ?? CONVERSATION_UPDATE_MAX_PAGE;
    const after = integer(url.searchParams.get("after")), epoch = url.searchParams.get("epoch");
    if ((after === undefined) !== (epoch === null) || !bootstrap && after === undefined) throw new Error("Missing update cursor");
    const through = integer(url.searchParams.get("through"));
    input = { limit, ...(after !== undefined && epoch !== null ? { cursor: { epoch, after } } : {}), ...(through !== undefined ? { through } : {}) };
    if (!isConversationUpdateFeedRequest(input)) throw new Error("Invalid update parameters");
  } catch { return json({ error: "Invalid conversation-update parameters", code: "invalid-update-cursor" }, 400); }
  try {
    const page = bootstrap ? await service.bootstrap(input.limit!) : await service.page(input);
    if (!isConversationUpdatePage(page, { ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.through !== undefined ? { through: input.through } : {}), limit: input.limit })) throw new Error("Invalid update projection");
    return json(page);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? (error as { status: unknown }).status : undefined;
    const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
    if (status === 410 || code === "CONVERSATION_UPDATE_CURSOR_EXPIRED" || code === "conversation-update-gap" || code === "update-gap") return json({ error: "Conversation-update coverage expired. Recovery is required.", code: "conversation-update-gap" }, 410);
    if (status === 400 || code === "INVALID_CONVERSATION_UPDATE_REQUEST") return json({ error: "Invalid conversation-update cursor", code: "invalid-update-cursor" }, 400);
    return json({ error: "Conversation-update coverage is temporarily unavailable", code: "conversation-updates-unavailable" }, 503);
  }
}

import type { WorkstreamOverview } from "../src/workstreams-contract";
import { useWorkstreamOverview } from "./conversation-hooks";
import { formatTitle } from "./conversation-filter";
import type { Conversation } from "./types";
import "./conversation-heading.css";

/** Reuse the sidebar's overview unless the selected chat belongs to another workspace. */
export function ConversationHeading({ conversation, selectedId, overview, overviewWorkspaceId }: {
  conversation?: Conversation;
  selectedId: string | null;
  overview: WorkstreamOverview | null;
  overviewWorkspaceId: string | null;
}) {
  const workspaceId = conversation?.workspaceId ?? null;
  const separateOverview = useWorkstreamOverview(workspaceId, !!workspaceId && workspaceId !== overviewWorkspaceId);
  const data = workspaceId && workspaceId === overviewWorkspaceId ? overview : separateOverview;
  const membership = data?.conversations.find(row => row.sessionId === selectedId)?.conversation;
  const workstreamId = membership?.workstreamId;
  const workstream = data?.workstreams.find(row => row.workstream.id === workstreamId)?.workstream;
  const free = !workstreamId && (!!membership || !selectedId);
  const label = workstreamId ? workstream?.title || workstreamId : free ? "Free" : "Unknown";
  const hint = workstreamId ? `${label} · ${workstreamId}` : free ? "No workstream assigned" : "Workstream association unavailable";
  const root = conversation?.cwd.split("/").filter(Boolean).at(-1) || conversation?.cwd || "Conversation";
  const title = conversation?.title ? formatTitle(conversation.title, root) : selectedId ? "Conversation" : "New conversation";

  return <div className="conversation-heading conversation-binder">
    <span className={`conversation-workstream-tab${free ? " is-free" : ""}`} title={hint} aria-label={`Workstream: ${label}`}><span>{label}</span></span>
    <span className="conversation-binder-title" title={conversation?.title || title}>{title}</span>
  </div>;
}

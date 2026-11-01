import { codeSharePages, type CodeShareRecord } from "../shared/code-share-contract";
import type { MediaShareRecord } from "../shared/media-share-contract";
import { codeShareSnippetPresentation } from "./code-share-presentation";
import { mediaShareContentUrl, mediaShareFilename } from "./media-share-presentation";
import type { UserQuestionsDraft } from "./user-questions-client";
import { questionsStatus } from "./user-questions-presentation";

/** A row identifies the original durable card, never an individual page or item. */
export type SharedArtifact = {
  kind: "code-share" | "media-share" | "questions";
  id: string;
  sessionId: string;
  anchor: CodeShareRecord["anchor"];
  title: string;
  createdAt: string;
  paths: readonly string[];
  itemCount: number;
  itemLabel: string;
  kindLabel: string;
  status?: string;
  /** First image in a media share, even when videos precede it. */
  representativeImageUrl?: string;
  representativeImageName?: string;
  videoOnly?: boolean;
  searchText: string;
};

export type SharedArtifactFilter = "all" | SharedArtifact["kind"];

/** Only supplied persisted records are indexed; this model owns no reads or drafts. */
export function buildSharedArtifacts(
  sessionId: string,
  codeShares: readonly CodeShareRecord[],
  mediaShares: readonly MediaShareRecord[],
  questions: readonly UserQuestionsDraft[],
): SharedArtifact[] {
  const rows = new Map<string, SharedArtifact>();
  const add = (row: SharedArtifact, extraSearch: readonly string[] = []) => {
    rows.set(`${row.kind}:${row.id}`, {
      ...row,
      searchText: [row.title, row.kindLabel, row.itemLabel, row.createdAt, row.status ?? "", ...row.paths, ...extraSearch].join("\n").toLocaleLowerCase(),
    });
  };
  for (const share of codeShares) {
    if (share.sessionId !== sessionId) continue;
    const pages = codeSharePages(share).map(codeShareSnippetPresentation);
    const first = pages[0]?.title ?? "Shared code";
    add({
      kind: "code-share", id: share.id, sessionId, anchor: share.anchor, createdAt: share.createdAt,
      title: share.input.title ?? (pages.length > 1 ? `${first} + ${pages.length - 1} more` : first),
      paths: [...new Set(pages.flatMap(page => page.path ? [page.path] : []))],
      itemCount: pages.length, itemLabel: `${pages.length} snippet${pages.length === 1 ? "" : "s"}`,
      kindLabel: "Code", searchText: "",
    }, pages.map(page => page.title));
  }
  for (const share of mediaShares) {
    if (share.sessionId !== sessionId) continue;
    const representativeImage = share.media.find(item => item.kind === "image");
    const representative = representativeImage ?? share.media[0];
    const first = representative ? mediaShareFilename(representative) : "Shared media";
    const images = share.media.filter(item => item.kind === "image").length;
    const videos = share.media.length - images;
    add({
      kind: "media-share", id: share.id, sessionId, anchor: share.anchor, createdAt: share.createdAt,
      title: share.input.title ?? (share.media.length > 1 ? `${first} + ${share.media.length - 1} more` : first),
      paths: share.media.map(item => item.path), itemCount: share.media.length,
      itemLabel: [images ? `${images} image${images === 1 ? "" : "s"}` : "", videos ? `${videos} video${videos === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
      kindLabel: "Media", searchText: "",
      representativeImageUrl: representativeImage ? mediaShareContentUrl(share, representativeImage) : undefined,
      representativeImageName: representativeImage ? mediaShareFilename(representativeImage) : undefined,
      videoOnly: images === 0 && videos > 0,
    });
  }
  for (const draft of questions) {
    const { form } = draft;
    if (form.sessionId !== sessionId) continue;
    const status = questionsStatus(draft);
    const lifecycle = form.status === "presented" ? "Awaiting answers" : form.status === "submitted" ? "Submitted" : "Dismissed";
    add({
      kind: "questions", id: form.id, sessionId, anchor: form.anchor, createdAt: form.createdAt,
      title: form.input.title, paths: [], itemCount: form.input.pages.length,
      itemLabel: `${form.input.pages.length} question${form.input.pages.length === 1 ? "" : "s"}`,
      kindLabel: "Questionnaire", status: status === lifecycle ? status : `${lifecycle} · ${status}`, searchText: "",
    }, form.input.pages.map(page => page.question));
  }
  // Explicit insertion-order tie breaking keeps equal timestamps stable.
  return [...rows.values()].map((row, index) => ({ row, index })).sort((a, b) =>
    (Date.parse(b.row.createdAt) || 0) - (Date.parse(a.row.createdAt) || 0) || a.index - b.index,
  ).map(({ row }) => row);
}

export function filterSharedArtifacts(rows: readonly SharedArtifact[], query: string, filter: SharedArtifactFilter): SharedArtifact[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => (filter === "all" || row.kind === filter) && terms.every(term => row.searchText.includes(term)));
}

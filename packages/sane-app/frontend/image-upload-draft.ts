import { IMAGE_UPLOAD_LIMITS, imageUploadMimeType, isImageUploadReceipt, type ImageUploadReceipt } from "../shared/image-upload-contract";
import { catalog } from "./catalog";
import type { ImageUploadTarget } from "./image-upload-client";
import { store } from "./store";
import { workspaceEpoch } from "./workspace-store";

export type ImageUploadDraftScope = { key: string; draftKey: string; selected: string; target: ImageUploadTarget; bindingRevision: string; root: string; executionCwd: string };

/** Resolve only the conversation's association, or an explicit catalog selection.
 * Browsing another checkout must never redirect an existing conversation upload. */
export function imageUploadDraftScope(): ImageUploadDraftScope | null {
  const state = store.snapshot(), selected = state.selected;
  const conversation = state.conversations.find(item => item.id === selected);
  const snapshot = catalog.snapshot();
  if (state.phase !== "ready" || state.config?.authenticated !== true || !state.config.storeId || !snapshot.ready
    || selected && (!conversation || conversation.replacedBy || conversation.association === "unresolved")) return null;
  const workspaceId = selected ? conversation?.workspaceId : snapshot.navigation.workspaceId;
  const worktreeId = selected ? conversation?.worktreeId : snapshot.navigation.worktreeId;
  if (!workspaceId || !worktreeId) return null;
  const worktree = snapshot.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  if (!worktree || worktree.state !== "available" || !worktree.bindingRevision) return null;
  // Custom new-draft execution directories cannot prove this catalog association.
  const cwd = store.draft().cwd;
  if (!selected && cwd && cwd !== worktree.root) return null;
  const draftKey = store.draftKey();
  const executionCwd = selected ? conversation!.cwd : cwd || worktree.root;
  return { draftKey, selected, target: { workspaceId, worktreeId }, bindingRevision: worktree.bindingRevision, root: worktree.root, executionCwd,
    key: JSON.stringify([draftKey, selected, workspaceId, worktreeId, worktree.bindingRevision, worktree.root,
      state.config.storeId, state.config.authenticated, workspaceEpoch(), store.sessionNameScope(selected), cwd,
      conversation?.replacedBy, executionCwd]) };
}

export function imageUploadDraftBlocked(): boolean {
  const state = store.snapshot();
  return state.sending || state.actionBusy || state.loading || store.pendingInputChainLocked()
    || !store.capabilities().prompt || !store.captureSendSupported() || !!store.legacyScienceSendBlocked();
}

/** Only duplicate object references are collapsed: matching file metadata does
 * not establish that two selected images have the same contents. */
export function imageUploadSelection(files: File[]): { files: File[]; error?: string } {
  const unique = [...new Set(files)];
  if (!unique.length) return { files: [], error: "Choose PNG, JPEG, or static WebP images to upload." };
  if (unique.some(file => !imageUploadMimeType(file.name) || file.type && file.type !== imageUploadMimeType(file.name))) {
    return { files: [], error: "Only PNG, JPEG, and static WebP images are supported. Mixed selections were not uploaded; choose images only." };
  }
  if (unique.length > IMAGE_UPLOAD_LIMITS.files) return { files: [], error: `Choose at most ${IMAGE_UPLOAD_LIMITS.files} images per upload.` };
  if (unique.some(file => !file.size || file.size > IMAGE_UPLOAD_LIMITS.imageBytes)) return { files: [], error: "Each image must be non-empty and no larger than 10 MiB." };
  if (unique.reduce((bytes, file) => bytes + file.size, 0) > IMAGE_UPLOAD_LIMITS.totalBytes) return { files: [], error: "The image selection must be no larger than 160 MiB." };
  return { files: unique };
}

/** Synchronous scope check + latest draft read: never restore the opening text,
 * clear a draft, send it, or route receipts into a newly selected conversation. */
export function appendImageUploadReferences(scope: ImageUploadDraftScope, receipts: ImageUploadReceipt[], seen: Set<string>): number {
  if (imageUploadDraftScope()?.key !== scope.key || imageUploadDraftBlocked()) return 0;
  const accepted = receipts.filter(receipt => {
    if (!isImageUploadReceipt(receipt) || receipt.workspaceId !== scope.target.workspaceId || receipt.worktreeId !== scope.target.worktreeId
      || receipt.bindingRevision !== scope.bindingRevision || seen.has(receipt.uploadId)) return false;
    seen.add(receipt.uploadId);
    return true;
  });
  if (!accepted.length) return 0;
  const text = store.draft().text;
  const references = accepted.map(receipt => {
    const path = scope.executionCwd === scope.root ? receipt.path : `${scope.root.replace(/\/+$/, "")}/${receipt.path}`;
    return `Image: ${path}`;
  }).join("\n");
  store.setDraft({ text: text + (text && !text.endsWith("\n") ? "\n" : "") + references }, scope.selected);
  return accepted.length;
}

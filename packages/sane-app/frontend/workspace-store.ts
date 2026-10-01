import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { WorkspaceFile, WorkspaceGit, GitComparison } from "../src/workspace-contract";
import type { WorktreeResolution as Workspace } from "../src/catalog-contract";
import { workspaceClient, WorkspaceError } from "./workspace-client";
import { bufferLanguage, createBufferState, language, wrapping, wrappingExtension } from "./workspace-editor";
import { codeSettings } from "./code-settings";

export type Buffer = {
  path: string; state: EditorState; baseText: string; file: WorkspaceFile; disk?: WorkspaceFile;
  saving: boolean; checking: boolean; missing: boolean; error: string; view: EditorView | null;
  attach: (view: EditorView | null) => void;
};
export type TreePresentation = { expandedItems: string[]; focusedItem: string | null };
export type RootState = { root: string; workspace: Workspace; generation: number; selected: string; buffers: Map<string, Buffer>; pathVersions: Map<string, number>; mutations: Set<string>; gitVersion: number; git?: WorkspaceGit; comparison: GitComparison; codeTree: TreePresentation; gitTree: TreePresentation };
const roots = new Map<string, RootState>();
codeSettings.subscribe(() => {
  for (const root of roots.values()) for (const buffer of root.buffers.values()) {
    buffer.state = buffer.state.update({ effects: wrapping.reconfigure(wrappingExtension(buffer.path)) }).state;
    buffer.view?.setState(buffer.state);
  }
  notifyWorkspace();
});
let epoch = 0, version = 0;
let authExpired: (() => void) | undefined;
export const onWorkspaceAuthExpired = (handler: () => void) => { authExpired = handler; };
const listeners = new Set<() => void>();
export const subscribeWorkspace = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const workspaceSnapshot = () => version;
export const notifyWorkspace = () => { version++; listeners.forEach(listener => listener()); };
export const workspaceEpoch = () => epoch;
export const dirty = (buffer: Buffer) => buffer.state.doc.toString() !== buffer.baseText;
export const workspaceHasDirtyBuffers = () => [...roots.values()].some(root => [...root.buffers.values()].some(dirty));
export function invalidateWorkspaceRequests() { epoch++; for (const root of roots.values()) { root.generation++; root.mutations.clear(); for (const buffer of root.buffers.values()) { buffer.saving = false; buffer.checking = false; } } notifyWorkspace(); }
export function resetWorkspaceState() { epoch++; roots.clear(); notifyWorkspace(); }
const requestId = (workspace: Workspace) => JSON.stringify([workspace.catalogWorkspaceId, workspace.worktreeId]);
const rootKey = (workspace: Workspace) => JSON.stringify([workspace.catalogWorkspaceId, workspace.worktreeId, workspace.bindingRevision, workspace.root]);
export function rootState(workspace: Workspace) {
  let root = roots.get(rootKey(workspace));
  if (!root) { root = { root: workspace.root, workspace, generation: 0, selected: "", buffers: new Map(), pathVersions: new Map(), mutations: new Set(), gitVersion: 0, comparison: "unstaged", codeTree: { expandedItems: [], focusedItem: null }, gitTree: { expandedItems: ["group:staged:", "group:unstaged:", "group:untracked:"], focusedItem: null } }; roots.set(rootKey(workspace), root); }
  if (root.workspace.bindingRevision !== workspace.bindingRevision) {
    root.generation++; root.git = undefined; root.mutations.clear();
    for (const buffer of root.buffers.values()) { buffer.checking = false; buffer.saving = false; }
  }
  root.workspace = workspace;
  return root;
}
export function workspaceFailure(error: unknown) {
  if (error instanceof WorkspaceError && error.status === 401) {
    // Invalidate every outstanding workspace request. The shell handles sign-in.
    epoch++;
    for (const root of roots.values()) {
      root.generation++; root.mutations.clear();
      for (const buffer of root.buffers.values()) { buffer.checking = false; buffer.saving = false; }
    }
    notifyWorkspace();
    authExpired?.();
    return "Sign-in expired. Reconnect or sign in again; unsaved buffers remain in memory.";
  }
  return error instanceof Error ? error.message : "Workspace request failed.";
}
export function requestFence(workspace: Workspace, valid: () => boolean = () => true) {
  const root = rootState(workspace), token = epoch, generation = root.generation;
  return () => token === epoch && roots.get(rootKey(workspace)) === root && root.generation === generation && valid();
}
export const fencePath = (root: RootState, path: string) => root.pathVersions.set(path, (root.pathVersions.get(path) ?? 0) + 1);
export function pathFence(root: RootState, path: string) {
  const version = root.pathVersions.get(path) ?? 0;
  return () => (root.pathVersions.get(path) ?? 0) === version;
}
function bufferFence(workspace: Workspace, buffer: Buffer, valid: () => boolean = () => true) {
  const root = rootState(workspace), path = buffer.path, current = requestFence(workspace, valid), unchanged = pathFence(root, path);
  return () => current() && unchanged() && buffer.path === path && root.buffers.get(path) === buffer;
}
// Reconfigure, rather than recreate, so history, selection and unsaved text survive.
export function renameBuffer(root: RootState, buffer: Buffer, destination: string, file: WorkspaceFile) {
  root.buffers.delete(buffer.path);
  buffer.path = destination;
  buffer.file = { ...buffer.file, ...file, text: buffer.file.text };
  if (buffer.disk) buffer.disk = { ...buffer.disk, path: destination, workspaceId: file.workspaceId };
  buffer.state = buffer.state.update({ effects: [bufferLanguage.reconfigure(language(destination)), wrapping.reconfigure(wrappingExtension(destination))] }).state;
  buffer.view?.setState(buffer.state);
  root.buffers.set(destination, buffer);
}
// Acquisition never changes canonical selection. Navigation belongs to the controller.
export async function openBuffer(id: string, workspace: Workspace, path: string, valid: () => boolean = () => true) {
  const root = rootState(workspace), unchanged = pathFence(root, path), current = requestFence(workspace, () => valid() && unchanged() && !root.mutations.has(path));
  if (root.mutations.has(path)) return;
  const existing = root.buffers.get(path);
  if (existing) return existing;
  const file = await workspaceClient.file(id, workspace.workspaceId, path);
  if (!current()) return;
  // Another view may have opened the same canonical file during the request.
  if (root.buffers.has(path)) return root.buffers.get(path);
  const buffer = {} as Buffer;
  Object.assign(buffer, { path, file, baseText: file.text ?? "", saving: false, checking: false, missing: false, error: "", view: null,
    attach: (view: EditorView | null) => { if (buffer.view !== view) { buffer.view = view; notifyWorkspace(); } },
  });
  buffer.state = createBufferState(path, file.text ?? "", state => { buffer.state = state; notifyWorkspace(); }, () => { void saveBuffer(requestId(root.workspace), root.workspace, buffer); });
  root.buffers.set(path, buffer); notifyWorkspace();
  return buffer;
}
function replaceBuffer(buffer: Buffer, file: WorkspaceFile) {
  const state = buffer.state.update({ changes: { from: 0, to: buffer.state.doc.length, insert: file.text ?? "" } }).state;
  buffer.state = state;
  buffer.file = file; buffer.baseText = file.text ?? ""; buffer.disk = undefined; buffer.missing = false; buffer.error = "";
  if (buffer.view) buffer.view.setState(state);
}
export async function refreshBuffer(id: string, workspace: Workspace, buffer: Buffer, reload = false, valid: () => boolean = () => true) {
  if (buffer.checking || buffer.saving) return;
  const root = rootState(workspace);
  if (root.mutations.has(buffer.path) || root.buffers.get(buffer.path) !== buffer) return;
  const current = bufferFence(workspace, buffer, valid), ownership = bufferFence(workspace, buffer), revision = buffer.file.revision, initialState = buffer.state, path = buffer.path;
  buffer.checking = true;
  notifyWorkspace();
  try {
    const file = await workspaceClient.file(id, workspace.workspaceId, path);
    if (!current() || buffer.saving || revision !== buffer.file.revision) return;
    buffer.missing = false;
    if ((reload && buffer.state.doc.eq(initialState.doc)) || (!dirty(buffer) && file.revision !== revision)) replaceBuffer(buffer, file);
    else if (file.revision !== revision) buffer.disk = file;
    else buffer.disk = undefined;
    buffer.error = "";
  } catch (error) {
    if (!current()) return;
    // Only a successful read above can clear a missing/unverified destination.
    // Network/server errors are not evidence that a committed rename is safe to save.
    if (error instanceof WorkspaceError && error.status === 404) buffer.missing = true;
    buffer.error = workspaceFailure(error);
  } finally { if (ownership()) { buffer.checking = false; notifyWorkspace(); } }
}
export async function saveBuffer(id: string, workspace: Workspace, buffer: Buffer) {
  if (buffer.saving || !dirty(buffer) || !buffer.file.editable || !buffer.file.revision || buffer.missing) return;
  const root = rootState(workspace);
  if (root.mutations.has(buffer.path) || root.buffers.get(buffer.path) !== buffer) return;
  const text = buffer.state.doc.toString(), path = buffer.path, revision = buffer.file.revision, current = bufferFence(workspace, buffer);
  if (new TextEncoder().encode(text).length > workspace.maxFileBytes) { buffer.error = "File exceeds the 256 KiB editing limit."; notifyWorkspace(); return; }
  buffer.saving = true; buffer.error = ""; notifyWorkspace();
  try {
    const result = await workspaceClient.save(id, workspace.workspaceId, path, text, revision);
    if (!current()) return;
    // Only the submitted snapshot becomes the base; later typing stays dirty.
    buffer.file = result; buffer.baseText = text; buffer.disk = undefined;
  } catch (error) {
    if (!current()) return;
    buffer.error = error instanceof WorkspaceError && error.status === 409 ? "Disk or workspace changed. Your edits are preserved. Compare with disk or explicitly reload before saving." : workspaceFailure(error);
    if (error instanceof WorkspaceError && error.status === 409) {
      try { const disk = await workspaceClient.file(id, workspace.workspaceId, path); if (current()) buffer.disk = disk; } catch { /* Keep the conflict and local buffer. */ }
    }
  } finally { if (current()) { buffer.saving = false; notifyWorkspace(); } }
}

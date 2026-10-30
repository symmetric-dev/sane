import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronRight, FiFolder, FiLink, FiLoader, FiRotateCw } from "react-icons/fi";
import type { WorkspaceList } from "../src/workspace-contract";
import { isImageUploadDirectory } from "../shared/image-upload-contract";
import { workspaceClient, WorkspaceError } from "./workspace-client";
import { imageUploadScopeId, type ImageUploadBinding } from "./image-upload-client";

type Listing = { loading?: boolean; value?: WorkspaceList; error?: string; missing?: boolean };
const ancestors = (path: string) => ["", ...path.split("/").filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join("/"))];

/** Independent directory-only browser: no full Files controller, editor, or recursive inventory. */
export function ImageUploadDirectoryPicker({ binding, selected, onSelect, onAvailability, disabled = false, refresh = 0 }: {
  binding: ImageUploadBinding; selected: string; onSelect: (path: string) => void;
  onAvailability?: (usable: boolean) => void; disabled?: boolean; refresh?: number;
}) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState(() => new Set(ancestors(selected)));
  const cache = useRef<Record<string, Listing>>({});
  const generation = useRef(0);
  const alive = useRef(true);
  const load = async (path: string, force = false) => {
    if (!force && Object.hasOwn(cache.current, path)) return;
    const current = generation.current;
    cache.current = { ...cache.current, [path]: { loading: true } }; setListings(cache.current);
    let result: Listing;
    try {
      const value = await workspaceClient.list(imageUploadScopeId(binding), binding.bindingRevision, path);
      result = value.workspaceId === binding.bindingRevision && value.path === path
        ? { value } : { error: "The worktree binding changed. Close and reopen the upload dialog." };
    } catch (error) {
      result = error instanceof WorkspaceError && error.status === 404 ? { missing: true }
        : { error: error instanceof Error ? error.message : "Could not list this folder." };
    }
    if (!alive.current || current !== generation.current) return;
    cache.current = { ...cache.current, [path]: result }; setListings(cache.current);
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    generation.current++; cache.current = {}; setListings({});
    setExpanded(new Set(ancestors(selected)));
    for (const path of ancestors(selected)) void load(path);
  }, [refresh, binding.bindingRevision]);
  useEffect(() => {
    setExpanded(previous => new Set([...previous, ...ancestors(selected)]));
    for (const path of ancestors(selected)) void load(path);
  }, [selected]);
  useEffect(() => {
    const chain = ancestors(selected);
    const blocked = chain.some((path, index) => {
      const entry = listings[path]?.value?.entries.find(entry => entry.path === chain[index + 1]);
      return !!entry && entry.kind !== "directory";
    });
    onAvailability?.(!blocked && !!(listings[selected]?.value || listings[selected]?.missing));
  }, [listings, selected, onAvailability]);

  const renderDirectory = (path: string, name: string, depth: number, synthetic = false) => {
    const listing = listings[path];
    const open = expanded.has(path);
    const entries = listing?.value?.entries.filter(entry => entry.kind === "directory" || entry.kind === "symlink") ?? [];
    const next = ancestors(selected).find(candidate => candidate !== path && candidate.startsWith(path ? `${path}/` : "")
      && candidate.split("/").length === (path ? path.split("/").length + 1 : 1));
    const nonDirectoryNext = next && listing?.value?.entries.find(entry => entry.path === next && entry.kind !== "directory" && entry.kind !== "symlink");
    const missingNext = next && !nonDirectoryNext && !entries.some(entry => entry.path === next);
    return <li key={path}>
      <div className={`image-upload-directory-row${selected === path ? " is-selected" : ""}`} style={{ paddingInlineStart: depth * 14 }}>
        <button type="button" className="image-upload-expand" aria-label={`${open ? "Collapse" : "Expand"} ${name}`} aria-expanded={open} disabled={disabled}
          onClick={() => { setExpanded(previous => { const value = new Set(previous); open ? value.delete(path) : value.add(path); return value; }); if (!open) void load(path); }}>{open ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}</button>
        <button type="button" className="image-upload-directory-name" aria-pressed={selected === path} disabled={disabled} title={path || binding.root || "Project root"} onClick={() => onSelect(path)}>
          <FiFolder aria-hidden="true" /><span>{name}</span>{(listing?.missing || synthetic && !listing?.value && !listing?.loading) && <small className="image-upload-badge" title="Created when you upload">New</small>}
        </button>
      </div>
      {open && <ul>
        {listing?.loading && <li className="image-upload-tree-note" role="status"><FiLoader className="image-upload-spin" aria-hidden="true" />Loading…</li>}
        {listing?.error && <li className="image-upload-tree-note"><span role="alert">{listing.error}</span> <button type="button" className="icon-button" aria-label={`Retry loading ${name}`} title="Retry" disabled={disabled} onClick={() => void load(path, true)}><FiRotateCw aria-hidden="true" /></button></li>}
        {entries.map(entry => entry.kind === "symlink" || !isImageUploadDirectory(entry.path)
          ? <li key={entry.path} className="image-upload-tree-note"><button type="button" disabled title={entry.kind === "symlink" ? "Symlink — unavailable" : "Unavailable destination"} aria-label={`${entry.name}: unavailable${entry.kind === "symlink" ? " symlink" : " destination"}`}>{entry.kind === "symlink" && <FiLink aria-hidden="true" />}{entry.name}</button></li>
          : renderDirectory(entry.path, entry.name, depth + 1))}
        {missingNext && renderDirectory(next, next.split("/").pop()!, depth + 1, !!listing?.value || !!listing?.missing)}
        {nonDirectoryNext && <li className="image-upload-tree-note" role="alert">{nonDirectoryNext.name} is not a folder. Choose another destination.</li>}
        {listing?.value?.truncated && <li className="image-upload-tree-note" role="status"><span>More folders not shown.</span><button type="button" className="icon-button" aria-label={`Refresh ${name}`} title="Refresh folders" disabled={disabled} onClick={() => void load(path, true)}><FiRotateCw aria-hidden="true" /></button></li>}
      </ul>}
    </li>;
  };
  return <div className="image-upload-directory-picker" aria-label="Destination folders">
    <ul>{renderDirectory("", "Project root", 0)}</ul>
  </div>;
}

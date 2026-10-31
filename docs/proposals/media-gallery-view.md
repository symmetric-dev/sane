# Media Gallery View and Agent Pairing

Status: Proposed implementation plan; no implementation has started.
Date: 2026-10-30

## Summary

Add a **Media** view containing persistent **Galleries** that can be paired with
agent conversations. Grid, Focus, and Compare are presentations of a gallery,
not separate resource types.

A gallery is an album, not a filesystem directory. SANE owns its metadata and
references existing media without moving or copying source files. Users and
agents curate the album through SANE operations. Actual media generation and
editing continue through the agent's existing tools and permissions.

Keep mutable galleries separate from immutable media shared in chat. A user can
freeze a gallery selection into chat to preserve exactly what was reviewed.

This document is a workstream-ready proposal. The recommended defaults below
are design choices, not descriptions of already implemented behavior.

## Goals

- Browse and curate media from a dedicated view.
- Pair a conversation with a stable gallery resource.
- Reference existing files without relocating or duplicating their bytes.
- Let agents inspect media and curate galleries through explicit SANE tools.
- Make the media and versions supplied to an agent turn visible to the user.
- Preserve immutable chat evidence while live source files continue changing.
- Reuse existing pairing, workspace access, and media components where suitable.

## Non-goals for the first release

- An OS-level virtual filesystem, FUSE mount, or real symlink tree.
- Arbitrary host-path access or automatic access to external directories.
- A general asset-management platform or image/video editor.
- Watched folders, query-based smart galleries, or automatic organization.
- Region annotations, overlay comparison, or pixel-difference processing.
- Automatic relinking of moved files by filename or content hash.
- Sending all gallery media to the model simply because a gallery was opened.

## Existing foundations

Validate these integration points against the code at implementation time:

| Area | Current foundation | Implication |
| --- | --- | --- |
| Pairing contract | `packages/sane-app/shared/resource-pair-contract.ts` | Targets currently identify Browser tabs or individual files. Add a gallery target without changing those identities. |
| Pairing persistence | `packages/sane-app/src/resource-pair-store.ts` | File links use App-owned persistence, revisions, and native conversation identity checks. Extend deliberately; the store currently assumes browser/file kinds. |
| Preview target | `packages/sane-app/frontend/preview-pair-target.ts` | Source and Notebook are presentations of the same file resource. Apply the same principle to gallery modes. |
| Paired shell | `packages/sane-app/frontend/preview-pair-layout.tsx` | Resource lists and agent history share a sidebar rather than competing sidebars. |
| Image preview | `packages/sane-app/frontend/workspace-image-preview.tsx` | Existing saved-file preview and bounded cache behavior can inform live media display. |
| Image serving | `packages/sane-app/src/workspace-image.ts` | Existing authenticated, bounded, validated image reads should remain the access boundary. |
| Shared media UI | `packages/sane-app/frontend/shared-media-card.tsx` | Existing focus/gallery, grid, and row rendering is reusable where its immutable-share assumptions fit. |
| Immutable media | `packages/sane-app/src/media-share-store.ts` | Chat shares preserve frozen bytes. Do not turn them into mutable gallery records. |
| Public media metadata | `packages/sane-app/shared/media-share-contract.ts` | Existing share metadata separates public records from private blob locations. |

Individual image-file pairing appears structurally covered by the existing file
target. Verify that integration rather than introducing a second image identity.
The new resource is the persistent multi-item gallery.

## UX

### Entry points

- Open Media from workspace navigation.
- Create a named gallery and add existing workspace media by reference.
- Offer an "Add to gallery" action from supported file previews.
- Offer "Add to gallery" from an existing media share where its access rules
  permit reuse.
- Offer "Pair agent" on the gallery, using the established conversation picker.

Uploads are a separate operation: their bytes need an explicit real destination
before the resulting asset can be referenced. Do not make dropping an existing
file synonymous with copying it.

### Grid: browse and curate

```text
+---------------------------------------------------------------+
| Media / Website review     [Grid* Focus Compare]  [Pair agent] |
+----------------+----------------------------------------------+
| Galleries      | [Search...]  [Filter]  [+ Add]                 |
|                |                                              |
| Website review | +------------+ +------------+ +------------+  |
| Product shots  | |            | |            | |            |  |
| References     | |  image A   | |  image B   | |  image C   |  |
|                | |            | |            | |            |  |
|                | +------------+ +------------+ +------------+  |
|                | [x] Homepage  [x] Mobile     [ ] Alternative  |
|                |                                              |
|                | 2 selected  [Compare] [Ask agent] [Remove]    |
+----------------+----------------------------------------------+
```

Support keyboard selection, opening an item in Focus, reordering, labels,
captions, tags, and removing references. Search/filter and Compare can follow the
initial vertical slice. A label change is not a source-file rename.

Use **Remove from gallery** for reference removal. A gallery action must not
silently delete a source file. Source deletion is outside the first release.

### Focus: pair around one image

```text
+---------------------------------------------------------------+
| Website review / Mobile      2 of 12       Agent: Design review |
+----------------+----------------------------------------------+
| [Media|Agent*] | mobile.png                  [Fit] [100%] [+/-] |
|                |                                              |
| You:           |                                              |
| Review this    |                 IMAGE                        |
| mobile layout. |                                              |
|                |                                              |
| Agent:         |                                              |
| The primary    |                                              |
| action is...   |----------------------------------------------|
|                | [thumb] [ACTIVE] [thumb] [thumb] [thumb]      |
+----------------+----------------------------------------------+
| Context: [Mobile - captured version]                           |
| Ask the agent...                                       [Send] |
+---------------------------------------------------------------+
```

Reuse the existing paired shell's resource/history switch and composer behavior.
Pairing remains attached to the gallery while focus, selection, and layout change.

Show explicit media context chips. Opening or selecting an image does not by
itself attach it to a model turn. "Ask agent" creates the visible attachment
intent; sending captures and binds exact media versions.

### Compare: pair around a decision

```text
+---------------------------------------------------------------+
| Website review        [Grid Focus Compare*]     Agent connected |
+----------------+----------------------------------------------+
| [Media|Agent*] | BEFORE                 AFTER                   |
|                | +-------------------+ +--------------------+  |
| You:           | |                   | |                    |  |
| Which version  | |      image A      | |      image B       |  |
| is clearer?    | |                   | |                    |  |
|                | +-------------------+ +--------------------+  |
| Agent:         |                                              |
| Version B...   | [Side by side]           [Choose B]            |
+----------------+----------------------------------------------+
| Context: [A @ version] [B @ version]                            |
| Ask the agent...                                       [Send] |
+---------------------------------------------------------------+
```

Start with two-item side-by-side display. "Choose B" is a possible future durable
review decision, not an implicit filesystem action. Overlay, synchronized zoom,
and difference rendering are later enhancements.

### Narrow screens

```text
+---------------------------+
| Website review            |
| [Media*] [Conversation]   |
+---------------------------+
|                           |
|       IMAGE / GRID        |
|                           |
+---------------------------+
| Context: [2 selected]     |
| Ask agent...       [Send] |
+---------------------------+
```

Follow existing compact paired-view behavior. Switching panes must not change
the paired resource or the media already bound to a submitted turn.

## Virtual collection model

```text
SANE gallery                       Actual storage

Website review
  Desktop -----------------------> checkout/screens/desktop.png
  Mobile ------------------------> checkout/screens/mobile.png
  Approved baseline -------------> SANE immutable media snapshot

Product presentation
  Cover -------------------------> checkout/screens/desktop.png
```

Two galleries can reference the same asset with different labels and captions.
Reordering or deleting a gallery does not move or delete source media.

Logical IDs are not shell paths. An optional display URI such as
`sane://gallery/<id>/item/<id>` must not be presented as an OS-readable file.
Agents resolve resources through SANE tools or use separately authorized real
paths for actual file operations.

## Data model

These are conceptual contracts. Final codecs must follow the repository's strict
validation and App-store identity conventions.

```ts
type MediaSource =
  | {
      kind: "workspace-file";
      workspaceId: string;
      worktreeId: string;
      path: string; // Checkout-relative; never an arbitrary host path.
    }
  | {
      kind: "snapshot";
      snapshotId: string;
      mediaId: string;
    };

type Asset = {
  id: string;
  source: MediaSource;
};

type Gallery = {
  id: string;
  workspaceId: string;
  title: string;
  revision: number;
  defaultLayout: "grid" | "focus" | "compare";
};

type GalleryItem = {
  id: string;
  galleryId: string;
  assetId: string;
  label?: string;
  caption?: string;
  tags: string[];
  rank: string;
};

type GalleryPairTarget = {
  kind: "gallery";
  workspaceId: string;
  galleryId: string;
};
```

### Identity and revision rules

- **Gallery ID:** stable resource identity for pairing and navigation.
- **Gallery revision:** changes when membership, ordering, or metadata changes.
- **Item ID:** stable identity for an occurrence in a gallery.
- **Asset ID:** logical media reference, independent of its gallery placement.
- **Content version:** identifies the particular bytes inspected or submitted.
- **Worktree binding revision:** verifies the resolved checkout has not been
  replaced or rebound; capture and validate it at access/operation boundaries.

A file path may resolve to different bytes over time. A hash identifies content,
not reliable move/rename identity. Missing references remain visible until the
user removes or explicitly relinks them.

For the initial implementation, accept workspace-file references from the
gallery's workspace and selected registered worktree only. Keep the source's
explicit worktree ID; switching browsing or execution checkouts must never
silently retarget the reference. Broader cross-worktree curation can follow.

### Derived metadata

Resolve/cache separately from durable gallery edits:

```text
availability: available | missing | denied | unsupported
contentVersion
mimeType
dimensions
duration (when video is supported)
thumbnail/cache key
```

Do not make filesystem refreshes increment the gallery's metadata revision.
Display changed or unavailable sources clearly. Never show a cached image as if
its source version were still verified when it is not.

### Presentation state

Keep layout overrides, focused/selected item IDs, comparison selection, zoom,
pan, and scroll position device-local. They are not shared metadata edits.

Durable annotations and review decisions are later features. When added, bind
them to a content version; image-region coordinates should be independent of
viewport zoom and display size.

### Pairing and access

Keep saved conversation links in the pairing subsystem, not an `agentId` field
on Gallery. Preserve full native conversation identity checks, explicit restore
behavior, conflict detection, and the distinction between exiting a paired view
and removing its saved links.

Pairing is a passive association. Inspection and curation permissions are
separate grants, scoped to the actual admitted conversation and gallery.

## Storage and ownership

Recommended initial persistence: App-owned, versioned gallery records under the
configured App data directory, consistent with existing pairing/media ownership.
Do not place authoritative gallery state in agent-editable project files.

Use the existing atomic-record conventions where appropriate. A small gallery's
metadata can be one transaction record containing its asset references and items;
the conceptual model does not require separate database tables or a global asset
registry in the first release. Validate reference integrity within that record.

Persist a gallery operation batch atomically with an expected revision. Define
record/item/text limits and reject oversized input. Include actor/operation
attribution using existing App conventions where available.

Media bytes stay in their real source location unless explicitly frozen or
uploaded. Thumbnail caches are derived, bounded, and evictable. Removing a
reference must not garbage-collect source files or existing chat snapshots.

Snapshot references must preserve existing media-share authorization and
retention rules. Merely knowing a snapshot ID must not grant access or allow
cross-conversation exposure. Do not modify existing share provenance to make a
snapshot look newly created by the gallery.

Portable manifests can be an explicit import/export feature later. They must
not become a second competing live source of truth.

## Agent interface

Proposed tools, not currently implemented:

| Tool | Purpose |
| --- | --- |
| `gallery_get` | Read bounded metadata, items, availability, and current revision. |
| `gallery_inspect` | Resolve authorized items and provide bounded actual visual content through the harness-supported inspection path. |
| `gallery_apply` | Submit an atomic, revision-checked batch of curation operations. |
| `gallery_freeze` | Capture selected versions into immutable media using an authorized snapshot/sharing path. |

Example mutation:

```json
{
  "galleryId": "gallery-1",
  "expectedRevision": 8,
  "operations": [
    {"type": "set_caption", "itemId": "item-2", "caption": "Preferred"},
    {"type": "move_before", "itemId": "item-2", "beforeId": "item-1"}
  ]
}
```

Minimum operations: add reference, remove reference, reorder, rename gallery,
set label/caption/tags. Agents must not directly rewrite internal store JSON.
Stale revisions return a conflict; no silent last-write-wins behavior.

Inspection must return actual supported media content or a supported inspection
artifact, not just filenames and a claim that the model has seen the image.
Reuse admitted-session tool plumbing for each supported harness. An unsupported
harness must show a clear limitation rather than pretending inspection worked.

Agent generation/editing workflow:

1. Generate or edit media using existing tools and permissions.
2. Write the output to an explicit real destination.
3. Register that file in the gallery through `gallery_apply`.
4. Inspect or freeze the result when required; registration alone is not visual
   inspection and does not automatically submit it to the model.

## Permissions and turn context

Distinguish three actions:

1. **Pair:** associate conversation and gallery.
2. **Grant:** authorize gallery inspection and/or curation through SANE.
3. **Send:** bind specific media versions to an agent turn.

Suggested controls:

```text
Agent access
  [x] Inspect gallery media
  [ ] Curate items, captions, and ordering

Source-file edits use the agent's existing permissions.
```

These grants govern the SANE interface. They are not a sandbox for an agent that
already has independent shell/filesystem access.

"Ask about selection" must capture selected item IDs, resolved source identity,
and exact media versions at submission. Reuse existing immutable capture and
turn-submission conventions where possible. If capture or attachment fails, do
not send an apparently image-backed question without the images.

Record sufficient provenance to explain what the model actually received. A
later source edit, selection change, gallery edit, or navigation must not rewrite
that historical context. Enforce media-count, byte, dimension, and context-budget
limits with visible errors.

The browsing worktree and conversation execution checkout may differ. Display
that distinction and never resolve a gallery source relative to the agent's cwd
as a shortcut. Gallery access does not authorize the agent to write into that
source checkout.

## Live references and frozen media

| Mode | Promise |
| --- | --- |
| Live workspace reference | Show the current saved file, with version/availability checks. |
| Frozen snapshot reference | Show exactly the captured media. |
| Frozen chat share | Preserve the bytes and provenance of an existing conversation share. |

Freezing a selection creates immutable evidence; it does not automatically change
all live gallery references into snapshots. Offer an explicit baseline/snapshot
reference action later if needed.

Existing shared media supports PNG, JPEG, WebP, and MP4; the current workspace
image preview supports PNG, JPEG, and WebP. Start the new live gallery path with
those image formats. Treat live video as a separate extension requiring bounded
streaming/range behavior, codec handling, and lifecycle management. Reusing a
frozen video share is possible only through its existing authorized serving path.

## Security and failure behavior

- Reuse authenticated workspace reads, protected-path exclusions, real-path and
  symlink policy, and checkout-binding validation. References are not new grants
  to arbitrary host files.
- Resolve media server-side; never expose private snapshot storage paths.
- Recheck authorization and source identity around asynchronous capture/read
  boundaries. Do not serve bytes from a replaced checkout.
- Preserve existing file-format validation and bounded resource use.
- If a file disappears, retain its gallery item with Locate source / Remove
  reference actions. Explicit relinking is a revision-checked edit.
- If a source changes, show the new live version without changing old chat media.
- On stale gallery revision, return a conflict rather than overwriting edits.
- Revoke or invalidate grants when conversation identity, authorization, or
  relevant workspace bindings change.
- Restoring a saved pair must not restore active permissions implicitly.
- Do not automatically fetch arbitrary remote URLs as media sources in the MVP.

## Implementation phases

### Phase 1: Persistent gallery and live-image vertical slice

- Define strict gallery/source/item contracts and persistence limits.
- Implement App-owned atomic persistence and revision-checked operations.
- Implement authenticated create/list/read/update/delete gallery routes.
- Add Media navigation, named gallery list, Grid, and Focus.
- Add existing supported image files by reference from the selected worktree.
- Support labels/captions/tags, removal, and reordering.
- Keep presentation state separate and handle missing/denied/changed sources.
- Reuse bounded image serving/cache logic; avoid loading all originals at once.

Exit criteria: a gallery survives restart, references its original files, and
can be curated without moving or deleting those files.

### Phase 2: Gallery pairing

- Extend target codecs, keying, storage, reverse lookup, clients, and route
  handling for `kind: "gallery"`; audit browser/file-only branches.
- Integrate gallery navigation and availability with pairing/restore logic.
- Reuse paired shell, conversation picker, composer, and compact presentation.
- Preserve native identity checks and explicit grant boundaries.

Exit criteria: pairing survives switching gallery modes and reload/explicit
restore, while existing Browser/file pairing behavior remains unchanged.

### Phase 3: Agent inspection and curation

- Add admitted-session gallery tools with explicit inspection/curation grants.
- Implement bounded actual visual inspection, not metadata-only inspection.
- Route UI and agent edits through the same mutation service.
- Add revision-conflict feedback and operation attribution.
- Register generated files without changing the agent's execution checkout.

Exit criteria: an authorized paired agent can inspect selected media and curate
the gallery; a stale or ungranted operation cannot modify it through SANE.

### Phase 4: Exact turn context and frozen evidence

- Add explicit selected-media context chips and submission-time capture.
- Bind exact versions to supported model turns and persist their provenance.
- Add Freeze selection into chat through the existing immutable-media boundary.
- Support authorized snapshot references without broadening existing share ACLs.

Exit criteria: a source edit after submission does not change what the agent
received or what the historical media share displays.

### Phase 5: Comparison and polish

- Add two-image side-by-side comparison and selection-to-composer context.
- Refine keyboard interaction, focus management, loading/errors, and empty states.
- Add bounded filtering/search if needed for real gallery sizes.
- Consider frozen-video references only within existing serving constraints.

Exit criteria: two candidate images can be compared and sent with unambiguous
version-bound context on desktop and compact layouts.

## Acceptance checklist

- [ ] Creating a gallery does not create a directory of media copies.
- [ ] The same source can appear in multiple galleries with different labels.
- [ ] Reordering/removing/deleting galleries leaves original files untouched.
- [ ] Metadata persists across App restart; presentation changes do not create
      metadata revision conflicts.
- [ ] Missing, denied, unsupported, and changed sources are distinguishable.
- [ ] Worktree switching/rebinding never silently retargets a reference.
- [ ] Grid/Focus/Compare changes do not change gallery pairing identity.
- [ ] Saved pair restoration does not silently grant inspection or curation.
- [ ] Concurrent UI/agent edits cannot overwrite each other silently.
- [ ] Inspection provides actual visual content within explicit limits.
- [ ] Selected-media submission binds exact versions and fails visibly if media
      cannot be attached.
- [ ] Frozen chat media remains unchanged when originals change or disappear.
- [ ] Snapshot references do not bypass existing authorization or retention.
- [ ] Existing Browser, file, Notebook, and media-share behavior is preserved.

These criteria describe required behavior, not authorization to run checks.
Follow repository instructions: only write or run tests and perform browser
verification when explicitly requested; keep any authorized checks focused.

## Decisions to confirm before expanding scope

Recommended defaults for the first implementation:

| Question | Recommended default |
| --- | --- |
| Name | Media view; Gallery resource; Grid/Focus/Compare modes. |
| State owner | SANE App service; agents use validated tools. |
| Persistence | App data directory, not agent-editable project manifests. |
| Initial source scope | Registered selected worktree within the gallery workspace. |
| Supported live formats | PNG, JPEG, WebP. |
| Pair target | Gallery ID, not current image/selection. |
| Permission model | Separate inspect and curate grants; pairing alone grants neither. |
| Media submission | Explicit selected-media context, captured at send time. |
| Copies | Only explicit uploads/snapshots; references by default. |
| Initial delivery | Phases 1–4 for the complete paired-gallery workflow; Compare follows. |

Later extensions: external authorized source roots, cross-worktree curation,
watched folders, smart galleries, portable manifests, version-bound annotations,
review decisions, live video, overlay comparison, and pixel differences.

## Suggested SANE workstream brief

> Implement the Media Gallery View proposal in
> `docs/proposals/media-gallery-view.md`. Begin with Phase 1 and report the
> integration plan before expanding to pairing, agent tools, and turn context.
> Treat galleries as SANE-owned metadata referencing media, not filesystem
> directories or mutable chat shares. Preserve existing authorization, worktree
> identity, native conversation pairing, and immutable-media guarantees. Follow
> repository instructions; do not write/run tests or perform browser verification
> unless explicitly requested. Flag design changes and unresolved access or
> harness-attachment constraints before broadening scope.

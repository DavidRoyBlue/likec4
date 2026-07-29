# Command Center: diagram-first editing for LikeC4

**Date:** 2026-07-29
**Branch:** `command-center`
**Status:** Approved design, pre-implementation

## Goal

A command center: one `likec4 start` over a workspace containing all projects' `.c4`
files, rendering every project's architecture at a glance, where the diagram itself is a
full authoring surface — edit properties, compose views, create and delete elements,
relationships and containers — and every edit lands as a precise, comment-preserving
text edit in the correct source file, visible in that project's git diff.

The multi-project shell is configuration, not code: `likec4 start <parent-dir>` discovers
every folder holding a `.likec4rc`/`likec4.config.*` as its own project, and the
`/projects` overview page is the front door. Projects outside a shared root are reachable
via a hub folder of thin configs using `include.paths`. Zero build effort; documented as
the recommended arrangement.

## Posture

Fork-first, upstream-later. Work lands on the `command-center` branch following upstream
conventions strictly — changesets, tests, focused commits, dprint/oxlint — so any slice
(especially the sync hardening and element-property op) can become an upstream PR without
rework.

## Non-goals (v1)

- **No auth / remote deployment.** Editing exists only under the dev server on localhost.
  Static builds stay read-only (unchanged upstream behavior).
- **No renaming of existing relationships.** Relationship identity is fingerprinted on
  source+target+kind+title; renaming silently orphans cross-file `extend` blocks. Creating
  and deleting relationships is in scope; renaming is not.
- **No source-code pane.** The diagram is the interface.
- **No DSL grammar changes.** Everything v1 writes is expressible in today's language.

## Decisions log

| Decision | Choice |
|---|---|
| Posture | Fork-first, upstream-quality conventions |
| v1 edit surface | Element properties, view properties, include/exclude writer, create/delete elements + relationships + containers, wrap-existing-in-container |
| New-element file target | Children → parent's declaring file; roots → configurable `editor.newElementsFile` (default `model.c4`) |
| Delete UX | Delete key = view-scoped `exclude`; explicit gated "Delete from model…" with cascade manifest |
| Containers | Full scope including wrap-existing, via move engine |
| Move engine | Move + full-FQN reference rewrite + validate-or-rollback gate + wildcard-drift warning |
| Creation UI | Canvas-native: chooser (Node/Container/Relationship) → per-type flow |

## Architecture

One write pipeline, extended — never a second path:

```
UI gesture (toolbar / dialog / drag / delete)
  → diagram.triggerChange(ModelChange | ViewChange)      [diagram machine — exists]
  → editor actor sync queue (debounce, coalesce, undo)   [exists, op-agnostic]
  → LikeC4EditorCallbacks.handleChange                   [exists, opaque pass-through]
  → likec4:rpc updateView / NEW updateModel              [vite-plugin, birpc over HMR]
  → LikeC4ModelChanges.applyChange                       [language-server dispatcher]
  → op handler → TextEdit[] → applyTextEdits             [FileSystemProvider.writeFile
                                                          + DocumentBuilder.update]
  → reparse → recompute → relayout → HMR push → diagram re-renders
```

### Protocol

- Existing `ChangeView.Params` = `{viewId, change: ViewChange}` stays. View-scoped new ops
  join the `ViewChange` union: `include-element`, `exclude-element`.
- New `ChangeModel.Params` = `{projectId, change: ModelChange}` with a new discriminated
  union `ModelChange` in `@likec4/core` (sibling of `ViewChange`):
  `change-element-property`, `create-element`, `create-relationship`, `delete-element`,
  `move-elements`.
- One new RPC method `updateModel` in the vite-plugin protocol, mirroring `updateView`.
- Every change carries a client-generated `changeId` (ack token, see Hardening).

### Server side

One handler module per op in `packages/language-server/src/model-change/`, following the
`changeElementStyle.ts` pattern: locate the live AST via `LikeC4ModelLocator` +
`AstNodeLocator`, find-or-insert against CST ranges, emit `TextEdit[]`. All DSL printing
goes through the existing `@likec4/generators/likec4` `ops` combinators — no hand-rolled
string templates.

Shared infrastructure extracted first:

- `upsertProperty` — the find-existing-property / replace-vs-insert / indentation logic
  currently re-derived in `viewChange.ts`, `changeElementStyle.ts`, and
  `changeViewLayout.ts`, generalized over view bodies and element bodies.
- `locateElementAst(fqn, projectId)` on `LikeC4ModelLocator` — returns
  `{doc, element, elementAst}` (the missing sibling of `locateViewAst`), built from
  `getParsedElement` + `AstNodeLocator` as `locateRelation` already does.

### Client side

Features stay in their existing homes per the diagram package's layer rules. Property
editing attaches to the element toolbar and details card; creation gestures live in the
diagram machine + editor panel; the diagram package keeps zero knowledge of transport
(service-injection via `LikeC4EditorCallbacks`, which needs no signature change — it is
already generic over the change union).

## Phase 1 — Foundation hardening

Shipped before any new op; the current path has a live race (upstream issue #2975) and no
failure story.

1. **Ack tokens replace the 2-second timer.** Server includes the `changeId` in its
   response after `DocumentBuilder.update` completes; the vite-plugin tags the resulting
   HMR model push with the last-applied `changeId`. The sync queue's `waitViewSynced`
   waits for the model update carrying its token (30s fallback purely as a hang escape).
2. **Everything through the queue.** All ops — including `change-property`, which today
   sits outside the queue's synchronization gating server-side and has no client path at
   all — enter via `diagram.triggerChange` and obey the ack discipline. Kills the
   duplicate-insert race (second edit computed against pre-insert AST).
3. **Failure rollback + surfacing.** On `executeChanges.onError`: restore the pre-edit
   snapshot (reverting optimistic `updateNodeData`), raise a Mantine notification with the
   server's error text. No `console.error`-only failure paths in new code.
4. **Concurrent-writer guard.** `applyChange` asserts the document version it computed
   edits against is still current at apply time; on mismatch fails cleanly
   ("file changed underneath — retry"). Covers two tabs and IDE edits mid-op.

## Phase 2 — Property editing

### Element properties (`change-element-property`)

Title, description, technology, tags on a model element. Handler resolves the declaring
document via `locateElementAst`, then `upsertProperty` against `ast.ElementBody.props`
using `ops.props.*` printers. Grammar guarantees description/title/technology live only at
the declaration site (`extend` carries only tags/links/metadata), so the file target is
unambiguous. Tag edits write to the declaration file; when the same tag also arrives via
an `extend` elsewhere (detectable from `MergedExtends`), the UI surfaces a warning.

**UI:** the Element Details card's Properties tab becomes editable when an editor is
present — pencil per field, `Textarea` for description (markdown source; live rendered
preview stays in the card), `TextInput` for title/technology, tag chips with add/remove.
Commit on blur or Ctrl+Enter, never per keystroke. Requires relaxing
`DiagramFeatures.Overlays`: stop force-setting `enableReadOnly: true`; inherit it, forcing
read-only only when no editor is attached.

### View properties (existing `change-property`)

Backend is implemented and tested upstream with zero UI callers. Add click-to-edit popover
on the navigation panel's view title area for title/description/tags.

## Phase 3 — View composition (predicate writer)

Two ops joining `ViewChange`, both writing single lines into the view's block in the
view's own file (insertion pattern of `changeElementStyle`):

- **`include-element`** — from Search (gains an "Add to current view" action when an
  editor is present) and from the relationships browser ("include this neighbor"). Writes
  `include <fqn>` after the last existing rule. The element appears via normal recompute.
- **`exclude-element`** — the Delete key, replacing the snapshot-hide illusion (which
  today silently reverts in exports). Multi-select writes one `exclude` with a comma list.

Toggle behavior is powered by `deriveElementState` lifted from the removed adhoc-editor
(`git show 903c5e98c^`): deleting an implicitly-included element writes `exclude`;
deleting an explicitly-included one removes its `include` line instead.

## Phase 4 — Creation

### Unified entry: the creation chooser

Double-click (empty canvas or a container node) or the editor panel's "+" opens a
three-option quick-pick anchored at the click point, keyboard-first
(`N`/`C`/`R`, arrows + Enter, Esc):

```
N  ▢  Node
C  ▣  Container
R  →  Relationship
```

### Node / Container → creation dialog

Compact dialog anchored at the click point: **kind**, **title**, auto-slugged editable
**id** (identifier rules enforced: no dots, no leading digit; deduplicated within parent),
parent pre-filled from the click target (container double-clicked = parent; empty canvas
= root). The specification does not formally distinguish leaf from container kinds — any
element can nest — so the kind dropdown is grouped by observed usage: kinds that currently
have children anywhere in the model appear under "Containers", the rest under "Nodes",
full list always reachable. The chooser's Node/Container split pre-selects the matching
group but never restricts. Both paths run the same op.

**Server op `create-element`:** prints the declaration with `ops.model.element()`,
inserts via `TextEdit.insert` — into the parent's body in the parent's declaring file
(before the closing brace; adds `{ }` if the parent was braceless), or for roots into the
project's `editor.newElementsFile` (new config key, default `model.c4`; file and
`model {}` block created if absent).

**Visibility guarantee:** the op is composite — after computing whether the current view's
predicates already match the new element, it appends `include <fqn>` to the view only if
needed. One atomic change, at most two files touched.

**Placement:** position is normally decided by layout on recompute. If the view already
has a manual layout snapshot, the new node is seeded into the snapshot near the click
point, so hand-arranged views place things where asked.

### Relationship → connect mode (or drag shortcut)

Chooser path: crosshair cursor, hint bar ("pick source → pick target · Esc"), first click
sets source, rubber-band edge follows cursor, second click sets target → popover for
optional kind (from specification) and title. Invalid targets (parent↔child, self) are
dimmed and unclickable during connect mode. Drag-from-node-handle (native XYFlow
connection dragging) remains the direct shortcut into the same popover.

**Server op `create-relationship`:** inserts `-> <target-fqn> 'title'` into the source
element's body in its declaring file (adds a body if braceless), matching hand-authoring
convention. Fingerprint-safe by construction: a new relation has no extends referencing
it. The parent-child constraint is validated before writing.

## Phase 5 — Structural operations

### Delete from model (`delete-element`)

Toolbar action "Delete from model…" (Delete key stays view-scoped). Server computes a
**cascade manifest** first via the References index: the declaration (with descendants),
every relationship touching the subtree, every `extend` targeting it, every view predicate
and style rule naming it, across all files. Confirmation dialog shows the manifest
concretely ("removes 1 declaration, 3 relationships, 2 view references across 4 files")
and notes when the project has uncommitted changes. Apply is a single multi-file batch,
followed by the validate-or-rollback gate. Git is the stated safety net for this class.

### Move engine (`move-elements` — wrap existing in container)

Multi-select → "Wrap in container" on the selection toolbar → the creation dialog.
**V1 constraint: selection must be siblings** (same parent); wrapping across parents is
semantically ill-defined and out of scope.

Atomic batch:

1. Insert the new container declaration in the parent's file.
2. Move each selected declaration's text into the container body.
3. Find every cross-reference to every moved element via the References service; rewrite
   each to the new **full FQN** (always fully qualified — correct even where a short
   scoped name would also resolve).
4. Apply all edits, rebuild, **validate**: if the project's error count increased, revert
   the entire batch and surface why.
5. Diff the computed node-sets of all affected views before/after and report semantic
   drift — the honest warning for wildcard predicates (`include parent.*` is
   depth-sensitive; no reference rewrite can fix semantics): "2 views changed contents —
   review".

Note: the dormant `LikeC4RenameProvider` is not used — LSP rename changes names, not
paths. The References/index machinery underneath it is the reused part.

### Undo across disk

Inverse cost draws the line. **Property, predicate, and create ops carry trivial
inverses** (rewrite old value / remove written line / delete created range), held on a
disk-history stack in the editor actor and replayed through the same RPC on Ctrl+Z.
**Model-delete and move rely on the confirmation gate + git**; full inverse batches for
multi-file cascades buy little over `git checkout` and cost real complexity.

## Error handling conventions (all ops)

- **Atomic per invocation:** one op → one `TextEdit[]` batch → applied fully or not at
  all. Multi-file ops validate after rebuild and auto-revert on regression.
- **Every failure visible:** structured `{success:false, error}` → optimistic-state
  rollback → notification with the actual message.
- **Every op reports a `location`** (`modifiedRange` convention) so the UI can flash the
  changed region.
- **Version guard** on every apply (see Hardening #4).

## Testing

The `testDoc` memfs harness from `viewChange.spec.ts` is the workhorse: fixture `.c4` in,
op through the real `ModelChanges` dispatcher, full resulting source snapshotted.

- **Property ops:** replace-vs-insert per property, markdown descriptions, tag chains
  (mirror the view-tag edge cases for elements), extend-tag warning detection.
- **Creation:** braceless parents, missing `model {}` block, id collisions, the
  include-if-not-visible composite (assert both files).
- **Delete cascade:** manifest correctness on a multi-file fixture; rollback on induced
  validation regression.
- **Move engine:** siblings moved, references rewritten across three files, scoped short
  refs requalified, validation-gate revert path, wildcard-drift detection via view
  node-set diff.
- **Sync/ack:** integration test driving two rapid ops through the queue against a slow
  rebuild; assert no duplicate insert (the #2975 class).
- **UI:** component tests where logic lives (toggle-cycle derivation); Playwright e2e
  smoke — edit a description against a live dev server, assert file content.

## Phasing

Each phase ships usable, as focused commits with changesets and tests:

1. **Foundation** — ack tokens, queue unification, rollback + notifications,
   `upsertProperty` + `locateElementAst` extraction, version guard. Invisible, mandatory.
2. **Properties** — view-properties UI; element-property op + editable details card
   (incl. overlays read-only relaxation). First visible payoff.
3. **View composition** — include/exclude writer, Search "add to view", honest Delete.
4. **Creation** — chooser, node/container dialog, connect mode + drag, config key,
   manual-layout position seeding.
5. **Structural** — delete-from-model with cascade manifest; move engine last (depends on
   reference rewriting, validation gate, and view diffing all being proven).

## Known risks

- **Move engine is the riskiest component** — mitigated by the sibling constraint, full-FQN
  rewriting, the validation gate with atomic revert, and shipping it last.
- **Wildcard predicate semantics** cannot be preserved by any rewrite; mitigated by
  before/after view diffing surfaced to the user, never silent.
- **astPath-derived relation ids shift** when siblings are inserted/removed earlier in a
  container; all client references to relations are resolved per-model-generation, never
  persisted across edits.
- **Upstream divergence:** ~1000 commits/year on main. Mitigated by convention-strict,
  slice-shaped commits designed for later PRs, and by keeping all new server logic in new
  files (handlers) rather than spread edits.

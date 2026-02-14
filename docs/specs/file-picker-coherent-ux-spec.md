# File Picker Coherent UX Spec

Status: Draft for review  
Owner: MRMD  
Surface: `Ctrl+P` file picker (`mrmd-electron/index.html`)

## 1. Problem Statement

Current behavior is fast but not coherent enough:

- Folder discovery is unreliable from the user perspective (`attachments` expected, not visible).
- Navigation hints and actual behavior can diverge.
- Scope behavior feels inconsistent (especially moving above project root).
- "No modes" goal is correct, but query + tree navigation semantics need to be explicit and stable.

This spec defines a single coherent model that is keyboard-first, mode-less, and predictable.

## 2. Product Principles

1. One mental model, no mode toggles.
2. Folders are first-class navigation objects, not second-class search byproducts.
3. Scope is explicit and visible at all times.
4. Keyboard commands always do what hints say.
5. Query refines; arrows navigate hierarchy.
6. Deterministic ranking and section order.
7. No surprise snapping back to project root.

## 3. Mental Model

The picker always has:

- A **scope path** (absolute directory) or **global scope** (`null`).
- A **query** (free text, fuzzy, optional `/` segmentation).
- A **selected row**.

The list is "what can I do from here":

- go up (`..`)
- enter matching folders
- open matching files
- create when appropriate

No explicit "path mode" vs "fuzzy mode". It is one model.

## 4. Core Invariants (Must Always Hold)

1. If scope is set and has a parent, first section includes `..` row.
2. Folder rows are always eligible and visible in scoped browsing.
3. With non-empty query, `Folders` section appears before `Files`.
4. `Recent` section is only shown when query is empty.
5. `Backspace` on empty input goes to parent scope if possible.
6. Parent traversal is not clamped to project root.
7. Footer hints are generated from current selection/context only.
8. Enter on folder always enters folder (never opens as file).
9. Enter on `..` always goes up.
10. Query `a/b/c` means progressive segment matching.
11. Folder visibility is quota-protected (cannot be drowned by files).
12. Result ordering is stable for equal scores.

## 5. Scope Model

## 5.1 Initial Scope

On picker open:

- `scope = project.root` if available.
- else `scope = dirname(currentFile)` if available.
- else `scope = homeDir`.

## 5.2 Scope Climbing

`goUp()`:

- if `scope` is `/` -> set `scope = null` (global)
- else if `scope` is set -> `scope = parent(scope)`
- else no-op

This allows moving beyond project root naturally.

## 5.3 Scope Visibility

Context bar always shows when `scope != null`:

- `SCOPE: ~/Projects/myproj › docs › assets`
- Hint: `[← / ⇧Tab / Backspace up]`

Global scope:

- Context bar hidden or shows `SCOPE: Global` (pick one and keep it consistent).

## 6. Query Semantics

## 6.1 Empty Query

Primary use case: tree navigation.

Sections:

1. `Navigate` (`..` row if parent exists)
2. `Folders` (direct children of current scope first)
3. `Recent` (files only)
4. `Files` (if needed; can be capped)

## 6.2 Non-Empty Query

Primary use case: fuzzy narrowing.

Rules:

- Query is always fuzzy.
- If query contains `/`, split into ordered segments and match progressively through path segments.
- Folder and file candidates both participate.

Sections:

1. `Navigate` (`..` row)
2. `Folders` (all matching folders in scope; recursive)
3. `Files` (matching files in scope)
4. `Outside Scope` (only when scope exists and query is non-empty)
5. `Create` (conditional)

`Recent` is hidden when query is non-empty.

## 6.3 Progressive Segment Matching

Examples:

- `att` -> matches `attachments`, `data/attrition.md`
- `doc/att` -> folder segment matching in order
- `proj/api/ws` -> progressive path narrowing

Segmented match should prefer:

1. contiguous segment chain
2. shallower depth
3. basename match over full path-only match

## 7. Folder Visibility Guarantees

This is the key fix for "attachments not visible".

## 7.1 Folder Quota Protection

With non-empty query:

- Reserve top `N_folder = 20` slots for folder matches (if available) before file-only overflow.
- Never let file matches fully displace folder matches.

## 7.2 Ancestor Witness Rows

If a file matches query inside folder `F`, and `F` does not strongly match by itself, include `F` as a witness folder candidate when it helps navigation.

Example:

- query: `attac`
- matched file: `docs/attachments/2026-plot.png`
- ensure `attachments/` appears in `Folders`.

## 7.3 Direct Child Priority

When scope is active and query is short (`len <= 4`), direct child folders get a boost so common navigation targets appear early.

## 8. Row Types and Actions

## 8.1 `scope-up` row (`..`)

- Label: `..`
- Path text: parent scope display
- Enter: go up
- Right/Tab: no-op (or same as Enter, pick one and keep)

## 8.2 Folder row

- Enter: enter folder
- Right: enter folder
- Tab: enter folder
- Double-click: enter folder

## 8.3 File row

- Enter: open file
- Tab: complete query input with selected path (optional)
- Double-click: open

## 8.4 Create row

- Enter: create immediately
- `Cmd/Ctrl+Enter`: jump to first create row and create

## 9. Keyboard Contract

When picker is visible:

- `Up/Down`: move selection
- `Enter`: primary action for selected row
- `Right`: enter selected folder
- `Left`: go up scope (input must be empty)
- `Tab`: enter folder OR complete file
- `Shift+Tab`: go up scope
- `Backspace` on empty input: go up scope
- `Esc`: close picker
- `Cmd/Ctrl+Enter`: create shortcut

No keyboard command should depend on hidden mode state.

## 10. Footer Hint Contract

Footer is dynamic and truthful.

Examples:

- Selected `..` row: `Enter up`, `↑↓ navigate`, `Esc close`
- Selected folder: `Enter open folder`, `→/Tab enter`, `←/⇧Tab up`, `Esc close`
- Selected file: `Enter open`, `Tab complete`, `Esc close`
- Selected create: `Enter create`, `Esc close`

Hint generation must only use actual executable actions in current state.

## 11. Ranking and Sorting

Within each section:

1. exact/prefix basename matches
2. segmented fuzzy score
3. recency bonus (for files only)
4. shorter relative path (shallower)
5. lexical tiebreaker

Do not mix folder/file ranking into one undifferentiated top list in scoped mode.

## 12. Performance Constraints

Targets on 50k files:

- initial open interactive < 100ms after modal paint
- arrow navigation response < 16ms per keypress
- first preview visible < 250ms for small text files
- filter update under 30ms median in worker

Implementation expectations:

- worker filtering
- virtualized list
- non-blocking preview reads
- batched scan updates

## 13. Accessibility and Visual Clarity

- Distinct folder icon and label.
- `Outside Scope` rows visibly subdued and tagged.
- `..` row always visually obvious.
- Preview panel must never steal keyboard focus from query/list flow.

## 14. Acceptance Tests

## 14.1 Attachments Visibility

Given scope `~/Projects/myproj`, folder `~/Projects/myproj/attachments`, query `attac`:

- `Folders` section includes `attachments` within first visible page.

## 14.2 Scoped Tree Browse

Given empty query and scope `~/Projects/myproj/docs`:

- top row is `..` to `~/Projects/myproj`
- `Folders` section lists direct child folders

## 14.3 Beyond Project Root

From scope `~/Projects/myproj`:

- `Backspace` on empty -> `~/Projects`
- `Backspace` again -> `~/`
- `Backspace` again -> global (`null`) or stays `/` (decide and keep consistent)

## 14.4 No False Hints

For every selectable row type, footer hints must map 1:1 to available actions.

## 14.5 Determinism

Same scope + query + index snapshot returns same ordering.

## 15. Implementation Notes (Suggested)

1. Keep the current worker + virtualization architecture.
2. Refactor candidate pipeline into explicit phases:
   - collect
   - classify (`inScope`, `outside`, `folder`, `file`, `witness`)
   - score
   - section
   - quota trim
3. Add debug toggle to print section counts and folder quota usage.
4. Add unit-like tests for matching and section assembly.

## 16. Explicit Decisions Needed Before Final Build

1. Global terminal behavior: when scope reaches `/`, go `null` global or stay at `/`.
2. In global scope, whether to show context bar as `Global` or hide it.
3. Whether `Tab` on files should complete path or do nothing.
4. Exact folder quota number (`20` proposed).

---

This spec is intentionally strict so behavior is coherent and reviewable.  
If approved, implementation should be done against these invariants first, then micro-polish.

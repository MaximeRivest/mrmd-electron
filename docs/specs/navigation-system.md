# Navigation System Specification

> Focus by default. Context on demand. The nav is not a cage — it's a map you pull out when needed.

---

## 1. Overview

### 1.1 Philosophy

The navigation system has three layers:

| Layer | Purpose | Always Visible? | Primary Access |
|-------|---------|-----------------|----------------|
| **Breadcrumbs** | Know where you are | Yes | Click to navigate up |
| **Quick Switcher** | Jump to any file | No (overlay) | `Ctrl+P` |
| **Nav Panel** | See & manipulate structure | Context-dependent | `Ctrl+1` |

These layers work together to provide **peace when writing** and **power when navigating**.

### 1.2 Component Map

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│  thesis / 04-experiments / experiment-1.md                      [≡] [⚙]    │ ← BREADCRUMBS
├─────────────┬───────────────────────────────────────────────────┬───────────┤
│             │                                                   │           │
│  NAV PANEL  │                 DOCUMENT EDITOR                   │    TOC    │
│             │                                                   │           │
│  (optional) │                   (primary)                       │  (auto)   │
│             │                                                   │           │
└─────────────┴───────────────────────────────────────────────────┴───────────┘

                              QUICK SWITCHER
                    ┌─────────────────────────────────┐
                    │  > search files...              │  ← OVERLAY (Ctrl+P)
                    │  ────────────────────────────── │
                    │  📄 experiment-1.md             │
                    │  📄 experiment-2.md             │
                    └─────────────────────────────────┘
```

### 1.3 Design Principles

1. **The document is primary** — navigation serves the writing, not the other way around
2. **Rendered until activated** — all components follow this pattern
3. **Keyboard-first, mouse-friendly** — full keyboard control, but mouse always works
4. **Context-aware defaults** — opening a file vs folder vs workspace changes behavior
5. **Escape to the OS** — heavy file management can happen in Finder/Explorer

---

## 2. Breadcrumbs

### 2.1 Purpose

Always-visible orientation. Minimal footprint. Shows your location in the project hierarchy.

### 2.2 Visual Design

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│  thesis / 04-experiments / experiment-1.md                      [≡] [⚙]    │
└─────────────────────────────────────────────────────────────────────────────┘
    ↑           ↑                ↑                                  ↑    ↑
    │           │                │                                  │    └─ Settings
    │           │                │                                  └─ Toggle nav panel
    │           │                └─ Current file (not clickable)
    │           └─ Parent folder (clickable)
    └─ Project root (clickable)
```

### 2.3 Elements

| Element | Appearance | Click | Hover |
|---------|------------|-------|-------|
| Project root | Project name | Opens nav at root | Shows full path |
| Folder segment | Folder name (clean) | Opens nav at folder | Shows siblings dropdown |
| Current file | File title (clean) | No action | Shows full filename |
| `[≡]` button | Hamburger icon | Toggles nav panel | "Toggle navigation (Ctrl+1)" |
| `[⚙]` button | Gear icon | Opens settings | "Settings" |

### 2.4 Siblings Dropdown

Hovering on a folder segment shows siblings after 300ms delay:

```output
  thesis / 04-experiments / experiment-1.md
                  │
                  ▼
          ┌─────────────────────┐
          │ 03-methods          │
          │ 04-experiments    ◀ │  ← current
          │ 05-results          │
          │ 06-conclusion       │
          └─────────────────────┘
```

- Click a sibling to navigate there
- Dropdown disappears on mouse leave
- Keyboard: `Alt+↑` focuses breadcrumbs, then `←`/`→` to navigate

### 2.5 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+↑` | Go to parent folder (open its index.md or first file) |
| `Alt+↑` | Focus breadcrumbs for keyboard navigation |
| `←` / `→` (when focused) | Move between segments |
| `Enter` (when focused) | Open selected segment in nav |
| `Escape` | Return focus to document |

---

## 3. Quick Switcher

### 3.1 Purpose

Fast file navigation without seeing the full tree. The primary way to switch files during focused work.

### 3.2 Activation

| Signal | Context |
|--------|---------|
| `Ctrl+P` | Anytime (primary) |
| `Ctrl+K` | Anytime (alternative) |
| `/` | When nav panel is closed |

### 3.3 Visual Design

```output
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                  ┌───────────────────────────────────┐          │
│                  │  > exp█                           │          │
│                  ├───────────────────────────────────┤          │
│                  │  📄 04-experiments/experiment-1.md│ ← selected│
│                  │  📄 04-experiments/experiment-2.md│          │
│                  │  📄 03-methods/experimental.md    │          │
│                  │  📁 04-experiments/               │          │
│                  ├───────────────────────────────────┤          │
│                  │  ↵ open  ⇧↵ split  esc close     │          │
│                  └───────────────────────────────────┘          │
│                                                                 │
│                         (backdrop dimmed)                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 Behavior

| Input | Result |
|-------|--------|
| Type text | Fuzzy filter files and folders |
| `↓` / `↑` | Move selection |
| `Enter` | Open file, close switcher |
| `Shift+Enter` | Open in split pane |
| `Ctrl+Enter` | Open and keep switcher open |
| `Tab` | Autocomplete to selected path |
| `Escape` | Close switcher |

### 3.5 Fuzzy Matching

- `exp1` → matches `experiment-1.md`
- `meth algo` → matches `methods/algorithm.md`
- `04/exp` → matches files in `04-experiments/`
- Scoring: filename matches rank higher than path matches

### 3.6 Result Types

```output
│  📄 experiment-1.md              │  ← file (opens it)
│  📁 04-experiments/              │  ← folder (opens index.md or reveals in nav)
│  # Setup                         │  ← heading in current file (scrolls to it)
│  ⏱ thesis.md                     │  ← recent file (shown when query empty)
```

### 3.7 Empty State

When query is empty, show:
1. Recently opened files (last 10)
2. Frequently opened files
3. Current file's siblings

---

## 4. Nav Panel

### 4.1 Purpose

Full project structure visibility and file manipulation. The "power mode" for navigation.

### 4.2 Visibility Rules

| Context | Default Visibility | Rationale |
|---------|-------------------|-----------|
| Open a **file** directly | Hidden | Focus on writing |
| Open a **folder** | Visible | Project mode |
| Open a **workspace** | Visible | Orchestration mode |
| User toggled manually | Remembers per-project | User preference wins |

### 4.3 Two Internal States

The nav panel has two modes: **Passive** and **Active**.

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   PASSIVE STATE                          ACTIVE STATE                       │
│   (Reader View)                          (Manipulation View)                │
│                                                                             │
│   ┌───────────────────┐                  ┌───────────────────────┐          │
│   │                   │                  │ ▎                 [+] │          │
│   │ Getting Started   │    ──────────►   ├───────────────────────│          │
│   │   Introduction    │    Ctrl+1 or     │ ▌02-getting-started/▾ │          │
│   │   Installation  ◀ │    Double-click  │ │ ├─ index.md         │          │
│   │   Quick Start     │                  │ │ ├─ installation.md◀ │          │
│   │                   │    ◄──────────   │ │ └─ quickstart.md    │          │
│   │ Tutorials         │    Escape or     │                       │          │
│   │   Basic Usage     │    Click away    │   03-tutorials/     ▸ │          │
│   │                   │                  │ ◦ _lib/              ▸ │          │
│   └───────────────────┘                  └───────────────────────┘          │
│                                                                             │
│   • Clean labels                         • File extensions visible          │
│   • No extensions                        • Selection cursor visible         │
│   • Click navigates                      • Keyboard actions work            │
│   • Technical files hidden               • Technical files dimmed           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Nav Panel: Passive State

### 5.1 Purpose

Show project structure as a reader would see it. Non-distracting. Orientation only.

### 5.2 Visual Characteristics

| Element | Appearance |
|---------|------------|
| Labels | Clean titles (from heading/frontmatter/filename) |
| Extensions | Hidden |
| Numeric prefixes | Hidden (`01-intro.md` → "Introduction") |
| Technical folders | Hidden (`_lib/`, `_data/`) |
| Current page | Highlighted background |
| Hover state | Subtle highlight |
| Affordances | None (no drag handles, no checkboxes, no buttons) |

### 5.3 Example

```output
Getting Started
  Introduction
  Installation              ◀ current page
  Quick Start

Tutorials
  Basic Usage
  Advanced Topics

API Reference
  Overview
  Endpoints
```

### 5.4 Behavior

| Action | Result |
|--------|--------|
| Click item | Navigate to that page |
| Click folder label | Expand/collapse |
| Scroll | Passive scroll, no selection |
| Any keyboard | No effect (focus stays in document) |
| Right-click | No context menu |
| Drag | No drag behavior |

### 5.5 Label Derivation

Labels are derived in this priority:

1. **Frontmatter `title`** field
2. **First `# heading`** in document
3. **Filename**, cleaned:
   - Remove numeric prefix: `01-` → (empty)
   - Remove extension: `.md` → (empty)
   - Convert dashes to spaces: `getting-started` → `getting started`
   - Title case: `getting started` → `Getting Started`

---

## 6. Nav Panel: Active State

### 6.1 Purpose

Full file management. Create, rename, move, delete, reorder. Power-user mode.

### 6.2 Activation

| Signal | Context | Notes |
|--------|---------|-------|
| `Ctrl+1` | When nav is visible (passive) | Primary toggle |
| `Ctrl+B` | Anytime | Alternative (mnemonic: "browse") |
| `Escape` | In document, nothing to escape | Falls through to nav |
| Double-click | On nav item (passive state) | Activates with that item selected |

### 6.3 Deactivation

| Signal | Result |
|--------|--------|
| `Escape` | Return to document, restore cursor position |
| `Enter` on file | Open file, return to document |
| Click in document area | Return to document |
| `Ctrl+1` | Toggle back to passive |

### 6.4 Visual Characteristics

| Element | Appearance |
|---------|------------|
| Toolbar | Appears at top with `[+]` button |
| Selection cursor | Vertical bar (`▌`) or background highlight |
| Extensions | Visible (`.md`, `.py`, `.js`) |
| Numeric prefixes | Visible (`01-`, `02-`) |
| Technical folders | Visible but dimmed (50% opacity) |
| Command hints | Optional bar at bottom |
| Background | Subtle tint shift (~5% darker) |

### 6.5 Example

```output
▎                                    [+]
────────────────────────────────────────
▌02-getting-started/               ▾
│ ├─ index.md
│ ├─ installation.md               ◀ selected
│ └─ quickstart.md

  03-tutorials/                    ▸

  04-api/                          ▸

◦ _lib/                            ▸
◦ _data/                           ▸
────────────────────────────────────────
a:new  r:rename  d:delete  ?:help
```

### 6.6 Toolbar

```output
▎  [+] ▾                         [⋮]
       │                           │
       │                           └─ More actions (Import, Reveal in Finder...)
       └─ Dropdown: New File, New Folder
```

---

## 7. Nav Panel: Keyboard Language

Full vim-inspired bindings when nav is in active state.

### 7.1 Navigation

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `l` / `→` | Expand folder / Enter folder |
| `h` / `←` | Collapse folder / Go to parent |
| `g` `g` | Jump to top |
| `G` | Jump to bottom |
| `{` / `}` | Jump to prev/next sibling folder |
| `z` `z` | Center selection in viewport |

### 7.2 Opening Files

| Key | Action |
|-----|--------|
| `Enter` | Open file, exit nav mode |
| `o` | Open file, stay in nav mode |
| `Ctrl+Enter` | Open in split pane |

### 7.3 Creating

| Key | Action |
|-----|--------|
| `a` | New file (sibling) |
| `A` | New folder |
| `O` | New file and open immediately |

**Inline creation flow:**

```output
│ ├─ installation.md               │
│ ├─ ┃untitled┃.md                 │  ← name selected, editable
│ └─ quickstart.md                 │
```

- Default name: `untitled.md` (or `untitled-1.md` if exists)
- Name is pre-selected for immediate typing
- `Enter` creates file
- `Escape` cancels (no file created)
- Type `foldername/` (ending with `/`) to create folder instead

### 7.4 Renaming

| Key | Action |
|-----|--------|
| `r` / `F2` | Rename inline |

**Inline rename flow:**

```output
│ ├─ ┃installation┃.md             │  ← name selected (not extension)
```

- Name (without extension) is pre-selected
- `Enter` confirms
- `Escape` cancels
- Changing extension prompts: "Change from .md to .txt?"

### 7.5 Deleting

| Key | Action |
|-----|--------|
| `d` / `Delete` | Delete with confirmation |
| `d` `d` | Delete without moving selection |

**Confirmation dialog:**

```output
┌─────────────────────────────────────┐
│  Delete "installation.md"?          │
│                                     │
│       [ Cancel ]  [ Delete ]        │
└─────────────────────────────────────┘
```

For folders: "Delete folder and 5 items inside?"

### 7.6 Clipboard Operations

| Key | Action |
|-----|--------|
| `y` `y` | Copy (yank) |
| `x` `x` | Cut |
| `p` | Paste after selection |
| `P` | Paste before selection |
| `D` | Duplicate in place |

### 7.7 Multi-Selection

| Key | Action |
|-----|--------|
| `Space` | Toggle mark on current item |
| `V` | Enter visual (range) select mode |
| `Shift+↓/↑` | Extend selection |
| `*` | Select all siblings |
| `u` | Clear all marks |

**Visual feedback:**

```output
│ ├─ ✓ index.md                    │  ← marked
│ ├─   installation.md             │  ← current selection (unmarked)
│ └─ ✓ quickstart.md               │  ← marked
│                                  │
│  2 selected                      │
```

When multiple items are selected, actions (delete, move, copy) apply to all.

### 7.8 Reordering

| Key | Action |
|-----|--------|
| `K` / `Ctrl+↑` | Move item up |
| `J` / `Ctrl+↓` | Move item down |
| `Ctrl+Shift+↑` | Move to top of folder |
| `Ctrl+Shift+↓` | Move to bottom of folder |

**Auto-renaming with numeric prefixes:**

Moving `02-setup.md` above `01-intro.md`:
- `02-setup.md` → `01-setup.md`
- `01-intro.md` → `02-intro.md`

### 7.9 Filtering

| Key | Action |
|-----|--------|
| `/` | Open filter input |
| `n` | Next match |
| `N` | Previous match |
| `Escape` | Clear filter, show all |

**Filter UI:**

```output
▎  / install█
────────────────────────────────────
  02-getting-started/
    └─ installation.md             ◀ match
  05-advanced/
    └─ install-from-source.md      ◀ match

  2 matches
```

- Non-matching items hidden (or dimmed, per setting)
- Fuzzy matching: `inst` matches `installation`
- `Enter` opens match and clears filter

### 7.10 Meta Commands

| Key | Action |
|-----|--------|
| `?` | Toggle command hints bar |
| `:` | Open command palette (nav-scoped) |
| `.` | Repeat last action |
| `Ctrl+z` | Undo last nav operation |
| `Ctrl+Shift+z` | Redo |

---

## 8. Nav Panel: Mouse Interactions

### 8.1 In Passive State

| Action | Result |
|--------|--------|
| Click | Navigate to page |
| Hover | Subtle highlight |
| Right-click | No action |
| Drag | No action |

### 8.2 In Active State

| Action | Result |
|--------|--------|
| Click | Select item |
| Double-click | Open item |
| Right-click | Context menu |
| Click + drag | Begin move operation |
| `Alt+drag` | Copy instead of move |

### 8.3 Drag and Drop

**Visual feedback during drag:**

```output
│ ├─ index.md                      │
│ ╞════════════════════════════════│  ← drop indicator line
│ ├─ installation.md    ◊────────┐ │  ← ghost of dragged item
│ ├─ quickstart.md               │ │
│                                │ │
│                       [moving] ┘ │
```

**Drop targets:**
- **Between items** → reorder
- **On folder** → move into folder
- **On folder edge** → insert at specific position in folder

### 8.4 Context Menu

```output
┌─────────────────────────┐
│  Open                   │
│  Open in Split          │
│  ──────────────────     │
│  Rename            F2   │
│  Duplicate         D    │
│  Delete            Del  │
│  ──────────────────     │
│  Copy Path              │
│  Reveal in Finder       │
└─────────────────────────┘
```

---

## 9. Visual Transitions

### 9.1 Timing

| Transition | Duration | Easing |
|------------|----------|--------|
| Panel show/hide | 150ms | ease-out |
| State change (passive↔active) | 100-150ms | ease-out |
| Selection movement | 50ms | ease |
| Scroll into view | 100ms | ease |
| Item expand/collapse | 100ms | ease |

### 9.2 Passive → Active Sequence

1. Selection bar fades in on current item (opacity 0→1)
2. File extensions fade in (opacity 0→1, slight slide right)
3. Toolbar slides down from top (height 0→32px)
4. Background tint appears (~5% darker overlay)
5. Technical folders fade in (opacity 0→50%)
6. Command hints slide up from bottom (if enabled)

### 9.3 Active → Passive Sequence

Reverse of above. Selection bar fades out last.

### 9.4 Reduced Motion

If `prefers-reduced-motion` is set: all transitions become instant (0ms duration).

---

## 10. File Organization Display

### 10.1 Sort Order

Files display in this order:

1. **Numeric prefix**: `01-`, `02-`, etc. (ascending)
2. **Alphabetical**: if no numeric prefix
3. **Interleaved**: folders and files sort together by their position

### 10.2 Technical File Visibility

| Pattern | Passive State | Active State |
|---------|---------------|--------------|
| `*.md` | Visible | Visible |
| `_folder/` | Hidden | Visible, dimmed (50%) |
| `.folder/` | Hidden | Hidden (unless setting) |
| `*.py`, `*.js`, etc. | Hidden | Visible, dimmed (50%) |
| `mrmd.yaml` | Hidden | Visible, dimmed (50%) |
| `node_modules/`, `.git/` | Hidden | Hidden always |

### 10.3 Dimming Style

Dimmed items:
- 50% opacity
- No hover highlight in passive state
- Normal hover in active state
- Still fully interactive in active state

---

## 11. Workspace Support

### 11.1 Detection

Workspaces are detected when `mrmd-workspace.yaml` exists at project root.

### 11.2 Unified View

```output
▎ THESIS                           ▾
├─ Introduction
├─ Methods
├─ Experiments
└─ Results

▸ LIBRARIES ────────────────────────  ← collapsed
   dataprep
   viztools
   statskit

▸ NOTEBOOKS ────────────────────────
```

### 11.3 Section Behavior

| Action | Result |
|--------|--------|
| Click section header | Expand/collapse |
| `l`/`→` on collapsed | Expand |
| `h`/`←` on expanded | Collapse |
| `Enter` on section | Expand and select first item |

### 11.4 Project Switcher

`Ctrl+Shift+P` or clicking workspace name:

```output
┌─────────────────────────────────┐
│  Switch Project                 │
├─────────────────────────────────┤
│  📖 Thesis (paper/)           ◀ │  ← current
│  📚 dataprep docs               │
│  📚 viztools docs               │
│  📚 statskit docs               │
│  🧪 Notebooks                   │
└─────────────────────────────────┘
```

---

## 12. Undo/Redo

### 12.1 Undoable Operations

| Operation | Undo Behavior |
|-----------|---------------|
| Create | Delete permanently |
| Delete | Restore from memory |
| Rename | Rename back |
| Move | Move back |
| Reorder | Reorder back |

### 12.2 Scope

- Undo stack is **per-session**
- Deleted files held in memory until app closes
- After restart, deleted files are not recoverable
- Undo stack limit: 100 operations

### 12.3 Feedback

```output
┌─────────────────────────────────┐
│  ↩ Restored: installation.md    │  ← toast, auto-dismiss 3s
└─────────────────────────────────┘
```

---

## 13. Accessibility

| Feature | Implementation |
|---------|----------------|
| Keyboard navigation | All actions have keyboard equivalents |
| Focus indicator | Visible selection bar, high contrast |
| Screen reader | "installation.md, file, 2 of 5 in Getting Started" |
| High contrast mode | Selection bar uses solid color, not transparency |
| Reduced motion | All transitions instant (0ms) |
| Focus trap | When nav active, Tab cycles within nav |
| ARIA labels | All interactive elements labeled |

---

## 14. Settings

```yaml
nav:
  # Visibility
  default_visibility: "auto"      # "auto" | "visible" | "hidden"
                                  # auto: hidden for file, visible for folder/workspace

  # Activation
  activation_key: "ctrl+1"        # or "ctrl+b"

  # Display
  show_extensions: "active"       # "always" | "never" | "active"
  show_technical: "dimmed"        # "hidden" | "dimmed" | "normal"
  show_hints: true                # command hint bar at bottom

  # Behavior
  vim_keys: true                  # j/k/h/l navigation
  confirm_delete: true            # show confirmation dialog
  auto_reveal: true               # reveal current file on document open

  # Animation
  animation_duration: 100         # ms, 0 to disable

  # Filter
  filter_mode: "fuzzy"            # "fuzzy" | "exact" | "regex"
```

---

## 15. Complete Interaction Map

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  USER INTENT                  ACTION                    COMPONENT           │
│  ────────────────────────────────────────────────────────────────────────   │
│                                                                             │
│  "Where am I?"                Look at top bar           Breadcrumbs         │
│                                                                             │
│  "Go to parent folder"        Click breadcrumb          Breadcrumbs         │
│                               or Ctrl+↑                                     │
│                                                                             │
│  "See sibling files"          Hover on breadcrumb       Breadcrumbs         │
│                                                                             │
│  "Jump to specific file"      Ctrl+P, type name         Quick Switcher      │
│                                                                             │
│  "See project structure"      Ctrl+1 (if hidden)        Nav Panel (passive) │
│                               or click [≡]                                  │
│                                                                             │
│  "Reorganize files"           Ctrl+1 again (or          Nav Panel (active)  │
│                               double-click in nav)                          │
│                                                                             │
│  "Create new file"            In active nav: 'a'        Nav Panel (active)  │
│                               or click [+]                                  │
│                                                                             │
│  "Rename/delete file"         In active nav: r/d        Nav Panel (active)  │
│                                                                             │
│  "Heavy file management"      Right-click →             OS Filesystem       │
│                               "Reveal in Finder"                            │
│                                                                             │
│  "Return to writing"          Escape (anywhere)         Document Editor     │
│                               or click in document                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 16. State Machine

```output
                                    ┌─────────────────┐
                                    │                 │
                         ┌──────────│  Document Focus │◄─────────────┐
                         │          │  (default)      │              │
                         │          └────────┬────────┘              │
                         │                   │                       │
                    Ctrl+P             Ctrl+1 or [≡]            Escape
                         │                   │                       │
                         ▼                   ▼                       │
              ┌─────────────────┐   ┌─────────────────┐              │
              │                 │   │                 │              │
              │ Quick Switcher  │   │  Nav Passive    │──────────────┤
              │    (overlay)    │   │                 │   Escape     │
              └────────┬────────┘   └────────┬────────┘              │
                       │                     │                       │
                  Enter│               Ctrl+1│or dbl-click           │
                   (open)                    │                       │
                       │                     ▼                       │
                       │            ┌─────────────────┐              │
                       │            │                 │              │
                       └───────────►│   Nav Active    │──────────────┘
                                    │                 │   Escape or
                                    └─────────────────┘   Enter (open)
```

---

## 17. Implementation Checklist

### 17.1 Breadcrumbs
- [ ] Render path segments from project root
- [ ] Click segment → reveal in nav
- [ ] Hover segment → show siblings dropdown (300ms delay)
- [ ] `[≡]` button toggles nav panel visibility
- [ ] `[⚙]` button opens settings
- [ ] `Ctrl+↑` navigates to parent

### 17.2 Quick Switcher
- [ ] `Ctrl+P` opens modal overlay
- [ ] Fuzzy search across all project files
- [ ] Show icons (file/folder), paths, recent indicators
- [ ] `Enter` opens and closes, `Escape` just closes
- [ ] Show headings within current file as results
- [ ] Empty state shows recent files

### 17.3 Nav Panel - Structure
- [ ] Toggle visibility with `Ctrl+1` or `[≡]`
- [ ] Remember visibility per-project
- [ ] Context-aware default (file→hidden, folder→visible)

### 17.4 Nav Panel - Passive State
- [ ] Render clean labels (title/heading/filename)
- [ ] Hide extensions, numeric prefixes, technical files
- [ ] Click navigates to page
- [ ] Highlight current page
- [ ] No keyboard capture

### 17.5 Nav Panel - Active State
- [ ] Selection cursor visible and styled
- [ ] Show extensions and prefixes
- [ ] Dim technical files (50% opacity)
- [ ] Toolbar with [+] button
- [ ] Optional command hints bar
- [ ] All keyboard commands functional (see §7)
- [ ] Drag and drop with visual feedback
- [ ] Context menu on right-click

### 17.6 Transitions
- [ ] 100-150ms state transitions with easing
- [ ] 50ms selection movement
- [ ] Respect `prefers-reduced-motion`

### 17.7 Undo/Redo
- [ ] Track create, delete, rename, move, reorder
- [ ] Store deleted files in memory
- [ ] Show toast notification on undo
- [ ] `Ctrl+Z` / `Ctrl+Shift+Z` bindings

### 17.8 Workspace Support
- [ ] Detect `mrmd-workspace.yaml`
- [ ] Render sections for each project
- [ ] Collapsible section headers
- [ ] Project switcher overlay (`Ctrl+Shift+P`)

### 17.9 Settings
- [ ] All settings from §14 configurable
- [ ] Persist settings per-project and globally
- [ ] Live preview for animation changes

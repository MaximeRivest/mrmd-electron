# Left Navigation Panel Specification

> The nav is a modal interface: beautiful by default, powerful on demand, keyboard-first always.

## Core Principle

The left nav follows the same rendering logic as the document editor: **rendered until activated, then manipulable**. When passive, it looks like a polished documentation sidebar. When active, it becomes a full-powered file manager.

---

## Two States

### Passive State (Reader View)

The default state. The nav presents content as a reader would see it on a documentation site.

**Visual characteristics:**
- Clean typography, no visual noise
- Titles derived from `# heading`, frontmatter `title`, or filename (in that priority)
- No file extensions visible
- No manipulation affordances (drag handles, checkboxes)
- Folders appear as expandable sections with labels
- Current page highlighted
- Hover shows subtle highlight on items
- Technical folders (`_lib/`, `_data/`) hidden entirely

**Behavior:**
- Single click navigates to that page
- Scroll is passive (no selection cursor)
- Keyboard has no effect (focus is in document)

**Example:**
```
Getting Started
  Introduction
  Installation          ← current page, highlighted
  Quick Start

Tutorials
  Basic Usage
  Advanced Topics

API Reference
```

### Active State (Manipulation View)

Entered via signal. The nav transforms into a (optionally) keyboard-driven file manager. optionally means that it is fully keyboard drivable but mouse is also always an appropriate option for those not used to the keyboard (yet).

**Visual characteristics:**
- Visible selection cursor (vertical bar or background highlight)
- File extensions visible (`.md`, `.py`, etc.)
- Numeric prefixes visible (`01-`, `02-`)
- Technical folders visible but dimmed (`_lib/`, `_data/`)
- Folder expand/collapse chevrons visible
- Optional command hint bar at bottom
- Subtle background tint shift (~5% darker or whatever is best to match users' selected theme) to indicate mode
- Thin toolbar appears at top with [+] button

**Behavior:**
- Full keyboard navigation (see Keyboard Language below)
- Selection follows keyboard/mouse
- Actions available on selected item(s)
- Multi-select supported
- Drag-and-drop enabled

**Example:**
```
▎                                    [+]
────────────────────────────────────────
▌02-getting-started/               ▾
│ ├─ index.md
│ ├─ installation.md               ← selected
│ └─ quickstart.md

  03-tutorials/                    ▸

  04-api/                          ▸

◦ _lib/                            ▸
◦ _data/                           ▸
────────────────────────────────────────
a:new  r:rename  d:delete  ?:help
```

---

## Activation Signals

### Entering Active State

| Signal | Context | Notes |
|--------|---------|-------|
| `Ctrl+1` | Anytime | Primary hotkey, always works |
| `Ctrl+B` | Anytime | Alternative (mnemonic: "browse") |
| `Escape` | In document, nothing to escape | Falls through to nav |
| Double-click | On nav item | Activates with item selected |

### Exiting Active State

| Signal | Behavior |
|--------|----------|
| `Escape` | Return to document, restore cursor position |
| `Enter` on file | Open file, exit nav mode |
| Click in document area | Exit nav mode |
| `Ctrl+1` | Toggle off |

---

## Keyboard Language

When nav is active, it becomes a modal interface with vim-inspired bindings.

### Navigation

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

### Opening

| Key | Action |
|-----|--------|
| `Enter` | Open file and exit nav mode |
| `o` | Open file, stay in nav mode |
| `Ctrl+Enter` | Open in split/new pane |

### Creating

| Key | Action |
|-----|--------|
| `a` | New file (sibling, inline rename) |
| `A` | New folder (inline rename) |
| `O` | New file and open immediately |

When creating:
- New item appears at selection point
- Name field is immediately editable
- Default: `untitled.md` (or `untitled-1.md` if exists)
- Type name ending with `/` to create folder instead
- `Enter` confirms, `Escape` cancels (no file created)

### Renaming

| Key | Action |
|-----|--------|
| `r` / `F2` | Rename (inline) |

When renaming:
- Filename becomes editable input
- Name (without extension) is pre-selected
- `Enter` confirms, `Escape` cancels
- Changing extension prompts confirmation

### Deleting

| Key | Action |
|-----|--------|
| `d` / `Delete` | Delete (with confirmation) |
| `d` `d` | Delete without moving selection |

Confirmation appears inline or as modal for folders with children.

### Clipboard

| Key | Action |
|-----|--------|
| `y` `y` | Yank (copy) |
| `x` `x` | Cut (mark for move) |
| `p` | Paste after selection |
| `P` | Paste before selection |
| `D` | Duplicate in place |

### Selection

| Key | Action |
|-----|--------|
| `Space` | Toggle mark on current item |
| `V` | Enter visual (range) select mode |
| `Shift+↓/↑` | Extend selection |
| `*` | Select all siblings |
| `u` | Clear all marks |

When multiple items selected, actions apply to all.

### Reordering

| Key | Action |
|-----|--------|
| `K` / `Ctrl+↑` | Move item up |
| `J` / `Ctrl+↓` | Move item down |
| `Ctrl+Shift+↑` | Move to top of folder |
| `Ctrl+Shift+↓` | Move to bottom of folder |

Reordering auto-renames files with numeric prefixes:
- `01-intro.md`, `02-setup.md` → move `02` above `01` → renames to `01-setup.md`, `02-intro.md`

### Filtering

| Key | Action |
|-----|--------|
| `/` | Open filter input |
| `n` | Next match |
| `N` | Previous match |
| `Escape` | Clear filter, show all |

Filter behavior:
- Non-matching items hidden (or dimmed, per user preference)
- Fuzzy matching: `inst` matches `installation`
- `Enter` on match opens file and clears filter

### Meta

| Key | Action |
|-----|--------|
| `?` | Toggle command hints bar |
| `:` | Open command palette (nav-scoped) |
| `.` | Repeat last action |
| `Ctrl+z` | Undo last nav operation |
| `Ctrl+Shift+z` | Redo |

---

## Visual Transitions

Transition between states: **100-150ms duration**, interruptible.

### Passive → Active

1. Selection bar fades in (opacity 0→1) on current/first item
2. File extensions fade in (opacity 0→1, slight slide)
3. Toolbar slides down from top (height 0→32px)
4. Background tint shifts (subtle, ~5% opacity overlay)
5. Technical folders fade in (opacity 0→0.5)
6. Command hints slide up from bottom (if enabled)

### Active → Passive

Reverse of above. Selection bar fades out last.

### Selection Movement

- Selection bar slides smoothly (not instant jump)
- ~50ms transition
- Items scroll into view with ~100ms ease

---

## Mouse Interactions

Even with keyboard-first design, mouse must work intuitively.

### In Passive State

| Action | Result |
|--------|--------|
| Click | Navigate to page |
| Hover | Subtle highlight |

### In Active State

| Action | Result |
|--------|--------|
| Click | Select item |
| Double-click | Open item |
| Click + hold | Begin drag |
| Drag to folder | Move into folder |
| Drag between items | Reorder |
| `Alt+drag` | Copy instead of move |
| Right-click | Context menu |

### Drag Visual Feedback

```
│ ├─ index.md                      │
│ ╞════════════════════════════════│  ← insertion indicator
│ ├─ installation.md    ◊────────┐ │  ← ghost of dragged item
│ ├─ quickstart.md               │ │
                                 │
                        [moving] │
                                 ┘
```

---

## Workspace Support

When the project has `mrmd-workspace.yaml`, the nav shows multiple projects.

### Unified View

```
▎ THESIS
├─ Introduction
├─ Methods
└─ Results                       ▾

▸ LIBRARIES ──────────────────────  ← collapsed section
   dataprep
   viztools
   statskit

▸ NOTEBOOKS ──────────────────────
```

Sections are collapsible. Click section header or press `l`/`→` to expand.

### Project Switcher

`Ctrl+Shift+P` or clicking workspace name opens project picker:

```
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

## File Organization Display

### Ordering

Files display in this order:
1. Numeric prefix: `01-`, `02-`, etc.
2. Alphabetical if no prefix
3. Folders and files interleaved by their sort position

### Labels

In passive state, labels are derived (priority order):
1. Frontmatter `title` field
2. First `# heading` in document
3. Filename without prefix and extension (`01-getting-started.md` → "Getting Started")

In active state, actual filenames shown.

### Technical Files

| Pattern | Passive | Active |
|---------|---------|--------|
| `_folder/` | Hidden | Visible, dimmed |
| `.folder/` | Hidden | Hidden (unless "show dotfiles" enabled) |
| `*.md` | Visible | Visible |
| `*.py`, `*.js`, etc. | Hidden | Visible, dimmed |
| `mrmd.yaml` | Hidden | Visible, dimmed |

---

## Undo/Redo

All nav operations are undoable:

| Operation | Undo Behavior |
|-----------|---------------|
| Create | Delete (permanently, no trash) |
| Delete | Restore from memory (until session ends) |
| Rename | Rename back |
| Move | Move back |
| Reorder | Reorder back |

Undo stack is per-session. Notification toast appears:

```
┌─────────────────────────────────┐
│  ↩ Restored: installation.md    │
└─────────────────────────────────┘
```

---

## Accessibility

- All actions have keyboard equivalents
- Focus is visually obvious (selection bar)
- Screen reader: announces item name, type, position ("installation.md, file, 2 of 5 in Getting Started")
- High contrast mode: selection bar uses solid color, not transparency
- Reduced motion mode: transitions instant (0ms)

---

## Settings

User-configurable in preferences:

```yaml
nav:
  activation_key: "ctrl+1"        # or "ctrl+b", "escape"
  show_extensions: "active"       # "always", "never", "active"
  show_hints: true                # command hints bar
  show_technical: "dimmed"        # "hidden", "dimmed", "normal"
  vim_keys: true                  # j/k/h/l navigation
  animation_duration: 100         # ms, 0 to disable
  filter_mode: "fuzzy"            # "fuzzy", "exact", "regex"
  confirm_delete: true            # show confirmation dialog
  auto_reveal: true               # reveal current file on document open
```

---

## Summary

The left nav is:

1. **Passive by default** — a clean, reader-friendly documentation sidebar
2. **Activated on signal** — becomes a power-user file tree
3. **Keyboard-first** — full vim-style navigation and actions
4. **Mouse-capable** — drag-drop, right-click, all expected interactions
5. **Workspace-aware** — shows multiple projects in a unified hierarchy
6. **Undoable** — all operations can be reversed
7. **Fast** — transitions are snappy (100-150ms), never blocking

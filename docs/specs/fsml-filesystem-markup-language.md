# Filesystem Markup Language (FSML)

> The filesystem is the markup language. Folders and filenames are syntax. The editor renders and manipulates this syntax.

---

## 1. Core Concept

Just as Markdown is a markup language that renders to HTML, **the filesystem structure is a markup language that renders to navigation, outlines, and site structure**.

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   MARKDOWN                              FILESYSTEM (FSML)                   │
│   ────────────────────────────          ────────────────────────────────    │
│                                                                             │
│   # Heading                             01-heading/                         │
│   ## Subheading                         01-heading/01-subheading.md         │
│   **emphasis**                          (frontmatter: featured: true)       │
│   [link](url)                           [[internal-link]]                   │
│   <!-- hidden -->                       _hidden-folder/                     │
│   `code`                                _lib/code.py                        │
│                                                                             │
│   SOURCE → RENDER                       SOURCE → RENDER                     │
│   .md → HTML, PDF                       filesystem → nav, outline, site     │
│                                                                             │
│   EDIT TOOLS                            EDIT TOOLS                          │
│   Ctrl+B adds **                        Drag reorders 01-, 02-              │
│   Table editor                          Rename tool                         │
│   Link picker                           Asset drop                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Syntax Definition

### 2.1 Ordering Prefix

| Syntax | Example | Meaning |
|--------|---------|---------|
| `NN-` | `01-intro.md`, `02-setup.md` | Position NN in navigation |
| No prefix | `appendix.md` | Sorted alphabetically after numbered items |

**Rules:**
- Two digits recommended: `01-` through `99-`
- Gaps allowed: `01-`, `05-`, `10-` (leaves room for insertion)
- Leading zeros required for correct sorting: `01-` not `1-`

### 2.2 Word Separator

| Syntax | Example | Renders As |
|--------|---------|------------|
| `-` (hyphen) | `getting-started.md` | "Getting Started" |
| `_` (underscore) | `getting_started.md` | "Getting Started" |

**Title derivation:**
1. Remove ordering prefix: `01-getting-started.md` → `getting-started`
2. Remove extension: `getting-started` → `getting-started`
3. Replace `-` or `_` with spaces: `getting started`
4. Title case: `Getting Started`

### 2.3 Folder Prefixes

| Prefix | Example | Visibility | Purpose |
|--------|---------|------------|---------|
| None | `02-tutorials/` | Public | Regular section |
| `_` | `_assets/`, `_lib/` | Author-only | Supporting content, not in nav |
| `.` | `.git/`, `.mrmd/` | Hidden | System/tooling, never shown |

**Rule:** `_` prefix = "part of project but not public". `.` prefix = "tooling, not content".

### 2.4 Special Files

| File | Purpose | Behavior |
|------|---------|----------|
| `index.md` | Section landing page | If present, clicking section opens this file |
| `mrmd.md` | Project configuration | Marks project root, contains `yaml config` blocks |
| `_meta.yaml` | Section metadata | Optional overrides for section |

### 2.5 Titles (Short and Long)

| Source | Purpose | Example |
|--------|---------|---------|
| Filename | Short title (nav, breadcrumbs) | `01-setup-guide.md` → "Setup Guide" |
| `# Heading` | Long title (document header) | `# Complete Setup Guide for Beginners` |
| `title:` frontmatter | Override short title | `title: Quick Setup` |

**Syncing:** Changing filename updates the derived short title. Changing `title:` frontmatter offers to rename file.

---

## 3. Project Structure

### 3.1 Minimal Project

```output
my-project/
├── mrmd.md                ← Project root marker (contains config)
└── 01-document.md         ← Single document
```

### 3.2 Standard Project

```output
my-project/
├── mrmd.md                          # Project config (markdown with yaml config blocks)
├── 01-introduction.md               # Top-level document
├── 02-getting-started/              # Section
│   ├── index.md                     # Section landing (optional)
│   ├── 01-installation.md           # Section child
│   └── 02-configuration.md          # Section child
├── 03-tutorials/                    # Another section
│   ├── 01-basic.md
│   └── 02-advanced.md
├── _assets/                         # Assets (author-only in nav)
│   ├── screenshot.png
│   └── diagram.svg
├── _lib/                            # Code library (author-only)
│   └── helpers.py
└── _drafts/                         # Drafts (author-only)
    └── upcoming-feature.md
```

### 3.3 Rendered Navigation

From the above structure:

```output
Introduction
Getting Started              ← clickable (has index.md)
  Installation
  Configuration
Tutorials                    ← expands only (no index.md)
  Basic
  Advanced
```

---

## 4. Internal Links

### 4.1 Syntax

```markdown
See the [[installation]] guide.
Check the [[getting-started/configuration#advanced|advanced config]].
Go to [[next]] or [[prev]].
```

### 4.2 Link Types

| Syntax | Resolves To |
|--------|-------------|
| `[[filename]]` | First file matching `filename` (fuzzy) |
| `[[path/to/file]]` | Explicit path (without extension) |
| `[[#heading]]` | Heading in current document |
| `[[file#heading]]` | Heading in another document |
| `[[link\|display text]]` | Custom display text |

### 4.3 Special Links

| Syntax | Meaning |
|--------|---------|
| `[[next]]` | Next document in order |
| `[[prev]]` | Previous document in order |
| `[[home]]` | First document in project |
| `[[up]]` | Parent section's index or first doc |
| `[[toc]]` | Table of contents (current section) |

### 4.4 Refactoring

When a file is renamed or moved:
1. All `[[links]]` pointing to it are updated
2. User is shown: "Update 5 references to 'installation'? [Yes] [No]"

---

## 5. Assets

### 5.1 Principle

Assets use **standard Markdown image syntax** with **relative paths** from the document to `_assets/`. This ensures **GitHub compatibility** — images render correctly when viewing markdown on github.com.

### 5.2 Path Resolution

Paths are **relative to the file containing them**, not the project root.

```output
my-project/
├── _assets/
│   └── screenshot.png
├── 01-intro.md                      ← ![Screenshot](_assets/screenshot.png)
└── 02-getting-started/
    └── 01-installation.md           ← ![Screenshot](../_assets/screenshot.png)
```

**Examples by file depth:**

| File Location | Path to `_assets/screenshot.png` |
|---------------|----------------------------------|
| `01-intro.md` | `_assets/screenshot.png` |
| `02-section/01-doc.md` | `../_assets/screenshot.png` |
| `02-section/sub/01-doc.md` | `../../_assets/screenshot.png` |

### 5.3 Automatic Path Refactoring

**When a document moves, the editor automatically updates all asset paths.**

```output
BEFORE: 02-getting-started/01-installation.md
        Contains: ![](../_assets/screenshot.png)

ACTION: Move to 03-tutorials/advanced/01-installation.md

AFTER:  03-tutorials/advanced/01-installation.md
        Contains: ![](../../_assets/screenshot.png)  ← auto-updated
```

This happens transparently — the user drags to reorganize, paths update automatically.

### 5.4 Why Relative Paths?

| Path Style | GitHub Raw | GitHub Pages | Pandoc | Verdict |
|------------|------------|--------------|--------|---------|
| `../_assets/img.png` (relative) | ✓ | ✓ | ✓ | **Best compatibility** |
| `/_assets/img.png` (root) | ✗ | ✓ | ✓ | Breaks GitHub raw view |
| `asset:img.png` (custom) | ✗ | ✗ | ✗ | Non-standard |

Relative paths work everywhere. The editor handles the complexity.

### 5.5 Storage Structure

```output
_assets/
├── screenshot.png              # Manually added
├── diagram.svg                 # Manually added
├── diagrams/                   # Subfolder organization (optional)
│   └── architecture.svg
├── generated/                  # From code cells
│   ├── fig-1-abc123.png        # Hash suffix for uniqueness
│   └── fig-2-def456.png
└── .manifest.json              # Internal tracking (hidden)
```

### 5.6 Asset Operations

| Action | What Happens |
|--------|--------------|
| **Drag image into document** | Saved to `_assets/`, relative path inserted |
| **Paste image** | Same as drag, auto-named `paste-TIMESTAMP.png` |
| **Code cell generates figure** | Saved to `_assets/generated/`, relative path inserted |
| **Move document** | All asset paths in document auto-refactored |
| **Drag same image again** | Recognized by hash, reuses existing file |
| **Rename asset in gallery** | File renamed, all references across project updated |
| **Delete document** | Assets remain (orphan cleanup available) |

### 5.7 Content Addressing (Internal)

The manifest tracks content hashes to prevent duplicates and enable rename refactoring:

```json
{
  "screenshot.png": {
    "hash": "abc123def456...",
    "addedAt": "2025-01-15T10:30:00Z",
    "usedIn": ["01-intro.md", "02-getting-started/01-installation.md"]
  }
}
```

When you drop an image:
1. Compute content hash
2. Check manifest for matching hash
3. If match: reuse existing file, insert relative path
4. If no match: save file, add to manifest, insert relative path

### 5.9 Gallery View

```output
┌─────────────────────────────────────────────────────────────────┐
│  Assets                                       [+ Import] [⚙]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  IMAGES (4)                                                     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                   │
│  │   🖼   │ │   🖼   │ │   📊   │ │   📈   │                   │
│  └────────┘ └────────┘ └────────┘ └────────┘                   │
│  screenshot  hero       diagram    chart                        │
│  2 uses      1 use      3 uses     1 use                        │
│                                                                 │
│  GENERATED (2)                                          [Clear] │
│  ┌────────┐ ┌────────┐                                         │
│  │   📉   │ │   📊   │                                         │
│  └────────┘ └────────┘                                         │
│  fig-1      fig-2                                               │
│  exp-1.md   exp-2.md   ← source document                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Gallery interactions:**
- Click asset → show all documents using it
- Double-click → open in default app
- Right-click → Rename, Delete, Reveal in Finder
- Drag from gallery → insert relative path into document

### 5.10 Orphan Cleanup

Command: "Clean Unused Assets"

```output
┌─────────────────────────────────────────────────────────────────┐
│  Unused Assets                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  3 assets are not referenced by any document:                   │
│                                                                 │
│  ☑ old-diagram.png         added 3 months ago, 245 KB          │
│  ☑ test-image.png          added 1 month ago, 89 KB            │
│  ☐ fig-draft.png           generated 2 weeks ago, 12 KB        │
│                                                                 │
│  Selected: 334 KB                                               │
│                                                                 │
│              [ Cancel ]  [ Delete Selected ]                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Editor Tools

The editor provides tools to manipulate FSML, just like Markdown editors provide formatting tools.

### 6.1 Reorder Tool

**User action:** Drag "Configuration" above "Installation" in nav

**What happens on disk:**
```
02-getting-started/
  01-installation.md    →  02-installation.md
  02-configuration.md   →  01-configuration.md
```

**User sees:** Items swap in nav

---

### 6.2 Rename Tool

**User action:** Click item label, edit text

**What happens on disk:**
```
01-installation.md  →  01-setup-guide.md
```

**User sees:** Label updates in nav

---

### 6.3 Create Tool

**User action:** Click [+] or press `a` in nav

**For new document:**
```
(new) → 03-untitled.md    (cursor in name field)
```

**For new section:**
```
(new) → 03-new-section/
        └── 01-untitled.md
```

---

### 6.4 Nest/Unnest Tool

**User action:** Drag "Basic" out of "Tutorials" to top level

**What happens:**
```output
BEFORE                           AFTER
03-tutorials/                    03-tutorials/
  01-basic.md       ────────►      01-advanced.md  (renumbered)
  02-advanced.md

                                 04-basic.md       (new top-level)
```

**Also:** Any asset paths in the moved file are automatically refactored:
```output
BEFORE (in 03-tutorials/01-basic.md):    ![](../../_assets/diagram.png)
AFTER  (in 04-basic.md):                 ![](_assets/diagram.png)
```

---

### 6.5 Asset Drop Tool

**User action:** Drag image file onto document

**What happens:**
1. Copy to `_assets/image-name.png`
2. Add to manifest with hash
3. Calculate relative path from document to `_assets/`
4. Insert markdown at cursor with correct relative path

**Example:**
```
Document: 02-getting-started/01-installation.md
Asset:    _assets/screenshot.png
Inserted: ![screenshot](../_assets/screenshot.png)
```

---

### 6.6 Link Tool

**User action:** Type `[[`

**What happens:**
1. Autocomplete dropdown appears with all documents
2. User types to filter: `[[inst` shows "Installation"
3. User selects or completes
4. Inserts: `[[installation]]`

**Rendered:** Clickable link showing "Installation"

---

## 7. Rendering Rules

### 7.1 Navigation Tree

```output
SOURCE (filesystem)              RENDERED (nav)
────────────────────             ──────────────
01-intro.md                      Introduction
02-getting-started/              Getting Started        ← section
  index.md                         (landing page)
  01-installation.md               Installation
  02-configuration.md              Configuration
03-tutorials/                    Tutorials              ← section
  01-basic.md                      Basic
_assets/                         (not shown)
_lib/                            (not shown)
```

### 7.2 Rules

1. **Ordering:** Numeric prefix determines order, then alphabetical
2. **Labels:** Derived from filename, overridden by `title:` frontmatter
3. **Sections:** Folders become collapsible sections
4. **Section landing:** If `index.md` exists, section is clickable
5. **Hidden:** `_` prefix folders are not shown in nav
6. **System:** `.` prefix folders are never processed

---

## 8. Configuration (mrmd.md)

`mrmd.md` serves two purposes:
1. **Project root marker** — its presence defines where the project starts
2. **Configuration** — settings for navigation, assets, runtime, and build

### 8.1 Why Markdown?

mrmd is a markdown editor. The project config should be editable IN mrmd:

- **Documentable** — explain WHY the config is the way it is
- **Literate** — prose between config sections
- **Full editor experience** — code execution, assets, everything works

Config is extracted from `yaml config` blocks. Multiple blocks are deep-merged.

### 8.2 Minimal Configuration

````markdown
# My Project

```yaml config
name: "My Project"
```
````

This is enough. Everything else has sensible defaults.

### 8.3 Structure-Related Settings

````markdown
# My Project

```yaml config
name: "My Project"
```

## Navigation

We override the default filesystem order for the nav.

```yaml config
nav:
  order:
    - introduction
    - getting-started
    - tutorials
```

## Assets

```yaml config
assets:
  directory: "_assets"
  generated: "_assets/generated"
```

## Internal Links

```yaml config
links:
  validate: true
  auto_refactor: true
```

## Build Output

```yaml config
build:
  output: "_site"
  formats: ["html", "pdf"]
```
````

### 8.4 Session Configuration

Session settings (venv, cwd, name) are documented separately.

**See:** [Runtime and Execution Specification](./runtime-and-execution.md)

````markdown
## Session Setup

We use a shared session for all documents.

```yaml config
session:
  python:
    venv: ".venv"              # Created automatically if missing
    cwd: "."                   # Project root by default
    name: "default"            # Session name (becomes {project}:{name})
```
````

Documents can override session settings in frontmatter:

```yaml
---
title: "GPU Experiments"
session:
  python:
    name: "gpu-session"        # Connect to different session
    venv: "../ml-env/.venv"    # Only used if starting new session
---
```

---

## 9. Summary

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                      FSML: Filesystem as Markup Language                    │
│                                                                             │
│  ┌─────────────────┐         ┌─────────────────┐        ┌───────────────┐  │
│  │                 │         │                 │        │               │  │
│  │  Source         │  ────►  │  Rendered       │  ────► │  Output       │  │
│  │  (filesystem)   │  parse  │  (nav/outline)  │  build │  (site/pdf)   │  │
│  │                 │         │                 │        │               │  │
│  │  01-intro.md    │         │  Introduction   │        │  HTML pages   │  │
│  │  02-setup/      │         │  Setup          │        │  PDF book     │  │
│  │  _assets/       │         │    ...          │        │               │  │
│  │                 │         │                 │        │               │  │
│  └─────────────────┘         └─────────────────┘        └───────────────┘  │
│         ▲                            │                                      │
│         │                            │                                      │
│         │         ┌──────────────────┘                                      │
│         │         ▼                                                         │
│  ┌─────────────────────────────────────────────┐                           │
│  │                                             │                           │
│  │  Editor Tools                               │                           │
│  │                                             │                           │
│  │  • Reorder (drag in nav → rename files)     │                           │
│  │  • Rename (edit label → rename file)        │                           │
│  │  • Create (add item → create file/folder)   │                           │
│  │  • Nest/Unnest (drag → move file)           │                           │
│  │  • Link ([[...]] → autocomplete)            │                           │
│  │  • Asset (drop → save + insert markdown)    │                           │
│  │                                             │                           │
│  └─────────────────────────────────────────────┘                           │
│                                                                             │
│  The editor manipulates SOURCE while showing RENDERED.                      │
│  Heavy restructuring → "Reveal in Finder" → use OS tools.                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** We're not building a file manager. We're building an editor for a markup language whose syntax is the filesystem. The tools manipulate that syntax (filenames, folders) while displaying the rendered result (navigation, outlines).

**Why mrmd.md?** The project config is a markdown document because mrmd is a markdown editor. You should be able to edit your project config IN mrmd, with full editor features. Config lives in `yaml config` blocks, with explanatory prose between them.

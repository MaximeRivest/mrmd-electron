# File Navigation and Creation Specification

> The unified Ctrl+P interface for finding, navigating, and creating files and projects.

---

## 1. Overview

### 1.1 The Problem

Users need to:
1. **Find** existing files quickly (even with common names like `README.md`)
2. **Navigate** to specific locations in the filesystem
3. **Create** new files at specific paths
4. **Create** new projects with proper scaffolding

These are different mental models, but forcing users to learn separate interfaces creates friction.

### 1.2 The Solution

A unified Ctrl+P panel that:
- **Fuzzy searches on full paths** (not just filenames)
- **Shows both files and folders** in results
- **Creates files** when input ends with `.md`
- **Creates projects** when input has no `.md` extension

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ONE INTERFACE, MULTIPLE MODES                                              │
│                                                                             │
│  Ctrl+P → Type anything                                                     │
│                                                                             │
│  "thesis readme"        → Find README.md in thesis project                  │
│  "./03-exp/"            → Browse experiments folder                         │
│  "./new-analysis.md"    → Create new file                                   │
│  "~/projects/my-proj"   → Create new project with scaffolding               │
│                                                                             │
│  The input determines the action. No mode switching required.               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Fuzzy Search

### 2.1 Full Path Matching

Fuzzy search matches against the **entire path**, not just the filename. This allows disambiguation of files with common names.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > thesis readme                                                            │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  📄 ~/thesis/README.md                                                      │
│       ^^^^^^ ^^^^^^                                                         │
│       matches "thesis" in path AND "readme" in filename                     │
│                                                                             │
│  📄 ~/thesis/docs/readme-template.md                                        │
│                                                                             │
│  (not shown: ~/work/other-project/README.md)                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Query Examples

| Query | Matches | Why |
|-------|---------|-----|
| `readme` | All README files | Filename match |
| `thesis readme` | `~/thesis/README.md` | "thesis" in path, "readme" in name |
| `exp neural` | `03-experiments/neural-net.md` | Both fragments match path |
| `ml intro` | `~/work/ml-course/01-intro.md` | "ml" in path, "intro" in name |
| `2024 jan` | `~/notes/2024/january/*.md` | Date fragments in path |
| `src comp button` | `src/components/Button.md` | Multiple path fragments |

### 2.3 Matching Algorithm

The fuzzy matcher should:

1. **Split query into tokens** — `"thesis readme"` → `["thesis", "readme"]`
2. **Match each token against path** — Each token must appear somewhere in the path
3. **Score by**:
   - Token match quality (exact > prefix > substring > fuzzy)
   - Token order (matches in order score higher)
   - Path depth (shallower paths score higher for ties)
4. **Highlight matched regions** in the UI

```
Query: "exp neural"
Path:  ~/thesis/03-experiments/neural-network-results.md
                   ^^^         ^^^^^^
                   matches     matches
Score: High (both tokens match, in order)
```

### 2.4 Folders in Results

Folders appear in search results alongside files:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > experiments                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  📁 ~/thesis/03-experiments/                                     [→ browse] │
│  📄 ~/thesis/03-experiments/neural-net.md                                   │
│  📄 ~/thesis/03-experiments/ablation.md                                     │
│  📄 ~/work/experiments-log.md                                               │
│  📁 ~/work/old-experiments/                                      [→ browse] │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Selecting a folder** scopes the search to that folder (enters folder context):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > 03-experiments/ _                                                        │
│  ───────────────────────────────────────────────────────────────────────────│
│  IN: ~/thesis/03-experiments/                          [Backspace to go up] │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  📄 neural-net.md                                                           │
│  📄 ablation.md                                                             │
│  📄 baseline.md                                                             │
│  📁 data/                                                        [→ browse] │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ✨ Create new file here...                                                 │
│  ✨ Create new project here...                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Now typing continues to filter within that folder context.

### 2.5 Result Grouping

Results are grouped by context:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > neural                                                                   │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  CURRENT PROJECT                                                            │
│  📄 03-experiments/neural-net.md                                            │
│  📄 02-methods/neural-architecture.md                                       │
│                                                                             │
│  RECENT                                                                     │
│  📄 ~/work/ml-course/neural-networks.md                         2 days ago  │
│                                                                             │
│  OTHER                                                                      │
│  📄 ~/notes/deep-learning/neural-intro.md                                   │
│  📁 ~/old-projects/neural-experiments/                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Group priority:**
1. **Current project** — Files in the same project as the currently open file
2. **Recent** — Files opened in the last 7 days
3. **Other** — Everything else discovered on the filesystem

### 2.6 Ranking Within Groups

Within each group, results are ranked by:

1. **Match quality** — How well do tokens match the path?
2. **Frecency** — Frequency × Recency (files used often AND recently)
3. **Path depth** — Shallower paths rank higher for ties
4. **Alphabetical** — Final tiebreaker

---

## 3. Path Mode

### 3.1 Triggering Path Mode

Path mode is entered when the query starts with a path prefix:

| Prefix | Base Path |
|--------|-----------|
| `./` | Current file's directory |
| `../` | Parent of current file's directory |
| `/` | Filesystem root |
| `~/` | Home directory |

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ./03-exp                                                                 │
│  ───────────────────────────────────────────────────────────────────────────│
│  📁 PATH MODE                                                               │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  📁 ./03-experiments/                                              [Tab ↵]  │
│  📄 ./03-exploration.md                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Tab Completion

In path mode, Tab expands/completes the selected item:

**Before Tab:**
```
> ./03-exp
```

**After Tab (with folder selected):**
```
> ./03-experiments/
```

The cursor is now inside that folder, showing its contents.

### 3.3 Path Mode vs Fuzzy Search

| Aspect | Fuzzy Search | Path Mode |
|--------|--------------|-----------|
| Trigger | No path prefix | Starts with `./` `../` `~/` `/` |
| Matching | Tokens anywhere in path | Sequential path completion |
| Results | Files across filesystem | Files in specified directory |
| Use case | "I remember fragments" | "I know exactly where" |

### 3.4 Escaping Path Mode

- **Backspace at start** — If input is just `./`, backspace returns to fuzzy mode
- **Esc** — Closes panel entirely
- **Clear input** — Returns to fuzzy mode

---

## 4. File Creation

### 4.1 When to Create

A file is created when:
- The input ends with `.md`
- The path does not exist

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ./03-experiments/new-gpu-benchmark.md                                    │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ✨ Create: ./03-experiments/new-gpu-benchmark.md                  [Enter]  │
│                                                                             │
│  Similar existing:                                                          │
│  📄 ./03-experiments/gpu-benchmark-v1.md                                    │
│  📄 ./03-experiments/gpu-memory-tests.md                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Creating in Folder Context

When inside a folder context, typing a filename creates in that folder:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > 03-experiments/ new-analysis.md                                          │
│  ───────────────────────────────────────────────────────────────────────────│
│  IN: ~/thesis/03-experiments/                                               │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ✨ Create: new-analysis.md                                        [Enter]  │
│                                                                             │
│  Existing files:                                                            │
│  📄 neural-net.md                                                           │
│  📄 ablation.md                                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Creating with Intermediate Directories

If the path includes non-existing directories, they are created automatically:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ./new-section/analysis/results.md                                        │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ✨ Create: ./new-section/analysis/results.md                      [Enter]  │
│     Will also create:                                                       │
│     📁 ./new-section/                                                       │
│     📁 ./new-section/analysis/                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.4 Fuzzy Search + Create

In fuzzy mode, a "Create" option appears at the bottom if the query could be a filename:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > neural-analysis                                                          │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  CURRENT PROJECT                                                            │
│  📄 03-experiments/neural-net-analysis.md                                   │
│                                                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ✨ Create "neural-analysis.md"...                              [↵ choose]  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Selecting "Create" shows a location picker:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CREATE: neural-analysis.md                                                 │
│  ───────────────────────────────────────────────────────────────────────────│
│  WHERE?                                                                     │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  📁 ./ (current folder)                         ~/thesis/03-experiments/    │
│  📁 Project root                                              ~/thesis/     │
│  📁 Recent: ~/work/ml-course/                                               │
│  📁 Recent: ~/notes/                                                        │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  📁 Browse...                                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.5 File Content After Creation

**If created inside a project (mrmd.md exists in ancestors):**
- File is empty (inherits project configuration)

**If created outside a project (standalone file):**
- See Section 6: Standalone Files

---

## 5. Project Creation

### 5.1 When to Create a Project

A project is created when:
- The input does **not** end with `.md`
- The path does not exist (or is empty)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ~/projects/new-research                                                  │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ✨ Create PROJECT: ~/projects/new-research/                       [Enter]  │
│                                                                             │
│     Will create:                                                            │
│     📁 ~/projects/new-research/                                             │
│        ├── mrmd.md              (project config)                            │
│        ├── 01-index.md          (welcome document)                          │
│        ├── _assets/             (images, files)                             │
│        └── .venv/               (Python environment)                        │
│                                                                             │
│     Will install: mrmd-python                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Project vs File Decision

| Input | Result |
|-------|--------|
| `notes.md` | Create **file** |
| `./analysis.md` | Create **file** |
| `my-project` | Create **project** |
| `my-project/` | Create **project** |
| `~/work/new-research` | Create **project** |
| `~/work/new-research/` | Create **project** |

**Rule:** `.md` extension = file, otherwise = project.

### 5.3 Project Scaffold

When a project is created, the following structure is generated:

```
new-research/
├── mrmd.md                    # Project configuration
├── 01-index.md                # Welcome / getting started
├── _assets/                   # Images, data files
│   └── .gitkeep
└── .venv/                     # Python virtual environment
    └── (mrmd-python installed)
```

### 5.4 Template: mrmd.md

````markdown
# new-research

Welcome to your new mrmd project.

## Configuration

```yaml config
name: "new-research"
```

## Session Setup

We use a shared session for all documents in this project.

```yaml config
session:
  python:
    venv: ".venv"
    cwd: "."
    name: "default"
    auto_start: true
```

## Getting Started

- Edit this file to configure your project
- Create new documents with `Ctrl+P`
- Run code blocks with `Ctrl+Enter`

## Environment Check

```python
import sys
print(f"Python: {sys.version}")
print(f"Working directory: {__import__('os').getcwd()}")
```
````

### 5.5 Template: 01-index.md

```markdown
# new-research

This is your project's main document.

## Quick Start

```python
print("Hello from mrmd!")
```

## Project Structure

| Path | Purpose |
|------|---------|
| `mrmd.md` | Project configuration |
| `_assets/` | Images and data files |
| `.venv/` | Python environment |

## Next Steps

- Create new documents with `Ctrl+P`
- Organize with folders: `02-section/01-document.md`
- Add images to `_assets/` and reference with `![](_assets/image.png)`
```

### 5.6 Project Creation Progress

After pressing Enter, show progress:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Creating project "new-research"...                                         │
│                                                                             │
│  ✓ Created ~/projects/new-research/                                         │
│  ✓ Created mrmd.md                                                          │
│  ✓ Created 01-index.md                                                      │
│  ✓ Created _assets/                                                         │
│  ◐ Creating .venv...                                                        │
│    Running: python -m venv .venv                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Then:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Creating project "new-research"...                                         │
│                                                                             │
│  ✓ Created ~/projects/new-research/                                         │
│  ✓ Created mrmd.md                                                          │
│  ✓ Created 01-index.md                                                      │
│  ✓ Created _assets/                                                         │
│  ✓ Created .venv                                                            │
│  ◐ Installing mrmd-python...                                                │
│    Running: uv pip install mrmd-python                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Finally:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ✓ Project "new-research" created!                                          │
│                                                                             │
│  ✓ Created ~/projects/new-research/                                         │
│  ✓ Created mrmd.md                                                          │
│  ✓ Created 01-index.md                                                      │
│  ✓ Created _assets/                                                         │
│  ✓ Created .venv                                                            │
│  ✓ Installed mrmd-python                                                    │
│                                                                             │
│  Opening 01-index.md...                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.7 Project Creation in Folder Context

When inside a folder context, creating without `.md` creates a project there:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ~/work/ my-new-project                                                   │
│  ───────────────────────────────────────────────────────────────────────────│
│  IN: ~/work/                                                                │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ✨ Create PROJECT: my-new-project/                                [Enter]  │
│                                                                             │
│     Will create at: ~/work/my-new-project/                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Standalone Files (No Project)

### 6.1 Detection

A file is "standalone" when no `mrmd.md` is found in its ancestor directories.

### 6.2 Opening a Standalone File

When opening a standalone file:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ⚠ This file is not part of an mrmd project                          │  │
│  │                                                                       │  │
│  │  To run code, you need runtime configuration.                         │  │
│  │                                                                       │  │
│  │  [ Add frontmatter ]    [ Create project here ]    [ Just view ]      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  # My Standalone Document                                                   │
│                                                                             │
│  Some content here...                                                       │
│                                                                             │
│  ```python                                                                  │
│  print("hello")       ← Cannot run without configuration                   │
│  ```                                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 User Choices

**"Just view":**
- Banner collapses to subtle indicator at top
- Document is editable (markdown editing works)
- Code blocks show "Configure runtime to execute" when hovered/clicked

**"Add frontmatter":**
- Opens venv picker (reuses existing discover logic)
- Generates frontmatter with selected venv
- Inserts at top of document

**"Create project here":**
- Creates `mrmd.md` in the file's directory
- Creates `.venv/` and installs mrmd-python
- File now inherits project configuration

### 6.4 Running Code in Standalone File

If user tries to run a code block without configuration:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ⚠ Cannot run code                                                   │  │
│  │                                                                       │  │
│  │  This file needs runtime configuration to execute code.               │  │
│  │                                                                       │  │
│  │  [ Add frontmatter ]    [ Create project here ]                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Standalone File Frontmatter

When "Add frontmatter" is selected, generate:

```yaml
---
title: "My Standalone Document"
session:
  python:
    venv: "/absolute/path/to/.venv"
    cwd: "/absolute/path/to/working/dir"
---
```

**Note:** Standalone files use **absolute paths** because there's no project root to resolve relative paths against.

### 6.6 Creating a Standalone File

When creating a file outside any project:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ~/random-notes/quick-analysis.md                                         │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ✨ Create FILE: ~/random-notes/quick-analysis.md                  [Enter]  │
│                                                                             │
│     ⚠ This location is not inside a project.                               │
│     The file will need frontmatter to run code.                             │
│                                                                             │
│     [ Create anyway ]    [ Create project instead ]                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

If "Create anyway":
- File is created empty
- When opened, shows the standalone file banner (Section 6.2)

---

## 7. Keyboard Shortcuts

### 7.1 Global

| Key | Action |
|-----|--------|
| `Ctrl+P` | Open file navigation panel |
| `Esc` | Close panel |

### 7.2 In Panel

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate results |
| `Enter` | Open selected (or create if create item) |
| `Tab` | In path mode: expand/complete directory |
| `Backspace` | At path start: go up one level / exit folder context |
| `Ctrl+Enter` | Force create new (even if similar exists) |

### 7.3 Shortcuts Reference

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  NAVIGATION                                                                 │
│  ↑/↓         Navigate results                                               │
│  Enter       Open / Create                                                  │
│  Esc         Close panel                                                    │
│                                                                             │
│  PATH MODE                                                                  │
│  Tab         Complete / Expand directory                                    │
│  Backspace   Go up one level (when at path start)                           │
│                                                                             │
│  CREATION                                                                   │
│  Ctrl+Enter  Force create (skip "similar exists" warning)                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Visual Design

### 8.1 Panel Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > [input field]                                            [?] [shortcuts] │
│  ───────────────────────────────────────────────────────────────────────────│
│  [context indicator if in path/folder mode]                                 │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  [GROUP HEADER]                                                             │
│  [icon] [path with highlights]                              [metadata]      │
│  [icon] [path with highlights]                              [metadata]      │
│                                                                             │
│  [GROUP HEADER]                                                             │
│  [icon] [path with highlights]                              [metadata]      │
│                                                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  [create options if applicable]                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Icons

| Icon | Meaning |
|------|---------|
| 📄 | Markdown file |
| 📁 | Folder |
| ✨ | Create action |
| ⚠ | Warning/attention |

### 8.3 Highlighting

Matched portions of paths should be highlighted:

```
Query: "thesis neural"

📄 ~/thesis/03-experiments/neural-net.md
     ^^^^^^               ^^^^^^
     highlighted          highlighted
```

### 8.4 Metadata Column

| File State | Metadata |
|------------|----------|
| Recent file | "2 days ago" |
| Current project | (no metadata, implied by group) |
| Folder | "[→ browse]" |
| Create option | "[Enter]" |

---

## 9. State Machine

```
                         Ctrl+P
                           │
                           ▼
                    ┌──────────────┐
                    │              │
                    │  EMPTY       │
                    │  INPUT       │
                    │              │
                    └──────┬───────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │              │ │              │ │              │
    │  FUZZY       │ │  PATH        │ │  FOLDER      │
    │  SEARCH      │ │  MODE        │ │  CONTEXT     │
    │              │ │  (./ ../ ~/) │ │              │
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │               │               │
           │               │               │
           ▼               ▼               ▼
    ┌─────────────────────────────────────────────────┐
    │                                                 │
    │  RESULT SELECTED                                │
    │                                                 │
    │  File?      → Open file                         │
    │  Folder?    → Enter folder context              │
    │  Create?    → Create file or project            │
    │                                                 │
    └─────────────────────────────────────────────────┘
```

---

## 10. Edge Cases

### 10.1 No Current File Open

When Ctrl+P is pressed with no file open:

- `./` and `../` are unavailable (or use home directory)
- Show recent files prominently
- Show "Create new project" option at top

### 10.2 Empty Query

Show:
1. Recent files (last 10)
2. Current project files (if in a project)
3. "Create new..." options

### 10.3 Query Matches Nothing

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > xyzzy-nonexistent-thing                                                  │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  No files found matching "xyzzy-nonexistent-thing"                          │
│                                                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ✨ Create "xyzzy-nonexistent-thing.md"...                                  │
│  ✨ Create project "xyzzy-nonexistent-thing"...                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 10.4 Path Doesn't Exist

In path mode, show what will be created:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ~/nonexistent/path/                                                      │
│  ───────────────────────────────────────────────────────────────────────────│
│  📁 PATH MODE                                                               │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ⚠ Path does not exist                                                     │
│                                                                             │
│  ✨ Create folder: ~/nonexistent/path/                             [Enter]  │
│  ✨ Create project: ~/nonexistent/path/                            [Enter]  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 10.5 File Already Exists

When trying to create a file that exists:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  > ./existing-file.md                                                       │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  📄 ./existing-file.md                                 [Enter to open]      │
│                                                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ✨ Create ./existing-file-1.md                        [Ctrl+Enter]         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Implementation Notes

### 11.1 File Discovery

The panel needs access to:
1. **Current project files** — Walk from mrmd.md root
2. **Recent files** — Stored in `~/.config/mrmd/recent.json`
3. **Filesystem scan** — Background scan of home directory (cached)

### 11.2 Performance

- Fuzzy matching should be <16ms for smooth typing
- File discovery should be incremental (show results as they arrive)
- Cache filesystem scan results, invalidate on window focus

### 11.3 Fuzzy Matching Library

Consider using:
- `fzf` (already in mrmd-electron dependencies)
- `fuse.js` for JavaScript implementation
- Custom implementation for path-aware scoring

---

## 12. Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  THE MENTAL MODEL                                                           │
│                                                                             │
│  Ctrl+P = Universal file interface                                          │
│                                                                             │
│  FIND FILES                                                                 │
│  Just type words you remember from the path                                 │
│  "thesis neural" → ~/thesis/experiments/neural-net.md                       │
│                                                                             │
│  NAVIGATE                                                                   │
│  Start with ./ or ~/ to enter path mode                                     │
│  Tab to complete directories                                                │
│                                                                             │
│  CREATE FILES                                                               │
│  End with .md → creates a file                                              │
│  ./new-doc.md → creates new-doc.md in current folder                        │
│                                                                             │
│  CREATE PROJECTS                                                            │
│  No .md extension → creates a project with scaffolding                      │
│  ~/work/my-project → creates project with mrmd.md, .venv, etc.              │
│                                                                             │
│  THE SUFFIX DETERMINES THE ACTION                                           │
│  .md = file                                                                 │
│  no .md = project                                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

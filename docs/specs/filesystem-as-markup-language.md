  # The Reframe: Filesystem as Markup Language

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   MARKDOWN                              FILESYSTEM                          │
│   ────────────────────────────          ────────────────────────────────    │
│                                                                             │
│   # Heading                             01-heading/                         │
│   ## Subheading                         01-heading/01-subheading.md         │
│   **bold**                              (frontmatter: featured: true)       │
│   [link](path)                          [[internal-link]]                   │
│   <!-- hidden -->                       _hidden-folder/                     │
│         code                            .code-file.py                       │
│                                                                             │
│   RENDERS TO:                           RENDERS TO:                         │
│   HTML, LaTeX, PDF                      Nav, TOC, Outline, Site             │
│                                                                             │
│   EDITED WITH:                          EDITED WITH:                        │
│   Ctrl+B adds **                        Drag reorders 01-, 02-              │
│   Table editor makes | |                Rename tool changes filename        │
│   Link picker inserts []()              Asset drop places in _assets/       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
  ---
  The Filesystem Markup Language (FSML)

  Syntax Definition

  | Syntax                | Meaning             | Renders As                     | my comment |
  |-----------------------|---------------------|--------------------------------|
  | 01-, 02- prefix       | Ordering            | Position in nav                |
  | - in filename         | Word separator      | Space in title                 |
  | _folder/              | Hidden from readers | Not in nav, visible to author  | !! what is the difference between _ and .?
  | .folder/              | System/config       | Never shown                    |
  | index.md in folder    | Folder's content    | Folder becomes clickable page  |  !! I dont get that?
  | # Heading in file     | Document title      | long title | !! by default its the same as the file name (- - for space in file no caps)
  | title: in frontmatter | Explicit title      | Nav label (highest priority)   | !! title: and the file name of the same changing one changes the other. its the short title.
  | Folder nesting        | Hierarchy           | Nav nesting                    |
  | _assets/              | Asset storage       | Gallery view                   | !! we need a concept of 'doc'/project/root/book
  | [[link]]              | Internal reference  | Resolved path                  | !! no sure what this mean? clickable link to jump to other file/sections?

  Example "Source Code"

  my-project/                          # Project root
  ├── 01-introduction.md               # "Introduction" (position 1)
  ├── 02-getting-started/              # "Getting Started" section (position 2)
  │   ├── index.md                     # Section landing page        !! its not clear what value this has? over all just numbers?
  │   ├── 01-installation.md           # "Installation" (2.1)
  │   └── 02-configuration.md          # "Configuration" (2.2)
  ├── 03-tutorials/                    # "Tutorials" section (position 3)
  │   ├── 01-basic.md                  # "Basic" (3.1)
  │   └── 02-advanced.md               # "Advanced" (3.2)
  ├── _assets/                         # Hidden: asset storage
  │   ├── images/
  │   └── generated/
  ├── _lib/                            # Hidden: code library
  └── mrmd.yaml                        # Config (like .gitignore)


  "Rendered" Output (Nav)

  Introduction
  Getting Started
    Installation
    Configuration
  Tutorials
    Basic
    Advanced

!! yes that language/convention looks good/makes sense to me
  ---
  The Editor Tools

  Just like a Markdown editor has tools to manipulate syntax, mrmd has tools to manipulate filesystem markup:

  1. Reorder Tool (like table row drag)

  User action: Drag "Configuration" above "Installation"

  What the tool does:
  02-getting-started/
    01-installation.md    →    02-installation.md
    02-configuration.md   →    01-configuration.md

  User sees: Items swap positions in nav

  ---
  2. Rename Tool (like Ctrl+B for bold)

  User action: Double-click "Installation", type "Setup Guide"

  What the tool does:
  01-installation.md    →    01-setup-guide.md

  Or if title frontmatter exists:
  # In 01-installation.md
  ---
  title: Setup Guide    # ← tool edits this
  ---

  User sees: Label changes in nav

  ---
  3. Create Section Tool (like inserting a heading)

  User action: Click [+], choose "New Section"

  What the tool does:
  03-tutorials/         →    04-tutorials/
  (new)                 →    03-new-section/
                             └── index.md

  User sees: New section appears, cursor in title for naming

  !! yes I like that but why index.md ? over 01-untitled.md?

  ---
  4. Nest/Unnest Tool (like indent/outdent in lists)

  User action: Drag "Basic" out of "Tutorials" to top level

  What the tool does:
  03-tutorials/
    01-basic.md         →    (deleted from here)
    02-advanced.md      →    01-advanced.md  (renumbered)

  04-basic.md           →    (created at top level)

  User sees: "Basic" moves to top level in nav

  ---
  5. Asset Drop Tool (like image insert in Markdown)

  User action: Drag image onto document

  What the tool does:
  1. Hash the image content: abc123.png
  2. Check _assets/: does abc123 exist?
     - Yes: reuse it
     - No: save to _assets/images/abc123.png
  3. Insert into document: ![](/_assets/images/abc123.png)

  User sees: Image appears in document

  ---
  6. Link Tool (like link picker)

  User action: Type [[

  What the tool does:
  1. Show autocomplete of all documents
  2. User selects "Installation"
  3. Insert: [[02-getting-started/01-installation]]
  4. Renders as: "Installation" (clickable)

  User sees: Link to Installation

!! yes ok i get it but would have to be properly refactored/folling any restructuring/ naming that is done (still i want us to support that!) could we also have short hands for next/previous/home/etc.
  ---
  The Two Views (Source & Rendered)

  Just like you can view Markdown source or rendered output:

  Rendered View (Default)

  Getting Started
    Installation              ← clean label
    Configuration

  - What readers see
  - What the document outline shows
  - Click navigates

  Source View (On Demand)

  02-getting-started/
  ├── index.md
  ├── 01-installation.md      ← actual filename
  └── 02-configuration.md

  - What the filesystem looks like
  - Accessed via "Reveal in Finder" or a toggle
  - For debugging, heavy restructuring

  The nav panel only shows Rendered View. Source view is the OS file manager.

!! we won't render the source for that, we will reveal in finder on ctrl-click instead. that is it.
  ---
  Asset Organization (The Missing Spec)

  The Principle

  Assets are content-addressed, not location-addressed.

  WRONG (location-addressed):
    "The image is at ./images/screenshot.png"
    Problem: Move the doc, link breaks

  RIGHT (content-addressed):
    "The image has hash abc123"
    System: "abc123 is stored at _assets/images/abc123-screenshot.png"
    Benefit: Move the doc, link still works

  The Syntax

  In documents:
  ![Screenshot](asset:abc123)           # by hash
  ![Screenshot](asset:screenshot.png)   # by name (resolved to hash)

  On disk:
  _assets/
  ├── images/
  │   ├── abc123-screenshot.png         # hash-prefixed
  │   └── def456-diagram.png
  ├── generated/                        # from code cells
  │   └── ghi789-fig-1.png
  └── manifest.json                     # hash → metadata mapping

!! we must tweak that so it is valid markdown !!! we most have github should the images appropriately if this repo is on github as is (for example) 

  The Gallery

!! yes that gallery is a must!
  
```output
┌─────────────────────────────────────────────────────────────────┐
│  Assets                                            [+ Import]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  IMAGES                                                         │
│  ┌────────┐ ┌────────┐ ┌────────┐                              │
│  │        │ │        │ │        │                              │
│  │   🖼   │ │   📊   │ │   📈   │                              │
│  │        │ │        │ │        │                              │
│  └────────┘ └────────┘ └────────┘                              │
│  screenshot diagram    chart                                    │
│  Used in: 2 docs       Used in: 1 doc    Used in: 3 docs       │
│                                                                 │
│  GENERATED (from code cells)                                    │
│  ┌────────┐ ┌────────┐                                         │
│  │        │ │        │                                         │
│  │   📉   │ │   📊   │                                         │
│  │        │ │        │                                         │
│  └────────┘ └────────┘                                         │
│  fig-1      fig-2                                               │
│  Source: exp-1.md      Source: exp-2.md                        │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```
  Asset Operations

  | Action                       | What Happens                                         |
  |------------------------------|------------------------------------------------------|
  | Drag image into doc          | Hash, store in _assets/, insert reference            |
  | Paste image                  | Same as drag                                         |
  | Code cell generates figure   | Save to _assets/generated/, insert reference         |
  | Delete doc with unique asset | Asset stays (orphan cleanup later)                   |
  | Same image added twice       | Recognized by hash, reused                           |
  | Click asset in gallery       | Shows all documents using it                         |
  | Rename asset                 | Updates manifest, references still work (hash-based) |

  Asset Cleanup

  Periodic or manual "Clean unused assets":
  ┌─────────────────────────────────────────────────────────────────┐
  │  Unused Assets                                                  │
  ├─────────────────────────────────────────────────────────────────┤
  │                                                                 │
  │  3 assets are not referenced by any document:                   │
  │                                                                 │
  │  ☐ old-diagram.png (added 3 months ago)                        │
  │  ☐ test-image.png (added 1 month ago)                          │
  │  ☐ fig-draft.png (generated, 2 weeks ago)                      │
  │                                                                 │
  │            [ Keep All ]  [ Delete Selected ]                    │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  ---
  Summary: The New Mental Model

  ```output
         ─────────────────────────────────────────────────────────────────────────────┐
  │                                                                             │
  │                         FILESYSTEM = MARKUP LANGUAGE                        │
  │                                                                             │
  │  ┌─────────────────┐         ┌─────────────────┐        ┌───────────────┐  │
  │  │                 │         │                 │        │               │  │
  │  │  Source         │  ────►  │  Rendered       │  ────► │  Output       │  │
  │  │  (filesystem)   │  parse  │  (nav/outline)  │  build │  (site/pdf)   │  │
  │  │                 │         │                 │        │               │  │
  │  └─────────────────┘         └─────────────────┘        └───────────────┘  │
  │         ▲                            │                                      │
  │         │                            │                                      │
  │         │         ┌──────────────────┘                                      │
  │         │         │                                                         │
  │         │         ▼                                                         │
  │  ┌─────────────────────────────────────────────┐                           │
  │  │                                             │                           │
  │  │  Editor Tools                               │                           │
  │  │  (reorder, rename, nest, link, asset drop)  │                           │
  │  │                                             │                           │
  │  │  These manipulate the SOURCE (filesystem)   │                           │
  │  │  while showing the RENDERED view            │                           │
  │  │                                             │                           │
  │  └─────────────────────────────────────────────┘                           │
  │                                                                             │
  └─────────────────────────────────────────────────────────────────────────────┘
```
  Key insight: We're not building a file manager. We're building an editor for a markup language whose source
  happens to be the filesystem.

  The tools (reorder, rename, create section, drop asset) are exactly like Ctrl+B, table editors, and link pickers
  — they manipulate syntax while showing rendered output.



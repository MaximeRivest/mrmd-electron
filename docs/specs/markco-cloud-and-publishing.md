# Markco: Cloud, Publishing, and Collaboration

> MRMD as a cloud platform (markco.dev), continuous publishing, real-time collaboration, and the data service architecture. Builds on the FSML spec and cloud-runtime-spec.

---

## 1. Overview

### 1.1 What Is Markco?

Markco (markco.dev) is MRMD running as a cloud service. Users sign in, get an isolated Linux environment, and access the full MRMD editor from any browser. Three capabilities layer on top of the core editor:

1. **Publishing** — any project is a live website, rendered by the same engine as the editor
2. **Collaboration** — invite others to edit in real-time
3. **GitHub import** — open any repo in one action

### 1.2 Core Principles

| Principle | What it means |
|-----------|--------------|
| **MRMD doesn't do git** | Users use whatever git tool they prefer. MRMD opens folders. |
| **One rendering engine** | Published site = read-only MRMD editor. Pixel-identical. |
| **FSML = site structure** | Nav tree, URL paths, and visibility all derive from the filesystem |
| **Feels like one machine** | AI assistants, terminals, and tools see a normal Linux box |
| **Collaboration is a spectrum** | Reader → viewer → runner → editor → owner, same URL, same bundle |

---

## 2. How MRMD Server Works

### 2.1 Architecture

mrmd-server is an Express.js HTTP/WebSocket server that brings the MRMD editor to the browser. It reuses services from mrmd-electron (pure Node.js, no Electron dependencies) and serves the same `index.html` UI with an injected HTTP shim.

```
Browser → HTTP/WS → Express routes → mrmd-electron services → runtime workers (MRP protocol)
```

### 2.2 Key Components

- **Express.js** for HTTP routing with CORS
- **WebSocket** (`/events?token=xxx`) for push notifications (file changes, runtime events)
- **Token-based auth** (24-byte base64), checked via query string, header, or cookie
- **Sync manager** — spawns one mrmd-sync (Yjs CRDT) server per project, reference counted
- **AI service** — lazily starts mrmd-ai-server, proxied through `/proxy/:port/*`

### 2.3 API Routes

All under `/api/*`, protected by token auth:

| Route group | Purpose |
|---|---|
| `/api/project` | Detect, create, navigate, watch projects |
| `/api/session` | Python session CRUD, auto-detect for documents |
| `/api/bash`, `/api/r`, `/api/julia` | Runtime session management (same pattern) |
| `/api/file` | Scan, create files |
| `/api/settings` | API keys, quality levels |
| `/api/pty` | Terminal sessions |
| `/api/asset`, `/api/notebook` | Asset management, notebook operations |

### 2.4 Runtime Session Management

All four runtimes (Python, Bash, R, Julia) share the same core pattern:

**Common endpoints (all 4):**
- `GET /` — list sessions
- `POST /` — start session
- `DELETE /:name` — stop session
- `POST /:name/restart` — restart
- `POST /for-document` — get/create session for a document

**Common lifecycle:**
1. Registry files in `~/.mrmd/sessions/` (JSON per session)
2. `findFreePort()` → spawn process → `waitForPort()` → register
3. Dead sessions auto-cleaned on list/attach
4. Stop uses `killProcessTree(pid)`
5. All communicate via MRP protocol over HTTP once started

**Per-language differences:**

| | Python | Bash | R | Julia |
|---|---|---|---|---|
| Extra endpoints | `POST /attach` | — | `GET /available` | `GET /available` |
| Venv management | Yes (auto-installs mrmd-python) | No | No | No |
| Runtime check | No (assumes Python) | No (assumes bash) | Yes (`R --version`) | Yes (`julia --version`) |
| Startup timeout | Default | Default | Default | 60s (Julia is slow) |
| Registry prefix | `{name}.json` | `bash-{name}.json` | `r-{name}.json` | `julia-{name}.json` |

### 2.5 mrmd-js: Browser-Native JavaScript Runtime

Unlike the four process-based runtimes, mrmd-js runs entirely in the browser:

| | Python/Bash/R/Julia | JavaScript (mrmd-js) |
|---|---|---|
| Runs where | Server-side subprocess | Browser iframe |
| Isolation | OS process | Iframe sandbox |
| Needs backend | Yes | No (works offline) |
| Communication | MRP over HTTP | In-process calls |
| Variable persistence | Runtime handles it | `const`→`var` transform |

mrmd-js implements the same MRP API surface (`createSession`, `execute`, `complete`, `hover`, `inspect`) but operates entirely client-side. Supports JavaScript, HTML, CSS, and Mermaid execution.

---

## 3. Cloud Infrastructure

> Full details in `markco-build-plan.md`. Summary of key decisions here.

### 3.1 Architecture

```
AWS EC2 t3.small — ca-central-1 (Montreal)        ~$15 CAD/mo
├── Editor: mrmd-server + mrmd-sync + Caddy
├── Postgres
├── Publish-service
└── Orchestrator (manages elastic runtimes)

CloudFront CDN (global)
├── Static assets (mrmd-reader.iife.js, HTML shell)
└── ~10-30ms globally for published pages

Elastic EC2 runtimes (per-user, on-demand)
├── Start co-located on base server (instant, 256 MB)
├── CRIU migrate to bigger EC2 as memory grows (transparent)
├── CRIU migrate to GPU EC2 when GPU libraries detected
├── Checkpoint + terminate when idle → $0
└── Restore from snapshot when user returns (even months later)
```

Editor runs on the always-on base server (low latency for WebSocket/typing). Runtimes are elastic — they hop between EC2 instances via CRIU, scaling from 256 MB to unlimited RAM to GPU and back, transparently.

### 3.2 Feels Like One Machine

AI assistants (Claude Code, Codex) connect to **one PTY** in the runtime container. They see:

```
- /home/user/ with all projects, data, config
- python, R, julia, bash, git, curl, duckdb all available
- Environment variables with API keys loaded
- Internet access for pip install, git clone, etc.
```

They don't know about containers, Arrow Flight, CRIU, or that the runtime just migrated to a GPU instance. It's just a Linux box.

A thin `mrmd` CLI bridges to the editor/notebook:

```bash
mrmd open 02-methods.md              # open in editor
mrmd run 02-methods.md --cell 3      # run a cell
mrmd sessions                        # list runtime sessions
mrmd sandbox create                  # CRIU fork for AI experimentation
```

### 3.3 Elastic Compute

Runtimes transparently scale up/down via CRIU checkpoint/restore:

```
User runs first cell → runtime starts on base server (instant, 256 MB)

Memory grows past 50% → orchestrator pre-provisions bigger EC2 (~60-90s)
Memory grows past 75% → CRIU --leave-running checkpoint → transfer → restore
                         → proxy switches atomically → user never noticed

pip install torch       → orchestrator pre-provisions GPU spot instance
model.to("cuda")        → CRIU migrate to GPU instance → run → migrate back
                         → GPU instance terminated → $0

User idle 15 min        → CRIU checkpoint → snapshot to EBS → EC2 terminated
User returns            → restore from snapshot → exactly where they left off
```

**Pre-provisioning triggers (code analysis before execution):**

```
pip install torch/tensorflow/jax    → pre-provision GPU (~minutes of headroom)
import torch/cupy/rapids            → pre-provision GPU if not already
model.to("cuda") / .cuda()          → GPU must be ready by now
pd.read_csv("10gb.csv")             → pre-provision big RAM machine
```

### 3.4 CRIU Sandboxes for AI

CRIU enables forking the user's runtime state for AI assistants to experiment in safely:

```
User's runtime (precious state, 2 hours of work)
     │
     │ podman checkpoint --leave-running --export=/tmp/snap.tar.gz  (~2s)
     │
     ▼
AI sandbox (exact clone, disposable)
     │
     │ AI tries 50 approaches, installs risky packages, crashes, etc.
     │
     ▼
Report results → destroy sandbox

User's runtime: completely untouched.
Each AI conversation turn forks from the user's LATEST state.
```

Parallel experimentation: fork 5 sandboxes, try 5 approaches simultaneously, report the best one. Zero risk to user state.

### 3.5 Storage Architecture

| Tier | What | Where | Speed |
|---|---|---|---|
| **User files** | Code, .md, config | EBS on base server | Fast enough (small files) |
| **Runtime data** | CSV, Parquet, Safetensors | EBS on runtime EC2 | ~3 GB/s (gp3) |
| **Snapshots** | CRIU checkpoints | EBS on base server (or S3 for cold) | Transfer within AZ: ~5 Gbps |
| **Cold** | Archives, old datasets | S3 | ~500 MB/s |

User files live on the base server's EBS. Runtime EC2 instances access them via network (same AZ = fast). Snapshots stored on base server EBS for quick restore, archived to S3 for long-term.

### 3.6 Arrow Flight Data Service

For shared large datasets (e.g., 1 TB dataset used by 100-person team):

```
Arrow Flight Data Service (dedicated EC2)
  │
  │ mmap'd Parquet/Arrow files in page cache
  │ ONE copy serves all users (mmap = shared pages)
  │ DuckDB as query engine for server-side filtering
  │
  ├── same-AZ access → ~5 Gbps
  └── cross-region   → ~1 Gbps
```

Users interact via `mrmd.load("dataset")` or `mrmd.query("SELECT ... FROM dataset WHERE ...")`. Server-side filtering means a 1 TB dataset returns only the relevant 50 MB to the user's runtime.

| Phase | Infrastructure | Cost (CAD) |
|---|---|---|
| Start | Data on base server EBS | ~$15/mo (included) |
| Grow | Dedicated r7g EC2 (64-256 GB RAM) | ~$100-400/mo |
| Scale | Multiple data nodes + compute nodes | ~$1000+/mo |

---

## 4. Publishing

### 4.1 Mental Model

FSML already maps filesystem → navigation → rendered site. Publishing is just making that rendering public. No build step in the user's mind.

```
Filesystem:                            Published URL:

01-intro.md                            /intro
02-getting-started/                    /getting-started/
  01-installation.md                   /getting-started/installation
  02-configuration.md                  /getting-started/configuration
03-tutorials/                          /tutorials/
  01-basic.md                          /tutorials/basic
_drafts/upcoming.md                    (not published)
_assets/screenshot.png                 /_assets/screenshot.png (served)
_lib/helpers.py                        (not published)
```

URL derivation: strip numeric prefix, strip extension. Same structure, same order, same titles.

### 4.2 Continuous Publishing

No "publish" button. The project is always live.

```
User edits 01-analysis.md → save → fs watch triggers → incremental rebuild (<1s)
→ CDN cache invalidated → site updated

Delay from save to live: ~2-5 seconds
```

### 4.3 FSML Visibility = Publish Visibility

No new syntax needed. The existing FSML `_` prefix convention determines what's published:

| Prefix | In editor nav | Published |
|---|---|---|
| None (`01-intro.md`) | Visible | Yes |
| `_` (`_drafts/`, `_lib/`, `_assets/`) | Visible (dimmed, below separator) | No (except `_assets/` which is served for images) |
| `.` (`.git/`, `.mrmd/`) | Hidden | No |

**Draft → Published:** Drag from `_drafts/` to top level. Site updates in seconds.
**Published → Draft:** Drag to `_drafts/`. Disappears from site immediately.

### 4.4 Published Site = Read-Only MRMD Editor

The published page uses the **same mrmd-editor rendering engine** in read-only mode. Not a separate static site generator.

```
MRMD Editor (authoring):           Published site (reading):

  Same CodeMirror instance           Same CodeMirror instance
  Same block decorations             Same block decorations
  Same table/math/mermaid widgets    Same table/math/mermaid widgets
  Editable, cursor, toolbar          readOnly: true, no cursor, no toolbar
```

**Why not a separate renderer:**

| Separate static generator | Read-only MRMD editor |
|---|---|
| Two rendering engines to maintain | One rendering engine |
| Drift over time | Pixel-identical, always |
| Tables/math/mermaid may differ | Same widget classes |
| Custom components need two implementations | One implementation |

### 4.5 Reader Implementation

```javascript
// Published page loads mrmd-editor in read-only mode:
mrmd.createReader({
  target: document.getElementById('editor'),
  nav: { target: document.getElementById('nav'), tree: navTree },
  content: markdownContent,
  outputs: cachedCellOutputs,
  // No toolbar, no keybindings, no collaboration, no sessions
});
```

Under the hood: `EditorState.readOnly.of(true)` with the same extensions (decorations, widgets, math, tables, mermaid) minus editing-specific ones.

**Bundle size:**
- Full `mrmd.iife.js`: ~2 MB (gzipped ~600 KB)
- Reader-only `mrmd-reader.iife.js`: ~800 KB (gzipped ~250 KB) — tree-shake editing code

### 4.6 Code Cell Outputs

Published pages show cached outputs (static snapshots from last execution):

```
my-project/
├── 01-analysis.md
├── .mrmd/
│   └── outputs/
│       └── 01-analysis/
│           ├── cell-1.json     ← { "text/html": "<table>...</table>" }
│           └── cell-2.png      ← chart image
```

`.mrmd/` is dot-prefixed → never published. The build process reads outputs and inlines them. User re-runs cells → outputs update → site updates.

### 4.7 Configuration

In `mrmd.md`:

````markdown
## Publishing

```yaml config
publish:
  url: "@maxime/my-analysis"      # markco.dev/@maxime/my-analysis
  visibility: "public"             # public | unlisted | private
  domain: "docs.mycompany.com"    # optional custom domain (Pro+)
```
````

| Visibility | Behavior |
|---|---|
| `public` | Listed in profile, indexed by search engines |
| `unlisted` | Accessible by URL, not listed or indexed |
| `private` | Requires login (team/invited members only) |

Existence of `publish:` in config = project is published. Remove it = unpublished.

### 4.8 Published Nav and Links

Same FSML-derived nav tree. `[[internal links]]` resolve to published URLs. `[[next]]`/`[[prev]]` become navigation buttons.

```
┌──────────────┐
│ Introduction │  → /intro
│ Getting      │
│ Started      │
│   Setup    ◄ │  → /getting-started/setup (current)
│   Config     │  → /getting-started/config
│ Tutorials    │
│   Basic      │  → /tutorials/basic
│──────────────│
│ Edit on      │  → opens markco.dev editor (if user has access)
│ markco ✎      │
└──────────────┘
```

### 4.9 Build Architecture

No static file generation. Server reads from disk and serves:

```
Request: markco.dev/@maxime/my-analysis/getting-started/setup

1. Map URL to FSML: /getting-started/setup → 02-getting-started/01-setup.md
2. Read markdown content from disk
3. Read cached outputs from .mrmd/outputs/
4. Read nav tree (precomputed from filesystem)
5. Serve HTML shell + mrmd-reader.iife.js + content as JSON
```

CDN caches the rendered HTML. Invalidated when file changes (filesystem watcher already exists).

### 4.10 Local Preview (mrmd-electron / mrmd-server)

For users running MRMD locally:

```
localhost:8080/                                  ← editor (normal use)
localhost:8080/published/my-analysis/            ← reader view (preview published site)
```

Exact same rendering as markco.dev published pages.

---

## 5. GitHub Integration

### 5.1 Principle: MRMD Opens Folders

MRMD doesn't do git. Users use whatever git tool they prefer — terminal, GitHub Desktop, VS Code, Tower, etc.

MRMD's relationship with git:
- Opens folders (doesn't care how they got there)
- Watches the filesystem for changes (reacts to external edits, including `git pull`)
- Never runs git commands on behalf of the user

### 5.2 Cloud: One-Action Import

On markco.dev, the only GitHub integration is clone + open:

```
User pastes: github.com/someone/cool-project

markco.dev:
  1. git clone into /home/user/repos/someone-cool-project/
  2. Has mrmd.md? → open as MRMD project
     No mrmd.md?  → offer to create one (infer structure from .md files)
  3. Redirect to markco.dev/someone/cool-project (editor view)
  Done.
```

After that, the user manages git from their terminal (PTY in the runtime container) or any git tool they install.

### 5.3 GitHub Repo Compatibility

A GitHub repo with `mrmd.md` is an MRMD project. The same files work in three contexts:

| Context | What happens |
|---|---|
| **On GitHub** | Renders as normal markdown (images work — relative paths) |
| **On markco.dev** | Full MRMD editor + published site |
| **In mrmd-electron** | Desktop editor, full experience |

No duplication. Same files, three views.

### 5.4 Desktop (mrmd-electron)

User clones a repo however they want, then opens the folder in MRMD:

```bash
# User's terminal (not MRMD's job):
git clone https://github.com/someone/project ~/Projects/project

# Then opens ~/Projects/project in MRMD electron
# Or: drags folder onto MRMD icon
```

MRMD watches the filesystem. If the user does `git pull` in another terminal and files change, MRMD reacts automatically.

---

## 6. Collaboration

### 6.1 Existing Pieces

| Component | Package | What it does |
|---|---|---|
| mrmd-sync | Separate package | Yjs CRDT server — real-time collaborative editing |
| Sync manager | mrmd-server | Spawns one mrmd-sync per project, reference counted |
| WebSocket events | mrmd-server | Push notifications to connected browsers |
| Shared filesystem | Cloud architecture | Both users see same files |
| Auth + tokens | mrmd-server | Token-based access per user |

### 6.2 Invite Flow

```
┌─────────────────────────────────────────────────┐
│  Share                                           │
│                                                  │
│  markco.dev/@maxime/my-analysis                   │
│                                                  │
│  People:                                         │
│    maxime (you)                    Owner          │
│    sarah@company.com              Editor  [×]    │
│                                                  │
│  ┌──────────────────────────────┐                │
│  │ Add by email or username     │  [Invite]      │
│  └──────────────────────────────┘                │
│                                                  │
│  ── Or share link ──────────────────────────     │
│  🔗 markco.dev/join/a7f3b2c1     [Copy]          │
│     Anyone with this link can edit               │
│     Expires: 7 days  [▾]                         │
│                                                  │
└─────────────────────────────────────────────────┘
```

Two methods:
- **By username/email** — notification sent, project appears in their sidebar
- **By link** — anyone with the link can join (like Google Docs)

### 6.3 What Happens When a Collaborator Joins

```
Sarah clicks invite link

Orchestrator:
  1. Authenticate Sarah
  2. She connects to Maxime's project directly (no copy)
  3. Editor container mounted to Maxime's project volume
  4. Connected to Maxime's mrmd-sync server (same Yjs rooms)
  5. Sarah sees the same project, same files, same nav
```

### 6.4 Real-Time Editing

Both users open the same document. mrmd-sync handles it via Yjs CRDT:

```
Maxime's edits → Yjs CRDT merge → Sarah sees
Sarah's edits  → Yjs CRDT merge → Maxime sees

Conflict-free. No locking. Both type simultaneously.
```

Each user sees the other's cursor and selection (Yjs awareness protocol):

```
┌──────────────────────────────────────────────────────┐
│  # Data Collection Methods                            │
│                                                       │
│  We collected data from three sources|                │
│                        ↑ Maxime's cursor              │
│                                                       │
│  The sampling strategy was ██████████                 │
│                            ↑ Sarah is typing here     │
│                              (highlighted in blue)    │
└──────────────────────────────────────────────────────┘

┌─────────────────┐
│ Online (2)       │
│  ● Maxime        │
│  ● Sarah         │
└─────────────────┘
```

### 6.5 What's Shared, What's Separate

| Resource | Shared? | Why |
|---|---|---|
| Files on disk | Shared | One copy, both read/write via mrmd-sync |
| Nav tree | Shared | Same filesystem = same nav |
| mrmd-sync rooms | Shared | Real-time co-editing per document |
| Published site | Shared | One project = one URL |
| Runtime sessions | Configurable | See below |
| Editor UI state | Separate | Own scroll position, open tabs, etc. |
| Settings / API keys | Separate | Each user's own config |

### 6.6 Runtime Sessions: Shared or Separate

Configurable per project in `mrmd.md`:

**Shared sessions (default for small teams):**

````markdown
```yaml config
collaboration:
  sessions: "shared"
```
````

Both users work in the same Python/R/Julia session. Maxime runs `df = pd.read_csv(...)`, Sarah can immediately run `df.describe()`. Like pair programming on one machine.

**Separate sessions:**

````markdown
```yaml config
collaboration:
  sessions: "separate"
```
````

Each user gets their own runtime sessions. They edit the same files (via mrmd-sync) but execute cells independently. Better when working on different parts of the project.

### 6.7 Permissions

| Role | Edit files | Run cells | Change config | Invite others | Publish |
|---|---|---|---|---|---|
| **viewer** | No | No | No | No | No |
| **runner** | No | Yes (own session) | No | No | No |
| **editor** | Yes | Yes | No | No | No |
| **admin** | Yes | Yes | Yes | Yes | Yes |
| **owner** | Yes | Yes | Yes | Yes | Yes |

`viewer` — sees real-time edits and cursors but can't modify. Good for presenting/teaching.

`runner` — can execute cells in their own session but can't change the notebook. Good for students running a teacher's notebook.

````markdown
```yaml config
collaboration:
  default_role: "editor"    # what invite links grant
```
````

### 6.8 The Reader ↔ Collaborator Spectrum

Published site, viewer, runner, editor, and owner are all points on one spectrum. Same URL, same mrmd-editor bundle, different permission flags:

```
Published reader    Viewer           Runner          Editor          Owner
(anonymous)        (logged in)      (logged in)     (invited)       (creator)
────────────────────────────────────────────────────────────────────────────
mrmd-reader        mrmd-reader      mrmd-editor     mrmd-editor     mrmd-editor
read-only          read-only        read-only files full editing    full editing
cached outputs     live cursors     own sessions    shared/own      shared/own
no auth            auth required    auth required   auth required   auth required
static CDN         WebSocket        WebSocket       WebSocket       WebSocket
                   (awareness)      (awareness)     (sync+aware)    (sync+aware)
```

Implementation is just flags:

```javascript
mrmd.create({
  target: el,
  content: doc,
  readOnly: role === 'viewer' || role === 'reader',
  showCursors: role !== 'reader',
  canExecute: role !== 'viewer' && role !== 'reader',
  syncUrl: role !== 'reader' ? syncWebSocketUrl : null,
});
```

### 6.9 Desktop Collaboration (mrmd-electron)

Same protocol, different transport:

```
Maxime runs mrmd-electron locally.
Clicks "Share" → starts mrmd-server on a port.
Gets URL: https://abc123.markco.dev (tunneled)
         or https://maxime-mbp.local:8080 (local network)

Sarah opens that URL in her browser.
Connected to Maxime's local mrmd-sync.
Same real-time editing experience as cloud.
```

Or: both on same LAN → Bonjour/mDNS discovery → Sarah sees "Maxime's project" in her MRMD app.

---

## 7. URL Scheme

### 7.1 markco.dev URLs

| URL pattern | What it is |
|---|---|
| `markco.dev/login` | OAuth sign-in |
| `markco.dev/user/repo` | Clone + open a GitHub repo in editor |
| `markco.dev/@user/project` | Published site (reader mode) |
| `markco.dev/@user/project/path` | Published page (reader mode) |
| `markco.dev/join/abc123` | Collaboration invite link |
| `user.markco.dev` | Custom subdomain for published sites (Pro+) |
| `custom-domain.com` | Custom domain via CNAME (Pro+) |

### 7.2 Relationship Between URLs

```
Where the code lives:     github.com/maxime/my-analysis
Where you edit it:        markco.dev/maxime/my-analysis
Where the public reads:   markco.dev/@maxime/my-analysis
                          (or docs.mycompany.com via custom domain)
```

The `@` prefix distinguishes published view from editor view.

---

## 8. User Experience Flows

### 8.1 New User

```
1. Visit markco.dev → Sign in with Google/GitHub
2. Workspace created with getting-started project
3. Redirected to editor
4. Total time: ~5-10 seconds
```

### 8.2 Open a GitHub Repo

```
1. Paste github.com/someone/project into Markco
2. Repo cloned, editor opens
3. User edits .md files, runs code cells
4. Git managed from terminal (their choice of tool)
```

### 8.3 Publish a Project

```
1. Add to mrmd.md:
   publish:
     url: "@maxime/my-analysis"
     visibility: "public"

2. Done. Site is live. Updates on every save.
```

### 8.4 Unpublish a Page

```
1. Drag page from main nav into _drafts/
2. Page disappears from published site immediately
3. Still visible in editor (dimmed, under separator)
```

### 8.5 Invite a Collaborator

```
1. Click "Share" in editor
2. Copy invite link
3. Send to colleague
4. They click link → sign in → land in the same project
5. Both see each other's cursors, edit in real-time
```

### 8.6 AI Assistant Explores Safely

```
1. User asks AI to "try different feature engineering approaches"
2. CRIU checkpoint → fork into disposable sandbox (~2s)
3. AI experiments freely in sandbox
4. AI reports results
5. Sandbox destroyed. User's runtime untouched.
```

---

## 9. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                    CloudFront CDN (global)                            │
│  Static assets: mrmd-reader.iife.js, HTML, CSS                       │
│  Published pages: markco.dev/@user/project                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────────────┐
│            Base Server — EC2 t4g.small (ca-central-1)                │
│                                                                       │
│  Caddy (reverse proxy, auto-HTTPS for markco.dev)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐             │
│  │ mrmd-server  │  │ auth-service │  │ publish-service│             │
│  │ mrmd-sync    │  │              │  │                │             │
│  └──────┬───────┘  └──────────────┘  └────────────────┘             │
│         │                                                             │
│  ┌──────┴──────────────────────────────┐                             │
│  │ Orchestrator                         │                             │
│  │  compute-manager (EC2 API + CRIU)    │                             │
│  │  resource-monitor (memory + GPU hints)│                             │
│  │  Postgres                             │                             │
│  └──────┬───────────────────────────────┘                             │
│         │                                                             │
│  ┌──────┴──────┐  Snapshots stored on EBS                            │
│  │ Local       │  (restore when user returns)                         │
│  │ runtimes    │                                                      │
│  │ (256 MB     │                                                      │
│  │  starter)   │                                                      │
│  └─────────────┘                                                      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ CRIU migrate (transparent)
            ┌──────────────────┼──────────────────┐
            │                  │                   │
     ┌──────┴───────┐  ┌──────┴──────┐   ┌───────┴──────────┐
     │ EC2 CPU      │  │ EC2 GPU     │   │ Data Service      │
     │ (elastic)    │  │ (on-demand) │   │ (future)          │
     │              │  │             │   │                   │
     │ t4g.small →  │  │ g5.xlarge   │   │ Arrow Flight      │
     │ t4g.medium → │  │ spot        │   │ DuckDB            │
     │ t4g.xlarge   │  │             │   │ mmap'd Parquet    │
     │              │  │ CRIU +      │   │                   │
     │ Podman+CRIU  │  │ CRIUgpu    │   │ Shared datasets   │
     └──────────────┘  └─────────────┘   └───────────────────┘
```

---

## 10. What MRMD Does and Does Not Do

| MRMD's job | NOT MRMD's job |
|---|---|
| Open folders, edit markdown | Git operations (user's tool of choice) |
| Watch filesystem, react to changes | GitHub UI (PRs, issues, etc.) |
| Render content (one engine: editor + reader) | Static site generation (no separate build) |
| Serve published sites (reader mode) | File sync across machines (NFS/JuiceFS handles this) |
| Real-time collaboration (mrmd-sync/Yjs) | Version control (git does this) |
| Runtime management (sessions, CRIU sandboxes) | Package management (user's pip/uv/etc.) |

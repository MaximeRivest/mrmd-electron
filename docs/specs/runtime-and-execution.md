# Runtime and Execution Specification

> How mrmd manages code execution environments across projects and documents.

---

## 1. Overview

### 1.1 What is a Session?

**A session is a Jupyter kernel.** If you understand Jupyter, you understand sessions.

| Session IS | Session IS NOT |
|------------|----------------|
| A real Python process | A subprocess spawned by another Python |
| One PID | A "connection" or "channel" |
| One namespace (`globals()`) | An abstraction over multiple processes |
| One port (MRP protocol) | Something that can switch interpreters |

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Session "my-project:default"                                               │
│  ════════════════════════════                                               │
│                                                                             │
│  PID: 12345                                                                 │
│  Port: 41765                                                                │
│  Python: /path/to/project/.venv/bin/python                                 │
│  CWD: /path/to/project                                                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  globals() = { 'df': <DataFrame>, 'model': <vLLM>, 'x': 42 }        │   │
│  │  imports  = [ numpy, pandas, torch, vllm ]                          │   │
│  │  GPU mem  = 24GB allocated                                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│       ▲              ▲              ▲                                       │
│       │              │              │                                       │
│  intro.md      methods.md     results.md                                   │
│  (connected)   (connected)   (connected)                                   │
│                                                                             │
│  Three documents, ONE process, ONE namespace, shared variables              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Why Real Processes (Not Subprocesses)?

Sessions are **real Python processes**, not subprocesses spawned from another Python. This matters for:

**GPU Memory:**
- Subprocesses can't properly release GPU memory when killed
- Real processes: `kill -9 <pid>` → GPU memory freed immediately
- vLLM, PyTorch, CUDA contexts require real process isolation

**Resource Management:**
- Real process has its own memory space
- Kill the session = kill the process = release everything
- No parent process holding references

**How it works:**
```bash
# Session is started as a real process, not subprocess.Popen() from Python
/path/to/.venv/bin/python -m mrmd_python --port 41765 --cwd /path/to/project

# To kill and release all resources:
kill -9 12345  # or killpg for entire process group
```

### 1.3 Core Concepts

| Concept | Definition |
|---------|------------|
| **Project** | A folder with `mrmd.md` — defines defaults for sessions |
| **Session** | A Python process running mrmd-python. One PID, one namespace, one port. |
| **Document** | Connects to a session. Multiple docs can share one session. |
| **CWD** | Working directory for the session |
| **Venv** | Which Python interpreter runs the session |

### 1.4 Session = Process = Interpreter

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Project A (.venv-a)              Project B (.venv-b)                       │
│  ┌──────────────────┐             ┌──────────────────┐                      │
│  │  mrmd.md         │             │  mrmd.md         │                      │
│  │  session: default│             │  session: default│                      │
│  │  venv: .venv     │             │  venv: .venv     │                      │
│  └────────┬─────────┘             └────────┬─────────┘                      │
│           │                                │                                │
│           ▼                                ▼                                │
│  ┌──────────────────┐             ┌──────────────────┐                      │
│  │  Session         │             │  Session         │                      │
│  │  PID 12345       │             │  PID 67890       │                      │
│  │  Port 41765      │             │  Port 41766      │                      │
│  │  .venv-a/python  │             │  .venv-b/python  │                      │
│  └──────────────────┘             └──────────────────┘                      │
│                                                                             │
│  Different venvs → Different sessions → Different processes                 │
│  Want isolation? Start another session.                                     │
│  Want to share state? Connect to the same session.                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Project Configuration (mrmd.md)

### 2.1 Location and Purpose

`mrmd.md` is the **project root marker**. Its presence defines:
1. Where the project starts (for navigation, asset paths, etc.)
2. Default runtime configuration for all documents in the project
3. Build and output settings

### 2.2 Why Markdown, Not YAML?

mrmd is a markdown editor. The project config should be editable IN mrmd, not in a separate tool. By making the config a markdown document:

- **Documentable** — explain WHY the config is the way it is
- **Editable in mrmd** — full editor experience, code execution, everything
- **Versionable** — meaningful diffs with context
- **Literate** — the config teaches future you

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  TYPICAL APP                              mrmd                              │
│  ───────────────────────────              ───────────────────────────────   │
│                                                                             │
│  Settings UI (modal)                      mrmd.md (markdown document)       │
│       ↓ writes to                              ↓ contains                   │
│  config.yaml (hidden)                     ```yaml config``` blocks          │
│       ↓ reads from                             ↓ extracted as               │
│  App behavior                             Project configuration             │
│                                                                             │
│  File is implementation detail            File IS the documentation         │
│  UI is the interface                      Config blocks are the data        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Config Extraction

Configuration is extracted from code blocks tagged with `config`:

````markdown
# My Project

This is an ML research project.

```yaml config
name: "ML Research"
```

## Session Setup

We use a shared session because model loading is slow.

```yaml config
session:
  python:
    venv: ".venv"
    name: "default"
```
````

The `config` tag after `yaml` marks it as configuration (vs. example YAML).

### 2.4 Multiple Config Blocks (Deep Merge)

Multiple `yaml config` blocks are **deep merged** in document order:

````markdown
```yaml config
session:
  python:
    venv: ".venv"
```

```yaml config
session:
  python:
    name: "default"
```
````

**Result:**
```yaml
session:
  python:
    venv: ".venv"
    name: "default"
```

This allows organizing config into logical sections with explanatory prose between them.

### 2.5 Minimal Configuration

````markdown
# My Project

```yaml config
name: "My Project"
```
````

With just this, mrmd will:
- Create `.venv/` alongside `mrmd.md` if it doesn't exist
- Install `mrmd-python` in that venv
- Use project root as CWD for all code execution
- Start a shared runtime for all documents

### 2.6 Full Configuration Example

````markdown
# Vision Research

A project for training and evaluating vision models.

## Project Metadata

```yaml config
name: "Vision Research"
description: "CNN experiments on ImageNet"
author: "Research Team"
```

## Session Configuration

We use a shared default session for most work. The venv contains
PyTorch, torchvision, and our custom training utilities.

```yaml config
session:
  python:
    venv: ".venv"
    cwd: "."
    name: "default"
    auto_start: true
```

For GPU-intensive training runs, individual documents can override
to use a dedicated session (see `04-training.md` frontmatter).

## Environment Check

```python
# You can run this to verify your setup
import torch
print(f"CUDA available: {torch.cuda.is_available()}")
print(f"Device count: {torch.cuda.device_count()}")
```

```output
CUDA available: True
Device count: 2
```
````

### 2.7 Session Configuration Details

| Field | Default | Description |
|-------|---------|-------------|
| `session.python.venv` | `.venv` | Path to virtual environment |
| `session.python.cwd` | `.` (project root) | Working directory for the session |
| `session.python.name` | `"default"` | Session name (becomes `{project}:{name}`) |
| `session.python.auto_start` | `true` | Start session when project opens |

---

## 3. Document-Level Overrides

### 3.1 Frontmatter Configuration

Individual documents can override project settings:

```yaml
---
title: "GPU Experiments"
session:
  python:
    name: "gpu-session"             # Connect to different session
    cwd: "../experiments"           # Different working directory (if new session)
    venv: "../ml-env/.venv"         # Different venv (if new session)
---

# GPU Experiments

This document uses a dedicated GPU session...
```

### 3.2 Override Behavior

| Setting | Document Override | What Happens |
|---------|-------------------|--------------|
| `name` | Different name | Connects to or creates a different session (different PID) |
| `cwd` | Different path | Only applies when creating new session |
| `venv` | Different path | Only applies when creating new session |

**Note:** If the session already exists, `cwd` and `venv` are ignored — you connect to the existing process as-is.

### 3.3 Session Binding

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Project: my-thesis/                                                        │
│  ├── mrmd.md (session: "default", venv: ".venv")                           │
│  │                                                                          │
│  │                                    Session "default" (PID 12345)        │
│  │                                    ┌─────────────────────────────┐      │
│  ├── 01-intro.md ────────────────────►│ namespace: {df, model, ...} │      │
│  ├── 02-methods.md ──────────────────►│ .venv/bin/python            │      │
│  ├── 03-results.md ──────────────────►│ Port 41765                  │      │
│  │                                    └─────────────────────────────┘      │
│  │                                                                          │
│  │                                    Session "gpu" (PID 67890)            │
│  │                                    ┌─────────────────────────────┐      │
│  └── 04-gpu-experiments.md ──────────►│ namespace: {cuda, tensor,...│      │
│      (frontmatter: session: "gpu")    │ ml-env/.venv/bin/python     │      │
│      (frontmatter: venv: "...")       │ Port 41766                  │      │
│                                       └─────────────────────────────┘      │
│                                                                             │
│  3 docs share session "default" (same PID, same variables)                 │
│  1 doc has its own session "gpu" (different PID, isolated)                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Project Initialization

### 4.1 When `mrmd.md` is Created

When user creates a new project (or opens a folder without `mrmd.md`):

1. **Create `mrmd.md`** with minimal config
2. **Create `.venv/`** if it doesn't exist
3. **Install `mrmd-python`** in the venv

````markdown
# My Project

```yaml config
name: "My Project"
session:
  python:
    venv: ".venv"
```
````

### 4.2 Startup Sequence

When opening a project:

```output
1. Read mrmd.md, extract ```yaml config``` blocks
2. Deep merge config blocks in document order
3. Resolve venv path (relative to project root)
4. Check if runtime already running for this venv
   ├── Yes: Reuse existing runtime
   └── No: Start new runtime
5. Register session in runtime registry
6. Ready to execute code
```

---

## 5. Session Lifecycle

### 5.1 Starting a Session

```output
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  mrmd-electron                                                 │
│       │                                                        │
│       │ "Start session for project X"                          │
│       ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  1. Read project X's mrmd.md, extract config            │   │
│  │  2. Resolve venv: /path/to/project/.venv                │   │
│  │  3. Find free port: 41765                               │   │
│  │  4. Spawn REAL PROCESS (not subprocess):                │   │
│  │     /path/to/project/.venv/bin/python -m mrmd_python    │   │
│  │       --port 41765                                       │   │
│  │       --cwd /path/to/project                            │   │
│  │  5. Register in ~/.mrmd/sessions/{name}.json            │   │
│  │  6. Return session URL: http://localhost:41765/mrp/v1   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 5.2 Session Registry

```json
// ~/.mrmd/sessions/my-project-default.json
{
  "name": "my-project:default",
  "pid": 12345,
  "port": 41765,
  "venv": "/path/to/project/.venv",
  "cwd": "/path/to/project",
  "started_at": "2025-01-17T10:30:00Z"
}
```

### 5.3 Stopping a Session

Sessions are killed when:
- User explicitly stops them (Restart Session)
- Project is closed (configurable: keep alive or kill)
- mrmd-electron quits

```bash
# Kill releases ALL resources (GPU memory, CUDA contexts, file handles)
kill -9 <pid>  # Or killpg for entire process group

# This is why sessions are REAL processes, not subprocesses.
# Subprocess GPU memory doesn't release properly.
```

---

## 6. MRP Protocol (mrmd-python)

Each session runs an mrmd-python server exposing the MRP (Markdown Runtime Protocol) API.

### 6.1 Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mrp/v1/execute` | POST | Execute code, stream output |
| `/mrp/v1/interrupt` | POST | Interrupt running execution |
| `/mrp/v1/complete` | POST | Get completions |
| `/mrp/v1/inspect` | POST | Get documentation |
| `/mrp/v1/status` | GET | Session status |

### 6.2 Execute Request

```json
POST /mrp/v1/execute
{
  "code": "print('hello')",
  "execution_id": "exec-123"
}
```

### 6.3 Streaming Response

```
event: output
data: {"stream": "stdout", "text": "hello\n"}

event: output
data: {"stream": "result", "text": "None", "mime": "text/plain"}

event: status
data: {"status": "completed", "execution_id": "exec-123"}
```

### 6.4 Input Request (stdin)

When code calls `input()`:

```
event: input_request
data: {"prompt": "Enter your name: ", "execution_id": "exec-123"}
```

Editor shows input prompt, user types, sends:

```json
POST /mrp/v1/input
{
  "execution_id": "exec-123",
  "text": "Alice\n"
}
```

---

## 7. Session Management

### 7.1 What is a Session?

A session is a **REPL instance** — a single Python interpreter process with:
- One PID
- One namespace (variables persist)
- One execution queue
- One history

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Session "my-thesis:default" (PID 12345)                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                                                                       │ │
│  │  Namespace: { 'df': <DataFrame>, 'model': <Model>, 'x': 42 }         │ │
│  │  Imports:   numpy, pandas, sklearn                                   │ │
│  │  CWD:       /path/to/my-thesis                                       │ │
│  │  History:   [cell1, cell2, cell3, ...]                               │ │
│  │                                                                       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│         ▲              ▲              ▲                                    │
│         │              │              │                                    │
│    intro.md      methods.md     results.md                                │
│    (bound)       (bound)        (bound)                                   │
│                                                                             │
│  Three documents, ONE session, ONE namespace, ONE PID                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Session Naming

Sessions are identified by: `{project}:{session_name}`

Examples:
- `my-thesis:default` — Default session for my-thesis project
- `my-thesis:gpu` — Separate GPU session (different PID, different state)
- `experiments:main` — Main session for experiments project

### 7.3 Session State

Since a session IS a REPL process, it maintains:
- **Variables**: Python namespace persists across cells and across documents
- **Imports**: Imported modules stay imported
- **Working directory**: Can be changed by code, but starts at configured CWD
- **History**: Execution history for the session (all cells from all bound documents)

### 7.4 Binding Documents to Sessions

Multiple documents can bind to the same session:

```yaml
# doc-a.md frontmatter
---
runtime:
  python:
    session: "shared-analysis"
---

# doc-b.md frontmatter
---
runtime:
  python:
    session: "shared-analysis"
---
```

**Effect:** Both documents execute in the SAME Python process. A variable defined in doc-a is immediately available in doc-b.

### 7.5 Session Isolation

To isolate documents, use different session names:

```yaml
# experiment-1.md
---
runtime:
  python:
    session: "exp1"
---

# experiment-2.md
---
runtime:
  python:
    session: "exp2"
---
```

**Effect:** Two separate Python processes. Variables don't leak between them.

---

## 8. Editor Integration

### 8.1 Design Philosophy

Session configuration lives in YAML (frontmatter or `mrmd.md` config blocks). The editor enhances this YAML with:

1. **Autocomplete/pickers** — for paths, session names, etc.
2. **Inline status indicators** — connection state, PID, etc.
3. **CodeLens actions** — start, stop, restart buttons above the block

The YAML stays YAML. We don't replace it with a form UI.

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  THE PRINCIPLE                                                              │
│                                                                             │
│  YAML is the source of truth                                                │
│  Editor enhancements are views/actions on that source                       │
│  Like how nav tree is a view of the filesystem                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Config Block UI (mrmd.md)

The `yaml config` block in `mrmd.md` renders with CodeLens actions and status:

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ```yaml config                                                             │
│  ▶ Start  ↻ Restart  ■ Stop                      ← CodeLens actions        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  session:                                                                   │
│    python:                                                                  │
│      venv: ".venv"  ────────────────────────────── [.venv ▾] autocomplete  │
│      name: "default"  ──────────────────────────── ● Connected (PID 12345) │
│      cwd: "."                                                               │
│  ```                                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Element | Behavior |
|---------|----------|
| CodeLens `▶ Start` | Start session (shown when disconnected) |
| CodeLens `↻ Restart` | Kill and restart session |
| CodeLens `■ Stop` | Kill session |
| Venv autocomplete | Shows available venvs (.venv, ../other/.venv, etc.) |
| Status indicator | Shows connection state, PID (right-aligned, unobtrusive) |

### 8.3 Frontmatter UI (documents)

Document frontmatter gets the same treatment:

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ---                                                                        │
│  title: "GPU Experiments"                                                   │
│  session:                                ▶ Start  ↻ Restart   ← CodeLens   │
│    python:                                                                  │
│      name: "gpu-session"  ───────────────────────── ○ Not started          │
│      venv: "../ml-env/.venv"  ───────────────────── ✓ Found                │
│  ---                                                                        │
│                                                                             │
│  # GPU Experiments                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.4 Status Indicators

| Status | Indicator | Meaning |
|--------|-----------|---------|
| Connected | ● Green | Session running, ready to execute |
| Starting | ◐ Yellow | Session process starting up |
| Not started | ○ Gray | No session (need to start one) |
| Error | ● Red | Session crashed (process died) |
| Venv found | ✓ | Virtual environment exists at path |
| Venv missing | ✗ | Virtual environment not found |

### 8.5 Session Actions

| Action | Trigger | Effect |
|--------|---------|--------|
| Start | CodeLens `▶` or first cell run | Start session process |
| Restart | CodeLens `↻` or `Ctrl+Shift+R` | Kill process, start new one, clear all state |
| Stop | CodeLens `■` | Kill session process |
| Interrupt | `Ctrl+C` (during execution) | Interrupt current execution (keeps session) |

### 8.6 Cell Execution Flow

```output
User runs cell
     │
     ▼
┌─────────────────────────────────────────┐
│ 1. Get document's runtime config        │
│    (from frontmatter or mrmd.md)        │
│                                         │
│ 2. Find or create session               │
│    - Check if runtime exists for venv   │
│    - If not, start one                  │
│                                         │
│ 3. Send execute request to runtime      │
│    POST /mrp/v1/execute                 │
│                                         │
│ 4. Stream output to document            │
│    - Append to output block             │
│    - Handle input() prompts             │
│                                         │
│ 5. Mark execution complete              │
└─────────────────────────────────────────┘
```

---

## 9. Multi-Language Support (Future)

### 9.1 Architecture

Each language has its own session type:

```yaml
# mrmd.yaml
session:
  python:
    venv: ".venv"
    name: "py-default"

  shell:
    cwd: "."
    name: "sh-default"

  julia:
    project: "."  # Julia project directory
    name: "jl-default"

  r:
    library: ".renv"
    name: "r-default"
```

### 9.2 One Session per Language

````output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Project with multiple languages = multiple sessions                        │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │ Python       │  │ Shell        │  │ Julia        │                      │
│  │ Session      │  │ Session      │  │ Session      │                      │
│  │ PID 12345    │  │ PID 12346    │  │ PID 12347    │                      │
│  │ Port 41765   │  │ Port 41766   │  │ Port 41767   │                      │
│  └──────────────┘  └──────────────┘  └──────────────┘                      │
│         ▲                 ▲                 ▲                               │
│         │                 │                 │                               │
│  ```python         ```bash           ```julia                              │
│  print("hi")       echo "hi"         println("hi")                         │
│  ```               ```               ```                                   │
│                                                                             │
│  Each language = separate process = separate session                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
````

---

## 10. Error Handling

### 10.1 Session Cannot Start

in code cell output chunk:

```output
┌─────────────────────────────────────────────────────────────────┐
│  ⚠ Cannot start Python session                                  │
│                                                                 │
│  The virtual environment at .venv was not found.                │
│                                                                 │
│  [ go to frontmatter ]  [ go to config mrmd.yaml ]   │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 Session Crashed

```output
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Python session crashed                                       │
│                                                                 │
│  The session process (PID 12345) exited unexpectedly.           │
│  Your variables and state have been lost.                       │
│                                                                 │
│  
└─────────────────────────────────────────────────────────────────┘
```
---

## 11. Configuration Reference

### 11.1 Project Level (mrmd.md)

Config blocks in `mrmd.md` are deep-merged in document order:

````markdown
```yaml config
session:
  python:
    venv: ".venv"           # Path to venv (relative to project root)
    cwd: "."                # Default CWD (relative to project root)
    name: "default"         # Session name (becomes {project}:{name})
    auto_start: true        # Start session when project opens
    timeout: 300            # Execution timeout (seconds)
    env:                    # Additional environment variables
      CUDA_VISIBLE_DEVICES: "0"
```
````

### 11.2 Document Level (frontmatter)

```yaml
---
session:
  python:
    name: "custom"          # Connect to different session
    cwd: "../data"          # Override CWD (if starting new session)
    venv: "../other/.venv"  # Override venv (if starting new session)
---
```

### 11.3 Precedence

1. Document frontmatter (highest)
2. Project `mrmd.md` config blocks (merged)
3. Built-in defaults (lowest)

### 11.4 Session Resolution

When a document needs to execute code:

1. Get session name from frontmatter, or project default, or `"default"`
2. Check if session `{project}:{name}` is already running
3. If running → connect to it
4. If not → start new session with configured venv/cwd

---

## 12. Summary

**A session is analogous to a Jupyter kernel.** One process, one PID, one namespace.

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  THE MENTAL MODEL                                                           │
│                                                                             │
│  Session = Process = Kernel                                                │
│  ├── Real Python process (not a subprocess)                                │
│  ├── One PID, one port, one namespace                                      │
│  ├── Kill it → GPU memory freed, all state gone                            │
│  └── Named: {project}:{name}                                               │
│                                                                             │
│  Document → connects to → Session                                          │
│  ├── Like notebook connecting to kernel                                    │
│  ├── Multiple docs can share one session                                   │
│  ├── Shared session = shared variables                                     │
│  └── Different session = isolated                                          │
│                                                                             │
│  mrmd.md                                                                    │
│  ├── Marks project root (it's a markdown document!)                        │
│  ├── Config in ```yaml config``` blocks (deep merged)                      │
│  ├── Documentable: explain WHY, not just WHAT                              │
│  └── Documents can override via frontmatter                                │
│                                                                             │
│  Defaults (zero config)                                                    │
│  ├── venv: .venv (created if missing)                                      │
│  ├── cwd: project root                                                     │
│  └── session: "default" (all project docs share it)                        │
│                                                                             │
│  WHY REAL PROCESSES?                                                        │
│  ├── GPU memory releases properly on kill                                  │
│  ├── vLLM/CUDA need real process isolation                                 │
│  └── No subprocess funkiness                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

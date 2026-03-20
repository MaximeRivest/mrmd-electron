# Agentic Orchestration in MRMD

This document outlines the architecture and patterns for programmatic, recursive agent spawning within MRMD notebooks.

## The Vision
The goal is to allow a "Driver Agent" or a human user to use a deterministic control flow (e.g., Python `for` loops, `if` statements) to dispatch fuzzy, non-deterministic tasks to sub-agents. 

This enables recursivity: an agent in a notebook can spawn sub-agents to solve sub-problems, and those sub-agents can spawn their own sub-agents.

## The Anti-Patterns (Red Herrings)

When designing this, we must actively avoid:

1. **Simultaneous editing of the same UI document:** Multiple agents using `mrmd cells insert` on the same `mrmd-electron` document will cause race conditions and corrupt the Yjs state. (Rule: 1 document = 1 active driver).
2. **Shared runtime namespace concurrency:** Multiple agents running code in the same Python REPL simultaneously will overwrite variables and cause state collisions.
3. **Headless UI spawning:** Spawning full `mrmd-electron` instances (Chromium + Node) for sub-agents is too heavy. Sub-agents only need an execution environment, not a UI.

## The Golden Path: "The Orchestrator Pattern"

The main MRMD notebook acts as the **Command Center**.

1. **Map:** A Python cell loops over tasks and spawns isolated sub-agents as background processes.
2. **Isolate:** Each sub-agent is given its own temporary workspace (folder) and isolated context.
3. **Reduce:** Sub-agents write their results to disk (JSON/SQLite). The Master Notebook waits for completion, reads the files, and aggregates the results for the user.

### Example Implementation

A tiny Python SDK (`mrmd_orchestrator`) can wrap this logic so it is clean to use inside a notebook cell:

```python
import subprocess
import json
from pathlib import Path

def spawn_pi_worker(task_id, prompt, input_data):
    # 1. Create an isolated workspace for this sub-agent
    workspace = Path(f"./agent_workspaces/task_{task_id}")
    workspace.mkdir(parents=True, exist_ok=True)
    
    # 2. Write the input data for the agent
    (workspace / "input.txt").write_text(input_data)
    
    # 3. Create the prompt instruction
    full_prompt = f"""
    {prompt}
    Read 'input.txt', process it, and write the exact output to 'output.json'. 
    Do not do anything else. Exit when done.
    """
    
    # 4. Spawn the Pi agent CLI headlessly
    process = subprocess.Popen(
        ["pi", full_prompt], 
        cwd=workspace,
        stdout=subprocess.PIPE, 
        stderr=subprocess.PIPE
    )
    return process, workspace

# --- THE ORCHESTRATION ---

tasks = ["Refactor this snippet", "Write a regex for this", "Find the logic bug here"]
processes = []

# Map: Spawn everyone
for i, task in enumerate(tasks):
    p, ws = spawn_pi_worker(i, "Solve the task in input.txt", task)
    processes.append((p, ws))

# Reduce: Wait for everyone and collect results
results = []
for p, ws in processes:
    p.wait() # wait for agent to finish
    results.append(json.loads((ws / "output.json").read_text()))

print(results)
```

## Sub-Agent Runtimes

If a sub-agent requires its own stateful REPL (e.g., to load a dataset and iteratively test code against it), it can spawn its own headless MRP server:

```bash
# Sub-agent starts its own private runtime
mrmd-python --daemon --id sub_agent_task_3
```

This gives the sub-agent an isolated memory space accessible via the MRP API, without touching the user's primary MRMD UI runtime.

## Future CLI Enhancements

To support this orchestration smoothly, the `mrmd-agent` CLI should eventually support:

- **Notifications:** `mrmd notify "Task 3 complete"` (sends a toast/notification back up to the main Electron UI).
- **Sub-agent bootstrapping:** CLI wrappers to easily spin up a `mrmd-python` daemon for the sub-agent and attach the agent to it.

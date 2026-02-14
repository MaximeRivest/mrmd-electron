# MRMD Cloud Runtime Specification

> Architecture for running MRMD as a multi-tenant cloud service with Podman containers, CRIU live migration, and elastic resource management.

---

## 1. Overview

### 1.1 What Is MRMD Cloud?

MRMD Cloud turns mrmd-server into a multi-tenant SaaS platform. Users sign in, get their own isolated Linux environment, and access MRMD from any browser. Each user gets persistent file storage, runtime containers (Python, R, Julia, Bash), and the full MRMD editor experience.

### 1.2 Core Principles

| Principle | What it means |
|-----------|--------------|
| **Split architecture** | Editor and runtimes are separate containers |
| **Podman everywhere** | No Docker daemon — rootless, daemonless containers |
| **CRIU for migration** | Live-migrate runtimes between machines with sub-second pause |
| **Shared filesystem** | Editor and runtime see the same files at the same paths |
| **Elastic resources** | Resize CPU/RAM live, no restart, no data loss |
| **Graceful degradation** | Warn before OOM, pause before kill, offer upgrade |

### 1.3 Why Not Docker?

| Requirement | Docker | Podman |
|-------------|--------|--------|
| CRIU checkpoint/restore | Experimental, limited | First-class, production-ready |
| Pre-copy migration | No | Yes |
| Post-copy (lazy pages) | No | Yes |
| Export checkpoints to file | No native support | Yes (`--export`) |
| Rootless by default | No (daemon is root) | Yes |
| No daemon (no SPOF) | No | Yes |
| Licensing cost | Docker Desktop paid for companies >250 employees | Free, always |

---

## 2. Architecture

### 2.1 High-Level Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Gateway (Caddy / Traefik)                 │
│                                                              │
│  mdhub.com/login          → OAuth (Google, GitHub)           │
│  mdhub.com/@user/project  → User's workspace                │
│  mdhub.com/user/repo      → GitHub integration              │
│  user.mdhub.com           → Published sites                 │
└────────────────────────────┬─────────────────────────────────┘
                             │
                ┌────────────┴────────────────┐
                │       Orchestrator           │
                │                              │
                │  - User DB (Postgres)        │
                │  - Container lifecycle       │
                │  - Resource metering         │
                │  - Migration controller      │
                │  - Billing (Stripe)          │
                └────────────┬────────────────┘
                             │
          ┌──────────────────┼──────────────────────┐
          │                  │                      │
   ┌──────┴───────┐   ┌─────┴──────┐   ┌──────────┴──────────┐
   │ Editor       │   │ Runtime    │   │ GPU Node            │
   │ Container    │   │ Container  │   │ (on-demand)         │
   │ (gVisor)     │   │ (Podman)   │   │                     │
   │              │   │            │   │ Podman + nvidia      │
   │ mrmd-server  │   │ Python     │   │ Container attached   │
   │ mrmd-sync    │   │ R          │   │ to user's volume     │
   │ Files, UI    │   │ Julia      │   │                     │
   │              │   │ Bash/PTY   │   │ App-level GPU        │
   │ Shared vol ──┼───┤ Shared vol │   │ checkpointing for   │
   │              │   │            │   │ migration           │
   └──────────────┘   └────────────┘   └─────────────────────┘
```

### 2.2 Split Architecture: Editor vs Runtime

The editor and runtime are **separate containers** that share a filesystem volume.

**Editor container** (gVisor — internet-facing, needs strong isolation):
- mrmd-server (HTTP API, WebSocket, file management)
- mrmd-sync (Yjs CRDT collaboration)
- Serves the MRMD UI to the browser
- Lightweight, mostly idle (WebSocket connections + file I/O)
- ~256MB RAM per user
- Does NOT run user code
- Stateless — can be restarted without data loss

**Runtime container** (Podman — compute, needs CRIU migration):
- Python, R, Julia, Bash kernels
- Runs user code
- Holds session state in RAM (variables, DataFrames, models)
- Resource-limited per user's plan
- CRIU-migratable between machines
- Not directly internet-facing (reachable only via editor proxy)

**Why split:**
- Editor can use gVisor for security (no CRIU needed — stateless)
- Runtime can use Podman for CRIU (not internet-facing — security less critical)
- Attacker must escape gVisor AND Podman — defense in depth
- Editor is cheap to run (many users per server)
- Runtime is expensive (dedicated resources per user)
- Can scale editor and runtime nodes independently

### 2.3 Shared Filesystem

Editor and runtime containers mount the same user volume:

```
/users/{user_id}/
├── projects/                  ← MRMD projects
│   ├── my-analysis/
│   │   ├── mrmd.md            ← project config
│   │   ├── 01-intro.md        ← notebook
│   │   ├── 02-methods.md      ← notebook
│   │   ├── data.csv           ← data file
│   │   └── utils.py           ← Python module
│   └── blog-post/
│       └── 01-post.md
├── repos/                     ← Cloned GitHub repos
│   └── numpy-numpy/
├── published/                 ← Built static sites
├── .venv/                     ← Python virtual environments
├── .julia/                    ← Julia packages
├── .local/lib/R/              ← R packages
├── .config/mrmd/              ← Settings, API keys
│   └── settings.json
└── .bashrc                    ← Shell config
```

Both containers see the same paths:

```bash
# Editor container
docker run -v /data/users/abc:/home/user mrmd-editor

# Runtime container
docker run -v /data/users/abc:/home/user mrmd-runtime
```

**Single machine:** bind mounts (native disk speed, zero overhead).

**Multi-machine:** JuiceFS backed by S3 + Redis. User data persists independently of any machine. Enables migration without transferring files.

### 2.4 Networking

```
Browser
  │
  ├── HTTPS ──→ Gateway ──→ Editor container (port 8080)
  │                          │
  │                          ├── /api/* ──→ mrmd-server (files, settings, etc.)
  │                          │
  │                          ├── /proxy/:port/* ──→ Runtime container
  │                          │     (HTTP proxy to Python/R/Julia kernels)
  │                          │
  │                          ├── /sync/:port/:path ──→ WebSocket proxy
  │                          │     (Yjs sync, PTY terminals)
  │                          │
  │                          └── /events ──→ WebSocket (push notifications)
  │
  └── WSS ──→ Gateway ──→ Editor container (WebSocket upgrade)
```

Runtime containers are **never directly exposed** to the internet. All traffic flows through the editor container's proxy. This means:
- Runtime doesn't need auth (editor already validated the token)
- Runtime IP/port can change (migration) without breaking browser connections
- Editor proxy updates its routing table on migration

---

## 3. Container Specifications

### 3.1 Editor Container (gVisor)

**Base image:** Node.js 22 LTS + mrmd-server + mrmd-sync + mrmd-editor

```dockerfile
FROM node:22-slim
COPY mrmd-server/ /app/mrmd-server/
COPY mrmd-electron/ /app/mrmd-electron/
COPY mrmd-editor/dist/ /app/mrmd-electron/editor/
COPY mrmd-sync/ /app/mrmd-sync/
WORKDIR /app/mrmd-server
RUN npm ci --production
EXPOSE 8080
CMD ["node", "bin/cli.js", "--port", "8080", "/home/user/projects"]
```

**Run command:**

```bash
podman run \
  --runtime=runsc \                    # gVisor
  --user 1000:1000 \                   # Non-root
  --cap-drop=ALL \                     # No capabilities
  --security-opt=no-new-privileges \   # Can't escalate
  --read-only \                        # Read-only root filesystem
  --tmpfs /tmp:size=100M \             # Writable temp
  --memory=512m \                      # Enough for Node.js + sync
  --cpus=0.5 \                         # Minimal CPU
  --pids-limit=64 \                    # No fork bombs
  -v /data/users/${USER_ID}:/home/user \
  -e TOKEN=${AUTH_TOKEN} \
  -p ${EDITOR_PORT}:8080 \
  mrmd-editor:latest
```

### 3.2 Runtime Container (Podman, CRIU-capable)

**Base image:** Python + R + Julia + Bash + mrmd runtimes

```dockerfile
FROM ubuntu:24.04

# System packages
RUN apt-get update && apt-get install -y \
  python3 python3-venv python3-pip \
  r-base \
  julia \
  bash \
  && rm -rf /var/lib/apt/lists/*

# MRMD runtimes
COPY mrmd-python/ /app/mrmd-python/
COPY mrmd-bash/   /app/mrmd-bash/
COPY mrmd-r/      /app/mrmd-r/
COPY mrmd-julia/  /app/mrmd-julia/

# uv for fast package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Non-root user
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user

# Supervisor to manage runtime processes
COPY supervisord.conf /etc/supervisord.conf
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
```

**Run command:**

```bash
podman run \
  --user 1000:1000 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --security-opt seccomp=mrmd-runtime.json \
  --memory=${PLAN_MEMORY} \              # e.g., 8g
  --memory-swap=${PLAN_MEMORY_SWAP} \    # e.g., 12g (8g RAM + 4g swap)
  --memory-reservation=${SOFT_LIMIT} \   # e.g., 6g
  --cpus=${PLAN_CPUS} \                  # e.g., 4
  --pids-limit=256 \
  -v /data/users/${USER_ID}:/home/user \
  --name runtime-${USER_ID} \
  mrmd-runtime:latest
```

### 3.3 GPU Container (on-demand, temporary)

Same as runtime but with GPU access:

```bash
podman run \
  --device nvidia.com/gpu=0 \            # GPU passthrough
  --memory=${GPU_PLAN_MEMORY} \
  --cpus=${GPU_PLAN_CPUS} \
  -v /data/users/${USER_ID}:/home/user \ # Same volume
  --name gpu-${USER_ID} \
  mrmd-runtime-gpu:latest
```

GPU containers share the same user volume. They start when the user requests GPU, stop when the GPU job completes.

---

## 4. Resource Management

### 4.1 Plans and Limits

| Tier | CPU | RAM | Swap | Storage | GPU | Always-on | Price |
|------|-----|-----|------|---------|-----|-----------|-------|
| **Free** | 1 | 1 GB | 2 GB | 5 GB | No | No (sleep after 10 min) | $0 |
| **Starter** | 2 | 4 GB | 6 GB | 20 GB | No | No (sleep after 1 hr) | $8/mo |
| **Pro** | 4 | 8 GB | 12 GB | 50 GB | On-demand ($1/hr) | Yes | $15/mo |
| **Power** | 8 | 16 GB | 24 GB | 100 GB | On-demand ($1/hr) | Yes | $30/mo |
| **GPU Burst** | — | — | — | — | A10 24GB | Per-hour | $1/hr |
| **GPU Pro** | — | — | — | — | A100 80GB | Per-hour | $3/hr |

### 4.2 Live Resource Adjustment

CPU and RAM limits can be changed on a running container without restart:

```bash
# User upgrades from Pro (8GB) to Power (16GB)
podman update --memory=16g --cpus=8 runtime-${USER_ID}
# Instant. No restart. No data loss. Process keeps running.
```

### 4.3 Memory Monitoring and Warnings

The orchestrator polls container memory usage every 5 seconds:

```
Usage     Action                             User notification
────────────────────────────────────────────────────────────────
0-85%     Normal                             None
85%       Soft warning                       Yellow banner:
                                             "Using 6.8 GB / 8 GB"
90%       Kernel reclaims aggressively       Slight slowdown
          (memory-reservation threshold)
95%       CRITICAL                           Red banner:
          1. Pause runtime container         "Runtime paused.
          2. Show upgrade options              [Upgrade to 16GB +$7/mo]
          3. Wait for user response            [Kill biggest runtime]
                                               [Resume anyway]"
100%      Only reached if user chose          OOM killer activates
          "Resume anyway" at 95%             (controlled — kill biggest
                                              runtime, not random)
```

### 4.4 Idle Resource Reclamation

When a user is inactive (no WebSocket messages for N minutes):

```
Idle 10 min (Free tier) / 30 min (Starter) / Never (Pro+):

  1. podman pause runtime-${USER_ID}
     → All processes frozen, 0% CPU

  2. echo max > /sys/fs/cgroup/${CGROUP}/memory.reclaim
     → Push RAM pages to swap, free physical RAM

  3. podman update --memory=512m runtime-${USER_ID}
     → Lower ceiling to prevent re-expansion

Result: ~0 RAM, 0 CPU. Container still exists.
        Variables, imports, state all preserved in swap.

User returns (browser refresh or WebSocket reconnect):

  1. podman update --memory=8g runtime-${USER_ID}
     → Restore original limit

  2. podman unpause runtime-${USER_ID}
     → Processes resume instantly

  3. Pages fault back from swap as process touches them
     → First cell run: 2-10s slower (paging in)
     → After that: fully native speed
```

### 4.5 Oversubscription

On a dedicated server (e.g., 256 GB RAM, 32 threads):

```
50 users × 8 GB plan = 400 GB "allocated"
But: only ~20 active at any time
Active users: 20 × 8 GB = 160 GB in RAM
Idle users: 30 × pushed to swap = ~0 RAM

Physical RAM needed: ~160 GB + headroom = fits in 256 GB
Oversubscription ratio: 2.5:1
```

With more aggressive sleep (free tier: 10 min idle → freeze):

```
100 users × mixed plans = 500 GB "allocated"
Active: ~25 users using ~120 GB
Idle/frozen: ~75 users using ~0 RAM
Oversubscription ratio: ~4:1
```

---

## 5. CRIU Live Migration

### 5.1 When Migration Happens

| Trigger | Example |
|---------|---------|
| User upgrades plan | Pro (8 GB) → Power (16 GB), current server doesn't have space |
| User requests GPU | Runtime moves to GPU node |
| Server maintenance | Drain all containers before reboot |
| Load balancing | Server at 90% RAM, move idle user to emptier server |
| User downgrades | Move off expensive GPU node back to CPU node |

### 5.2 Migration Strategies

#### Strategy A: Pre-Copy (Default, <2s Pause)

Best for most migrations. Copy memory while process runs, then brief freeze for final dirty pages.

```
Phase 1 (process RUNNING):
  Pre-dump: copy all memory pages to target
  Duration: proportional to RAM (8GB ≈ 2s at 100Gbps)

Phase 2 (process RUNNING):
  Iterative pre-dump: re-copy dirty pages
  Duration: <1s (only changed pages)

Phase 3 (process FROZEN):
  Final dump: CPU state + last dirty pages
  Duration: <0.5s

Phase 4: Restore on target
  Duration: <0.5s

Total pause: ~0.5-2 seconds
```

```bash
# Pre-dump (process keeps running)
podman container checkpoint runtime-${USER_ID} \
  --pre-checkpoint --export=/juicefs/migration/pre1.tar.gz

# Final checkpoint (brief freeze)
podman container checkpoint runtime-${USER_ID} \
  --export=/juicefs/migration/final.tar.gz \
  --with-previous --tcp-established

# On target machine
podman container restore \
  --import=/juicefs/migration/final.tar.gz
```

#### Strategy B: Post-Copy / Lazy Pages (<500ms Pause, Any RAM Size)

Best for large RAM workloads (>32 GB). Process resumes immediately, pages fetched on demand.

```
1. Freeze process (~100ms)
2. Send CPU state only (~5MB, ~1ms)
3. Restore on target (~200ms) — process runs with empty pages
4. Page faults fetch from source machine on demand (~10μs per page)
5. Background prefetch streams remaining pages
6. Source machine released when all pages transferred

Total pause: ~300ms regardless of RAM size
```

```bash
# Source: checkpoint with lazy pages
podman container checkpoint runtime-${USER_ID} \
  --lazy-pages --page-server=target-host:1234 \
  --export=/juicefs/migration/state.tar.gz

# Target: restore with lazy page loading
podman container restore \
  --import=/juicefs/migration/state.tar.gz \
  --lazy-pages=tcp:source-host:1234
```

#### Strategy C: Stop-and-Copy (Simplest, for Small Containers)

For containers using <1 GB RAM, just checkpoint and restore. Fast enough that pre-copy adds no benefit.

```bash
# Source
podman container checkpoint runtime-${USER_ID} \
  --export=/juicefs/migration/checkpoint.tar.gz

# Target
podman container restore \
  --import=/juicefs/migration/checkpoint.tar.gz
```

Total pause: ~1-3 seconds for <1 GB.

### 5.3 Migration Strategy Selection

```
if RAM_USAGE < 1GB:
    use stop-and-copy        # simple, <3s pause
elif RAM_USAGE < 32GB:
    use pre-copy             # <2s pause
else:
    use post-copy            # <500ms pause regardless of size
```

### 5.4 GPU Migration

GPUs cannot be checkpointed by CRIU. Application-level checkpointing is required:

```
1. Signal Python process: SIGUSR1
2. Migration hook in mrmd-python runtime:
   a. torch.save(model.state_dict(), '/home/user/.cache/gpu-checkpoint.pt')
   b. Move all CUDA tensors to CPU: model = model.cpu()
   c. torch.cuda.empty_cache()
   d. Signal orchestrator: "GPU released, ready for CRIU"
3. CRIU checkpoint (CPU state only now)
4. Transfer to new GPU machine
5. CRIU restore
6. Migration hook restores GPU state:
   a. model = model.cuda()
   b. model.load_state_dict(torch.load('/home/user/.cache/gpu-checkpoint.pt'))

Total pause: ~5-15 seconds (dominated by VRAM copy)
```

### 5.5 What Survives Migration

| Survives | Does not survive |
|----------|-----------------|
| All RAM (variables, objects, DataFrames) | GPU state (handled by app-level checkpoint) |
| Open files (same paths via shared storage) | Active TCP connections (proxy handles reconnection) |
| Python/R/Julia interpreter state | PID number (may differ on target) |
| All threads | |
| Timers, signals | |
| Installed packages (on shared volume) | |
| Working directory, environment variables | |
| REPL history | |

### 5.6 Post-Migration Routing

After migration, the orchestrator updates the reverse proxy so the editor container routes to the new runtime location:

```javascript
// Before migration:
//   editor proxies /proxy/:port → runtime @ machine-a:41765

// After migration:
//   editor proxies /proxy/:port → runtime @ machine-b:41765
//   (or editor moves too, if same-machine is preferred)

async function updateRouting(userId, newHost, newPort) {
  // Update the proxy routing table
  routingTable.set(userId, { host: newHost, port: newPort });

  // Notify editor container to reconnect
  eventBus.send(userId, {
    event: 'runtime-migrated',
    newHost, newPort
  });
}
```

---

## 6. Runtime Snapshots

### 6.1 User-Facing Snapshots

Users can save and restore runtime state as named snapshots:

```
┌──────────────────────────────────────────────────┐
│  Runtime Snapshots                                │
│                                                   │
│  "After data cleaning"       2.1 GB   2 min ago   │
│  "Before model training"     3.4 GB   1 hr ago    │
│  "Working baseline"          1.8 GB   yesterday   │
│                                                   │
│  [Save snapshot]  [Share with team]               │
└──────────────────────────────────────────────────┘
```

### 6.2 Snapshot Implementation

```bash
# Save snapshot (process keeps running with --leave-running)
podman container checkpoint runtime-${USER_ID} \
  --leave-running \
  --export=/data/users/${USER_ID}/.snapshots/${SNAPSHOT_NAME}.tar.gz

# Restore snapshot (replaces current runtime state)
podman stop runtime-${USER_ID}
podman container restore \
  --import=/data/users/${USER_ID}/.snapshots/${SNAPSHOT_NAME}.tar.gz \
  --name=runtime-${USER_ID}
```

### 6.3 Sharing Snapshots

Checkpoints are portable tar files. Sharing is just file access:

```bash
# User A saves and shares
podman checkpoint --export=/juicefs/shared/team-xyz/analysis-v3.tar.gz

# User B restores (same base image required)
podman container restore --import=/juicefs/shared/team-xyz/analysis-v3.tar.gz

# User B now has: same Python, same variables, same DataFrames, same imports
```

**Security constraint:** Snapshots must be scanned/sandboxed before sharing. A malicious snapshot could contain processes that exfiltrate data. Only allow sharing within teams or with explicit approval.

### 6.4 Snapshot Storage

| Destination | Use case |
|-------------|----------|
| `/data/users/${USER_ID}/.snapshots/` | Personal snapshots (counts against storage quota) |
| `/data/teams/${TEAM_ID}/snapshots/` | Team-shared snapshots |
| S3 bucket | Long-term archival, published snapshots |

---

## 7. Idle and Sleep Behavior

### 7.1 Activity Detection

Activity is detected via:
- WebSocket messages on `/events` (editor ↔ browser)
- HTTP requests to `/api/*` (cell execution, file operations)
- Runtime container CPU usage >1% (background computation)

### 7.2 Sleep Tiers

| Tier | Idle timeout | Sleep behavior | Wake time |
|------|-------------|----------------|-----------|
| **Free** | 10 min | Full freeze + reclaim | ~5-10s (page from swap) |
| **Starter** | 1 hr | Full freeze + reclaim | ~5-10s |
| **Pro** | Never | Never sleeps | N/A |
| **Power** | Never | Never sleeps | N/A |

### 7.3 Sleep Flow

```
1. No activity for N minutes
2. Orchestrator:
   a. podman pause runtime-${USER_ID}                    # freeze all processes
   b. echo max > /sys/fs/cgroup/$CGROUP/memory.reclaim   # push RAM to swap
   c. podman update --memory=256m runtime-${USER_ID}     # lower ceiling
3. Container state: frozen, ~0 RAM, 0 CPU
4. Status shown in UI: "Runtime sleeping. Will wake on next action."

Wake trigger: any API request or WebSocket message from user

5. Orchestrator:
   a. podman update --memory=${PLAN_MEMORY} runtime-${USER_ID}  # restore limit
   b. podman unpause runtime-${USER_ID}                          # resume
6. Pages fault back from swap over ~5-10 seconds
7. Full speed restored
```

### 7.4 Deep Sleep (Free Tier, 24hr Idle)

For free tier users inactive for 24+ hours, the container is fully stopped and its state checkpointed to disk:

```
1. podman checkpoint runtime-${USER_ID} --export=/data/users/${USER_ID}/.sleep/state.tar.gz
2. podman rm runtime-${USER_ID}
3. RAM and swap fully freed. Only disk storage used.

Wake (user logs in again):
1. podman container restore --import=/data/users/${USER_ID}/.sleep/state.tar.gz
2. All state restored (variables, imports, REPL history)
3. Takes ~5-15 seconds depending on state size
```

---

## 8. Security

### 8.1 Container Hardening

All runtime containers run with:

```bash
--user 1000:1000                       # Non-root
--cap-drop=ALL                         # No Linux capabilities
--security-opt=no-new-privileges       # Cannot escalate
--security-opt seccomp=mrmd-strict.json # Restricted syscalls
--read-only                            # Read-only root filesystem (except user volume)
--tmpfs /tmp:size=1G                   # Writable temp with size limit
--pids-limit=256                       # Fork bomb protection
--network=isolated                     # No inter-container networking
```

### 8.2 Network Isolation

```
Internet ──→ Gateway ──→ Editor (gVisor) ──→ Runtime (Podman)
                              │
                         Only container
                         with internet
                         access

Runtime CAN:
  - Talk to editor container (via internal network)
  - Access shared filesystem
  - Make outbound HTTP (for pip install, API calls)

Runtime CANNOT:
  - Accept inbound connections from internet
  - Talk to other users' containers
  - Access host filesystem outside its volume
  - See other containers or host processes
```

### 8.3 Editor Container Isolation (gVisor)

The editor container uses gVisor (`runsc`) runtime for stronger isolation. Even if an attacker compromises mrmd-server (the internet-facing component), gVisor's userspace kernel intercepts syscalls before they reach the real kernel. This prevents kernel exploits from escaping the container.

### 8.4 Resource Abuse Prevention

| Threat | Mitigation |
|--------|-----------|
| Crypto mining | CPU limit + monitoring. Alert if sustained >90% CPU for >5 min. |
| Fork bomb | `--pids-limit=256` |
| Disk fill | Storage quota per user (enforced via filesystem quota or volume size) |
| Network abuse | Rate limiting on outbound connections. Block known mining pools. |
| Container escape | gVisor (editor), seccomp + no caps (runtime). Defense in depth. |
| Snapshot poisoning | Scan shared snapshots. Only allow sharing within teams. |

### 8.5 API Key Security

- API keys stored in `~/.config/mrmd/settings.json` on user's volume
- Volume only accessible by that user's containers
- Keys passed to AI server as environment variables (standard for litellm/dspy)
- Keys masked in UI responses (`sk-ant-••••••last4`)
- Keys never logged in server output

---

## 9. Infrastructure

### 9.1 Single-Machine Setup (MVP, <50 Users)

```
One Hetzner AX102 (32 threads, 256 GB RAM, 2×2 TB NVMe)
├── Host OS (Ubuntu 24.04)
├── Podman + gVisor
├── NFS or bind mounts (single machine, no network FS needed)
├── Swap: 512 GB on NVMe
├── Caddy (reverse proxy + auto HTTPS)
├── Postgres (user DB, container state)
└── Orchestrator service (Node.js)

Cost: ~$105/month
Serves: 30-50 paying users (3:1 oversubscription)
Per-user cost: ~$2-3.50/month
```

### 9.2 Multi-Machine Setup (50-500 Users)

```
┌─ Load Balancer ──────────────────────────────┐
│  Caddy / Traefik (with Let's Encrypt)        │
└─────────────────┬────────────────────────────┘
                  │
    ┌─────────────┼──────────────┐
    │             │              │
┌───┴────┐  ┌────┴───┐   ┌─────┴────┐
│ Node 1 │  │ Node 2 │   │ GPU Node │
│ 256 GB │  │ 256 GB │   │ A100     │
│ 50 usr │  │ 50 usr │   │ on-demand│
└────────┘  └────────┘   └──────────┘
    │             │              │
    └─────────────┼──────────────┘
                  │
         ┌────────┴────────┐
         │    JuiceFS      │
         │  (S3 + Redis)   │
         │  Shared storage │
         └─────────────────┘
```

JuiceFS enables:
- Any container on any machine sees the same files
- CRIU checkpoints written to shared storage (no transfer step)
- Migration between machines without moving files
- Backups via S3 lifecycle policies

### 9.3 Swap Configuration

Critical for oversubscription and idle reclamation:

```bash
# Create swap on NVMe (fast page-in)
fallocate -l 512G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Tune: low swappiness (only swap when explicitly reclaimed)
sysctl vm.swappiness=10

# NVMe swap performance:
# Page-in: ~3-5 GB/s
# 8 GB idle process pages back in ~2 seconds
```

### 9.4 Monitoring

| Metric | Source | Alert threshold |
|--------|--------|----------------|
| Container RAM usage | `podman stats` / cgroup | >85% of limit |
| Container CPU usage | cgroup | Sustained >95% for >5 min |
| Host RAM usage | `/proc/meminfo` | >85% of physical RAM |
| Host swap usage | `/proc/swaps` | >70% of swap |
| Disk usage per user | `du` or quota | >90% of plan |
| Container count | `podman ps` | >80% of capacity |
| Migration queue depth | Orchestrator | >5 pending migrations |
| CRIU checkpoint time | Orchestrator logs | >30s (indicates issues) |

---

## 10. User Experience Flows

### 10.1 New User Signup

```
1. User visits mdhub.com
2. Clicks "Sign in with Google" (or GitHub, etc.)
3. OAuth flow → user created in DB
4. Orchestrator creates:
   a. User directory: /data/users/${USER_ID}/
   b. Default project: /data/users/${USER_ID}/projects/getting-started/
   c. Editor container (gVisor)
   d. Runtime container (Podman, Free tier limits)
5. User redirected to mdhub.com/@username/getting-started
6. MRMD loads with getting-started project
7. Total time: ~5-10 seconds
```

### 10.2 User Runs Python Cell

```
1. User writes: df = pd.read_csv("data.csv")
2. Browser sends cell to editor container via HTTP
3. Editor proxies to runtime container's Python kernel
4. Python kernel executes, reads data.csv from shared volume
5. Result returned via proxy → browser
6. User sees output
```

### 10.3 User Hits Memory Limit

```
1. Orchestrator detects 95% RAM usage
2. Orchestrator: podman pause runtime-${USER_ID}
3. WebSocket event to browser: memory-critical
4. Browser shows modal:
   ┌──────────────────────────────────────────┐
   │  ⚠ Runtime Paused — Memory Limit         │
   │                                           │
   │  You're using 7.6 GB / 8 GB (95%)        │
   │                                           │
   │  Biggest processes:                       │
   │    python (my-analysis): 5.2 GB           │
   │    julia (simulation):   2.1 GB           │
   │                                           │
   │  [Upgrade to 16 GB]  [Kill biggest]       │
   │  (+$7/mo)            (julia: 2.1 GB)      │
   │                                           │
   │          [Resume anyway]                  │
   └──────────────────────────────────────────┘
5. User clicks "Upgrade to 16 GB"
6. Orchestrator:
   a. podman update --memory=16g runtime-${USER_ID}
   b. podman unpause runtime-${USER_ID}
   c. Update billing (Stripe)
7. Process resumes. No data lost.
```

### 10.4 User Requests GPU

```
1. User clicks "Attach GPU" or runs GPU-requiring code
2. Orchestrator starts GPU container on GPU node:
   a. Same user volume mounted
   b. GPU device attached
3. Runtime proxy updated to route to GPU container
4. User's code now has GPU access
5. When done: GPU container stopped, routing reverts to CPU runtime
```

### 10.5 User Opens GitHub Repo

```
1. User visits mdhub.com/numpy/numpy
2. Orchestrator:
   a. git clone https://github.com/numpy/numpy /data/users/${USER_ID}/repos/numpy-numpy/
   b. Start editor pointed at cloned repo
3. User edits markdown files in the repo
4. Can commit and push (if authenticated with GitHub OAuth)
```

### 10.6 User Publishes Notebook

```
1. User clicks "Publish" on a project
2. Build pipeline:
   a. Read notebook .md files
   b. Render to static HTML (with executed outputs)
   c. Upload to CDN (Cloudflare Pages / S3)
3. Published at: mdhub.com/@username/project-name
4. Or custom domain: docs.company.com (CNAME)
```

---

## 11. Orchestrator Service

### 11.1 Responsibilities

The orchestrator is the control plane — a Node.js service that manages all containers and routing:

- **User lifecycle:** create/delete user volumes and containers
- **Container lifecycle:** start, stop, pause, unpause, checkpoint, restore
- **Resource monitoring:** poll container stats, trigger warnings/sleep/migration
- **Migration controller:** decide when and how to migrate, execute CRIU flows
- **Routing table:** map user → editor/runtime host:port
- **Billing integration:** track usage, enforce plan limits, Stripe webhooks
- **Health checks:** detect dead containers, auto-restart editors

### 11.2 Database Schema (Postgres)

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free',        -- free, starter, pro, power
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Containers
CREATE TABLE containers (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type TEXT NOT NULL,               -- 'editor' or 'runtime'
  host TEXT NOT NULL,               -- machine hostname
  port INTEGER,
  podman_id TEXT,                   -- podman container ID
  state TEXT DEFAULT 'running',     -- running, paused, sleeping, migrating, stopped
  memory_limit BIGINT,             -- bytes
  cpu_limit REAL,                  -- cores
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Snapshots
CREATE TABLE snapshots (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,               -- path to checkpoint tar
  size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrations
CREATE TABLE migrations (
  id UUID PRIMARY KEY,
  container_id UUID REFERENCES containers(id),
  from_host TEXT NOT NULL,
  to_host TEXT NOT NULL,
  strategy TEXT NOT NULL,           -- 'precopy', 'postcopy', 'stop-and-copy'
  status TEXT DEFAULT 'pending',    -- pending, in_progress, completed, failed
  pause_ms INTEGER,                 -- measured pause duration
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
```

### 11.3 Key API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /auth/google` | POST | OAuth login, create user if new |
| `POST /auth/github` | POST | OAuth login with GitHub |
| `GET /users/:id/containers` | GET | List user's containers |
| `POST /users/:id/containers/runtime/upgrade` | POST | Change plan (live resize) |
| `POST /users/:id/containers/runtime/snapshot` | POST | Create named snapshot |
| `POST /users/:id/containers/runtime/migrate` | POST | Trigger migration |
| `GET /users/:id/snapshots` | GET | List snapshots |
| `POST /users/:id/snapshots/:id/restore` | POST | Restore a snapshot |
| `POST /users/:id/gpu/attach` | POST | Start GPU container |
| `POST /users/:id/gpu/detach` | POST | Stop GPU container |
| `GET /admin/nodes` | GET | List server nodes and capacity |
| `GET /admin/migrations` | GET | Migration history and status |

---

## 12. Publishing

### 12.1 Build Pipeline

When a user clicks "Publish":

1. Read all notebook `.md` files in the project
2. Execute code cells and capture outputs (using the runtime container)
3. Render to static HTML with MRMD's renderer
4. Upload to static hosting (Cloudflare Pages, S3 + CloudFront, or Vercel)

### 12.2 URL Scheme

| URL | What |
|-----|------|
| `mdhub.com/@maxime/my-analysis` | Published project (shared domain) |
| `maxime.mdhub.com/my-analysis` | Published project (subdomain, Pro+) |
| `docs.company.com/my-analysis` | Custom domain (CNAME, Pro+) |

### 12.3 Hosting Cost

Static hosting is essentially free:
- Cloudflare Pages: free tier handles most traffic
- S3 + CloudFront: pennies per month per user
- No compute cost (pre-rendered static files)

---

## 13. GitHub Integration

### 13.1 URL Routing

```
mdhub.com/numpy/numpy              → clone + open public repo
mdhub.com/numpy/numpy/tree/main/doc/source → open specific directory
mdhub.com/@maxime/private-repo     → authenticated, user's own repo
```

### 13.2 Flow

```
1. Parse URL → extract GitHub owner/repo
2. Check: user has workspace for this repo?
   NO  → git clone into /data/users/${USER_ID}/repos/${OWNER}-${REPO}/
   YES → open existing workspace
3. Start/reuse editor pointed at cloned directory
4. User edits markdown files
5. Sync options:
   a. Auto-commit on save (configurable)
   b. Manual commit/push via Git panel in UI
   c. PR-based: each session creates a branch, user opens PR
```

### 13.3 Authentication

- Public repos: no auth needed, clone with HTTPS
- Private repos: GitHub OAuth scope includes `repo` access
- Push: requires OAuth token with write permission
- Token stored in user's settings (encrypted on user volume)

---

## 14. Cross-Runtime Data Transfer (Arrow)

### 14.1 Same-Machine (Zero-Copy)

When Python and R runtimes are in the same container (or on the same machine with shared memory):

```
Python writes Arrow IPC to /dev/shm/shared_data.arrow
R reads the same file — zero copy, same bytes in memory
Transfer time: ~0ms
```

### 14.2 Cross-Machine (Arrow Flight)

When runtimes are on different machines (e.g., user's Python on Node 1, collaborator's R on Node 2):

```
Arrow Flight over TCP:
  10 GB DataFrame at 100 Gbps (EFA) = ~0.8 seconds
  No serialization — Arrow format is identical in all languages
```

### 14.3 User-Facing API

```python
# In Python notebook
df = pd.read_csv("huge.csv")  # 10 GB DataFrame

# Colleague's R notebook references it:
# df <- mrmd_get("python:df")
# Behind the scenes: Arrow Flight transfers the data
```

---

## 15. Milestones

### Phase 1: MVP (Single Machine)

- [ ] OAuth login (Google + GitHub)
- [ ] User creation + volume setup
- [ ] Editor container (mrmd-server, gVisor)
- [ ] Runtime container (Podman, Python + Bash only)
- [ ] Shared volume (bind mount)
- [ ] Reverse proxy (Caddy)
- [ ] Basic resource limits (memory, CPU)
- [ ] Idle sleep (pause + reclaim)
- [ ] Memory warning UI
- [ ] Stripe billing (Free + Pro tiers)

### Phase 2: Migration + Snapshots

- [ ] CRIU pre-copy migration
- [ ] User-facing snapshots (save/restore)
- [ ] Snapshot sharing (within teams)
- [ ] R + Julia runtime support
- [ ] Live resource upgrade (podman update)
- [ ] Memory limit pause + upgrade flow

### Phase 3: Multi-Machine + GPU

- [ ] JuiceFS shared storage
- [ ] Multi-node orchestration
- [ ] CRIU post-copy migration (lazy pages)
- [ ] GPU container on-demand
- [ ] GPU app-level checkpointing
- [ ] Node health monitoring + auto-migration

### Phase 4: Publishing + GitHub

- [ ] Publish button → static site
- [ ] Custom domains
- [ ] GitHub repo cloning (mdhub.com/user/repo)
- [ ] GitHub OAuth for push/PR
- [ ] Team workspaces

### Phase 5: Advanced

- [ ] Arrow Flight cross-runtime data transfer
- [ ] Cross-machine Arrow transfer (RDMA/EFA)
- [ ] Checkpoint registry (share runtime states publicly)
- [ ] Pre-built environment catalog (like Docker Hub for runtime states)
- [ ] Pyodide/WebR browser fallback (zero-cost free tier)

# Markco Build Plan

> Bottom-up layered approach to building the full markco.dev platform. Each layer has clear contracts, independent validation, and no integration surprises.

---

## Principle

Build the real architecture from the start — no throwaway intermediaries. But build it **bottom-up by layer**, testing each layer in isolation before stacking the next.

```
Layer 5:  UI (share button, publish config, memory warnings)
Layer 4:  Orchestrator (user lifecycle, routing, elastic compute, billing)
Layer 3:  Services (publish-service, data-service, auth-service)
Layer 2:  Containers (editor, runtime Podman, CRIU, elastic migration)
Layer 1:  Infrastructure (EC2, CloudFront, Postgres, S3)
```

Don't start Layer N+1 until Layer N's validation scripts pass.

---

## Layer 1: Infrastructure

**Goal:** Get the base server running, install everything, validate the tools work.

**Time:** 2 days.

### Architecture Overview

```
AWS EC2 t3.small — ca-central-1 (Montreal)
├── Ubuntu 24.04 (x86_64, required for CRIU)
├── Podman + CRIU
├── Caddy (reverse proxy, auto-HTTPS)
├── Postgres
├── Node.js 22
├── Python 3.12 + uv
├── R, Julia
└── EBS gp3 (100 GB root + 100 GB data)

CloudFront CDN (global)
├── Static assets (mrmd-reader.iife.js, mrmd.iife.js, HTML shell)
├── 450+ edge locations worldwide
└── ~10-30ms latency globally for static content

Route 53
└── markco.dev → EC2 (editor/API) + CloudFront (static)
```

**Cost:** ~$15-20 CAD/mo (t3.small) + CloudFront free tier (1 TB/mo)

Domain: **markco.dev** (registered, DNS managed by owner)

**Why ca-central-1:** ~5-10ms latency from eastern Canada. Good for North America + acceptable for Europe (~80-90ms). Add regions later when real users need them.

**Why t3.small (2 GB RAM):** Editor containers are lightweight (~256 MB each). Runtimes run on separate EC2 instances via CRIU elastic compute. The base server just needs to run Caddy + Postgres + mrmd-server.

### Elastic Compute Model

Runtimes don't live on the base server. They scale up and down on separate EC2 instances:

```
User runs first cell:
  → Runtime starts on base server (co-located, instant, tiny allocation)
  → Free tier: 256-512 MB RAM

Runtime memory hits 50% of limit:
  → Orchestrator pre-provisions next-tier EC2 in background (~60-90s)
  → User doesn't know, keeps working

Runtime memory hits 75%:
  → CRIU checkpoint (--leave-running, ~2s)
  → Transfer snapshot to pre-provisioned EC2 (~1-5s within same AZ)
  → CRIU restore on bigger machine (~2-5s)
  → Proxy switches atomically
  → User never noticed

Tier ladder:
  base server (256 MB)  → t3.small (2 GB)  → t3.medium (4 GB)
  → t3.large (8 GB)   → t3.xlarge (16 GB) → bigger as needed

GPU needed:
  → Detected via static analysis (import torch, pip install tensorflow, etc.)
  → g5.xlarge spot instance pre-provisioned as soon as GPU library detected
  → CRIU migrate to GPU instance when cell executes .cuda() / .to("cuda")
  → CRIU migrate back to CPU instance after GPU work done
  → GPU instance terminated → $0

User idle 15 min:
  → CRIU checkpoint → snapshot saved to base server EBS
  → EC2 runtime instance stopped/terminated → $0

User returns (even months later):
  → Orchestrator reads snapshot from EBS
  → Provisions appropriately-sized EC2 based on snapshot size
  → CRIU restore → user is exactly where they left off
```

### Pre-Provisioning Triggers

```
Memory-based:
  50% of RAM limit → start provisioning next tier
  75% of RAM limit → migrate (machine ready by now)
  90% of RAM limit → hard migrate if not done
  95% of RAM limit → pause, show warning

Code analysis (before execution):
  pip install torch/tensorflow/jax    → pre-provision GPU (~minutes of headroom)
  import torch/cupy/rapids            → pre-provision GPU if not already
  model.to("cuda") / .cuda()          → GPU must be ready by now
  pd.read_csv("10gb.csv")             → pre-provision big RAM machine
  arrow.read_parquet("huge.parquet")  → same
```

### Cost Model (all CAD)

| State | Infrastructure | Cost |
|---|---|---|
| No users | t3.small base only | ~$15/mo |
| You working (4 GB runtime) | base + t3.medium | ~$15 + ~$0.05/hr = ~$35/mo |
| You idle | base + snapshots on EBS | ~$15/mo |
| 10 active users (small) | base + a few t3.mediums | ~$50-80/mo |
| Someone needs GPU | base + g5.xlarge spot | $15 + ~$0.50/hr burst |
| Everyone asleep | base + snapshots on EBS | ~$15/mo |

### Validation Scripts

Every one of these must pass before moving to Layer 2.

```bash
# 1. Podman works
sudo podman run alpine echo "Podman works"

# 2. Podman container with resource limits
sudo podman run --memory=512m --cpus=1 ubuntu stress-ng --vm 1 --vm-bytes 400M -t 5s

# 3. CRIU checkpoint and restore (same machine)
sudo podman run -d --name test-criu python:3.12 python -c "
import time
x = 42
while True:
    time.sleep(1)
"
sudo podman container checkpoint test-criu --export=/tmp/test.tar.gz
sudo podman rm test-criu
sudo podman container restore --import=/tmp/test.tar.gz --name=test-restored
sudo podman exec test-restored python -c "print(x)"  # should print 42

# 4. Checkpoint with --leave-running (zero-downtime migration)
sudo podman container checkpoint test-restored --leave-running --export=/tmp/snap.tar.gz
sudo podman container restore --import=/tmp/snap.tar.gz --name=clone-1
# Both test-restored AND clone-1 running with same state

# 5. CRIU cross-machine migration
# Transfer snapshot to a second EC2 instance and restore there
scp /tmp/snap.tar.gz ec2-runtime:/tmp/
ssh ec2-runtime "sudo podman container restore --import=/tmp/snap.tar.gz --name=migrated"
ssh ec2-runtime "sudo podman exec migrated python -c 'print(x)'"  # should print 42

# 6. Live-resize a container
sudo podman update --memory=1g --cpus=2 test-restored

# 7. Caddy auto-HTTPS
caddy reverse-proxy --from markco.dev --to localhost:8080

# 8. Postgres
sudo -u postgres createdb markco
psql markco -c "SELECT 1"

# 9. CloudFront serves static content
# Upload test file to S3 → verify CloudFront delivers it globally

# 10. EC2 API: provision and terminate an instance programmatically
aws ec2 run-instances --instance-type t3.small --image-id $AMI_ID ...
# Verify it starts in <90s, then terminate
```

**Done when:** Every script passes. Confidence in every tool we're building on.

---

## Layer 2: Containers

**Goal:** Build container images. Validate they run mrmd-server and runtimes with CRIU elastic migration across EC2 instances.

**Time:** 5 days.

### Editor Container

Runs on the base server. Serves UI, proxies to runtimes.

```dockerfile
FROM node:22-slim
COPY mrmd-server/ /app/mrmd-server/
COPY mrmd-electron/ /app/mrmd-electron/
COPY mrmd-editor/dist/ /app/mrmd-electron/editor/
COPY mrmd-sync/ /app/mrmd-sync/
WORKDIR /app/mrmd-server
RUN npm ci --production
EXPOSE 8080
CMD ["node", "bin/cli.js", "--port", "8080", "--host", "0.0.0.0"]
```

### Runtime Container (Podman, CRIU-capable)

Runs on elastic EC2 instances. Pre-baked AMI with this image ready.

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y \
    python3 python3-venv python3-pip \
    r-base julia bash git curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY mrmd-python/ /app/mrmd-python/
COPY mrmd-bash/ /app/mrmd-bash/
COPY mrmd-r/ /app/mrmd-r/
COPY mrmd-julia/ /app/mrmd-julia/
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user
```

### GPU Runtime Container

Same as runtime but with NVIDIA drivers + CUDA + CRIUgpu.

```dockerfile
FROM nvidia/cuda:12.x-runtime-ubuntu24.04
# ... same as runtime plus NVIDIA tooling
# CRIU 4.0+ with CRIUgpu support
```

### Pre-Baked AMIs

Build AMIs with Podman + CRIU + runtime container image pre-pulled:
- **CPU AMI:** t4g family (ARM64), Podman + CRIU + runtime image
- **GPU AMI:** g5 family (x86), Podman + CRIU + CRIUgpu + GPU runtime image

Pre-pulled images mean container start is instant — no image download on first run.

### Validation

```bash
# Build images
sudo podman build -t mrmd-editor -f Dockerfile.editor .
sudo podman build -t mrmd-runtime -f Dockerfile.runtime .

# Create test user data
mkdir -p /data/users/test/projects/hello
echo '```yaml config
name: "Hello"
```' > /data/users/test/projects/hello/mrmd.md
echo "# Hello World" > /data/users/test/projects/hello/01-hello.md

# 1. Editor serves UI
sudo podman run -d --name editor-test \
  --memory=256m --cpus=0.25 \
  -v /data/users/test:/home/user \
  -p 8080:8080 \
  mrmd-editor
# → open browser, see project, edit file

# 2. Runtime on same machine (instant start)
sudo podman run -d --name runtime-local \
  --memory=512m --cpus=0.5 \
  -v /data/users/test:/home/user \
  mrmd-runtime
sudo podman exec runtime-local ls /home/user/projects/hello/
# → mrmd.md  01-hello.md

# 3. CRIU elastic migration: local → remote EC2
sudo podman container checkpoint runtime-local \
  --leave-running --export=/tmp/rt-snap.tar.gz
scp /tmp/rt-snap.tar.gz ec2-runtime-2:/tmp/
ssh ec2-runtime-2 "sudo podman container restore \
  --import=/tmp/rt-snap.tar.gz --name=runtime-migrated"
# Verify state preserved on remote machine

# 4. CRIU migration back: remote → local
ssh ec2-runtime-2 "sudo podman container checkpoint runtime-migrated \
  --leave-running --export=/tmp/rt-back.tar.gz"
scp ec2-runtime-2:/tmp/rt-back.tar.gz /tmp/
sudo podman container restore --import=/tmp/rt-back.tar.gz --name=runtime-returned
# Full round-trip: state preserved

# 5. Measure migration time end-to-end
# Target: <10s for a 2 GB runtime within same AZ

# 6. Editor → runtime proxy works
# (editor proxies /proxy/:port/* to runtime's MRP port, even across machines)
```

**Done when:** Editor serves UI. Runtime runs Python/R/Julia/Bash. CRIU migration works across EC2 instances. Round-trip preserves state. Proxy works across machines.

---

## Layer 3: Services

**Goal:** Build each service as an independent module with its own tests. No service depends on another service yet.

**Time:** 3 weeks (work on multiple services in parallel).

### 3a: auth-service

```
Input:  OAuth callback from Google/GitHub
Output: user record in Postgres, session token

Tables:
  users (id, email, name, plan, created_at)
  sessions (id, user_id, token, expires_at)
  invites (id, project_path, token, role, expires_at, created_by)
```

**Validation:**

```bash
node auth-service/index.js

# OAuth → create user → return token
curl -X POST localhost:3001/auth/github -d '{"code": "test"}'
# → { "user_id": "abc", "token": "xyz" }

# Validate token
curl localhost:3001/auth/validate -H "Authorization: Bearer xyz"
# → { "user_id": "abc", "plan": "free" }

# Create invite
curl -X POST localhost:3001/invites -d '{"project": "/data/users/abc/projects/hello", "role": "editor"}'
# → { "token": "a7f3b2c1", "url": "markco.dev/join/a7f3b2c1" }

# Validate invite
curl localhost:3001/invites/a7f3b2c1
# → { "project": "...", "role": "editor", "created_by": "abc" }
```

### 3b: compute-manager

Replaces the old container-manager. Manages elastic compute across EC2.

```
Input:  "start runtime for user X", "migrate to bigger machine", "provision GPU"
Output: running runtimes with correct resources, transparent migration

Uses AWS EC2 API. Tracks state in Postgres.

Tables:
  runtimes (id, user_id, ec2_instance_id, instance_type, host, port,
            state, memory_limit, memory_used, cpu_limit, created_at)
  migrations (id, runtime_id, from_instance, to_instance, from_type, to_type,
              strategy, status, checkpoint_ms, transfer_ms, restore_ms,
              started_at, completed_at)
  snapshots (id, user_id, name, path, size_bytes, created_at)
```

**Validation:**

```bash
node compute-manager/index.js

# Start runtime (co-located on base server first)
curl -X POST localhost:3002/runtimes -d '{"user_id": "abc", "plan": "free"}'
# → { "runtime_id": "...", "host": "localhost", "port": 41765, "instance_type": "local" }

# Elastic scale-up: migrate to bigger EC2
curl -X POST localhost:3002/runtimes/abc/migrate \
  -d '{"target_type": "t3.medium"}'
# → provisions EC2, CRIU migrates, returns new host:port
# → { "host": "10.0.1.42", "port": 41765, "instance_type": "t3.medium" }

# GPU provision
curl -X POST localhost:3002/runtimes/abc/migrate \
  -d '{"target_type": "g5.xlarge", "spot": true}'
# → { "host": "10.0.1.99", "port": 41765, "instance_type": "g5.xlarge" }

# Scale down (back to small/local)
curl -X POST localhost:3002/runtimes/abc/migrate \
  -d '{"target_type": "local"}'

# Save snapshot (user idle or explicit save)
curl -X POST localhost:3002/runtimes/abc/snapshot \
  -d '{"name": "before-training"}'
# → { "snapshot_id": "...", "size_bytes": 2147483648, "path": "/snapshots/abc/..." }

# Restore from snapshot (user returns)
curl -X POST localhost:3002/runtimes/abc/restore \
  -d '{"snapshot_id": "..."}'
# → provisions appropriate EC2, restores, returns host:port

# AI sandbox (CRIU fork)
curl -X POST localhost:3002/runtimes/abc/sandbox
# → { "sandbox_id": "sandbox-1", "host": "...", "port": 41800 }

curl -X DELETE localhost:3002/runtimes/abc/sandbox/sandbox-1
# → sandbox destroyed
```

### 3c: publish-service

```
Input:  URL like /@maxime/my-analysis/getting-started/setup
Output: HTML page with mrmd-reader.iife.js + content
```

**Step 1: Build mrmd-reader.iife.js** — this is the critical piece.

```bash
cd mrmd-editor
# New rollup config: rollup.config.reader.js
# Same extensions as editor minus editing-specific ones:
#   KEEP: block decorations, inline decorations, syntax highlighting,
#         math, tables, mermaid, code block rendering, image rendering
#   STRIP: toolbar, keybindings, cursor, collaboration, session management
npm run build:reader
# → dist/mrmd-reader.iife.js (~800 KB, gzipped ~250 KB)
```

**Step 2: URL-to-FSML mapping.**

```
/@maxime/my-analysis/getting-started/setup
→ user: maxime
→ project: my-analysis
→ path: getting-started/setup
→ FSML lookup: 02-getting-started/01-setup.md
```

Rules: strip numeric prefixes, strip extensions, match against filesystem.

**Step 3: Serve reader pages.**

```bash
node publish-service/index.js --users-dir=/data/users

curl localhost:3003/@test/hello/hello
# → HTML page with mrmd-reader.iife.js + "Hello World" content
```

**Validation:** Compare screenshot of published page with editor showing the same document. Must be pixel-identical rendering for markdown, tables, math, code blocks, mermaid, images.

### 3d: resource-monitor

```
Input:  polls runtime stats (local and remote EC2)
Output: events (memory-warning, scale-trigger, idle-sleep, idle-wake, gpu-hint)

Actions:
  50% RAM → emit pre-provision event (start bigger EC2 in background)
  75% RAM → emit migrate event (CRIU to pre-provisioned machine)
  90% RAM → emit urgent-migrate event
  95% RAM → pause runtime + emit critical event
  Idle N min → CRIU checkpoint + snapshot to base EBS + terminate EC2
  User returns → restore from snapshot
  GPU library detected → emit gpu-hint event
```

**Validation:**

```bash
node resource-monitor/index.js

# Simulate: start a container, fill its memory
sudo podman run -d --name stress-test --memory=1g ubuntu \
  stress-ng --vm 1 --vm-bytes 800M -t 60s

# Monitor should detect >50% and emit pre-provision
# Monitor should detect >75% and emit migrate
# Monitor should detect idle and checkpoint after timeout
```

### 3e: data-service (Arrow Flight + DuckDB)

```
Input:  Arrow Flight requests, SQL queries
Output: filtered Arrow tables
```

```bash
python data-service/server.py --data-dir=/data/shared --port=8815

# Load a test dataset
python -c "
import pyarrow.flight as flight
client = flight.connect('grpc://localhost:8815')

# List available datasets
for f in client.list_flights():
    print(f.descriptor.path, f.total_records, f.total_bytes)

# Query with server-side filtering
ticket = flight.Ticket(b'{\"dataset\": \"test\", \"sql\": \"SELECT * WHERE state = \\\"CA\\\"\"}')
reader = client.do_get(ticket)
table = reader.read_all()
print(table.shape)  # should be filtered subset
"
```

**Done when:** Each service runs independently and passes its own validation. No service knows about any other service.

---

## Layer 4: Orchestrator

**Goal:** Glue the services together. The orchestrator is the only thing that knows about all services.

**Time:** 2 weeks.

### What It Does

```javascript
// On user login:
//   1. auth-service validates OAuth → user record
//   2. Editor container starts on base server (or already running)
//   3. Caddy config updated to route user's traffic

// On first cell execution:
//   1. Runtime starts co-located on base server (instant, small allocation)
//   2. compute-manager tracks memory usage

// On memory pressure (transparent to user):
//   1. resource-monitor detects 50% → compute-manager pre-provisions bigger EC2
//   2. resource-monitor detects 75% → compute-manager CRIU migrates (--leave-running)
//   3. Proxy switches to new host:port atomically
//   4. Old runtime killed. User never noticed.

// On GPU library detected:
//   1. resource-monitor detects import torch / pip install tensorflow
//   2. compute-manager pre-provisions g5.xlarge spot in background
//   3. When user runs .cuda() / .to("cuda") → CRIU migrate to GPU instance
//   4. GPU work done → CRIU migrate back to CPU instance
//   5. GPU instance terminated

// On user idle:
//   1. resource-monitor detects no activity for N minutes
//   2. CRIU checkpoint → snapshot saved to base server EBS
//   3. EC2 runtime instance terminated → $0
//   4. User returns → compute-manager restores from snapshot

// On published URL visit:
//   1. publish-service serves reader page (no containers needed)
//   2. Static assets served via CloudFront CDN

// On collaborator joins:
//   1. auth-service validates invite token
//   2. Route collaborator's browser to owner's editor + mrmd-sync

// On AI sandbox request:
//   1. compute-manager creates CRIU fork (--leave-running)
//   2. Returns sandbox host:port to AI assistant
//   3. On conversation end: sandbox destroyed
```

### Caddy Dynamic Config

The orchestrator updates Caddy's routing via its admin API:

```
markco.dev/@*           → publish-service:3003
markco.dev/auth/*       → auth-service:3001
markco.dev/join/*       → auth-service:3001 → then redirect to editor
markco.dev/user-abc/*   → editor container on port 8081
markco.dev/user-def/*   → editor container on port 8082
```

Runtime proxy routes through the editor container, which forwards to the correct EC2 instance (local or remote).

### Database Schema

```sql
-- From auth-service
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE invites (
  id UUID PRIMARY KEY,
  project_path TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id)
);

-- From compute-manager
CREATE TABLE runtimes (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  ec2_instance_id TEXT,
  instance_type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER,
  state TEXT DEFAULT 'running',
  memory_limit BIGINT,
  memory_used BIGINT,
  cpu_limit REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE snapshots (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE migrations (
  id UUID PRIMARY KEY,
  runtime_id UUID REFERENCES runtimes(id),
  from_instance TEXT NOT NULL,
  to_instance TEXT NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  checkpoint_ms INTEGER,
  transfer_ms INTEGER,
  restore_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
```

### Validation: Full Integration Test

```
1. Sign in with GitHub OAuth → user created, editor starts
2. Open project in editor → UI loads, files visible
3. Run Python cell → runtime starts co-located, output returned
4. Fill runtime memory past 50% → observe pre-provision of bigger EC2
5. Fill past 75% → observe CRIU migration, no interruption to user
6. Import torch → observe GPU instance pre-provisioned
7. Run .cuda() cell → observe CRIU migration to GPU, execution, migration back
8. Add publish: config → visit published URL → reader renders via CloudFront
9. Generate invite link → open in incognito → collaborator sees project
10. Both edit same document → cursors visible, changes merge
11. Go idle → observe checkpoint + EC2 termination
12. Return → observe restore from snapshot, all state preserved
13. Request AI sandbox → CRIU fork → AI executes → sandbox destroyed
```

**Done when:** All 13 steps of the integration test pass end-to-end.

---

## Layer 5: UI

**Goal:** Add user-facing UI for the features built in Layers 1-4.

**Time:** 2 weeks.

### Components

| Component | Where | What |
|---|---|---|
| Share button + invite panel | mrmd-electron index.html | Generate invite links, manage collaborators, set roles |
| Published site indicator | mrmd-electron index.html | Show "Live at markco.dev/@user/project" when publish: configured |
| Compute indicator | mrmd-electron index.html | Show current runtime tier (CPU/GPU), subtle, non-intrusive |
| Plan upgrade modal | mrmd-electron index.html | Show plan options, trigger Stripe checkout |
| Collaborator cursors | mrmd-editor | Yjs awareness rendering (may already work via mrmd-sync) |
| Online users indicator | mrmd-electron index.html | Show who's currently editing |
| `_drafts/` dimmed styling | mrmd-electron index.html | `_` prefix items shown dimmed below separator in nav |
| AI sandbox indicator | mrmd-electron index.html | Show when AI is working in a sandbox |
| Snapshot management | mrmd-electron index.html | Save/restore/share runtime snapshots |

Note: No memory warning banner needed — elastic compute handles it transparently. Only show compute indicator subtly (e.g., small icon showing CPU/GPU tier).

### Nav With Author-Only Sections

```
Nav (author view):

  Introduction
  Getting Started
    Installation
    Configuration
  Tutorials
    Basic
    Advanced
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  Drafts                  ← dimmed
    Upcoming Feature
  Assets                  ← dimmed
  Lib                     ← dimmed
```

`_` prefixed folders: visible but visually distinct. Below a separator. Dimmed text or muted color. Clicking works normally — full editing experience.

---

## Integration Contracts

Each layer's contract with the layer above:

```
Layer 1 → Layer 2:
  "I provide: EC2 API, Podman, CRIU, Caddy, Postgres, CloudFront, S3"
  "You can: run containers, checkpoint them, migrate across machines, route to them"

Layer 2 → Layer 3:
  "I provide: running containers with CRIU migration, pre-baked AMIs"
  "You can: start/stop runtimes, checkpoint, migrate, provision any EC2 tier"

Layer 3 → Layer 4:
  "I provide: auth tokens, elastic compute lifecycle, published pages, resource events, GPU hints"
  "You can: authenticate users, manage elastic runtimes, serve sites, monitor + auto-scale"

Layer 4 → Layer 5:
  "I provide: WebSocket events, REST APIs for all operations"
  "You can: show UI for login, editing, publishing, collaboration, compute status"
```

If a layer's contract is met, the layer above doesn't care how it's implemented.

---

## Multi-Region Expansion (Future)

When users outside North America need low-latency WebSocket:

```
Phase 1 (now):    ca-central-1 only + CloudFront CDN         ~$15/mo
Phase 2 (Europe): add eu-west-2 (London) base server         +$15/mo
Phase 3 (Asia):   add ap-northeast-1 (Tokyo) base server     +$15/mo
```

Each region runs its own base server (editor + Caddy + Postgres replica). Runtimes are elastic EC2 within each region. User files on EBS per region (or S3 + EFS for cross-region).

Route 53 latency-based routing sends users to nearest region automatically.

---

## Timeline

```
Layer 1: Infrastructure         2 days
Layer 2: Containers             5 days
Layer 3: Services (parallel)    3 weeks
Layer 4: Orchestrator           2 weeks
Layer 5: UI                     2 weeks
─────────────────────────────────────────
Total:                          ~8 weeks
```

**Key discipline:** Don't start Layer N+1 until Layer N's validation scripts pass. A solid Layer 2 makes Layer 3 trivial. A shaky Layer 2 makes Layer 3 a nightmare.

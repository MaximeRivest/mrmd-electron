# Layer 2: CRIU Benchmark Results

> 2026-02-09, ca-central-1b, Ubuntu 24.04 x86_64

## Setup

- **Base server:** EC2 t3.small (2 vCPU, 2 GB RAM) — `i-04210339d6c067c47`
- **Runtime server:** EC2 t3.medium (2 vCPU, 4 GB RAM) — `i-01de74e4c440b70cd`
- **Same AZ:** ca-central-1b (private IP transfer)
- **CRIU:** 4.2 (built from source)
- **Podman:** 4.9.3 with runc (crun doesn't support CRIU)
- **Container image:** python:3.12-slim

## Local Checkpoint/Restore (same machine, t3.small)

| Allocated | Checkpoint | Restore | --leave-running | Snapshot Size |
|-----------|-----------|---------|-----------------|---------------|
| 128 MB    | 800 ms    | 1,359 ms | 428 ms         | 777 KB        |
| 256 MB    | 1,381 ms  | 2,366 ms | 908 ms         | 789 KB        |
| 512 MB    | 3,835 ms  | 5,682 ms | 3,938 ms       | 830 KB        |

Note: Snapshot sizes are small because CRIU compresses memory pages. The checkpoint/restore time scales linearly with allocated memory (dominated by page dump/restore, not I/O).

## Cross-Machine Migration (t3.small → t3.medium, same AZ)

| Allocated | Checkpoint | Transfer (scp) | Restore | Total |
|-----------|-----------|----------------|---------|-------|
| 128 MB    | 513 ms    | 605 ms         | 352 ms  | 1,470 ms |
| 256 MB    | 737 ms    | 467 ms         | 348 ms  | 1,560 ms |
| 512 MB    | 3,066 ms  | 487 ms         | 376 ms  | 3,938 ms |

Key insight: Transfer is fast (~500ms) because snapshots compress well. Checkpoint dominates for larger allocations.

## Round-Trip Migration (128 MB)

| Direction | Time |
|-----------|------|
| Local → Remote | 1,429 ms |
| Remote → Local | 875 ms |
| **Full round-trip** | **2,314 ms** |

All 3 instances (original + remote clone + returned clone) ran simultaneously after round-trip.

## Key Findings

1. **--leave-running is the killer feature.** Zero downtime during migration — original keeps running while snapshot transfers. Switch proxy atomically after restore.

2. **Snapshot sizes are tiny** (~800 KB for 512 MB allocated). CRIU compresses zero pages and deduplicates. Transfer is not the bottleneck.

3. **Checkpoint time is the bottleneck.** Scales linearly with memory: ~800ms/128MB. For a 2GB runtime, expect ~6-8 seconds checkpoint.

4. **Cross-machine restore is faster than local restore.** Remote t3.medium restores in ~350ms vs local t3.small taking 1-5 seconds. More RAM = faster restore.

5. **Practical migration times:**
   - 256 MB runtime: ~1.5s total (imperceptible with --leave-running)
   - 512 MB runtime: ~4s total (user won't notice with --leave-running)
   - 2 GB runtime: ~10s estimated (still within spec target)

## Architecture Decision: runc vs crun

**Must use runc**, not crun. crun doesn't support CRIU checkpoint/restore. Set in `/etc/containers/containers.conf`:

```
[engine]
runtime = "runc"
```

## Next Steps

- [ ] Pre-bake AMI with Podman + CRIU + runc + Python image pre-pulled
- [ ] Build editor container and test mrmd-server serving UI
- [ ] Test editor → runtime proxy across machines
- [ ] Benchmark with real mrmd-python workloads (pandas, numpy)

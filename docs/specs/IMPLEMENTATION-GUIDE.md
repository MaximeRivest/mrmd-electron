# Implementation Guide

> Master guide for implementing the mrmd project/session/navigation system.

---

## Specifications

| Spec | Location | Purpose |
|------|----------|---------|
| **FSML** | `fsml-filesystem-markup-language.md` | Filesystem conventions, navigation tree |
| **Runtime & Execution** | `runtime-and-execution.md` | Sessions, config, frontmatter |
| **File Navigation & Creation** | `file-navigation-and-creation.md` | Ctrl+P interface |
| **mrmd-project** | `/mrmd-project/spec.md` | Pure logic package |
| **Services** | `services.md` | Electron main process services |
| **UI Components** | `/mrmd-editor/docs/specs/ui-components.md` | Editor UI components |

---

## Package Structure

```
mrmd-packages/
├── mrmd-project/                 # NEW - Pure logic
│   ├── package.json
│   ├── spec.md                   # Literate spec with tests
│   └── src/
│       ├── index.js              # Exports
│       ├── project.js            # Project.findRoot, parseConfig, etc.
│       ├── fsml.js               # FSML.parsePath, sortPaths, buildNavTree
│       ├── links.js              # Links.parse, resolve, refactor
│       ├── assets.js             # Assets.computeRelativePath, refactorPaths
│       ├── scaffold.js           # Scaffold.project, standaloneFrontmatter
│       └── search.js             # Search.fuzzyMatch, files
│
├── mrmd-editor/                  # ENHANCED - UI components
│   ├── docs/specs/ui-components.md
│   └── src/
│       ├── navigation-panel.js   # NEW
│       ├── file-picker.js        # NEW (replaces current in index.html)
│       ├── session-controls.js   # NEW
│       ├── standalone-banner.js  # NEW
│       ├── link-autocomplete.js  # NEW
│       └── ... (existing)
│
└── mrmd-electron/                # ENHANCED - Services
    ├── docs/specs/
    │   ├── services.md
    │   └── ... (other specs)
    ├── main.js                   # Refactored to use services
    ├── preload.js                # Enhanced IPC API
    ├── index.html                # Uses mrmd-editor components
    └── src/                      # NEW - Extracted services
        ├── services/
        │   ├── project-service.js
        │   ├── session-service.js
        │   ├── file-service.js
        │   └── asset-service.js
        └── ipc/
            ├── project.js
            ├── session.js
            ├── file.js
            └── asset.js
```

---

## Implementation Order

### Phase 1: mrmd-project (Foundation)

This is the foundation - pure logic, no I/O. Can be tested in isolation.

```bash
# 1. Create package
mkdir -p mrmd-project/src
cd mrmd-project

# 2. Initialize
npm init -y
```

**Implement in order:**

1. **project.js** — Config parsing
   - `parseConfig()` — Extract yaml config blocks
   - `parseFrontmatter()` — Extract YAML frontmatter
   - `mergeConfig()` — Deep merge configs
   - `resolveSession()` — Compute session config
   - `findRoot()` — Walk up to find mrmd.md

2. **fsml.js** — Path handling
   - `parsePath()` — Extract order, name, title
   - `sortPaths()` — Sort by FSML rules
   - `buildNavTree()` — Build nested structure
   - `titleFromFilename()` — Derive titles

3. **links.js** — Internal links
   - `parse()` — Extract [[links]]
   - `resolve()` — Find target file
   - `refactor()` — Update links on move

4. **assets.js** — Asset paths
   - `computeRelativePath()` — Document to asset
   - `refactorPaths()` — Update on doc move
   - `extractPaths()` — Find all asset refs

5. **scaffold.js** — Templates
   - `project()` — Project scaffold
   - `standaloneFrontmatter()` — Frontmatter template

6. **search.js** — Fuzzy search
   - `fuzzyMatch()` — Score a match
   - `files()` — Search file list

**Test each module using the spec.md code blocks:**

```bash
# Run the spec as a test
node --experimental-vm-modules -e "
  import * as Project from './src/project.js';
  // Paste test code from spec.md
"
```

### Phase 2: mrmd-electron Services

Implement services that use mrmd-project.

1. **project-service.js**
   - Uses `Project.findRoot()`, `Project.parseConfig()`
   - Adds file I/O, caching

2. **session-service.js**
   - Uses `Project.resolveSession()`
   - Manages Python processes

3. **file-service.js**
   - Uses `FSML.sortPaths()`, `Links.refactor()`, `Assets.refactorPaths()`
   - File operations with refactoring

4. **asset-service.js**
   - Uses `Assets.computeRelativePath()`
   - Deduplication, orphan detection

### Phase 3: IPC Handlers

Wire services to IPC:

```javascript
// src/ipc/project.js
import { ipcMain } from 'electron';
import { projectService } from '../services/project-service.js';

export function registerProjectIpc() {
  ipcMain.handle('project:get', async (e, { filePath }) => {
    return projectService.getProject(filePath);
  });

  ipcMain.handle('project:create', async (e, { targetPath }) => {
    return projectService.createProject(targetPath);
  });

  // ... etc
}
```

### Phase 4: mrmd-editor Components

Implement UI components:

1. **navigation-panel.js** — File tree
2. **file-picker.js** — Enhanced Ctrl+P
3. **session-controls.js** — CodeLens in config
4. **standalone-banner.js** — No-project warning
5. **link-autocomplete.js** — [[link]] completion

### Phase 5: Integration

Wire everything in mrmd-electron:

1. Update `main.js` to use services
2. Update `preload.js` with new IPC API
3. Update `index.html` to use mrmd-editor components

---

## Testing Strategy

### Unit Tests (mrmd-project)

Each module has tests embedded in `spec.md`. Extract and run:

```javascript
// test/project.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as Project from '../src/project.js';

describe('Project.parseConfig', () => {
  it('extracts single yaml config block', () => {
    const content = `# My Project
\`\`\`yaml config
name: "My Thesis"
\`\`\``;

    const config = Project.parseConfig(content);
    assert.strictEqual(config.name, 'My Thesis');
  });

  // More tests from spec.md...
});
```

Run: `node --test test/*.test.js`

### Integration Tests (mrmd-electron)

Test services with real file operations:

```javascript
// test/integration/project-service.test.js
import { describe, it, before, after } from 'node:test';
import { ProjectService } from '../../src/services/project-service.js';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ProjectService', () => {
  let tempDir;
  let service;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mrmd-test-'));
    service = new ProjectService();

    // Create test project
    await mkdir(join(tempDir, 'test-project'));
    await writeFile(
      join(tempDir, 'test-project', 'mrmd.md'),
      '```yaml config\nname: "Test"\n```'
    );
  });

  after(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('finds project from nested file', async () => {
    const project = await service.getProject(
      join(tempDir, 'test-project', 'subdir', 'file.md')
    );
    assert.strictEqual(project.config.name, 'Test');
  });
});
```

### E2E Tests (Electron)

Use Playwright for full app testing:

```javascript
// test/e2e/file-picker.test.js
import { test, expect, _electron } from '@playwright/test';

test('Ctrl+P opens file picker', async () => {
  const app = await _electron.launch({ args: ['.'] });
  const window = await app.firstWindow();

  await window.keyboard.press('Control+p');

  const picker = await window.locator('.mrmd-picker');
  await expect(picker).toBeVisible();

  await app.close();
});
```

---

## Running the Literate Specs

The spec files contain executable code blocks. To run them:

### Option 1: Manual extraction

Copy code blocks from spec.md into test files.

### Option 2: Literate programming runner

Create a simple runner that extracts and executes code blocks:

```javascript
// tools/run-spec.js
import { readFile } from 'fs/promises';

async function runSpec(specPath) {
  const content = await readFile(specPath, 'utf8');

  // Extract ```javascript blocks
  const codeBlocks = [];
  const regex = /```javascript\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    codeBlocks.push(match[1]);
  }

  console.log(`Found ${codeBlocks.length} code blocks`);

  // Run each block
  for (let i = 0; i < codeBlocks.length; i++) {
    console.log(`\n--- Block ${i + 1} ---`);
    try {
      // Use Function constructor for isolation
      const fn = new Function('require', codeBlocks[i]);
      await fn(require);
    } catch (e) {
      console.error(`Block ${i + 1} failed:`, e.message);
    }
  }
}

runSpec(process.argv[2]);
```

Run: `node tools/run-spec.js mrmd-project/spec.md`

### Option 3: Use mrmd itself!

Once mrmd-project is implemented, use mrmd to run the spec.md file — the code blocks will execute and verify themselves!

---

## Verification Checklist

### mrmd-project

- [ ] `Project.parseConfig` extracts yaml config blocks
- [ ] `Project.parseConfig` deep merges multiple blocks
- [ ] `Project.parseFrontmatter` extracts frontmatter
- [ ] `Project.mergeConfig` document overrides project
- [ ] `Project.resolveSession` computes absolute paths
- [ ] `FSML.parsePath` extracts order, name, title
- [ ] `FSML.sortPaths` orders correctly
- [ ] `FSML.buildNavTree` creates nested structure
- [ ] `Links.parse` extracts all link types
- [ ] `Links.resolve` finds exact and fuzzy matches
- [ ] `Links.refactor` updates links on move
- [ ] `Assets.computeRelativePath` handles nesting
- [ ] `Assets.refactorPaths` updates on doc move
- [ ] `Search.fuzzyMatch` scores correctly
- [ ] `Search.files` ranks by path match

### mrmd-electron Services

- [ ] `ProjectService.getProject` finds and parses project
- [ ] `ProjectService.createProject` scaffolds correctly
- [ ] `SessionService.start` creates running session
- [ ] `SessionService.stop` kills process and releases resources
- [ ] `FileService.scan` returns sorted, filtered files
- [ ] `FileService.move` refactors links and assets
- [ ] `AssetService.save` deduplicates by hash
- [ ] `AssetService.findOrphans` detects unused

### mrmd-editor Components

- [ ] `NavigationPanel` renders tree
- [ ] `NavigationPanel` drag-drop reorders
- [ ] `NavigationPanel` inline rename works
- [ ] `FilePicker` fuzzy search on full path
- [ ] `FilePicker` path mode navigation
- [ ] `FilePicker` creates files and projects
- [ ] `SessionControls` shows status
- [ ] `SessionControls` start/stop/restart work
- [ ] `StandaloneBanner` shows for non-project files
- [ ] `LinkAutocomplete` suggests files

### Integration

- [ ] Open file in project → nav shows, session starts
- [ ] Open standalone file → banner shows
- [ ] Create file via Ctrl+P → file created, opened
- [ ] Create project via Ctrl+P → scaffolded, opened
- [ ] Move file → links and assets refactored
- [ ] Session restart → PID changes, state cleared

---

## Dependencies

### mrmd-project

```json
{
  "name": "mrmd-project",
  "type": "module",
  "dependencies": {
    "yaml": "^2.3.0"
  }
}
```

### mrmd-editor additions

No new dependencies — uses existing CodeMirror.

### mrmd-electron additions

No new dependencies — uses existing Node.js APIs.

---

## Migration Path

To avoid breaking the existing app during implementation:

1. **Keep existing code working** — Don't modify main.js/index.html initially
2. **Build mrmd-project separately** — Test in isolation
3. **Add services alongside existing code** — New IPC handlers with different names
4. **Build components in mrmd-editor** — Export but don't use yet
5. **Create new index.html (v2)** — Uses new components
6. **Switch over** — Replace old with new
7. **Remove old code** — Clean up

---

## Next Steps

1. Create `mrmd-project/package.json`
2. Implement `project.js` with tests
3. Implement `fsml.js` with tests
4. Continue through the implementation order
5. Verify each module against spec.md
6. Integrate and test end-to-end

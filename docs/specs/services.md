# mrmd-electron Services Specification

> I/O and process management services for mrmd-electron.

**Mission:** Handle all side effects — file operations, process spawning, IPC communication.

**Depends on:** `mrmd-project` for all logic/computation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  main.js                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Services (stateful, manage processes)                               │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │   │
│  │  │ Project     │ │ Session     │ │ File        │ │ Asset       │    │   │
│  │  │ Service     │ │ Service     │ │ Service     │ │ Service     │    │   │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               │                                             │
│                        uses mrmd-project                                    │
│                        for all computation                                  │
│                               │                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  IPC Handlers (expose services to renderer)                          │   │
│  │  project:*, session:*, file:*, asset:*                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               │                                             │
│                          preload.js                                         │
│                               │                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  renderer (index.html)                                               │   │
│  │  electronAPI.project.*, electronAPI.session.*, etc.                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. ProjectService

Manages project detection, configuration, and context.

### 1.1 Interface

```typescript
interface ProjectInfo {
  root: string;
  config: ProjectConfig;      // From mrmd-project
  files: string[];            // All files in project
  navTree: NavNode[];         // From mrmd-project FSML
}

class ProjectService {
  // Get project for a file (cached)
  async getProject(filePath: string): Promise<ProjectInfo | null>

  // Invalidate cache (after file changes)
  invalidate(projectRoot: string): void

  // Create new project
  async createProject(targetPath: string): Promise<ProjectInfo>

  // Watch for changes
  watch(projectRoot: string, onChange: () => void): Watcher
}
```

### 1.2 IPC Handlers

```javascript
// Get project for a file
ipcMain.handle('project:get', async (event, { filePath }) => {
  return projectService.getProject(filePath);
});

// Create new project
ipcMain.handle('project:create', async (event, { targetPath }) => {
  return projectService.createProject(targetPath);
});

// Get navigation tree
ipcMain.handle('project:nav', async (event, { projectRoot }) => {
  const project = await projectService.getProject(projectRoot);
  return project?.navTree || [];
});
```

### 1.3 Implementation Notes

```javascript
// ProjectService implementation sketch

import { Project, FSML, Scaffold } from 'mrmd-project';
import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';

class ProjectService {
  constructor() {
    this.cache = new Map(); // projectRoot -> ProjectInfo
    this.watchers = new Map();
  }

  async getProject(filePath) {
    // 1. Find project root using mrmd-project
    const root = Project.findRoot(filePath, (p) => {
      try {
        return fs.existsSync(path.join(p, 'mrmd.md'));
      } catch { return false; }
    });

    if (!root) return null;

    // 2. Check cache
    if (this.cache.has(root)) {
      return this.cache.get(root);
    }

    // 3. Load project
    const mrmdPath = path.join(root, 'mrmd.md');
    const content = await fs.readFile(mrmdPath, 'utf8');
    const config = Project.parseConfig(content);

    // 4. Scan files
    const files = await this.scanFiles(root);

    // 5. Build nav tree using mrmd-project
    const navTree = FSML.buildNavTree(files);

    // 6. Cache and return
    const info = { root, config, files, navTree };
    this.cache.set(root, info);
    return info;
  }

  async createProject(targetPath) {
    // 1. Get scaffold from mrmd-project
    const name = path.basename(targetPath);
    const scaffold = Scaffold.project(name);

    // 2. Create directory
    await fs.mkdir(targetPath, { recursive: true });

    // 3. Write files
    for (const file of scaffold.files) {
      const fullPath = path.join(targetPath, file.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content);
    }

    // 4. Create venv
    await this.createVenv(path.join(targetPath, scaffold.venvPath));

    // 5. Install mrmd-python
    await this.installMrmdPython(path.join(targetPath, scaffold.venvPath));

    // 6. Return project info
    return this.getProject(targetPath);
  }

  async scanFiles(root) {
    // Recursive scan, excluding hidden and system folders
    const files = [];
    // ... implementation
    return files;
  }

  async createVenv(venvPath) {
    // python -m venv <venvPath>
  }

  async installMrmdPython(venvPath) {
    // uv pip install mrmd-python
  }
}
```

### 1.4 Tests

```javascript
// Test: ProjectService.getProject finds project
const projectService = new ProjectService();

// Setup: Create temp project structure
const tempDir = await createTempProject({
  'mrmd.md': '```yaml config\nname: "Test"\n```',
  '01-intro.md': '# Intro',
  '02-methods/01-setup.md': '# Setup',
});

const project = await projectService.getProject(
  path.join(tempDir, '02-methods/01-setup.md')
);

console.assert(project !== null);
console.assert(project.root === tempDir);
console.assert(project.config.name === 'Test');
console.assert(project.files.includes('01-intro.md'));
console.assert(project.navTree.length > 0);
console.log('✓ ProjectService.getProject finds and parses project');
```

```javascript
// Test: ProjectService.getProject returns null for non-project
const project = await projectService.getProject('/tmp/random/file.md');

console.assert(project === null);
console.log('✓ ProjectService.getProject returns null for non-project');
```

```javascript
// Test: ProjectService.createProject scaffolds correctly
const targetPath = '/tmp/test-new-project';

const project = await projectService.createProject(targetPath);

console.assert(fs.existsSync(path.join(targetPath, 'mrmd.md')));
console.assert(fs.existsSync(path.join(targetPath, '01-index.md')));
console.assert(fs.existsSync(path.join(targetPath, '_assets')));
console.assert(fs.existsSync(path.join(targetPath, '.venv/bin/python')));
console.assert(fs.existsSync(path.join(targetPath, '.venv/bin/mrmd-python')));
console.log('✓ ProjectService.createProject scaffolds full project');
```

---

## 2. SessionService

Manages Python runtime sessions (processes).

### 2.1 Interface

```typescript
interface SessionInfo {
  name: string;             // e.g., "my-thesis:default"
  pid: number;
  port: number;
  venv: string;
  cwd: string;
  startedAt: string;        // ISO timestamp
  alive: boolean;
}

class SessionService {
  // List running sessions
  list(): SessionInfo[]

  // Start a session
  async start(config: ResolvedSession): Promise<SessionInfo>

  // Stop a session
  async stop(sessionName: string): Promise<boolean>

  // Restart a session
  async restart(sessionName: string): Promise<SessionInfo>

  // Attach to existing session
  attach(sessionName: string): SessionInfo | null

  // Get session for document
  async getForDocument(
    documentPath: string,
    projectConfig: ProjectConfig,
    frontmatter: DocumentFrontmatter
  ): Promise<SessionInfo>
}
```

### 2.2 IPC Handlers

```javascript
// List all sessions
ipcMain.handle('session:list', () => {
  return sessionService.list();
});

// Start session
ipcMain.handle('session:start', async (event, { config }) => {
  return sessionService.start(config);
});

// Stop session
ipcMain.handle('session:stop', async (event, { sessionName }) => {
  return sessionService.stop(sessionName);
});

// Restart session
ipcMain.handle('session:restart', async (event, { sessionName }) => {
  return sessionService.restart(sessionName);
});

// Get or create session for document
ipcMain.handle('session:forDocument', async (event, { documentPath }) => {
  const project = await projectService.getProject(documentPath);
  if (!project) return null;

  const content = await fs.readFile(documentPath, 'utf8');
  const frontmatter = Project.parseFrontmatter(content);

  return sessionService.getForDocument(documentPath, project.config, frontmatter);
});
```

### 2.3 Implementation Notes

```javascript
// SessionService implementation sketch

import { Project } from 'mrmd-project';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const REGISTRY_DIR = path.join(os.homedir(), '.mrmd', 'sessions');

class SessionService {
  constructor() {
    this.sessions = new Map(); // name -> SessionInfo
    this.loadRegistry();
  }

  loadRegistry() {
    // Load existing session files from ~/.mrmd/sessions/
    if (!fs.existsSync(REGISTRY_DIR)) return;

    for (const file of fs.readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, file)));
        // Check if still alive
        try {
          process.kill(info.pid, 0);
          info.alive = true;
          this.sessions.set(info.name, info);
        } catch {
          // Process dead, remove registry file
          fs.unlinkSync(path.join(REGISTRY_DIR, file));
        }
      } catch {}
    }
  }

  list() {
    return Array.from(this.sessions.values());
  }

  async start(config) {
    // 1. Check if already running
    if (this.sessions.has(config.name)) {
      const existing = this.sessions.get(config.name);
      if (existing.alive) return existing;
    }

    // 2. Find free port
    const port = await findFreePort();

    // 3. Spawn mrmd-python
    const mrmdPythonPath = path.join(config.venv, 'bin', 'mrmd-python');

    const proc = spawn(mrmdPythonPath, [
      '--id', config.name,
      '--port', port.toString(),
      '--foreground'
    ], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VIRTUAL_ENV: config.venv },
    });

    // 4. Wait for ready
    await waitForPort(port);

    // 5. Register
    const info = {
      name: config.name,
      pid: proc.pid,
      port,
      venv: config.venv,
      cwd: config.cwd,
      startedAt: new Date().toISOString(),
      alive: true,
    };

    this.sessions.set(config.name, info);
    this.saveRegistry(info);

    // 6. Handle exit
    proc.on('exit', () => {
      info.alive = false;
      this.sessions.delete(config.name);
      this.removeRegistry(config.name);
    });

    return info;
  }

  async stop(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return false;

    try {
      // Kill process group to release GPU memory
      process.kill(-session.pid, 'SIGKILL');
    } catch {}

    this.sessions.delete(sessionName);
    this.removeRegistry(sessionName);
    return true;
  }

  async restart(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error('Session not found');

    const config = {
      name: sessionName,
      venv: session.venv,
      cwd: session.cwd,
    };

    await this.stop(sessionName);
    return this.start(config);
  }

  async getForDocument(documentPath, projectConfig, frontmatter) {
    // Use mrmd-project to resolve session config
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    const projectRoot = path.dirname(documentPath); // simplified
    const resolved = Project.resolveSession(documentPath, projectRoot, merged);

    // Check if session exists
    const existing = this.sessions.get(resolved.name);
    if (existing?.alive) return existing;

    // Start new session
    return this.start(resolved);
  }

  saveRegistry(info) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const file = path.join(REGISTRY_DIR, `${info.name.replace(/[:/]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(info, null, 2));
  }

  removeRegistry(sessionName) {
    const file = path.join(REGISTRY_DIR, `${sessionName.replace(/[:/]/g, '-')}.json`);
    try { fs.unlinkSync(file); } catch {}
  }
}
```

### 2.4 Tests

```javascript
// Test: SessionService.start creates session
const sessionService = new SessionService();

const config = {
  name: 'test-project:default',
  venv: '/tmp/test-venv',
  cwd: '/tmp/test-project',
};

// Setup: Create venv with mrmd-python
await createTestVenv(config.venv);

const session = await sessionService.start(config);

console.assert(session.name === 'test-project:default');
console.assert(session.port > 0);
console.assert(session.pid > 0);
console.assert(session.alive === true);
console.log('✓ SessionService.start creates running session');

// Verify MRP endpoint is accessible
const response = await fetch(`http://127.0.0.1:${session.port}/mrp/v1/status`);
console.assert(response.ok);
console.log('✓ Session is accessible via MRP');
```

```javascript
// Test: SessionService.list shows running sessions
const list = sessionService.list();

console.assert(list.length >= 1);
console.assert(list.some(s => s.name === 'test-project:default'));
console.log('✓ SessionService.list returns running sessions');
```

```javascript
// Test: SessionService.stop kills session
const stopped = await sessionService.stop('test-project:default');

console.assert(stopped === true);
console.assert(sessionService.list().length === 0);
console.log('✓ SessionService.stop kills session');
```

```javascript
// Test: SessionService.getForDocument auto-starts session
const project = await projectService.getProject('/tmp/test-project/doc.md');

const session = await sessionService.getForDocument(
  '/tmp/test-project/doc.md',
  project.config,
  null // no frontmatter
);

console.assert(session.name === 'test-project:default');
console.assert(session.alive === true);
console.log('✓ SessionService.getForDocument auto-starts session');
```

---

## 3. FileService

Manages file operations with automatic refactoring.

### 3.1 Interface

```typescript
class FileService {
  // Scan files in directory
  async scan(root: string, options?: ScanOptions): Promise<string[]>

  // Create file
  async createFile(filePath: string, content?: string): Promise<void>

  // Create file in project (handles FSML ordering)
  async createInProject(
    projectRoot: string,
    relativePath: string,
    content?: string
  ): Promise<string>  // Returns actual path (may have order prefix)

  // Move/rename file (refactors links and assets)
  async move(
    projectRoot: string,
    fromPath: string,
    toPath: string
  ): Promise<RefactorResult>

  // Delete file
  async delete(filePath: string): Promise<void>

  // Read file
  async read(filePath: string): Promise<string>

  // Write file
  async write(filePath: string, content: string): Promise<void>
}

interface RefactorResult {
  movedFile: string;
  updatedFiles: string[];  // Files whose links/assets were updated
}

interface ScanOptions {
  includeHidden?: boolean;
  extensions?: string[];
  maxDepth?: number;
}
```

### 3.2 IPC Handlers

```javascript
// Scan files
ipcMain.handle('file:scan', async (event, { root, options }) => {
  return fileService.scan(root, options);
});

// Create file
ipcMain.handle('file:create', async (event, { filePath, content }) => {
  return fileService.createFile(filePath, content);
});

// Create in project
ipcMain.handle('file:createInProject', async (event, { projectRoot, relativePath, content }) => {
  return fileService.createInProject(projectRoot, relativePath, content);
});

// Move file
ipcMain.handle('file:move', async (event, { projectRoot, fromPath, toPath }) => {
  return fileService.move(projectRoot, fromPath, toPath);
});

// Delete file
ipcMain.handle('file:delete', async (event, { filePath }) => {
  return fileService.delete(filePath);
});
```

### 3.3 Implementation Notes

```javascript
// FileService implementation sketch

import { Links, Assets, FSML } from 'mrmd-project';
import fs from 'fs/promises';
import path from 'path';

class FileService {
  async scan(root, options = {}) {
    const {
      includeHidden = false,
      extensions = ['.md'],
      maxDepth = 10,
    } = options;

    const files = [];

    async function walk(dir, depth) {
      if (depth > maxDepth) return;

      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath);

        // Skip hidden/system unless requested
        if (entry.name.startsWith('.')) continue;
        if (!includeHidden && entry.name.startsWith('_')) continue;

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          files.push(relativePath);
        }
      }
    }

    await walk(root, 0);
    return FSML.sortPaths(files);
  }

  async createFile(filePath, content = '') {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  async createInProject(projectRoot, relativePath, content = '') {
    // Determine order prefix if in a folder with ordered files
    const dir = path.dirname(relativePath);
    const dirPath = path.join(projectRoot, dir);

    let finalPath = relativePath;

    if (await this.dirExists(dirPath)) {
      const siblings = await fs.readdir(dirPath);
      const maxOrder = siblings
        .map(f => FSML.parsePath(f).order)
        .filter(o => o !== null)
        .reduce((max, o) => Math.max(max, o), 0);

      // If folder has ordered files, add order prefix
      if (maxOrder > 0) {
        const name = path.basename(relativePath);
        const parsed = FSML.parsePath(name);
        if (parsed.order === null) {
          // Add next order
          const newName = `${String(maxOrder + 1).padStart(2, '0')}-${name}`;
          finalPath = path.join(dir, newName);
        }
      }
    }

    const fullPath = path.join(projectRoot, finalPath);
    await this.createFile(fullPath, content);
    return finalPath;
  }

  async move(projectRoot, fromPath, toPath) {
    const updatedFiles = [];

    // 1. Read all .md files in project
    const files = await this.scan(projectRoot);

    // 2. For each file, check if it references the moved file
    for (const file of files) {
      if (file === fromPath) continue;

      const fullPath = path.join(projectRoot, file);
      const content = await fs.readFile(fullPath, 'utf8');

      // Update links
      const updatedContent = Links.refactor(content, [
        { from: fromPath, to: toPath }
      ], file);

      // Update asset paths if the moving file is what changed
      // (Actually, asset paths in OTHER files don't change when a file moves)

      if (updatedContent !== content) {
        await fs.writeFile(fullPath, updatedContent);
        updatedFiles.push(file);
      }
    }

    // 3. Update asset paths IN the moved file
    const movingContent = await fs.readFile(path.join(projectRoot, fromPath), 'utf8');
    const updatedMovingContent = Assets.refactorPaths(
      movingContent,
      fromPath,
      toPath,
      '_assets'
    );

    // 4. Actually move the file
    const fullFromPath = path.join(projectRoot, fromPath);
    const fullToPath = path.join(projectRoot, toPath);
    await fs.mkdir(path.dirname(fullToPath), { recursive: true });
    await fs.writeFile(fullToPath, updatedMovingContent);
    await fs.unlink(fullFromPath);

    // 5. Notify project service to invalidate cache
    projectService.invalidate(projectRoot);

    return { movedFile: toPath, updatedFiles };
  }

  async dirExists(dir) {
    try {
      const stat = await fs.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
```

### 3.4 Tests

```javascript
// Test: FileService.scan finds files in order
const fileService = new FileService();

// Setup
await createTempProject({
  'mrmd.md': '',
  '03-results.md': '',
  '01-intro.md': '',
  '02-methods/01-setup.md': '',
  '02-methods/02-analysis.md': '',
  '_assets/img.png': '',
});

const files = await fileService.scan(tempDir);

console.assert(files[0] === '01-intro.md');
console.assert(files[1] === '02-methods/01-setup.md');
console.assert(files[2] === '02-methods/02-analysis.md');
console.assert(files[3] === '03-results.md');
console.assert(!files.includes('mrmd.md')); // Excluded
console.assert(!files.includes('_assets/img.png')); // Hidden
console.log('✓ FileService.scan returns sorted, filtered files');
```

```javascript
// Test: FileService.move refactors links
await createTempProject({
  'mrmd.md': '',
  '01-intro.md': 'See [[setup]] for details.',
  '02-setup.md': '# Setup',
});

const result = await fileService.move(
  tempDir,
  '02-setup.md',
  '03-installation.md'
);

console.assert(result.movedFile === '03-installation.md');
console.assert(result.updatedFiles.includes('01-intro.md'));

const introContent = await fs.readFile(path.join(tempDir, '01-intro.md'), 'utf8');
console.assert(introContent.includes('[[installation]]'));
console.log('✓ FileService.move refactors links in other files');
```

```javascript
// Test: FileService.move refactors asset paths
await createTempProject({
  'mrmd.md': '',
  '01-intro.md': '![Img](_assets/img.png)',
  '_assets/img.png': '',
});

await fileService.move(
  tempDir,
  '01-intro.md',
  '02-section/01-intro.md'
);

const content = await fs.readFile(
  path.join(tempDir, '02-section/01-intro.md'),
  'utf8'
);
console.assert(content.includes('../_assets/img.png'));
console.log('✓ FileService.move refactors asset paths in moved file');
```

---

## 4. AssetService

Manages assets in `_assets/` directory.

### 4.1 Interface

```typescript
interface AssetInfo {
  path: string;           // Relative to _assets/
  fullPath: string;       // Absolute path
  hash: string;           // Content hash
  size: number;
  mimeType: string;
  usedIn: string[];       // Documents referencing this asset
}

class AssetService {
  // List all assets
  async list(projectRoot: string): Promise<AssetInfo[]>

  // Save asset (handles deduplication)
  async save(
    projectRoot: string,
    file: Buffer,
    filename: string
  ): Promise<{ path: string; deduplicated: boolean }>

  // Get relative path for use in document
  getRelativePath(
    assetPath: string,
    documentPath: string
  ): string

  // Find orphaned assets
  async findOrphans(projectRoot: string): Promise<string[]>

  // Delete asset
  async delete(projectRoot: string, assetPath: string): Promise<void>
}
```

### 4.2 IPC Handlers

```javascript
// List assets
ipcMain.handle('asset:list', async (event, { projectRoot }) => {
  return assetService.list(projectRoot);
});

// Save asset
ipcMain.handle('asset:save', async (event, { projectRoot, file, filename }) => {
  return assetService.save(projectRoot, Buffer.from(file), filename);
});

// Get relative path
ipcMain.handle('asset:relativePath', (event, { assetPath, documentPath }) => {
  return assetService.getRelativePath(assetPath, documentPath);
});

// Find orphans
ipcMain.handle('asset:orphans', async (event, { projectRoot }) => {
  return assetService.findOrphans(projectRoot);
});
```

### 4.3 Implementation Notes

```javascript
// AssetService implementation sketch

import { Assets } from 'mrmd-project';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

class AssetService {
  async list(projectRoot) {
    const assetsDir = path.join(projectRoot, '_assets');
    const manifest = await this.loadManifest(projectRoot);
    const assets = [];

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(assetsDir, fullPath);

        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          const hash = manifest[relativePath]?.hash || await this.computeHash(fullPath);

          assets.push({
            path: relativePath,
            fullPath,
            hash,
            size: stat.size,
            mimeType: this.getMimeType(entry.name),
            usedIn: manifest[relativePath]?.usedIn || [],
          });
        }
      }
    }

    await walk(assetsDir);
    return assets;
  }

  async save(projectRoot, file, filename) {
    const assetsDir = path.join(projectRoot, '_assets');
    const hash = this.computeHashFromBuffer(file);

    // Check for duplicate by hash
    const manifest = await this.loadManifest(projectRoot);
    const existing = Object.entries(manifest).find(([_, v]) => v.hash === hash);

    if (existing) {
      return { path: existing[0], deduplicated: true };
    }

    // Save new file
    const assetPath = await this.uniquePath(assetsDir, filename);
    await fs.mkdir(path.dirname(path.join(assetsDir, assetPath)), { recursive: true });
    await fs.writeFile(path.join(assetsDir, assetPath), file);

    // Update manifest
    manifest[assetPath] = { hash, addedAt: new Date().toISOString(), usedIn: [] };
    await this.saveManifest(projectRoot, manifest);

    return { path: assetPath, deduplicated: false };
  }

  getRelativePath(assetPath, documentPath) {
    // Use mrmd-project for computation
    return Assets.computeRelativePath(documentPath, path.join('_assets', assetPath));
  }

  async findOrphans(projectRoot) {
    const assets = await this.list(projectRoot);
    const files = await fileService.scan(projectRoot);

    // Read all files and extract asset references
    const usedAssets = new Set();
    for (const file of files) {
      const content = await fs.readFile(path.join(projectRoot, file), 'utf8');
      const refs = Assets.extractPaths(content);
      for (const ref of refs) {
        // Normalize path
        const normalized = path.normalize(ref.path).replace(/^(\.\.\/)*_assets\//, '');
        usedAssets.add(normalized);
      }
    }

    return assets
      .filter(a => !usedAssets.has(a.path))
      .map(a => a.path);
  }

  computeHashFromBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  }

  async loadManifest(projectRoot) {
    const manifestPath = path.join(projectRoot, '_assets', '.manifest.json');
    try {
      return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      return {};
    }
  }

  async saveManifest(projectRoot, manifest) {
    const manifestPath = path.join(projectRoot, '_assets', '.manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
}
```

### 4.4 Tests

```javascript
// Test: AssetService.save deduplicates by hash
const assetService = new AssetService();

const imageBuffer = Buffer.from('fake image data');

const result1 = await assetService.save(tempDir, imageBuffer, 'img1.png');
const result2 = await assetService.save(tempDir, imageBuffer, 'img2.png');

console.assert(result1.deduplicated === false);
console.assert(result2.deduplicated === true);
console.assert(result1.path === result2.path);
console.log('✓ AssetService.save deduplicates identical files');
```

```javascript
// Test: AssetService.findOrphans detects unused assets
await createTempProject({
  'mrmd.md': '',
  '01-intro.md': '![Used](_assets/used.png)',
  '_assets/used.png': 'data',
  '_assets/unused.png': 'data',
});

const orphans = await assetService.findOrphans(tempDir);

console.assert(orphans.includes('unused.png'));
console.assert(!orphans.includes('used.png'));
console.log('✓ AssetService.findOrphans detects unused assets');
```

---

## 5. SyncService (Existing - Enhanced)

Manages mrmd-sync servers per project. Already exists in main.js, just needs minor enhancements.

### 5.1 Enhancements

```javascript
// Add project awareness
async getSyncServer(projectRoot) {
  // Use projectRoot instead of filePath directory
  // This ensures one sync server per project, not per directory
}
```

---

## 6. MonitorService (Existing - Enhanced)

Manages mrmd-monitor per document. Already exists in main.js.

### 6.1 Enhancements

```javascript
// Add session awareness
async getMonitor(documentName, sessionConfig) {
  // Pass session info to monitor for runtime URL
}
```

---

## 7. Preload API

The preload script exposes services to the renderer.

```javascript
// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Project
  project: {
    get: (filePath) => ipcRenderer.invoke('project:get', { filePath }),
    create: (targetPath) => ipcRenderer.invoke('project:create', { targetPath }),
    nav: (projectRoot) => ipcRenderer.invoke('project:nav', { projectRoot }),
  },

  // Session
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    start: (config) => ipcRenderer.invoke('session:start', { config }),
    stop: (sessionName) => ipcRenderer.invoke('session:stop', { sessionName }),
    restart: (sessionName) => ipcRenderer.invoke('session:restart', { sessionName }),
    forDocument: (documentPath) => ipcRenderer.invoke('session:forDocument', { documentPath }),
  },

  // Files
  file: {
    scan: (root, options) => ipcRenderer.invoke('file:scan', { root, options }),
    create: (filePath, content) => ipcRenderer.invoke('file:create', { filePath, content }),
    createInProject: (projectRoot, relativePath, content) =>
      ipcRenderer.invoke('file:createInProject', { projectRoot, relativePath, content }),
    move: (projectRoot, fromPath, toPath) =>
      ipcRenderer.invoke('file:move', { projectRoot, fromPath, toPath }),
    delete: (filePath) => ipcRenderer.invoke('file:delete', { filePath }),
  },

  // Assets
  asset: {
    list: (projectRoot) => ipcRenderer.invoke('asset:list', { projectRoot }),
    save: (projectRoot, file, filename) =>
      ipcRenderer.invoke('asset:save', { projectRoot, file, filename }),
    relativePath: (assetPath, documentPath) =>
      ipcRenderer.invoke('asset:relativePath', { assetPath, documentPath }),
    orphans: (projectRoot) => ipcRenderer.invoke('asset:orphans', { projectRoot }),
  },

  // Existing APIs (backwards compatible)
  scanFiles: (searchDir) => ipcRenderer.invoke('scan-files', { searchDir }),
  // ... etc
});
```

---

## 8. Integration Test

Full workflow test:

```javascript
// Integration: Create project, add file, run code
async function testFullWorkflow() {
  // 1. Create project
  const project = await electronAPI.project.create('/tmp/test-workflow');
  console.assert(project.root === '/tmp/test-workflow');

  // 2. Session should auto-start
  const session = await electronAPI.session.forDocument(
    '/tmp/test-workflow/01-index.md'
  );
  console.assert(session.alive === true);

  // 3. Create new file
  const newPath = await electronAPI.file.createInProject(
    project.root,
    'analysis.md',
    '# Analysis\n\n```python\nprint("hello")\n```'
  );
  console.assert(newPath === '02-analysis.md'); // Auto-numbered

  // 4. Add asset
  const imageData = new Uint8Array([/* png data */]);
  const asset = await electronAPI.asset.save(
    project.root,
    imageData,
    'chart.png'
  );

  // 5. Update file with asset
  const assetRef = await electronAPI.asset.relativePath(
    asset.path,
    newPath
  );
  // assetRef = '_assets/chart.png' (from root level)

  // 6. Move file (tests refactoring)
  await electronAPI.file.move(
    project.root,
    '02-analysis.md',
    '02-section/01-analysis.md'
  );

  // Check asset path was updated
  const content = await electronAPI.file.read(
    '/tmp/test-workflow/02-section/01-analysis.md'
  );
  console.assert(content.includes('../_assets/chart.png'));

  // 7. Stop session
  await electronAPI.session.stop(session.name);

  console.log('✓ Full workflow test passed');
}
```

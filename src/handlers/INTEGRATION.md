# Handler Integration Guide

This directory contains unified handler definitions that work for both Electron (IPC) and mrmd-server (HTTP).

## Architecture

```
handlers/
├── index.js      # Registration helpers + exports
├── project.js    # Project handlers
├── session.js    # Session handlers
├── bash.js       # Bash session handlers
├── file.js       # File handlers
├── asset.js      # Asset handlers
└── system.js     # System/misc handlers
```

## Adding a New Handler

1. **Add the handler function** to the appropriate file:

```javascript
// handlers/project.js
export const projectHandlers = {
  // ... existing handlers ...

  // NEW: Add your handler here
  async myNewFeature({ someArg }, ctx) {
    return ctx.projectService.doSomething(someArg);
  },
};
```

2. **Update preload.cjs** to expose it (Electron only):

```javascript
// preload.cjs
project: {
  // ... existing ...
  myNewFeature: (someArg) => ipcRenderer.invoke('project:myNewFeature', { someArg }),
},
```

3. **That's it!**
   - Electron will automatically register it as IPC handler
   - mrmd-server will automatically register it as HTTP route
   - http-shim.js will be auto-generated with the new method

## How It Works

### Electron (main.js)

```javascript
import { registerElectronHandlers } from './handlers/index.js';

// Create context with services
const context = {
  projectService,
  sessionService,
  fileService,
  // ...
};

// Register all handlers as IPC
registerElectronHandlers(ipcMain, context);
```

### mrmd-server

```javascript
import { registerHttpHandlers } from 'mrmd-electron/src/handlers/index.js';

// Same context shape
const context = {
  projectService,
  sessionService,
  fileService,
  // ...
};

// Register all handlers as HTTP routes
registerHttpHandlers(app, context);
```

### Auto-generated http-shim.js

```javascript
import { generateHttpShim } from 'mrmd-electron/src/handlers/index.js';

// Serve at /http-shim.js
app.get('/http-shim.js', (req, res) => {
  res.type('application/javascript');
  res.send(generateHttpShim());
});
```

## Handler Signature

Every handler has the same signature:

```javascript
async function handler(args, context, event?) {
  // args: The arguments passed from the client
  // context: Services and state
  // event: Optional - Electron IPC event or HTTP request

  return result; // JSON-serializable
}
```

## Context Shape

Both Electron and mrmd-server should provide the same context:

```javascript
const context = {
  // Base directory
  projectDir: string,

  // Services
  projectService: ProjectService,
  sessionService: SessionService,
  bashService: BashSessionService,
  fileService: FileService,
  assetService: AssetService,
  venvService: VenvService,
  pythonService: PythonService,
  runtimeService: RuntimeService,
  recentService: RecentService,

  // Event bus for push notifications
  eventBus: EventBus,

  // Electron-only (null in mrmd-server)
  shell: { showItemInFolder, openExternal, openPath } | null,

  // Ports
  aiPort: number,
  syncPort: number,
  pythonPort: number,
};
```

## Benefits

1. **Single source of truth** - Handlers defined once, used everywhere
2. **Automatic sync** - New handlers in Electron work in browser automatically
3. **Type safety** - Same interfaces, same context shape
4. **Testable** - Handlers are pure functions, easy to unit test
5. **No duplication** - No need to maintain parallel implementations

#!/usr/bin/env node
/**
 * Bundle sibling packages into single-file scripts for packaged Electron app.
 *
 * These bundles:
 * - Include all dependencies (yjs, ws, etc.)
 * - Can be run with Electron's built-in Node via ELECTRON_RUN_AS_NODE
 * - Are placed in extraResources (outside ASAR)
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const parentDir = path.dirname(rootDir);
const bundlesDir = path.join(rootDir, 'bundles');

// Ensure bundles directory exists
if (!fs.existsSync(bundlesDir)) {
  fs.mkdirSync(bundlesDir, { recursive: true });
}

const packages = [
  {
    name: 'mrmd-sync',
    entry: path.join(parentDir, 'mrmd-sync', 'bin', 'cli.js'),
    output: path.join(bundlesDir, 'mrmd-sync.bundle.cjs'),  // .cjs for CommonJS
  },
  {
    name: 'mrmd-monitor',
    entry: path.join(parentDir, 'mrmd-monitor', 'bin', 'cli.js'),
    output: path.join(bundlesDir, 'mrmd-monitor.bundle.cjs'),  // .cjs for CommonJS
  },
];

async function bundlePackage(pkg) {
  console.log(`Bundling ${pkg.name}...`);

  // Check entry exists
  if (!fs.existsSync(pkg.entry)) {
    throw new Error(`Entry point not found: ${pkg.entry}`);
  }

  // WebSocket polyfill for y-websocket (needed by mrmd-monitor)
  // y-websocket expects a global WebSocket but Node.js doesn't have one
  // We inject code that sets up the polyfill before the bundle runs
  const needsWsPolyfill = pkg.name === 'mrmd-monitor';

  const result = await build({
    entryPoints: [pkg.entry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',  // CJS handles shebangs in source files better
    outfile: pkg.output,
    // Keep it readable for debugging
    minify: false,
    // Include source maps for debugging
    sourcemap: true,
    // Mark Node.js built-ins as external (they're available in Electron's Node)
    // Also mark native modules that can't be bundled
    external: [
      // Node.js builtins
      'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
      'stream', 'util', 'events', 'buffer', 'url', 'querystring',
      'child_process', 'cluster', 'dgram', 'dns', 'readline',
      'zlib', 'assert', 'tty', 'v8', 'vm', 'worker_threads',
      'perf_hooks', 'async_hooks', 'inspector', 'trace_events',
      // Native modules (can't bundle .node files)
      'fsevents',  // macOS file watcher (chokidar falls back gracefully)
      // Keep ws external so we can polyfill globalThis.WebSocket
      // The packaged app will have ws in node_modules
      ...(needsWsPolyfill ? ['ws'] : []),
    ],
    // Log level
    logLevel: 'info',
  });

  // Post-process: inject WebSocket polyfill for mrmd-monitor
  // y-websocket expects a global WebSocket but Node.js doesn't have one
  if (needsWsPolyfill) {
    const bundleContent = fs.readFileSync(pkg.output, 'utf8');
    const wsPolyfill = `// WebSocket polyfill for y-websocket (Node.js has no global WebSocket)
try {
  if (typeof globalThis.WebSocket === 'undefined') {
    const { WebSocket } = require('ws');
    globalThis.WebSocket = WebSocket;
  }
} catch (e) {
  console.warn('[polyfill] Failed to load ws module:', e.message);
}
`;
    // Insert polyfill after shebang (if present)
    let newContent;
    if (bundleContent.startsWith('#!')) {
      const firstNewline = bundleContent.indexOf('\n');
      newContent = bundleContent.slice(0, firstNewline + 1) + wsPolyfill + bundleContent.slice(firstNewline + 1);
    } else {
      newContent = wsPolyfill + bundleContent;
    }
    fs.writeFileSync(pkg.output, newContent);
    console.log(`  ✓ Injected WebSocket polyfill`);
  }

  // Make executable
  fs.chmodSync(pkg.output, 0o755);

  const stats = fs.statSync(pkg.output);
  console.log(`  → ${pkg.output} (${(stats.size / 1024).toFixed(1)} KB)`);

  return result;
}

async function main() {
  console.log('=== Bundling sibling packages for Electron ===\n');

  for (const pkg of packages) {
    try {
      await bundlePackage(pkg);
    } catch (err) {
      console.error(`Failed to bundle ${pkg.name}:`, err.message);
      process.exit(1);
    }
  }

  console.log('\n✅ All packages bundled successfully');
}

main();

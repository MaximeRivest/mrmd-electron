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
    // No banner needed - we run via spawn(process.execPath, [script])
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
    ],
    // Log level
    logLevel: 'info',
  });

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

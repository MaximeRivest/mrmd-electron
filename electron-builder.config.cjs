/**
 * electron-builder configuration for mrmd-electron
 *
 * Build commands:
 *   npm run build           - Build for current platform
 *   npm run build:linux     - Linux (AppImage, deb)
 *   npm run build:mac       - macOS (dmg, zip)
 *   npm run build:win       - Windows (nsis, portable)
 */

module.exports = {
  appId: "com.mrmd.electron",
  productName: "MRMD",

  // File associations - register MRMD as handler for markdown files
  // Users can set MRMD as default app for .md files in their OS
  fileAssociations: [
    {
      ext: "md",
      name: "Markdown",
      description: "Markdown document",
      role: "Editor",
      mimeType: "text/markdown"
    },
    {
      ext: "markdown",
      name: "Markdown",
      description: "Markdown document",
      role: "Editor",
      mimeType: "text/markdown"
    },
    {
      ext: "mdown",
      name: "Markdown",
      description: "Markdown document",
      role: "Editor",
      mimeType: "text/markdown"
    },
    {
      ext: "mdx",
      name: "MDX",
      description: "MDX document",
      role: "Editor",
      mimeType: "text/mdx"
    },
    {
      ext: "qmd",
      name: "Quarto Markdown",
      description: "Quarto markdown document",
      role: "Editor",
      mimeType: "text/markdown"
    }
  ],

  directories: {
    output: "dist",
    buildResources: "build"
  },

  // Files to include in the app
  files: [
    "main.js",
    "preload.cjs",
    "index.html",
    "src/**/*",
    "assets/**/*",
    "node_modules/**/*",
    // Exclude dev files
    "!node_modules/**/*.md",
    "!node_modules/**/*.ts",
    "!node_modules/**/test/**",
    "!node_modules/**/tests/**",
    "!node_modules/**/*.map"
  ],

  // Extra resources placed OUTSIDE the asar archive
  // These are spawned as child processes using Electron's Node
  extraResources: [
    // mrmd-editor dist (loaded by index.html via file:// protocol)
    // CI clones and builds this before electron-builder runs
    {
      from: "../mrmd-editor/dist",
      to: "mrmd-editor/dist",
      filter: ["*.js", "!*.map"]
    },
    // Bundled sibling packages (single-file, no node_modules needed)
    // Created by `npm run bundle` before build
    {
      from: "bundles/mrmd-sync.bundle.cjs",
      to: "mrmd-sync.bundle.cjs"
    },
    {
      from: "bundles/mrmd-monitor.bundle.cjs",
      to: "mrmd-monitor.bundle.cjs"
    }
  ],

  // Linux configuration
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] }
    ],
    category: "Development",
    icon: "build/icon.png",
    maintainer: "mrmd contributors"
  },

  // macOS configuration
  mac: {
    target: [
      { target: "dmg", arch: ["x64", "arm64"] },
      { target: "zip", arch: ["x64", "arm64"] }
    ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    // For alpha: skip signing (users will need to allow in Security settings)
    identity: null
  },

  // Windows configuration
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }
    ],
    icon: "build/icon.ico"
  },

  // NSIS installer options
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico"
  },

  // DMG options
  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" }
    ]
  },

  // Publish disabled - the release job in CI handles this
  // Set to null to prevent electron-builder from auto-publishing on tag
  publish: null
};

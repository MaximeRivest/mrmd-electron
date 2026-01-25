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

  // Include sibling packages that main.js resolves via resolvePackageBin
  // In CI, these are copied to sibling-packages/ before build
  // In dev, they're at ../
  extraResources: [
    // mrmd-editor dist (loaded by index.html)
    // CI copies to sibling-packages/mrmd-editor-dist, dev uses ../mrmd-editor/dist
    {
      from: "sibling-packages/mrmd-editor-dist",
      to: "mrmd-editor/dist",
      filter: ["*.js", "!*.map"]
    },
    // mrmd-sync (Yjs sync server)
    {
      from: "sibling-packages/mrmd-sync",
      to: "mrmd-sync",
      filter: ["package.json", "bin/**", "src/**", "node_modules/**"]
    },
    // mrmd-monitor (execution monitor)
    {
      from: "sibling-packages/mrmd-monitor",
      to: "mrmd-monitor",
      filter: ["package.json", "bin/**", "src/**", "node_modules/**"]
    },
    // mrmd-project (project logic library)
    {
      from: "sibling-packages/mrmd-project",
      to: "mrmd-project",
      filter: ["package.json", "src/**", "node_modules/**"]
    },
    // mrmd-jupyter-bridge (notebook sync)
    {
      from: "sibling-packages/mrmd-jupyter-bridge",
      to: "mrmd-jupyter-bridge",
      filter: ["package.json", "bin/**", "src/**", "node_modules/**"]
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

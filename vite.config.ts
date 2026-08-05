import { copyFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig } from 'vite'

function flattenPortalAssets() {
  return {
    name: 'flatten-portal-assets',
    apply: 'build' as const,
    async closeBundle() {
      const rootDir = process.cwd()
      const publicDir = path.join(rootDir, 'public')
      const distDir = path.join(rootDir, 'dist')
      for (const folder of ['backgrounds', 'sfx', 'sprites']) {
        const sourceDir = path.join(publicDir, folder)
        const entries = await readdir(sourceDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile()) continue
          await copyFile(path.join(sourceDir, entry.name), path.join(distDir, entry.name))
        }
      }
    },
  }
}

// base: './' emits relative asset URLs so one production build works both at a
// domain root (Vercel) and served from a subpath (GameMonetize hosts the game
// at https://html5.gamemonetize.com/<gameId>/). Runtime asset loads in Phaser
// (see BootScene/audio) use relative paths for the same reason.
export default defineConfig({
  base: './',
  plugins: [flattenPortalAssets()],
  build: {
    // Content-hashed startup bundle names (game-<hash>.js/.css). A CONSTANT name
    // (the old game-${BUILD_TAG}.js) meant the service worker / CDN kept serving
    // a stale bundle after every deploy — a fresh hash per build forces a refetch
    // everywhere. Still emitted at the archive root so portals load it fine.
    cssCodeSplit: false,
    assetsInlineLimit: 100_000,
    rollupOptions: {
      output: {
        entryFileNames: `game-[hash].js`,
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) return `game-[hash].css`
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
})

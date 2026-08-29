import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { computePrecacheUrls, stampPrecache, verifyPrecache } from './scripts/sw-precache.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Build id: UTC timestamp + short git sha. Stamped into the client bundle
// (__APP_BUILD_ID__), the service worker cache name, and dist/version.json —
// this is what makes each deploy detectable as an update by UpdatePrompt.
function makeBuildId() {
  let sha = 'nogit'
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
  } catch { /* not a git checkout (e.g. tarball build) — timestamp still varies per deploy */ }
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13) // YYYYMMDDTHHMM
  return `${ts}-${sha}`
}
const BUILD_ID = makeBuildId()

// After the bundle is written: stamp __BUILD_ID__ into dist/sw.js (so the SW
// byte-changes every deploy and browsers detect it), replace the precache
// marker block in sw.js with the REAL emitted asset list from the build
// manifest (entry chunks + css; SW-relative so it works under any --base),
// and emit dist/version.json (so the app can poll for newer deploys past any
// HTTP cache).
function stampBuildId() {
  return {
    name: 'stamp-build-id',
    apply: 'build',
    closeBundle() {
      const dist = resolve(__dirname, 'dist')
      const swPath = resolve(dist, 'sw.js')
      if (existsSync(swPath)) {
        let sw = readFileSync(swPath, 'utf8').replaceAll('__BUILD_ID__', BUILD_ID)
        const manifestPath = resolve(dist, '.vite', 'manifest.json')
        if (!existsSync(manifestPath)) {
          throw new Error('stamp-build-id: dist/.vite/manifest.json missing. build.manifest must stay enabled.')
        }
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        sw = stampPrecache(sw, computePrecacheUrls(manifest))
        writeFileSync(swPath, sw)
      }
      writeFileSync(resolve(dist, 'version.json'), JSON.stringify({ build: BUILD_ID }) + '\n')
    },
  }
}

// Runs after stamp-build-id (closeBundle hooks run in plugin order) and
// FAILS the build if the stamped precache list drifted from the emitted
// assets, if any listed file is absent from dist, or if any marker survived.
function assertPrecache() {
  return {
    name: 'assert-precache',
    apply: 'build',
    closeBundle() {
      const { count, entryAssets } = verifyPrecache(resolve(__dirname, 'dist'))
      console.log(`[assert-precache] OK: ${count} precache URLs cover all ${entryAssets} entry assets`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampBuildId(), assertPrecache()],
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    // Emit .vite/manifest.json so stamp-build-id can inject the real hashed
    // asset list into sw.js's precache and assert-precache can verify it.
    manifest: true,
  },
  server: {
    proxy: {
      '/npi-api': {
        target: 'https://npiregistry.cms.hhs.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/npi-api/, '/api'),
        secure: true,
      },
    },
  },
})

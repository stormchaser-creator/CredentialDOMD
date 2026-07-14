import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

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
// byte-changes every deploy and browsers detect it) and emit dist/version.json
// (so the app can poll for newer deploys past any HTTP cache).
function stampBuildId() {
  return {
    name: 'stamp-build-id',
    apply: 'build',
    closeBundle() {
      const dist = resolve(__dirname, 'dist')
      const swPath = resolve(dist, 'sw.js')
      if (existsSync(swPath)) {
        writeFileSync(swPath, readFileSync(swPath, 'utf8').replaceAll('__BUILD_ID__', BUILD_ID))
      }
      writeFileSync(resolve(dist, 'version.json'), JSON.stringify({ build: BUILD_ID }) + '\n')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampBuildId()],
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
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

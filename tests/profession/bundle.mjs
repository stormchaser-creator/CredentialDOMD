// Loads an app module whose imports carry no extensions (the Vite style) by
// bundling it with esbuild, the way tests/notification-center.test.mjs does.
// Not a test file itself.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));

export async function bundle(entry) {
  const out = await build({ entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'pdfjs-dist', 'jspdf', 'jspdf-autotable', 'xlsx', 'mammoth', 'jszip', 'docx'] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

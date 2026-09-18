#!/usr/bin/env node
// Copy the pinned PDF display/worker and standard fonts. No generic viewer,
// scripting sandbox, remote CDN, source maps or PDF document is published.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/pdfjs-dist");
const output = resolve(root, "public/credential-access/vendor");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const pdf = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
if (pdf.version !== packageJson.dependencies["pdfjs-dist"]) throw new Error("PDF renderer version does not match the exact package pin");
await mkdir(output, { recursive: true });
for (const name of await readdir(output)) if (name !== ".gitignore") await rm(resolve(output, name), { recursive: true, force: true });
const files = ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "LICENSE", ...(await readdir(resolve(source, "standard_fonts"))).map(name => `standard_fonts/${name}`)];
const manifest = { version: pdf.version, source: `https://github.com/mozilla/pdf.js/releases/tag/v${pdf.version}`, files: {} };
for (const name of files) {
  const target = name.replace("build/", "");
  await mkdir(dirname(resolve(output, target)), { recursive: true });
  await cp(resolve(source, name), resolve(output, target));
  manifest.files[target] = createHash("sha256").update(await readFile(resolve(output, target))).digest("hex");
}
await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Prepared same-origin PDF.js ${pdf.version}: ${files.length} reviewed asset paths`);

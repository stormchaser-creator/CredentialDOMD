// Generate PWA icons — white medical cross on emerald, matching the app brand.
// One master design; every size/variant derives from it.
import { writeFileSync } from "fs";

const makeSVG = (size, maskable = false) => {
  // Maskable icons must be full-bleed (the OS applies its own mask).
  const rx = maskable ? 0 : Math.round(size * 0.22);
  const s = size;
  // Cross geometry: arm thickness 24% of tile, length 62% of tile.
  const t = s * 0.24;
  const L = s * 0.62;
  const cx = s / 2;
  const r = t * 0.28; // rounded arm ends
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
  </defs>
  <rect width="${s}" height="${s}" rx="${rx}" fill="url(#g)"/>
  <rect x="${cx - t / 2}" y="${cx - L / 2}" width="${t}" height="${L}" rx="${r}" fill="#ffffff"/>
  <rect x="${cx - L / 2}" y="${cx - t / 2}" width="${L}" height="${t}" rx="${r}" fill="#ffffff"/>
</svg>`;
};

const dir = new URL("../public/icons/", import.meta.url).pathname;
for (const s of [192, 512]) {
  writeFileSync(`${dir}icon-${s}.svg`, makeSVG(s, false));
  writeFileSync(`${dir}icon-maskable-${s}.svg`, makeSVG(s, true));
}
console.log("icons written");

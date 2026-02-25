// Generate PWA icons as SVG files (will be served directly)
import { writeFileSync } from "fs";

const makeSVG = (size, maskable = false) => {
  const padding = maskable ? size * 0.1 : 0;
  const inner = size - padding * 2;
  const rx = maskable ? 0 : Math.round(size * 0.22);
  const fontSize = Math.round(inner * 0.35);
  const subSize = Math.round(inner * 0.12);
  const cx = size / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${padding}" y="${padding}" width="${inner}" height="${inner}" rx="${rx}" fill="#0A2540"/>
  <rect x="${padding}" y="${padding}" width="${inner}" height="${inner}" rx="${rx}" fill="url(#g)" opacity="0.6"/>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0A2540"/>
      <stop offset="50%" stop-color="#0F3460"/>
      <stop offset="100%" stop-color="#1A73E8"/>
    </linearGradient>
  </defs>
  <text x="${cx}" y="${cx + fontSize * 0.12}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="${fontSize}" font-weight="800" font-family="system-ui, -apple-system, sans-serif">MD</text>
  <text x="${cx}" y="${cx + fontSize * 0.12 + fontSize * 0.7}" text-anchor="middle" dominant-baseline="middle" fill="#60A5FA" font-size="${subSize}" font-weight="600" font-family="system-ui, -apple-system, sans-serif" letter-spacing="2">CREDENTIAL</text>
</svg>`;
};

const sizes = [192, 512];
const dir = new URL("../public/icons/", import.meta.url).pathname;

for (const s of sizes) {
  writeFileSync(`${dir}icon-${s}.svg`, makeSVG(s, false));
  writeFileSync(`${dir}icon-maskable-${s}.svg`, makeSVG(s, true));
}

console.log("Icons generated.");

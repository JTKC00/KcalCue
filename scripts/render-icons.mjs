// Renders the PWA PNG icons from the full-bleed master. Run from the repo root:
//   node scripts/render-icons.mjs
// The PNGs are opaque squares: Android masks icon-512 as maskable and iOS
// rounds apple-touch-icon itself, so transparent corners would show as black.
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const master = await readFile("docs/design/app-icon/icon-full-bleed.svg");
for (const [file, size] of [["icon-512.png", 512], ["icon-192.png", 192], ["apple-touch-icon.png", 180]]) {
  await sharp(master, { density: Math.ceil((72 * size) / 512) * 4 })
    .resize(size, size)
    .flatten({ background: "#c62a1f" })
    .png({ compressionLevel: 9 })
    .toFile(`public/${file}`);
  console.log(`public/${file} ${size}x${size}`);
}

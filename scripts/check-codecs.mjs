import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

// Real HEVC encode -> decode, entirely in memory. This is a codec smoke test,
// not an assertion that a real iPhone file/browser has passed device acceptance.
sharp.concurrency(1);
const input = process.argv[2]
  ? await readFile(process.argv[2])
  : await sharp({ create: { width: 64, height: 48, channels: 3, background: "#4b8b32" } })
    // libheif's x265 encoder accepts ssim, not sharp's AV1-oriented auto tune.
    .heif({ compression: "hevc", quality: 50, effort: 0, tune: "ssim" }).toBuffer();
const decoded = await sharp(input).rotate().jpeg().toBuffer();
const metadata = await sharp(decoded).metadata();
assert.equal(metadata.format, "jpeg");
assert.ok(metadata.width > 0 && metadata.height > 0);
console.log(process.argv[2] ? "PASS: supplied HEIC decoded in memory." : "PASS: real HEVC encode/decode in memory (synthetic image). Device photo acceptance remains separate.");

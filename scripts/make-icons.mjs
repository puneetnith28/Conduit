#!/usr/bin/env node
/**
 * Generate every icon the app serves from one source image (npm run icons).
 *
 * Why this exists: the favicons were all copies of the same 1254x1254, 916 KB
 * PNG — including the ones named `favicon-16` and `favicon-32`, and including
 * `favicon.ico`, which was a PNG with an .ico extension. That means a browser
 * asking for a 16-pixel icon downloaded most of a megabyte, and anything that
 * genuinely requires ICO format got a file it could not parse.
 *
 * Run this after replacing `client/public/conduit1.png` and every derived size
 * stays honest.
 *
 * Usage:
 *   npm run icons
 *   npm run icons -- path/to/other-source.png
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2] || 'client/public/conduit1.png';
const PUB = 'client/public';

if (!fs.existsSync(SRC)) {
  console.error(`No source image at ${SRC}`);
  process.exit(1);
}

const meta = await sharp(SRC).metadata();
console.log(`source: ${SRC}  ${meta.width}x${meta.height}  ${(fs.statSync(SRC).size / 1024).toFixed(0)}KB\n`);

if (meta.width < 512) {
  console.warn(`warning: source is only ${meta.width}px. 1024px or more gives a clean desktop icon.\n`);
}

/** PNG at an exact size, trimmed of metadata and compressed properly. */
async function png(out, size) {
  await sharp(SRC)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: size <= 64 })
    .toFile(out);
  return fs.statSync(out).size;
}

const targets = [
  [path.join(PUB, 'favicon-16.png'), 16],
  [path.join(PUB, 'favicon-32.png'), 32],
  [path.join(PUB, 'apple-touch-icon.png'), 180],
  // The in-app mark. `Icons.logo` renders it between 11 and 24 pixels, so 128
  // covers every use at 4x device pixel ratio. It used to point at the full
  // 1254px source, which meant a megabyte downloaded to draw a 14-pixel icon.
  [path.join(PUB, 'logo-128.png'), 128],
  // Electron/electron-builder wants a large square source; it derives the rest.
  [path.join('build', 'icon.png'), 1024],
];

for (const [out, size] of targets) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const bytes = await png(out, size);
  console.log(`  ${String(size).padStart(4)}px  ${(bytes / 1024).toFixed(1).padStart(7)}KB  ${out}`);
}

// ── a real .ico, not a PNG wearing the extension ──────────────────────
//
// ICO is a tiny container: a 6-byte header, then one 16-byte directory entry
// per image, then the images themselves. PNG-compressed entries are allowed
// and are what every modern browser expects, so we embed the PNGs directly
// rather than converting to BMP.
const icoSizes = [16, 32, 48];
const images = [];
for (const size of icoSizes) {
  images.push({
    size,
    data: await sharp(SRC)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);                 // reserved
header.writeUInt16LE(1, 2);                 // type: 1 = icon
header.writeUInt16LE(images.length, 4);     // image count

let offset = 6 + images.length * 16;
const entries = [];
for (const img of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size === 256 ? 0 : img.size, 0);  // width  (0 means 256)
  e.writeUInt8(img.size === 256 ? 0 : img.size, 1);  // height
  e.writeUInt8(0, 2);                                // palette colours
  e.writeUInt8(0, 3);                                // reserved
  e.writeUInt16LE(1, 4);                             // colour planes
  e.writeUInt16LE(32, 6);                            // bits per pixel
  e.writeUInt32LE(img.data.length, 8);               // size of the image data
  e.writeUInt32LE(offset, 12);                       // where it starts
  entries.push(e);
  offset += img.data.length;
}

const icoPath = path.join(PUB, 'favicon.ico');
fs.writeFileSync(icoPath, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`  ${icoSizes.join('/')}px  ${(fs.statSync(icoPath).size / 1024).toFixed(1).padStart(7)}KB  ${icoPath}  (real ICO container)`);

console.log('\nDone. Reference these from client/index.html by their real sizes.');

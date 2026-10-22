// Builds the unpacked MV3 extension into packages/extension/dist and a zip next to it.
import { build } from "esbuild";
import { zipSync } from "fflate";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "icons"), { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts", content: "src/content.ts", devtools: "src/devtools.ts",
    popup: "src/popup.ts", panel: "src/panel/main.tsx",
  },
  outdir: dist, bundle: true, format: "iife", target: "chrome116", minify: false, sourcemap: false, logLevel: "warning",
  jsx: "automatic", jsxImportSource: "preact", absWorkingDir: root,
  alias: { "@localelens/core": "../core/src/browser.ts" },
});

for (const f of fs.readdirSync(path.join(root, "static"))) fs.copyFileSync(path.join(root, "static", f), path.join(dist, f));

const { id, key } = JSON.parse(fs.readFileSync(path.join(root, "extension-id.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
manifest.key = key; // pins the extension id so the agent can allow-list it
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---- icons: ring + dot ("lens"), drawn into a PNG without dependencies
function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, R = size * 0.42, r = size * 0.30, d = size * 0.11;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dist2 = Math.hypot(x - c, y - c), i = (y * size + x) * 4;
    const ring = dist2 <= R && dist2 >= r, dot = dist2 <= d;
    const bg = dist2 <= R + 0.5 ? [31, 111, 235] : null;
    let col = null;
    if (ring) col = [255, 255, 255]; else if (dot) col = [255, 255, 255]; else if (bg) col = bg;
    if (col) { px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255; }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(t), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(dist, "icons", `${s}.png`), png(s));

// ---- zip for internal distribution
const files = {};
const walk = (dir, base = "") => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, base + e.name + "/"); else files[base + e.name] = new Uint8Array(fs.readFileSync(p)); } };
walk(dist);
fs.writeFileSync(path.join(root, "localelens-extension.zip"), zipSync(files));
console.log(`extension built: ${Object.keys(files).length} files, id ${id}`);

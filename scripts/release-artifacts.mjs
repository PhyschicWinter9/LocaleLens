// Builds the GitHub Release assets from ./release (after scripts/pack.mjs) into ./release-out:
//   localelens-extension-vX.zip, localelens-packages-vX.zip, checksums.sha256, release-manifest.json
// `--verify` re-checks checksums.sha256 in ./release-out (after download / on retries).
import { unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FORBIDDEN, SECRET } from "./release-check.mjs";

const root = path.resolve(import.meta.dirname, "..");
const rel = path.join(root, "release"), out = path.join(root, "release-out");
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (process.argv.includes("--verify")) {
  const bad = fs.readFileSync(path.join(out, "checksums.sha256"), "utf8").trim().split("\n").filter((l) => {
    const [h, f] = l.split(/\s+\*?/);
    return sha(fs.readFileSync(path.join(out, f))) !== h;
  });
  if (bad.length) { console.error("checksum mismatch:\n" + bad.join("\n")); process.exit(1); }
  console.log("checksums ok");
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// extension: scan the built zip against an allowlist, then publish it under the versioned name
const extZip = fs.readFileSync(path.join(rel, "localelens-extension.zip"));
const extFiles = unzipSync(new Uint8Array(extZip));
const okExt = /^(manifest\.json|[\w.-]+\.(js|html|css)|icons\/\d+\.png)$/;
for (const [name, data] of Object.entries(extFiles)) {
  if (!okExt.test(name) || FORBIDDEN.some((r) => r.test(name))) throw new Error(`extension zip: unexpected file ${name}`);
  if (/\.(js|html|json|css)$/.test(name) && SECRET.test(Buffer.from(data).toString("utf8"))) throw new Error(`extension zip: secret-like content in ${name}`);
}
const m = JSON.parse(Buffer.from(extFiles["manifest.json"]).toString("utf8"));
if (m.manifest_version !== 3 || m.version !== version) throw new Error(`extension manifest mismatch: MV${m.manifest_version} v${m.version} (expected ${version})`);
fs.writeFileSync(path.join(out, `localelens-extension-v${version}.zip`), extZip);

// packages: the npm tarballs, zipped
const tgzs = fs.readdirSync(rel).filter((f) => f.endsWith(".tgz")).sort();
if (tgzs.length !== 3 || !tgzs.every((f) => f.endsWith(`-${version}.tgz`))) throw new Error(`expected 3 tarballs at ${version}, got ${tgzs}`);
fs.writeFileSync(path.join(out, `localelens-packages-v${version}.zip`), zipSync(Object.fromEntries(tgzs.map((f) => [f, new Uint8Array(fs.readFileSync(path.join(rel, f)))]))));

const mm = version.split(".").slice(0, 2).join(".") + ".x"; // 0.x: agent and extension must match on major.minor
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const assets = fs.readdirSync(out).sort().map((f) => ({ file: f, sha256: sha(fs.readFileSync(path.join(out, f))), bytes: fs.statSync(path.join(out, f)).size }));
fs.writeFileSync(path.join(out, "release-manifest.json"), JSON.stringify({ version, tag: `v${version}`, commit, compatibility: { agent: mm, extension: mm }, packages: tgzs, assets }, null, 2) + "\n");
const all = fs.readdirSync(out).sort();
fs.writeFileSync(path.join(out, "checksums.sha256"), all.map((f) => `${sha(fs.readFileSync(path.join(out, f)))}  ${f}`).join("\n") + "\n");
console.log("release-out:\n" + fs.readdirSync(out).map((f) => "  " + f).join("\n"));

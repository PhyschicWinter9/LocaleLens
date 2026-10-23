// Builds everything and writes installable tarballs to ./release (for a private registry or local `npm i ./file.tgz`).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "release");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const run = (cmd, args, cwd = root) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" }); if (r.status) process.exit(r.status); };

run("node", ["scripts/build-packages.mjs"]);
run("node", ["packages/extension/build.mjs"]);
for (const p of ["cli", "vite", "next"]) {
  const dir = path.join(root, "packages", p);
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE")); // npm only packs files inside the package dir
  try { run("npm", ["pack", "--pack-destination", out, "--silent"], dir); } finally { fs.rmSync(path.join(dir, "LICENSE"), { force: true }); }
}
fs.copyFileSync(path.join(root, "packages/extension/localelens-extension.zip"), path.join(out, "localelens-extension.zip"));
console.log("\nrelease/:\n" + fs.readdirSync(out).map((f) => "  " + f).join("\n"));

// Bundles each runtime package to dist/index.js (ESM). Workspace deps are inlined so every package is self-contained;
// third-party deps stay external (installed by the consumer).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const thirdParty = Object.keys(rootPkg.devDependencies ?? {});
const only = process.argv.slice(2);

const PACKAGES = ["core", "ast-engine", "file-writer", "locale-registry", "adapter-i18next", "adapter-next-intl", "dev-agent", "vite", "translation-excel", "next", "cli"];
const alias = Object.fromEntries(fs.readdirSync(path.join(root, "packages")).map((p) => [`@localelens/${p}`, path.join(root, "packages", p, "src/index.ts")]));

for (const name of PACKAGES) {
  if (only.length && !only.includes(name)) continue;
  const dir = path.join(root, "packages", name);
  if (!fs.existsSync(path.join(dir, "src"))) continue;
  const entries = { index: path.join(dir, "src/index.ts") };
  if (name === "cli") entries.bin = path.join(dir, "src/bin.ts");
  if (name === "next") { entries.loader = path.join(dir, "src/loader.cts"); }
  const cjs = (o) => name === "next" && o === "loader";
  for (const [out, entry] of Object.entries(entries)) {
    if (!fs.existsSync(entry)) continue;
    await build({
      entryPoints: { [out]: entry }, outdir: path.join(dir, "dist"), bundle: true, platform: "node", format: cjs(out) ? "cjs" : "esm",
      outExtension: cjs(out) ? { ".js": ".cjs" } : {}, target: "node22", alias, logLevel: "warning",
      // the CJS loader runs inside Next/webpack workers: bundle everything so it needs no resolution or ESM interop
      external: cjs(out) ? [] : [...thirdParty, ...thirdParty.map((d) => d + "/*"), "vite", "next", "next/*", "webpack"],
      banner: out === "bin" ? { js: "#!/usr/bin/env node" } : undefined,
    });
  }
  console.log("built", name);
}

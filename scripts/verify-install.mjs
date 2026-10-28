// End-to-end proof of internal distribution, once per package manager (npm, pnpm, bun):
// a brand-new project installs LocaleLens from tarballs only, runs `localelens init`/`doctor`,
// and the installed Vite plugin instruments a live dev server and stays out of the production build.
//   node scripts/verify-install.mjs            -> npm, pnpm, bun (those that are installed)
//   node scripts/verify-install.mjs bun        -> just one
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rel = path.join(root, "release");
const tgz = (n) => path.join(rel, fs.readdirSync(rel).find((f) => f.startsWith(n) && f.endsWith(".tgz")));
const win = process.platform === "win32";
const run = (cmd, args, cwd = os.tmpdir()) => spawnSync(cmd, args, { cwd, encoding: "utf8", shell: win });

const PMS = {
  npm: { install: ["install", "--no-audit", "--no-fund", "--loglevel=error"], add: ["install", "--no-audit", "--no-fund", "--loglevel=error", "-D"], lock: "package-lock.json", hint: "npm i -D", exec: ["npx", "--no-install"] },
  pnpm: { install: ["install", "--reporter=silent"], add: ["add", "-D", "--reporter=silent"], lock: "pnpm-lock.yaml", hint: "pnpm add -D", exec: ["pnpm", "exec"] },
  bun: { install: ["install", "--silent"], add: ["add", "-d", "--silent"], lock: "bun.lock", hint: "bun add -d", exec: ["bunx", "--no-install"] },
};

let failed = 0;
async function verify(pm) {
  const cfg = PMS[pm];
  console.log(`\n── ${pm} ${run(pm, ["--version"], os.tmpdir()).stdout.trim()}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ll-install-${pm}-`));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  const check = (name, ok, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "\n    " + String(detail).slice(0, 900)}`); if (!ok) failed++; };

  w("package.json", JSON.stringify({ name: "fresh-app", private: true, type: "module", dependencies: { react: "^19", "react-dom": "^19", "react-i18next": "^16", i18next: "^25" }, devDependencies: { vite: "^8", "@vitejs/plugin-react": "latest" } }, null, 2));
  w("vite.config.ts", 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n');
  w("index.html", '<div id="root"></div><script type="module" src="/src/main.tsx"></script>');
  w("src/main.tsx", 'import { createRoot } from "react-dom/client";\nimport "./i18n";\nimport { App } from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
  w("src/i18n.ts", 'import i18n from "i18next";\nimport { initReactI18next } from "react-i18next";\nimport en from "./locales/en/common.json";\nvoid i18n.use(initReactI18next).init({ lng: "en", defaultNS: "common", resources: { en: { common: en } } });\n');
  w("src/App.tsx", 'export function App() {\n  return <h1 id="t">Hello fresh app</h1>;\n}\n');
  w("src/locales/en/common.json", "{}\n");
  w("src/locales/th/common.json", "{}\n");

  let r = run(pm, cfg.install, dir);
  check(`${pm} install of project deps`, r.status === 0, r.stderr + r.stdout);
  check(`${pm} wrote ${cfg.lock} (so init can detect it)`, fs.existsSync(path.join(dir, cfg.lock)), fs.readdirSync(dir).join(", "));
  r = run(pm, [...cfg.add, tgz("localelens-cli-0"), tgz("localelens-vite")], dir);
  check(`${pm} install of LocaleLens tarballs`, r.status === 0, r.stderr + r.stdout);

  const ll = (...a) => run(cfg.exec[0], [...cfg.exec.slice(1), "localelens", ...a], dir); // the way users run it: npx / pnpm exec / bunx
  r = ll("init", "--dry-run");
  check("init --dry-run shows a diff, changes nothing", r.status === 0 && r.stdout.includes("plugins: [localelens(), react()]") && !fs.existsSync(path.join(dir, "localelens.config.json")), r.stdout + r.stderr);
  check(`init detected ${pm}`, new RegExp(String.raw`Package manager\s+${pm}`).test(r.stdout), r.stdout.slice(0, 300));
  r = ll("init", "--yes");
  check("init --yes patches vite.config.ts", r.status === 0 && /localelens\(\)/.test(fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8")), r.stdout + r.stderr);
  check(`init prints the ${pm} install command`, r.stdout.includes(cfg.hint), r.stdout.slice(-400));
  r = ll("doctor");
  check("doctor passes", r.status === 0, r.stdout + r.stderr);

  // a TypeScript user's patched vite.config.ts must type-check against the shipped .d.ts (no internal @localelens/* leaking)
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true, skipLibCheck: false, lib: ["esnext", "dom"], types: [] }, include: ["vite.config.ts"] }));
  const tscBin = path.join(root, "node_modules/typescript/bin/tsc");
  r = run(process.execPath, [tscBin, "-p", "tsconfig.json"], dir);
  // third-party typings (vite, @types/node) may have their own unrelated errors; only ours matter here
  const ours = (r.stdout + r.stderr).split("\n").filter((l) => /localelens/i.test(l));
  check("patched vite.config.ts type-checks against the published typings", ours.length === 0, ours.join("\n"));

  const port = await new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const vite = spawn(process.execPath, [path.join(dir, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: dir, stdio: "pipe" });
  let log = ""; vite.stdout.on("data", (d) => (log += d)); vite.stderr.on("data", (d) => (log += d));
  let code = "";
  for (let i = 0; i < 100 && !code; i++) {
    try { const x = await fetch(`http://127.0.0.1:${port}/src/App.tsx`); if (x.ok) code = await x.text(); } catch { /* starting */ }
    if (!code) await new Promise((r) => setTimeout(r, 300));
  }
  check("installed Vite plugin instruments the dev server output", code.includes("data-ll"), log.slice(-600) + code.slice(0, 200));
  vite.kill();

  r = run(process.execPath, [path.join(dir, "node_modules/vite/bin/vite.js"), "build"], dir);
  const assets = fs.existsSync(path.join(dir, "dist/assets")) ? fs.readdirSync(path.join(dir, "dist/assets")).map((f) => fs.readFileSync(path.join(dir, "dist/assets", f), "utf8")).join("") : "";
  check("production build succeeds and contains no LocaleLens code", r.status === 0 && assets.length > 0 && !/data-ll|localelens/i.test(assets), r.stderr + r.stdout.slice(-400));

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const wanted = process.argv.slice(2).filter((a) => PMS[a]);
for (const pm of wanted.length ? wanted : Object.keys(PMS)) {
  if (run(pm, ["--version"], os.tmpdir()).status !== 0) { console.log(`\n── ${pm}: not installed, skipped`); continue; }
  await verify(pm);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll install checks passed");
process.exit(failed ? 1 : 0);

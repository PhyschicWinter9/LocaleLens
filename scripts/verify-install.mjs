// End-to-end proof of internal distribution: a brand-new project installs LocaleLens from tarballs only,
// runs `localelens init`/`doctor`, and the installed Vite plugin instruments a live dev server.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rel = path.join(root, "release");
const tgz = (n) => path.join(rel, fs.readdirSync(rel).find((f) => f.startsWith(n) && f.endsWith(".tgz")));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-install-"));
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8", shell: process.platform === "win32", ...opts });
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "\n    " + detail}`); if (!ok) failed++; };

w("package.json", JSON.stringify({ name: "fresh-app", private: true, type: "module", dependencies: { react: "^19", "react-dom": "^19", "react-i18next": "^16", i18next: "^25" }, devDependencies: { vite: "^8", "@vitejs/plugin-react": "latest" } }, null, 2));
w("vite.config.ts", 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n');
w("index.html", '<div id="root"></div><script type="module" src="/src/main.tsx"></script>');
w("src/main.tsx", 'import { createRoot } from "react-dom/client";\nimport "./i18n";\nimport { App } from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
w("src/i18n.ts", 'import i18n from "i18next";\nimport { initReactI18next } from "react-i18next";\nimport en from "./locales/en/common.json";\nvoid i18n.use(initReactI18next).init({ lng: "en", defaultNS: "common", resources: { en: { common: en } } });\n');
w("src/App.tsx", 'export function App() {\n  return <h1 id="t">Hello fresh app</h1>;\n}\n');
w("src/locales/en/common.json", "{}\n");
w("src/locales/th/common.json", "{}\n");

let r = sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
check("npm install of project deps", r.status === 0, r.stderr);
r = sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "-D", tgz("localelens-0"), tgz("localelens-vite")]);
check("npm install of LocaleLens tarballs (no workspace, no registry access to @localelens)", r.status === 0, r.stderr + r.stdout);

const bin = path.join(dir, "node_modules/.bin/localelens" + (process.platform === "win32" ? ".cmd" : ""));
r = sh(`"${bin}"`, ["init", "--dry-run"]);
check("localelens init --dry-run prints a diff and changes nothing", r.status === 0 && r.stdout.includes("plugins: [localelens(), react()]") && !fs.existsSync(path.join(dir, "localelens.config.json")), r.stdout + r.stderr);
r = sh(`"${bin}"`, ["init", "--yes"]);
check("localelens init --yes", r.status === 0 && /localelens\(\)/.test(fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8")), r.stdout + r.stderr);
r = sh(`"${bin}"`, ["doctor"]);
check("localelens doctor passes", r.status === 0, r.stdout + r.stderr);

// live dev server with the *installed* plugin
const port = await new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const vite = spawn(process.execPath, [path.join(dir, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: dir, stdio: "pipe" });
let log = ""; vite.stdout.on("data", (d) => (log += d)); vite.stderr.on("data", (d) => (log += d));
let code = "";
for (let i = 0; i < 100 && !code; i++) {
  try { const x = await fetch(`http://127.0.0.1:${port}/src/App.tsx`); if (x.ok) code = await x.text(); } catch { /* starting */ }
  if (!code) await new Promise((r) => setTimeout(r, 300));
}
check("installed Vite plugin instruments the dev server output", /data-ll":?\s*[:=]?\s*"?[0-9a-f]{8}:\d+:[0-9a-f]{8}/.test(code) || code.includes("data-ll"), log.slice(-800) + code.slice(0, 300));
vite.kill();

// production build must be clean
r = sh(process.execPath, [path.join(dir, "node_modules/vite/bin/vite.js"), "build"]);
const assets = fs.existsSync(path.join(dir, "dist/assets")) ? fs.readdirSync(path.join(dir, "dist/assets")).map((f) => fs.readFileSync(path.join(dir, "dist/assets", f), "utf8")).join("") : "";
check("production build succeeds and contains no LocaleLens code", r.status === 0 && assets.length > 0 && !/data-ll|localelens/i.test(assets), r.stderr + r.stdout.slice(-400));

fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
console.log(failed ? `\n${failed} check(s) failed` : "\nAll install checks passed");
process.exit(failed ? 1 : 0);

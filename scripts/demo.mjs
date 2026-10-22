// Interactive demo: playground app + agent + Chromium with the extension, pre-connected.
// Edits happen in a scratch copy (apps/.demo), never in apps/playground-vite.
//   bun run demo            (visible browser)
//   DEMO_HEADLESS=1 ...     (smoke test: starts, verifies, exits)
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigSchema } from "../packages/core/dist/index.js";
import { DevAgent } from "../packages/dev-agent/dist/index.js";

const root = path.resolve(import.meta.dirname, "..");
const ext = path.join(root, "packages/extension/dist");
if (!fs.existsSync(path.join(ext, "manifest.json"))) { console.error("Build first: bun run build"); process.exit(1); }

const dir = path.join(root, "apps/.demo");
fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync(path.join(root, "apps/playground-vite"), dir, { recursive: true, filter: (s) => !/node_modules|[\\/]dist$|\.localelens/.test(s) });

const port = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const cfg = ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "localelens.config.json"), "utf8")));
const agent = new DevAgent({ root: dir, cfg, port: 0 });
const { port: agentPort, token } = await agent.start();

const vite = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "localhost"], { cwd: dir, stdio: "ignore" });
const url = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 300)); }

const headless = !!process.env.DEMO_HEADLESS;
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ll-demo-")), {
  channel: "chromium", headless, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1280,860"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
await sw.evaluate(async ([t, u]) => { await chrome.storage.session.set({ token: t }); await chrome.storage.local.set({ agentUrl: u }); }, [token, `http://127.0.0.1:${agentPort}`]);

const app = ctx.pages()[0] ?? (await ctx.newPage());
await app.goto(url);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0].id);
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html?inspectedTabId=${tabId}&tab=inspector`);
await app.bringToFront();

console.log(`
LocaleLens demo running

  App         ${url}                       (scratch copy: ${dir})
  Panel tab   2nd browser tab = the LocaleLens panel (already connected)
  Real DevTools: press F12 on the app tab → "LocaleLens" tab (click the extension icon once to connect: URL http://127.0.0.1:${agentPort}  token ${token})

Try:
  1. Panel → Inspector → "Inspect Text", then click "Welcome back!" on the app tab
  2. Preview changes → Apply changes → watch src/App.tsx and the locale files change
  3. Click the "Home" heading, change the English text, Apply: the page hot-reloads. Then Undo
  4. Translations tab → Export package, edit the .xlsx, Import
Close the browser window (or Ctrl+C) to stop.
`);

const stop = async () => { vite.kill(); await agent.stop(); spawnSync("cmd", ["/c", "exit"]); process.exit(0); };
process.on("SIGINT", stop);
if (headless) {
  const ok = (await app.locator("[data-ll]").count()) > 0 && (await panel.locator("text=Inspect Text").count()) > 0;
  console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
  await ctx.close(); vite.kill(); await agent.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
ctx.on("close", stop);
await new Promise(() => {});

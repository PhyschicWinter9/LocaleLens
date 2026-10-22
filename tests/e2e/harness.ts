import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ConfigSchema } from "@localelens/core";
import { DevAgent } from "@localelens/dev-agent";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const EXT_DIST = path.join(REPO, "packages/extension/dist");

/** `next dev` spawns workers; on Windows plain kill() leaves them holding file locks. */
export function killTree(p: ChildProcess) {
  if (!p.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); else p.kill();
}

export const freePort = () => new Promise<number>((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
});

/** Copy an app (sans node_modules) into a scratch dir inside the repo and junction its node_modules. */
export function scratchCopy(appDir: string): string {
  const dest = path.join(REPO, "apps/.e2e", `${path.basename(appDir)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(appDir, dest, { recursive: true, filter: (s) => !/node_modules|[\\/]\.next|[\\/]dist$|\.localelens/.test(s) });
  return dest;
}

export async function waitHttp(url: string, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

export interface Rig {
  dir: string; appUrl: string; agent: DevAgent; agentUrl: string; token: string; ctx: BrowserContext; sw: Worker; extId: string; vite: ChildProcess;
  read: (rel: string) => string; stop: () => Promise<void>;
}

export async function startVite(dir: string): Promise<{ proc: ChildProcess; url: string; port: number }> {
  const port = await freePort();
  const viteBin = path.join(REPO, "node_modules/vite/bin/vite.js");
  const proc = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "localhost"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d)); proc.stderr!.on("data", (d) => (log += d));
  try { await waitHttp(`http://localhost:${port}/`); } catch (e) { proc.kill(); throw new Error(`vite failed to start:\n${log}`); }
  return { proc, url: `http://localhost:${port}`, port };
}

export async function startNext(dir: string, args: string[] = []): Promise<{ proc: ChildProcess; url: string; port: number }> {
  const port = await freePort();
  const bin = path.join(REPO, "node_modules/next/dist/bin/next");
  const proc = spawn(process.execPath, [bin, "dev", "--port", String(port), ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d)); proc.stderr!.on("data", (d) => (log += d));
  try { await waitHttp(`http://localhost:${port}/`, 120_000); } catch { proc.kill(); throw new Error(`next dev failed to start:
${log.slice(-3000)}`); }
  return { proc, url: `http://localhost:${port}`, port };
}

export async function startRig(appName = "playground-vite", dev: { kind: "vite" | "next"; args?: string[] } = { kind: "vite" }, overlay: Record<string, string> = {}): Promise<Rig> {
  if (!fs.existsSync(path.join(EXT_DIST, "manifest.json"))) throw new Error("Extension not built: run `bun run build` first");
  const dir = scratchCopy(path.join(REPO, "apps", appName));
  for (const [rel, content] of Object.entries(overlay)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const cfg = ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "localelens.config.json"), "utf8")));
  const agent = new DevAgent({ root: dir, cfg, port: 0 });
  const { port, token } = await agent.start();
  const v = dev.kind === "next" ? await startNext(dir, dev.args) : await startVite(dir);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ll-chrome-"));
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${EXT_DIST}`, `--load-extension=${EXT_DIST}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  return {
    dir, appUrl: v.url, agent, agentUrl: `http://127.0.0.1:${port}`, token, ctx, sw, extId, vite: v.proc,
    read: (rel) => fs.readFileSync(path.join(dir, rel), "utf8"),
    async stop() {
      await ctx.close().catch(() => {});
      killTree(v.proc);
      await agent.stop();
      await new Promise((r) => setTimeout(r, 800));
      for (const d of [dir, userData]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch { /* best-effort scratch cleanup */ }
    },
  };
}

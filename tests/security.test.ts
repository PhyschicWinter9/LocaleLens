import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, Logger, resolveInside, sanitize, assertSegment } from "@localelens/core";
import { FileWriter } from "@localelens/file-writer";
import { LocaleRegistry } from "@localelens/locale-registry";
import { AgentService, DevAgent } from "@localelens/dev-agent";

let root: string, outside: string;
const code = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === "function" ? p() : p); } catch (e: any) { return e.code as string; } return "NO_ERROR"; };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-sec-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "ll-out-"));
});

describe("path containment", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => resolveInside(root, "../x")).toThrow(/escapes/);
    expect(() => resolveInside(root, outside)).toThrow(/escapes/);
    expect(() => resolveInside(root, "a/../../x")).toThrow(/escapes/);
    expect(resolveInside(root, "a/b.json")).toBe(path.join(root, "a/b.json"));
  });
  it("rejects a symlink/junction that points outside the root (existing and not-yet-created targets)", async () => {
    fs.symlinkSync(outside, path.join(root, "link"), "junction");
    expect(() => resolveInside(root, "link/file.json")).toThrow(/escapes/);
    expect(() => resolveInside(root, "link/new/deep/file.json")).toThrow(/escapes/);
    const fw = new FileWriter(root);
    expect(await code(fw.commit([{ rel: "link/pwn.json", before: null, after: "{}" }]))).toBe("PATH_ESCAPE");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("segments (locale/namespace) cannot contain separators or dots-only", () => {
    for (const bad of ["../x", "a/b", "a\\b", "..", ".", "", " x", "x\0"]) expect(() => assertSegment(bad, "t"), JSON.stringify(bad)).toThrow();
    expect(assertSegment("en-US", "t")).toBe("en-US");
  });
  it("workspace roots outside the project are refused at construction; source roots too", async () => {
    expect(() => new LocaleRegistry(root, [{ id: "x", root: outside, pattern: "{locale}.json" }])).toThrow();
    const cfg = ConfigSchema.parse({ sourceRoots: ["../"], workspaces: [{ id: "a", root: "l", pattern: "{locale}.json" }] });
    expect(await code(new AgentService(root, cfg, new Logger("t")).reindex())).toBe("PATH_ESCAPE");
  });
  it("discovery and the source index never follow symlinks out of the tree", async () => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(outside, "Evil.tsx"), "export const E = () => <b>Evil</b>;");
    fs.symlinkSync(outside, path.join(root, "src", "ext"), "junction");
    const cfg = ConfigSchema.parse({ workspaces: [{ id: "a", root: "src/locales", pattern: "{locale}.json" }] });
    const svc = new AgentService(root, cfg, new Logger("t"));
    expect(await svc.reindex()).toBe(0);
  });
});

describe("file transactions", () => {
  it("two writers racing on one file: exactly one wins, the other gets REVISION_CONFLICT; no torn content", async () => {
    fs.writeFileSync(path.join(root, "a.json"), "base");
    const fw = new FileWriter(root);
    const r = await Promise.allSettled([
      fw.commit([{ rel: "a.json", before: "base", after: "one" }]),
      fw.commit([{ rel: "a.json", before: "base", after: "two" }]),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason.code).toBe("REVISION_CONFLICT");
    expect(["one", "two"]).toContain(fs.readFileSync(path.join(root, "a.json"), "utf8"));
  });
  it("journal ids are validated (no path injection through the undo API)", async () => {
    const fw = new FileWriter(root);
    for (const bad of ["../../etc/passwd", "a/b", "..\\x", "x"]) expect(await code(fw.undo(bad)), bad).toBe("BAD_REQUEST");
  });
  it("a precondition failure leaves every file untouched (no partial write)", async () => {
    fs.writeFileSync(path.join(root, "a.json"), "A"); fs.writeFileSync(path.join(root, "b.json"), "B-changed");
    const fw = new FileWriter(root);
    expect(await code(fw.commit([{ rel: "a.json", before: "A", after: "A2" }, { rel: "b.json", before: "B", after: "B2" }]))).toBe("REVISION_CONFLICT");
    expect(fs.readFileSync(path.join(root, "a.json"), "utf8")).toBe("A");
  });
});

describe("logging hygiene", () => {
  it("redacts tokens, bearer headers and secret-named keys; truncates big strings", () => {
    const tok = "ll_" + "A".repeat(32);
    const s = sanitize({ authorization: "Bearer abc.def", token: tok, nested: { password: "x", msg: `failed with ${tok} and Bearer zzz` }, big: "x".repeat(1000), ok: 1 }) as any;
    const json = JSON.stringify(s);
    expect(json).not.toContain(tok);
    expect(json).not.toContain("abc.def");
    expect(s.authorization).toBe("[redacted]");
    expect(s.big.length).toBeLessThan(400);
    expect(s.ok).toBe(1);
  });
});

describe("agent HTTP hardening", () => {
  let agent: DevAgent, base: string, token: string;
  beforeEach(async () => {
    fs.mkdirSync(path.join(root, "src/locales/en"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/locales/en/common.json"), "{}");
    const cfg = ConfigSchema.parse({ workspaces: [{ id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" }] });
    agent = new DevAgent({ root, cfg, port: 0 });
    const s = await agent.start(); token = s.token; base = `http://127.0.0.1:${s.port}/api/v1`;
  });
  afterEach(async () => { await agent.stop(); });
  const post = (p: string, body: string, ct = "application/json") => fetch(base + p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": ct }, body });

  it("malformed JSON → 400, oversized body → 413, unknown route → 404; errors carry no stack traces or absolute paths", async () => {
    const bad = await post("/changes/preview", "{not json");
    expect(bad.status).toBe(400);
    const big = await post("/keys/suggest", JSON.stringify({ text: "x".repeat(1_100_000) }));
    expect(big.status).toBe(413);
    const nf = await fetch(base + "/nope", { headers: { authorization: `Bearer ${token}` } });
    expect(nf.status).toBe(404);
    for (const r of [bad, nf]) { const t = await r.text(); expect(t).not.toMatch(/\bat \w|node_modules|\.ts:\d+/); expect(t).not.toContain(root); }
  });
  it("validates every field: invalid keys, locales with separators, huge values", async () => {
    const ok = { mode: "edit", workspaceId: "app", namespace: "common", key: "a", values: { en: "x" } };
    expect((await post("/changes/preview", JSON.stringify({ ...ok, key: "../../etc/passwd" }))).status).toBe(400);
    expect((await post("/changes/preview", JSON.stringify({ ...ok, values: { "../en": "x" } }))).status).toBe(400);
    expect((await post("/changes/preview", JSON.stringify({ ...ok, values: { en: "x".repeat(10_001) } }))).status).toBe(400);
    expect((await post("/changes/preview", JSON.stringify({ ...ok, workspaceId: "ghost" }))).status).toBe(404);
    expect((await post("/changes/preview", JSON.stringify({ ...ok }))).status).toBe(200);
    expect(fs.readFileSync(path.join(root, "src/locales/en/common.json"), "utf8")).toBe("{}"); // preview wrote nothing
  });
  it("GET with a cross-origin web page Origin is rejected even with a valid token; unknown extension ids too", async () => {
    for (const origin of ["https://evil.test", "http://localhost:3000", "null", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const r = await fetch(base + "/status", { headers: { authorization: `Bearer ${token}`, origin } });
      expect(r.status, origin).toBe(403);
    }
  });
  it("only binds to loopback", () => {
    const addr = (agent as any).server.address();
    expect(addr.address).toBe("127.0.0.1");
  });
  it("Host header variants: IPv4/localhost accepted, anything else (incl. suffix tricks) refused", async () => {
    const hit = (host: string) => new Promise<number>((res) => {
      const r = http.request({ host: "127.0.0.1", port: agent.port, path: "/api/v1/health", headers: { host } }, (x) => { x.resume(); res(x.statusCode!); });
      r.end();
    });
    expect(await hit(`localhost:${agent.port}`)).toBe(200);
    expect(await hit(`127.0.0.1:${agent.port}`)).toBe(200);
    for (const h of ["evil.com", "localhost.evil.com:80", "127.0.0.1.evil.com:80", "evil.com:4378", "localhost"]) expect(await hit(h), h).toBe(403);
  });
  it("session file holds the token with restrictive intent and is removed on stop", async () => {
    const f = path.join(root, ".localelens/session.json");
    expect(JSON.parse(fs.readFileSync(f, "utf8")).token).toBe(token);
    await agent.stop();
    expect(fs.existsSync(f)).toBe(false);
    await agent.start().then((s) => { token = s.token; base = `http://127.0.0.1:${s.port}/api/v1`; });
  });
});

describe("single agent per project", () => {
  it("a second agent on the same project is refused while the first is alive; a stale session file is ignored", async () => {
    fs.mkdirSync(path.join(root, "src/locales/en"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/locales/en/common.json"), "{}");
    const cfg = ConfigSchema.parse({ workspaces: [{ id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" }] });
    // simulate another live process owning the project: our parent's pid is certainly alive and not ours
    fs.mkdirSync(path.join(root, ".localelens"), { recursive: true });
    fs.writeFileSync(path.join(root, ".localelens/session.json"), JSON.stringify({ pid: process.ppid, port: 4378 }));
    expect(await code(new DevAgent({ root, cfg, port: 0 }).start())).toBe("BAD_REQUEST");
    fs.writeFileSync(path.join(root, ".localelens/session.json"), JSON.stringify({ pid: 2 ** 22 - 1, port: 4378 })); // dead pid
    const a = new DevAgent({ root, cfg, port: 0 });
    await a.start();
    await a.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DevAgent } from "@localelens/dev-agent";
import { ConfigSchema } from "@localelens/core";
import { instrument } from "@localelens/ast-engine";

let root: string, agent: DevAgent, base: string, token: string;
const put = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const SRC = `export function Dashboard({ user }) {
  return (
    <main>
      <h1>Welcome back!</h1>
      <p>Welcome, {user.name}!</p>
      <input placeholder="Email" />
      <b>Same</b>
      <b>Same</b>
    </main>
  );
}
`;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-agent-"));
  put("src/Dashboard.tsx", SRC);
  put("src/locales/en/common.json", '{\n  "existing": "Hello"\n}\n');
  put("src/locales/th/common.json", '{\n  "existing": "สวัสดี"\n}\n');
  const cfg = ConfigSchema.parse({ workspaces: [{ id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" }], devOrigins: ["http://localhost:5173"] });
  agent = new DevAgent({ root, cfg, port: 0, allowedExtensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
  const s = await agent.start();
  token = s.token; base = `http://127.0.0.1:${s.port}/api/v1`;
});
afterEach(async () => { await agent.stop(); });

const call = async (p: string, body?: unknown, headers: Record<string, string> = {}, auth = true) => {
  const r = await fetch(base + p, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any, headers: r.headers };
};
const refFor = (nth: number) => {
  const out = instrument(SRC, "src/Dashboard.tsx", "src/Dashboard.tsx")!.code;
  const all = [...out.matchAll(/data-ll="([0-9a-f]{8}):(\d+):([0-9a-f]{8})"/g)];
  const m = all[nth];
  return { fileId: m[1], n: Number(m[2]), fp: m[3] };
};

describe("authentication & origin policy", () => {
  it("health is public but minimal; everything else needs the token", async () => {
    const h = await call("/health", undefined, {}, false);
    expect(h.status).toBe(200);
    expect(Object.keys(h.json).sort()).toEqual(["authRequired", "ok", "product", "version"]);
    expect((await call("/status", undefined, {}, false)).json.error.code).toBe("UNAUTHORIZED");
  });
  it("rejects invalid token (same length and different length)", async () => {
    for (const t of ["ll_nope", token.slice(0, -1) + "x"]) {
      const r = await fetch(base + "/status", { headers: { authorization: `Bearer ${t}` } });
      expect(r.status).toBe(401);
    }
  });
  it("rejects unauthorized browser origins even with a valid token", async () => {
    for (const origin of ["https://evil.example", "http://localhost:5173", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const r = await call("/status", undefined, { origin });
      expect(r.status, origin).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN_ORIGIN");
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("accepts the allow-listed extension origin and answers preflight; also no-Origin with token (MV3 worker case)", async () => {
    const o = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const ok = await call("/status", undefined, { origin: o });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(o);
    const pre = await fetch(base + "/changes/preview", { method: "OPTIONS", headers: { origin: o } });
    expect(pre.status).toBe(204);
    expect((await call("/status")).status).toBe(200);
  });
  it("blocks DNS-rebinding style Host headers", async () => {
    const status = await new Promise<number>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: agent.port, path: "/api/v1/health", headers: { host: "evil.example:80" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.end();
    });
    expect(status).toBe(403);
  });
  it("rate-limits repeated bad tokens", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await fetch(base + "/status", { headers: { authorization: "Bearer bad" } })).status;
    expect(last).toBe(429);
  });
  it("status does not leak absolute paths or the token", async () => {
    const txt = JSON.stringify((await call("/status")).json);
    expect(txt).not.toContain(root.replace(/\\/g, "\\\\"));
    expect(txt).not.toContain(token);
  });
});

describe("resolve → preview → commit → undo", () => {
  it("resolves the exact occurrence and suggests workspace/key", async () => {
    const r = await call("/source/resolve", { ref: refFor(0), text: "Welcome back!" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ file: "src/Dashboard.tsx", ambiguous: false, suggestedWorkspaceId: "app", suggestedKey: "welcomeBack" });
    expect(r.json.candidates[0]).toMatchObject({ kind: "jsx-text", confidence: "exact", canExtract: true, line: 4 });
  });
  it("resolves dynamic text by pattern and reports vars", async () => {
    const r = await call("/source/resolve", { ref: refFor(1), text: "Welcome, Ada!" });
    expect(r.json.candidates[0]).toMatchObject({ kind: "dynamic-text", confidence: "pattern", template: "Welcome, {{name}}!", vars: ["name"] });
  });
  it("flags duplicate strings in one element as ambiguous (never guesses)", async () => {
    put("src/Two.tsx", `export const Two = () => <p>{a ? "Same" : "Same"}</p>;\n`);
    const out = instrument(read("src/Two.tsx"), "src/Two.tsx", "src/Two.tsx")!.code;
    const m = /data-ll="([0-9a-f]{8}):(\d+):([0-9a-f]{8})"/.exec(out)!;
    await agent.service.reindex();
    const r = await call("/source/resolve", { ref: { fileId: m[1], n: +m[2], fp: m[3] }, text: "Same" });
    expect(r.json.ambiguous).toBe(true);
    expect(r.json.candidates).toHaveLength(2);
  });
  it("rejects stale fingerprints and unknown files", async () => {
    const ref = refFor(0);
    expect((await call("/source/resolve", { ref: { ...ref, fp: "00000000" }, text: "x" })).json.error.code).toBe("SOURCE_STALE");
    expect((await call("/source/resolve", { ref: { ...ref, fileId: "deadbeef" }, text: "x" })).status).toBe(404);
  });
  it("browser cannot smuggle paths: schema rejects non-opaque ids", async () => {
    const r = await call("/source/resolve", { ref: { fileId: "../../etc/passwd", n: 0, fp: "00000000" }, text: "x" });
    expect(r.json.error.code).toBe("BAD_REQUEST");
  });

  it("extract: preview shows source+locale diffs; commit writes; undo restores", async () => {
    const cand = (await call("/source/resolve", { ref: refFor(1), text: "Welcome, Ada!" })).json.candidates[0];
    const body = {
      mode: "extract", workspaceId: "app", namespace: "common", key: "welcomeUser",
      values: { en: "Welcome, {{name}}!", th: "ยินดีต้อนรับ {{name}}!" },
      source: { ref: refFor(1), candidateId: cand.id, text: "Welcome, Ada!" },
    };
    const pv = await call("/changes/preview", body);
    expect(pv.status, JSON.stringify(pv.json)).toBe(200);
    expect(pv.json.changes.map((c: any) => [c.file, c.kind])).toEqual([
      ["src/Dashboard.tsx", "source"], ["src/locales/en/common.json", "locale"], ["src/locales/th/common.json", "locale"],
    ]);
    expect(pv.json.changes[0].diff).toContain(`+      <p>{t("welcomeUser", { name: user.name })}</p>`);
    expect(read("src/Dashboard.tsx")).toBe(SRC); // preview wrote nothing

    const cm = await call("/changes/commit", { operationId: pv.json.operationId });
    expect(cm.status).toBe(200);
    expect(cm.json.verified).toBe(true);
    expect(read("src/Dashboard.tsx")).toContain(`import { useTranslation } from "react-i18next";`);
    expect(read("src/Dashboard.tsx")).toContain(`const { t } = useTranslation("common");`);
    expect(JSON.parse(read("src/locales/th/common.json"))).toEqual({ existing: "สวัสดี", welcomeUser: "ยินดีต้อนรับ {{name}}!" });
    expect((await call("/changes/commit", { operationId: pv.json.operationId })).json.error.code).toBe("OPERATION_EXPIRED"); // one-shot

    // the page re-compiled → existing-translation candidate now resolves with values
    await agent.service.reindex();
    const re = instrument(read("src/Dashboard.tsx"), "src/Dashboard.tsx", "src/Dashboard.tsx")!.code;
    const m = [...re.matchAll(/data-ll="([0-9a-f]{8}):(\d+):([0-9a-f]{8})"/g)].find((x) => +x[2] === 2)!;
    const again = await call("/source/resolve", { ref: { fileId: m[1], n: +m[2], fp: m[3] }, text: "Welcome, Ada!" });
    expect(again.json.candidates[0]).toMatchObject({ kind: "i18n-call", key: "welcomeUser", namespace: "common", confidence: "exact" });

    const un = await call("/changes/undo", { transactionId: cm.json.transactionId });
    expect(un.json.state).toBe("undone");
    expect(read("src/Dashboard.tsx")).toBe(SRC);
    expect(JSON.parse(read("src/locales/en/common.json"))).toEqual({ existing: "Hello" });
  });

  it("rejects stale revisions between preview and commit", async () => {
    const cand = (await call("/source/resolve", { ref: refFor(0), text: "Welcome back!" })).json.candidates[0];
    const pv = await call("/changes/preview", {
      mode: "extract", workspaceId: "app", namespace: "common", key: "welcomeBack", values: { en: "Welcome back!" },
      source: { ref: refFor(0), candidateId: cand.id, text: "Welcome back!" },
    });
    put("src/locales/en/common.json", '{ "existing": "Hello", "dev": "edit" }\n'); // developer edits after preview
    const cm = await call("/changes/commit", { operationId: pv.json.operationId });
    expect(cm.status).toBe(409);
    expect(cm.json.error.code).toBe("REVISION_CONFLICT");
    expect(read("src/Dashboard.tsx")).toBe(SRC);
    expect(read("src/locales/en/common.json")).toContain('"dev"');
  });

  it("edit mode changes only locale files; detects placeholder mismatch and key collision on extract", async () => {
    const ed = await call("/changes/preview", { mode: "edit", workspaceId: "app", namespace: "common", key: "existing", values: { en: "Hello!", th: "สวัสดีครับ" } });
    expect(ed.json.changes.map((c: any) => c.kind)).toEqual(["locale", "locale"]);
    const bad = await call("/changes/preview", { mode: "edit", workspaceId: "app", namespace: "common", key: "x", values: { en: "Hi {{name}}", th: "สวัสดี {{nam}}" } });
    expect(bad.json.error.code).toBe("PLACEHOLDER_MISMATCH");
    const cand = (await call("/source/resolve", { ref: refFor(0), text: "Welcome back!" })).json.candidates[0];
    const col = await call("/changes/preview", { mode: "extract", workspaceId: "app", namespace: "common", key: "existing", values: { en: "Welcome back!" }, source: { ref: refFor(0), candidateId: cand.id, text: "x" } });
    expect(col.json.error.code).toBe("KEY_COLLISION");
  });

  it("attribute extraction", async () => {
    const ref = refFor(2);
    const r = await call("/source/resolve", { ref, text: "Email", attr: "placeholder" });
    const c = r.json.candidates[0];
    expect(c).toMatchObject({ kind: "attribute", attr: "placeholder" });
    const pv = await call("/changes/preview", { mode: "extract", workspaceId: "app", namespace: "common", key: "email", values: { en: "Email" }, source: { ref, candidateId: c.id, text: "Email", attr: "placeholder" } });
    expect(pv.json.changes[0].diff).toContain(`placeholder={t("email")}`);
  });

  it("diagnostics expose structured, token-free logs", async () => {
    await call("/source/resolve", { ref: refFor(0), text: "Welcome back!" });
    const d = await call("/diagnostics");
    const events = d.json.logs.map((l: any) => l.event);
    expect(events).toContain("source.resolve.completed");
    expect(JSON.stringify(d.json)).not.toContain(token);
    await call("/diagnostics/log", { entries: [{ ts: new Date().toISOString(), level: "INFO", component: "panel", event: "panel.selection_received", data: { token: "ll_" + "a".repeat(30), note: "Bearer abcdef" } }] });
    const d2 = await call("/diagnostics");
    expect(JSON.stringify(d2.json.extensionLogs)).not.toMatch(/ll_a{30}|abcdef/);
  });
});

describe("translation exchange over HTTP", () => {
  it("export returns a package; import preview rejects garbage with IMPORT_INVALID; unauthenticated is refused", async () => {
    const ex = await call("/translations/export", { format: "zip" });
    expect(ex.status).toBe(200);
    expect(ex.json.fileName).toMatch(/^translations-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(Buffer.from(ex.json.dataBase64, "base64").subarray(0, 2).toString()).toBe("PK");
    const pv = await call("/translations/import/preview", { dataBase64: ex.json.dataBase64 });
    expect(pv.status).toBe(200);
    expect(pv.json.report.changes).toEqual([]);
    const bad = await call("/translations/import/preview", { dataBase64: Buffer.from("not a zip").toString("base64") });
    expect(bad.json.error.code).toBe("IMPORT_INVALID");
    expect((await call("/translations/export", { format: "zip" }, {}, false)).status).toBe(401);
    expect((await call("/translations/import/commit", { importId: "nope" })).json.error.code).toBe("OPERATION_EXPIRED");
  });
});

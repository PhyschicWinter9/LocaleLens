import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileWriter, type FsLike } from "@localelens/file-writer";
import { LocaleRegistry, validatePlaceholders } from "@localelens/locale-registry";
import { i18nextAdapter } from "@localelens/adapter-i18next";

let root: string;
const w = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
const r = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-")); });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return "NO_ERROR"; };

describe("FileWriter", () => {
  it("commits, detects stale revisions, and undoes", async () => {
    w("a.json", '{"a":1}\n');
    const fw = new FileWriter(root);
    const j = await fw.commit([{ rel: "a.json", before: '{"a":1}\n', after: '{"a":2}\n' }, { rel: "new/b.json", before: null, after: "{}\n" }]);
    expect(r("a.json")).toBe('{"a":2}\n');
    expect(r("new/b.json")).toBe("{}\n");
    expect(await code(fw.commit([{ rel: "a.json", before: '{"a":1}\n', after: "x" }]))).toBe("REVISION_CONFLICT");
    await fw.undo(j.id);
    expect(r("a.json")).toBe('{"a":1}\n');
    expect(fs.existsSync(path.join(root, "new/b.json"))).toBe(false);
  });
  it("refuses undo when a file changed after commit", async () => {
    w("a.json", "1");
    const fw = new FileWriter(root);
    const j = await fw.commit([{ rel: "a.json", before: "1", after: "2" }]);
    w("a.json", "dev edit");
    expect(await code(fw.undo(j.id))).toBe("UNDO_CONFLICT");
    expect(r("a.json")).toBe("dev edit");
  });
  it("rolls back every file when a later write fails (failure injection)", async () => {
    w("a.json", "A"); w("b.json", "B");
    let renames = 0;
    const flaky: FsLike = { ...fsp, rename: async (a, b) => { if (++renames === 2) throw new Error("EIO injected"); return fsp.rename(a, b); } } as FsLike;
    const fw = new FileWriter(root, flaky);
    expect(await code(fw.commit([{ rel: "a.json", before: "A", after: "A2" }, { rel: "b.json", before: "B", after: "B2" }]))).toBe("WRITE_FAILED");
    expect(r("a.json")).toBe("A"); expect(r("b.json")).toBe("B");
    expect((await fw.list())[0].state).toBe("rolled-back");
    expect(fs.readdirSync(root).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
  it("recovers an interrupted transaction", async () => {
    w("a.json", "A");
    const crash: FsLike = { ...fsp, writeFile: async (p, d, e) => { await fsp.writeFile(p, d, e); } } as FsLike;
    const fw = new FileWriter(root, crash);
    const j = await fw.commit([{ rel: "a.json", before: "A", after: "A2" }]);
    // simulate crash mid-commit: journal says committing, post-image on disk
    const jp = path.join(root, ".localelens/journal", j.id + ".json");
    const rec = JSON.parse(fs.readFileSync(jp, "utf8")); rec.state = "committing"; fs.writeFileSync(jp, JSON.stringify(rec));
    expect(await new FileWriter(root).recover()).toEqual([j.id]);
    expect(r("a.json")).toBe("A");
  });
  it("rejects paths escaping the root", async () => {
    const fw = new FileWriter(root);
    expect(await code(fw.commit([{ rel: "../evil.json", before: null, after: "x" }]))).toBe("PATH_ESCAPE");
  });
  it("preserves CRLF", async () => {
    const { normalizeEol } = await import("@localelens/file-writer");
    expect(normalizeEol("a\r\nb", "a\nc\n")).toBe("a\r\nc\r\n");
  });
});

describe("LocaleRegistry", () => {
  const cfg = () => new LocaleRegistry(root, [
    { id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" },
    { id: "auth", root: "src/features/auth/locales", pattern: "{locale}.json", namespace: "auth", routes: ["src/features/auth/**"] },
    { id: "pub", root: "public/locales", pattern: "{locale}/{ns}.json", nested: false },
  ]);
  it("discovers multiple independent roots", async () => {
    w("src/locales/en/common.json", "{}"); w("src/locales/th/common.json", "{}");
    w("src/features/auth/locales/en.json", "{}"); w("public/locales/en/validation.json", "{}");
    const reg = cfg();
    expect((await reg.discover(reg.ws("app"))).map((f) => [f.locale, f.namespace])).toEqual([["en", "common"], ["th", "common"]]);
    expect((await reg.discover(reg.ws("auth")))[0]).toMatchObject({ locale: "en", namespace: "auth" });
    expect(await reg.namespaces(reg.ws("pub"))).toEqual(["validation"]);
  });
  it("routes by source path", () => {
    expect(cfg().suggestWorkspace("src/features/auth/Login.tsx")!.id).toBe("auth");
    expect(cfg().suggestWorkspace("src/pages/Home.tsx")!.id).toBe("app");
  });
  it("edits nested JSON preserving formatting and unrelated keys", async () => {
    w("src/locales/en/common.json", '{\n    "keep": { "x": "y" },\n    "title": "Old"\n}\n');
    const reg = cfg();
    const p = await reg.plan({ workspaceId: "app", namespace: "common", key: "home.title", values: { en: "Hi", th: "สวัสดี" }, allowOverwrite: false });
    expect(p.files).toHaveLength(2);
    const en = p.files.find((f) => f.rel.endsWith("en/common.json"))!;
    expect(en.after).toBe('{\n    "keep": { "x": "y" },\n    "title": "Old",\n    "home": {\n        "title": "Hi"\n    }\n}\n');
    expect(p.created.has("src/locales/th/common.json")).toBe(true);
  });
  it("detects collisions and shape conflicts", async () => {
    w("src/locales/en/common.json", '{"title":"Old","grp":{"a":"1"}}');
    const reg = cfg();
    const base = { workspaceId: "app", namespace: "common", values: { en: "New" }, allowOverwrite: false };
    expect(await code(reg.plan({ ...base, key: "title" }))).toBe("KEY_COLLISION");
    expect(await code(reg.plan({ ...base, key: "grp" }))).toBe("KEY_COLLISION");
    expect(await code(reg.plan({ ...base, key: "title.sub" }))).toBe("KEY_COLLISION");
    expect((await reg.plan({ ...base, key: "title", allowOverwrite: true })).files).toHaveLength(1);
    expect((await reg.plan({ ...base, key: "title", values: { en: "Old" } })).files).toHaveLength(0); // reuse
  });
  it("supports flat key files and CRLF", async () => {
    w("public/locales/en/validation.json", '{\r\n  "a.b": "x"\r\n}\r\n');
    const reg = cfg();
    const p = await reg.plan({ workspaceId: "pub", namespace: "validation", key: "c.d", values: { en: "y" }, allowOverwrite: false });
    expect(p.files[0].after).toBe('{\r\n  "a.b": "x",\r\n  "c.d": "y"\r\n}\r\n');
  });
  it("blocks traversal in locale/namespace", async () => {
    const reg = cfg();
    expect(await code(reg.plan({ workspaceId: "app", namespace: "../x", key: "a", values: { en: "x" }, allowOverwrite: false }))).toBe("PATH_ESCAPE");
    expect(await code(reg.plan({ workspaceId: "app", namespace: "common", key: "a", values: { "../en": "x" }, allowOverwrite: false }))).toBe("PATH_ESCAPE");
    expect(() => new LocaleRegistry(root, [{ id: "x", root: "../out", pattern: "{locale}.json" }])).toThrow();
  });
  it("validates placeholder consistency", () => {
    expect(validatePlaceholders(i18nextAdapter, { en: "Hi {{name}}", th: "สวัสดี {{name}}" })).toEqual([]);
    expect(validatePlaceholders(i18nextAdapter, { en: "Hi {{name}}", th: "สวัสดี {{nam}}" })[0]).toMatch(/th: missing/);
  });
});

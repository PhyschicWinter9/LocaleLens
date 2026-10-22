import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, Logger } from "@localelens/core";
import { AgentService, Exchange } from "@localelens/dev-agent";
import { diffSnapshots, parseUpload, readZip } from "@localelens/translation-excel";

let root: string, svc: AgentService, ex: Exchange;
const put = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return "NO_ERROR"; };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-ex-"));
  put("src/locales/en/common.json", '{\n  "hello": "Hello {{name}}",\n  "bye": "Bye",\n  "nav": {\n    "home": "Home"\n  }\n}\n');
  put("src/locales/th/common.json", '{\n  "hello": "สวัสดี {{name}}",\n  "bye": "ลาก่อน"\n}\n');
  const cfg = ConfigSchema.parse({ workspaces: [{ id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" }] });
  svc = new AgentService(root, cfg, new Logger("t"));
  await svc.reindex();
  ex = new Exchange(svc);
});

/** Apply edits to the exported workbook the way a translator would, then return the new bytes. */
async function translate(bytes: Uint8Array, edit: (ws: ExcelJS.Worksheet, col: (locale: string) => number) => void): Promise<Uint8Array> {
  const xlsx = bytes[0] === 0x50 && unzipSync(bytes)["translations.xlsx"] ? unzipSync(bytes)["translations.xlsx"] : bytes;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as any);
  const ws = wb.getWorksheet("Translations")!;
  const heads = (ws.getRow(1).values as any[]).map((v) => String(v));
  edit(ws, (l) => heads.indexOf(l));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
const rowOf = (ws: ExcelJS.Worksheet, key: string) => { for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(4).value === key) return ws.getRow(r); throw new Error("no row " + key); };

describe("export / import round trip", () => {
  it("exports every key (nested flattened) with the base snapshot embedded", async () => {
    const r = await ex.export({ format: "zip" });
    expect(r.count).toBe(3);
    const z = unzipSync(r.data);
    expect(Object.keys(z).sort()).toEqual(["README.txt", "manifest.json", "translations.xlsx"]);
    const m = JSON.parse(new TextDecoder().decode(z["manifest.json"]));
    expect(m.entries.map((e: any) => e.key)).toEqual(["bye", "hello", "nav.home"]);
    const parsed = await parseUpload(r.data);
    expect(parsed.manifest!.entries).toHaveLength(3);
    expect(parsed.rows.find((x) => x.key === "nav.home")!.values.en).toBe("Home");
  });

  it("an untouched file imports as a no-op", async () => {
    const r = await ex.export({ format: "xlsx" });
    const p = await ex.importPreview(r.data);
    expect(p.report.changes).toEqual([]);
    expect(p.report.conflicts).toEqual([]);
    expect(p.report.unchanged).toBeGreaterThan(0);
  });

  it("translator edits are applied through the safe writer, preserving file formatting; undo restores", async () => {
    const r = await ex.export({ format: "xlsx" });
    const edited = await translate(r.data, (ws, col) => {
      rowOf(ws, "nav.home").getCell(col("th")).value = "หน้าแรก";
      rowOf(ws, "bye").getCell(col("th")).value = "แล้วพบกัน";
    });
    const p = await ex.importPreview(edited);
    expect(p.report.changes.map((c) => `${c.key}:${c.locale}:${c.kind}`).sort()).toEqual(["bye:th:update", "nav.home:th:add-locale"]);
    const c = await ex.importCommit(p.importId);
    expect(c.applied).toBe(2);
    expect(read("src/locales/th/common.json")).toBe('{\n  "hello": "สวัสดี {{name}}",\n  "bye": "แล้วพบกัน",\n  "nav": {\n    "home": "หน้าแรก"\n  }\n}\n');
    await svc.writer.undo(c.transactionId!);
    expect(read("src/locales/th/common.json")).toContain("ลาก่อน");
  });

  it("blank cells never erase existing translations", async () => {
    const edited = await translate((await ex.export({ format: "xlsx" })).data, (ws, col) => { rowOf(ws, "bye").getCell(col("th")).value = ""; });
    const p = await ex.importPreview(edited);
    expect(p.report.changes).toEqual([]);
  });

  it("translator-added rows create new keys (with and without existing)", async () => {
    const edited = await translate((await ex.export({ format: "xlsx" })).data, (ws, col) => {
      const row = ws.addRow(["", "app", "common", "welcome.title", "Welcome", "ยินดีต้อนรับ"]);
      void row; void col;
    });
    const p = await ex.importPreview(edited);
    expect(p.report.changes.map((c) => `${c.key}:${c.locale}:${c.kind}`).sort()).toEqual(["welcome.title:en:new-key", "welcome.title:th:new-key"]);
    await ex.importCommit(p.importId);
    expect(JSON.parse(read("src/locales/en/common.json")).welcome.title).toBe("Welcome");
  });
});

describe("three-way merge", () => {
  it("both changed → conflict; nothing written until resolved; resolutions honoured", async () => {
    const r = await ex.export({ format: "xlsx" });
    put("src/locales/th/common.json", read("src/locales/th/common.json").replace("ลาก่อน", "บ๊ายบาย")); // developer edit after export
    const edited = await translate(r.data, (ws, col) => { rowOf(ws, "bye").getCell(col("th")).value = "แล้วพบกัน"; });
    const p = await ex.importPreview(edited);
    expect(p.report.conflicts).toHaveLength(1);
    expect(p.report.conflicts[0]).toMatchObject({ key: "bye", locale: "th", base: "ลาก่อน", current: "บ๊ายบาย", incoming: "แล้วพบกัน", reason: "both-changed" });
    expect(await code(ex.importCommit(p.importId))).toBe("IMPORT_CONFLICT");
    expect(read("src/locales/th/common.json")).toContain("บ๊ายบาย"); // not silently overwritten
    const keep = await ex.importCommit(p.importId, { "bye:th": "current" } as any).catch((e) => e);
    // conflict id is entryId:locale; look it up from the report
    const id = p.report.conflicts[0].conflictId;
    const ok = await ex.importCommit(p.importId, { [id]: "incoming" });
    expect(ok.applied).toBe(1);
    expect(read("src/locales/th/common.json")).toContain("แล้วพบกัน");
    void keep;
  });

  it("custom resolution and keep-current", async () => {
    const mk = async () => {
      const r = await ex.export({ format: "xlsx" });
      put("src/locales/th/common.json", read("src/locales/th/common.json").replace(/"bye": "[^"]*"/, '"bye": "บ๊ายบาย"'));
      return ex.importPreview(await translate(r.data, (ws, col) => { rowOf(ws, "bye").getCell(col("th")).value = "ลาก่อนนะ"; }));
    };
    const p = await mk();
    const id = p.report.conflicts[0].conflictId;
    await ex.importCommit(p.importId, { [id]: { custom: "ไว้พบกันใหม่" } });
    expect(read("src/locales/th/common.json")).toContain("ไว้พบกันใหม่");
  });

  it("project changed after the preview → commit refuses (REVISION_CONFLICT)", async () => {
    const r = await ex.export({ format: "xlsx" });
    const edited = await translate(r.data, (ws, col) => { rowOf(ws, "bye").getCell(col("th")).value = "แล้วพบกัน"; });
    const p = await ex.importPreview(edited);
    put("src/locales/th/common.json", read("src/locales/th/common.json").replace("ลาก่อน", "อื่นๆ"));
    expect(await code(ex.importCommit(p.importId))).toBe("REVISION_CONFLICT");
  });

  it("key deleted in the project but changed by translator → conflict, never resurrected silently", async () => {
    const r = await ex.export({ format: "xlsx" });
    put("src/locales/en/common.json", '{\n  "hello": "Hello {{name}}"\n}\n');
    put("src/locales/th/common.json", '{\n  "hello": "สวัสดี {{name}}"\n}\n');
    const p = await ex.importPreview(await translate(r.data, (ws, col) => { rowOf(ws, "bye").getCell(col("th")).value = "แล้วพบกัน"; }));
    expect(p.report.conflicts.map((c) => c.reason)).toEqual(["deleted-in-project"]);
  });

  it("placeholder mismatches are rejected per value, others still import", async () => {
    const r = await ex.export({ format: "xlsx" });
    const p = await ex.importPreview(await translate(r.data, (ws, col) => {
      rowOf(ws, "hello").getCell(col("th")).value = "สวัสดี {{nam}}";
      rowOf(ws, "bye").getCell(col("th")).value = "แล้วพบกัน";
    }));
    expect(p.report.invalid[0]).toMatchObject({ key: "hello", locale: "th" });
    expect(p.report.invalid[0].message).toMatch(/missing \{name\}/);
    expect(p.report.changes.map((c) => c.key)).toEqual(["bye"]);
  });

  it("diffSnapshots detects added/removed/changed and suggests renames", () => {
    const e = (key: string, en: string, ns = "common") => ({ workspaceId: "app", namespace: ns, key, values: { en } });
    const d = diffSnapshots([e("old.title", "Title"), e("keep", "K"), e("gone", "G")], [e("new.title", "Title"), e("keep", "K2"), e("fresh", "F")], "en");
    expect(d.renames.map((r) => [r.from.key, r.to.key])).toEqual([["old.title", "new.title"]]);
    expect(d.added.map((x) => x.key)).toEqual(["fresh"]);
    expect(d.removed.map((x) => x.key)).toEqual(["gone"]);
    expect(d.changed.map((x) => x.entry.key)).toEqual(["keep"]);
  });
});

describe("security", () => {
  it("formula-looking translations are stored as text and read back verbatim; no <f> elements exist", async () => {
    const evil = `=cmd|' /C calc'!A0`;
    put("src/locales/en/common.json", JSON.stringify({ bye: evil, "plus": "+1 now", at: "@SUM(1)" }));
    const r = await ex.export({ format: "xlsx" });
    const files = unzipSync(r.data);
    const sheet = new TextDecoder().decode(files["xl/worksheets/sheet1.xml"]);
    expect(sheet).not.toMatch(/<f[ >]/);
    const parsed = await parseUpload(r.data);
    expect(parsed.rows.find((x) => x.key === "bye")!.values.en).toBe(evil);
    expect(parsed.warnings.some((w) => w.includes("formula character"))).toBe(true);
  });

  it("rejects a workbook that contains real formulas", async () => {
    const r = await ex.export({ format: "xlsx" });
    const bad = await translate(r.data, (ws, col) => { rowOf(ws, "bye").getCell(col("th")).value = { formula: "1+1", result: 2 } as any; });
    expect(await code(parseUpload(bad))).toBe("IMPORT_INVALID");
  });

  it("rejects tampered identity columns", async () => {
    const r = await ex.export({ format: "xlsx" });
    const bad = await translate(r.data, (ws) => { rowOf(ws, "bye").getCell(4).value = "bye2"; });
    expect(await code(parseUpload(bad))).toBe("IMPORT_INVALID");
  });

  it("rejects zip bombs, traversal names, non-zip and oversized input before inflating", async () => {
    const bomb = zipSync({ "translations.xlsx": new Uint8Array(150 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const t0 = Date.now();
    expect(await code(parseUpload(bomb))).toBe("IMPORT_INVALID");
    expect(Date.now() - t0).toBeLessThan(2000);
    for (const name of ["../evil.txt", "a/../../evil", "/abs.txt", "C:\\evil.txt", "dir\\file"]) {
      const z = zipSync({ [name]: strToU8("x") });
      expect(await code(Promise.resolve().then(() => readZip(z, () => false))), name).toBe("IMPORT_INVALID");
    }
    expect(await code(parseUpload(strToU8("not a zip")))).toBe("IMPORT_INVALID");
    expect(await code(parseUpload(new Uint8Array(26 * 1024 * 1024)))).toBe("IMPORT_INVALID");
  });

  it("rejects macro-enabled content and corrupt workbooks", async () => {
    const r = await ex.export({ format: "xlsx" });
    const files = unzipSync(r.data);
    expect(await code(parseUpload(zipSync({ ...files, "xl/vbaProject.bin": strToU8("x") })))).toBe("IMPORT_INVALID");
    expect(await code(parseUpload(zipSync({ "[Content_Types].xml": strToU8("<x/>"), "xl/workbook.xml": strToU8("<x/>") })))).toBe("IMPORT_INVALID");
  });

  it("import cannot write outside the configured workspaces (unknown/read-only workspace, traversal-ish namespace)", async () => {
    const r = await ex.export({ format: "xlsx" });
    const p1 = await ex.importPreview(await translate(r.data, (ws) => { ws.addRow(["", "other", "common", "x.y", "X", ""]); }));
    expect(p1.report.invalid[0].message).toMatch(/Unknown workspace/);
    expect(await code(ex.importPreview(await translate(r.data, (ws) => { ws.addRow(["", "app", "../../etc", "x.y", "X", ""]); })))).toBe("IMPORT_INVALID");
  });
});

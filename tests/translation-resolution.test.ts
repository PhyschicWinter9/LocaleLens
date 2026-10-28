import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentService } from "@localelens/dev-agent";
import { ConfigSchema, Logger, sha256 } from "@localelens/core";
import { instrument } from "@localelens/ast-engine";

// Synthetic next-intl app: messages/<locale>/<feature>.json merged under one key per feature (namespace = dotted path).
let root: string;
const put = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const json = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

const EN = { hero: { title: "Turn every tip", body: "A plain statement.", support_1: "No fees", support_2: "Fast", rich: "Hello <b>world</b>" }, access: { open: { cta: "Start now" }, gated: { cta: "Join waitlist" } }, nav: { home: "Home" } };
const TH = { hero: { title: "ทุกทิป", body: "ข้อความ", support_1: "ไม่มีค่าธรรมเนียม", support_2: "เร็ว", rich: "สวัสดี <b>โลก</b>" }, access: { open: { cta: "เริ่มเลย" }, gated: { cta: "เข้าคิว" } }, nav: { home: "หน้าแรก" } };

function setup(workspaces: any[] = [{ id: "app", root: "messages", pattern: "{locale}/{ns}.json" }]) {
  put("messages/en/landing.json", json(EN)); put("messages/th/landing.json", json(TH));
  put("messages/en/nav.json", json({ menu: "Menu" })); put("messages/th/nav.json", json({ menu: "เมนู" }));
  const cfg = ConfigSchema.parse({ workspaces, provider: "next-intl", framework: "next-app", sourceRoots: ["app", "components"] });
  return new AgentService(root, cfg, new Logger("test"));
}

/** Resolve every instrumented element of `rel` for `text`; returns all candidates (what the inspector would list). */
async function inspect(svc: AgentService, rel: string, text: string) {
  await svc.reindex();
  const out = instrument(read(rel), rel, rel)!.code;
  const cands: any[] = [];
  for (const m of out.matchAll(/data-ll="([0-9a-f]{8}):(\d+):([0-9a-f]{8})"/g)) {
    const r = await svc.resolve({ ref: { fileId: m[1], n: Number(m[2]), fp: m[3] }, text });
    cands.push(...r.candidates);
  }
  return cands;
}
const tr = (cands: any[], key: string) => cands.find((c) => c.key === key || c.translation?.hits?.[0]?.key === key);

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-tr-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("next-intl resolution matrix (split files, dotted namespaces)", () => {
  const cases: [string, string, string, string, string][] = [
    ["async server component + Promise.all", "app/hero.tsx", `import { getTranslations } from "next-intl/server";\nexport async function Hero() {\n  const [t, ta] = await Promise.all([getTranslations("landing.hero"), getTranslations("landing.access")]);\n  return <p>{t("body")}</p>;\n}\n`, "A plain statement.", "body"],
    ["client component", "components/c.tsx", `"use client";\nimport { useTranslations } from "next-intl";\nexport function C() {\n  const t = useTranslations("landing.hero");\n  return <p>{t("title")}</p>;\n}\n`, "Turn every tip", "title"],
    ["alias of t", "components/alias.tsx", `export function A() {\n  const t = useTranslations("landing.hero");\n  const tt = t;\n  return <p>{tt("title")}</p>;\n}\n`, "Turn every tip", "title"],
    ["t.rich", "components/rich.tsx", `export function R() {\n  const t = useTranslations("landing.hero");\n  return <p>{t.rich("rich", { b: (c) => <b>{c}</b> })}</p>;\n}\n`, "Hello world", "rich"],
    ["object-form getTranslations({ namespace })", "app/obj.tsx", `export async function O({ locale }) {\n  const t = await getTranslations({ locale, namespace: "landing.hero" });\n  return <p>{t("title")}</p>;\n}\n`, "Turn every tip", "title"],
    ["conditional translations", "components/cond.tsx", `export function K({ ok }) {\n  const t = useTranslations("landing.hero");\n  return <p>{ok ? t("support_1") : t("support_2")}</p>;\n}\n`, "No fees", "support_1"],
    ["config array of t() values", "components/arr.tsx", `export function L() {\n  const t = useTranslations("landing.hero");\n  const items = [{ label: t("support_1") }, { label: t("support_2") }];\n  return <ul>{items.map((i) => <li>{i.label}</li>)}</ul>;\n}\n`, "Fast", "support_2"],
    ["nested namespace, `ns.key` in the key", "components/full.tsx", `export function F() {\n  const t = useTranslations();\n  return <p>{t("landing.hero.title")}</p>;\n}\n`, "Turn every tip", "title"],
    ["t received as a prop", "components/prop.tsx", `export function P({ t }) {\n  return <p>{t("title")}</p>;\n}\n`, "Turn every tip", "title"],
    ["dynamic template key", "components/dyn.tsx", `export function D({ mode }) {\n  const ta = useTranslations("landing.access");\n  return <a>{ta(\`\${mode}.cta\`)}</a>;\n}\n`, "Join waitlist", "gated.cta"],
  ];
  for (const [name, rel, code, text, key] of cases) {
    it(`${name}: resolves owning file + json path, editable without source rewrite`, async () => {
      put(rel, code);
      const svc = setup();
      const cands = await inspect(svc, rel, text);
      const c = cands.find((x) => x.translation?.canEditTranslation && x.translation.hits[0].jsonPath.endsWith(key));
      expect(c, JSON.stringify(cands.map((x) => [x.key, x.translation?.code]))).toBeTruthy();
      const h = c.translation.hits[0];
      expect(h.locales.map((l: any) => l.status)).toEqual(["found", "found"]);
      expect(Object.keys(h.values).sort()).toEqual(["en", "th"]);
      expect(h.locales[0].file).toMatch(/^messages\/(en|th)\/landing\.json$/);
      expect(c.translation.canRewriteSource).toBe(false);
    });
  }

  it("namespace ≠ filename: landing.hero lives in landing.json at hero.body", async () => {
    put("app/hero.tsx", cases[0][2]);
    const svc = setup();
    const c = tr(await inspect(svc, "app/hero.tsx", "A plain statement."), "hero.body");
    expect(c.translation.hits[0]).toMatchObject({ namespace: "landing", key: "hero.body", jsonPath: "hero.body", workspaceId: "app" });
    expect(c.confidence).toBe("exact");
  });

  it("a runtime/on-screen mismatch lowers source confidence but never blocks a verified edit", async () => {
    put("components/c.tsx", cases[1][2]);
    const c = tr(await inspect(setup(), "components/c.tsx", "Something else entirely"), "hero.title");
    expect(c.confidence).toBe("low");
    expect(c.translation).toMatchObject({ lookup: "verified", runtimeMatch: "mismatch", code: "RUNTIME_FILE_MAPPING_MISMATCH", canEditTranslation: true });
  });

  it("names the failing stage: missing key vs missing file vs unresolved", async () => {
    put("components/m.tsx", `export function M() {\n  const t = useTranslations("landing.hero");\n  const n = useTranslations("ghost.ns");\n  return <div><p>{t("nope")}</p><p>{n("x")}</p></div>;\n}\n`);
    const cands = await inspect(setup(), "components/m.tsx", "");
    const codes = cands.map((c) => c.translation?.code);
    expect(codes).toContain("TRANSLATION_KEY_NOT_FOUND");
    expect(codes).toContain("LOCALE_FILE_NOT_FOUND");
    expect(cands.every((c) => c.translation.canEditTranslation === false)).toBe(true);
    put("components/d.tsx", `export function D({ k }) {\n  const t = useTranslations("landing.hero");\n  return <p>{t(k)}</p>;\n}\n`);
    expect((await inspect(setup(), "components/d.tsx", ""))[0].translation.code).toBe("TRANSLATION_REFERENCE_UNRESOLVED");
  });

  it("ambiguous ownership (same path in two workspaces) is reported, never auto-editable", async () => {
    put("components/c.tsx", cases[1][2]);
    put("extra/en/landing.json", json(EN)); put("extra/th/landing.json", json(TH));
    const svc = setup([{ id: "app", root: "messages", pattern: "{locale}/{ns}.json" }, { id: "extra", root: "extra", pattern: "{locale}/{ns}.json" }]);
    const c = tr(await inspect(svc, "components/c.tsx", "Turn every tip"), "hero.title") ?? (await inspect(svc, "components/c.tsx", "Turn every tip"))[0];
    expect(c.translation).toMatchObject({ lookup: "ambiguous", code: "TRANSLATION_FILE_AMBIGUOUS", canEditTranslation: false });
    expect(c.translation.hits.map((h: any) => h.workspaceId).sort()).toEqual(["app", "extra"]);
    const rep = await svc.translationReport();
    expect(rep.ambiguous.map((a) => a.logical)).toContain("landing.hero.title");
  });

  it("single-file-per-locale layout (namespaces nested under top-level keys)", async () => {
    fs.rmSync(path.join(root, "messages"), { recursive: true, force: true });
    put("m/en.json", json({ landing: EN })); put("m/th.json", json({ landing: TH }));
    put("app/hero.tsx", cases[0][2]);
    const svc = new AgentService(root, ConfigSchema.parse({ workspaces: [{ id: "one", root: "m", pattern: "{locale}.json", nsInKey: true }], provider: "next-intl", framework: "next-app", sourceRoots: ["app"] }), new Logger("t"));
    const c = tr(await inspect(svc, "app/hero.tsx", "A plain statement."), "hero.body");
    expect(c.translation.hits[0]).toMatchObject({ namespace: "landing", key: "hero.body", workspaceId: "one" });
    expect(c.translation.canEditTranslation).toBe(true);
  });

  it("end to end: inspect → resolve → edit → preview diff → save → verify, JSX untouched", async () => {
    put("app/hero.tsx", cases[0][2]);
    const svc = setup();
    const before = sha256(read("app/hero.tsx"));
    const h = tr(await inspect(svc, "app/hero.tsx", "A plain statement."), "hero.body").translation.hits[0];
    const pv = await svc.preview({ mode: "edit", workspaceId: h.workspaceId, namespace: h.namespace, key: h.key, values: { ...h.values, en: "Edited body." }, allowOverwrite: false });
    expect(pv.changes.map((c) => c.file)).toEqual(["messages/en/landing.json"]);
    expect(pv.changes[0].diff).toContain("+    \"body\": \"Edited body.\"");
    const res = await svc.commit(pv.operationId);
    expect(res.verified).toBe(true);
    expect(JSON.parse(read("messages/en/landing.json")).hero.body).toBe("Edited body.");
    expect(JSON.parse(read("messages/en/landing.json")).hero.title).toBe("Turn every tip");
    expect(sha256(read("app/hero.tsx"))).toBe(before);
    // verify: the same reference now resolves to the new value
    expect((await svc.resolveRef("landing.hero", "body")).hits[0].values.en).toBe("Edited body.");
  });

  it("other pages are unaffected by resolving one (no cross-file state)", async () => {
    put("app/hero.tsx", cases[0][2]); put("components/c.tsx", cases[1][2]); put("components/cond.tsx", cases[5][2]);
    const svc = setup();
    for (const [rel, text, key] of [["app/hero.tsx", "A plain statement.", "hero.body"], ["components/c.tsx", "Turn every tip", "hero.title"], ["components/cond.tsx", "Fast", "hero.support_2"]] as const)
      expect(tr(await inspect(svc, rel, text), key).translation.canEditTranslation).toBe(true);
  });

  it("doctor report: missing keys, structure, locale gaps — read-only", async () => {
    put("components/m.tsx", `export function M() {\n  const t = useTranslations("landing.hero");\n  return <p>{t("nope")}</p>;\n}\n`);
    put("messages/en/broken.json", "{ not json");
    put("messages/th/broken.json", "{}");
    const svc = setup();
    const snapshot = ["messages/en/landing.json", "components/m.tsx"].map(read);
    const rep = await svc.translationReport();
    expect(rep.missingKeys).toEqual([expect.objectContaining({ namespace: "landing.hero", key: "nope" })]);
    expect(rep.workspaces[0].invalid).toEqual(["messages/en/broken.json"]);
    expect(rep.provider).toBe("next-intl");
    expect(["messages/en/landing.json", "components/m.tsx"].map(read)).toEqual(snapshot);
  });
});

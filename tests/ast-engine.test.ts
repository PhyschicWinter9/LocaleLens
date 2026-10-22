import { describe, expect, it } from "vitest";
import { extract, instrument, load, enumerateCandidates, DEFAULT_ENUM, fingerprint, fileIdOf } from "@localelens/ast-engine";
import { i18nextAdapter } from "@localelens/adapter-i18next";
import { nextIntlAdapter } from "@localelens/adapter-next-intl";
import { LlError } from "@localelens/core";

const run = (code: string, n = 0, id = "0", o: Partial<Parameters<typeof extract>[0]> = {}) => {
  const f = load(code, "a.tsx");
  return extract({
    code, filename: "a.tsx", n, fp: fingerprint(f.elements[n].node, code), candidateId: id,
    key: "welcomeBack", namespace: "dashboard", adapter: i18nextAdapter, isServerComponent: false, enumOpts: DEFAULT_ENUM, ...o,
  });
};
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as LlError; } throw new Error("expected throw"); };

describe("instrument", () => {
  const src = `export function A() {\n  return <div><h1>Hello</h1><img alt="Logo" /><p>{count}</p></div>;\n}\n`;
  it("tags only elements that own text, with stable ids", () => {
    const r = instrument(src, "A.tsx", "src/A.tsx")!;
    const id = fileIdOf("src/A.tsx");
    expect(r.count).toBe(2);
    expect(r.code).toContain(`<h1 data-ll="${id}:1:`);
    expect(r.code).toContain(`<img data-ll="${id}:2:`);
    expect(r.code).not.toContain("<p data-ll");
    expect(instrument(r.code, "A.tsx", "src/A.tsx")).toBeNull(); // idempotent
  });
  it("ignores unparsable and node_modules files", () => {
    expect(instrument("<<<", "A.tsx", "A.tsx")).toBeNull();
    expect(instrument(src, "/x/node_modules/p/A.tsx", "A.tsx")).toBeNull();
  });
  it("gives duplicate strings distinct identities", () => {
    const r = instrument(`const A=()=> <div><b>Same</b><b>Same</b></div>;`, "A.jsx", "A.jsx")!;
    const ids = [...r.code.matchAll(/data-ll="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("candidates", () => {
  const cands = (code: string, n = 0) => enumerateCandidates(load(code, "a.tsx").elements[n], code, DEFAULT_ENUM);
  it("handles static, dynamic, conditional, attr, existing t()", () => {
    expect(cands(`<h1>Welcome, {user.name}!</h1>`)[0]).toMatchObject({ kind: "dynamic-text", text: "Welcome, {name}!" });
    expect(cands(`<p>{ok ? "Yes" : "No"}</p>`).map((c) => c.text)).toEqual(["Yes", "No"]);
    expect(cands(`<input placeholder="Email" title={"T"} />`).map((c) => [c.attr, c.kind])).toEqual([["placeholder", "attribute"], ["title", "string-expression"]]);
    const c = cands(`function X(){ const {t}=useTranslation("ns"); return <p>{t("a.b")}</p>; }`, 0)[0];
    expect(c).toMatchObject({ kind: "i18n-call", key: "a.b", namespace: "ns" });
  });
  it("marks complex expressions unsupported with a reason", () => {
    const c = cands(`<p>Total {fmt(a)} due</p>`)[0];
    expect(c.canExtract).toBe(false);
    expect(c.reason).toMatch(/variable/);
  });
  it("looks through fragments", () => {
    expect(cands(`<div><>Hi there</></div>`)[0].text).toBe("Hi there");
  });
});

describe("extract (i18next)", () => {
  it("adds import + hook + call (spec example)", () => {
    const r = run(`export function Dashboard() {\n  return <h1>Welcome back!</h1>;\n}\n`);
    expect(r.code).toBe(
      `import { useTranslation } from "react-i18next";\n\nexport function Dashboard() {\n  const { t } = useTranslation("dashboard");\n\n  return <h1>{t("welcomeBack")}</h1>;\n}\n`,
    );
    expect(r.template).toBe("Welcome back!");
  });
  it("preserves interpolation semantics", () => {
    const r = run(`export function D({user}) {\n  return <h1>Welcome, {user.name}!</h1>;\n}\n`, 0, "0", { key: "welcomeUser" });
    expect(r.code).toContain(`<h1>{t("welcomeUser", { name: user.name })}</h1>`);
    expect(r.template).toBe("Welcome, {{name}}!");
    expect(r.vars).toEqual(["name"]);
  });
  it("converts attributes", () => {
    const r = run(`function F(){ return <input placeholder="Email" />; }`, 0, "0", { key: "email" });
    expect(r.code).toContain(`<input placeholder={t("email")} />`);
  });
  it("reuses existing hook, aliases and imports (no duplicates)", () => {
    const src = `import { useTranslation as useT, Trans } from "react-i18next";\nfunction P(){\n  const { t: tr } = useT("dashboard");\n  return <b>Save</b>;\n}\n`;
    const r = run(src, 0, "0", { key: "save" });
    expect(r.code).toContain(`<b>{tr("save")}</b>`);
    expect(r.code.match(/useT\(/g)!.length).toBe(1);
    expect(r.code.match(/import /g)!.length).toBe(1);
  });
  it("adds specifier to existing import without duplicating it", () => {
    const r = run(`import { Trans } from 'react-i18next';\nfunction P(){ return <b>Save</b>; }\n`, 0, "0", { key: "save" });
    expect(r.code).toContain(`import { Trans, useTranslation } from 'react-i18next';`);
  });
  it("uses ns-qualified key when an in-scope t has another namespace", () => {
    const r = run(`function P(){ const {t}=useTranslation("common"); return <b>Save</b>; }`, 0, "0", { key: "save" });
    expect(r.code).toContain(`t("dashboard:save")`);
  });
  it("hook goes in the component, not in a map callback", () => {
    const r = run(`function L({items}){ return <ul>{items.map(i => <li key={i}>Item</li>)}</ul>; }`, 1, "0", { key: "item" });
    expect(r.code.indexOf("useTranslation(")).toBeLessThan(r.code.indexOf("items.map"));
  });
  it("handles expression-bodied arrow components", () => {
    const r = run(`export const Card = () => (\n  <p>Hi</p>\n);\n`, 0, "0", { key: "hi" });
    expect(r.code).toContain(`const { t } = useTranslation("dashboard");`);
    expect(r.code).toMatch(/return \(\n\s*<p>\{t\("hi"\)\}<\/p>\n\);\n\}/);
    expect(() => load(r.code, "a.tsx")).not.toThrow();
  });
  it("respects use client directive position and CRLF", () => {
    const r = run(`"use client";\r\nfunction P(){\r\n  return <b>Save</b>;\r\n}\r\n`, 0, "0", { key: "save" });
    expect(r.code.startsWith(`"use client";\r\n\r\nimport { useTranslation }`)).toBe(true);
    expect(r.code.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
  it("picks a non-colliding name when t is already a variable", () => {
    const r = run(`function P(){ const t = 5; return <b>Save {t}</b>; }`, 0, "0", { key: "save" });
    expect(r.code).toContain(`t2("save"`);
  });
  it("avoids duplicate vars for same expression", () => {
    const r = run(`function P({a}){ return <b>{a.x} and {a.x}</b>; }`, 0, "0", { key: "k" });
    expect(r.template).toBe("{{x}} and {{x}}");
    expect(r.vars).toEqual(["x"]);
  });
});

describe("extract safety", () => {
  it("rejects hooks in invalid contexts", () => {
    expect(err(() => run(`const x = <b>Hi</b>;`)).code).toBe("HOOK_CONTEXT_INVALID");
    expect(err(() => run(`function renderRow(){ return <b>Hi</b>; }`)).code).toBe("HOOK_CONTEXT_INVALID");
    expect(err(() => run(`class C extends React.Component { render(){ return <b>Hi</b>; } }`)).code).toBe("HOOK_CONTEXT_INVALID");
  });
  it("rejects stale fingerprints", () => {
    const code = `function P(){ return <b>Hi</b>; }`;
    expect(err(() => run(code, 0, "0", { fp: "00000000" })).code).toBe("SOURCE_STALE");
  });
  it("rejects unsupported expressions and already-translated text", () => {
    expect(err(() => run(`function P(){ return <b>A {f(x)} B</b>; }`)).code).toBe("SOURCE_UNSUPPORTED");
    expect(err(() => run(`function P(){ const {t}=useTranslation(); return <b>{t("a")}</b>; }`)).code).toBe("SOURCE_UNSUPPORTED");
  });
  it("i18next server component is refused with explanation", () => {
    const e = err(() => run(`export default function P(){ return <b>Hi</b>; }`, 0, "0", { isServerComponent: true }));
    expect(e.code).toBe("SERVER_COMPONENT_UNSUPPORTED");
  });
});

describe("extract (next-intl)", () => {
  it("client component", () => {
    const r = run(`"use client";\nexport default function P(){\n  return <b>Hi</b>;\n}\n`, 0, "0", { adapter: nextIntlAdapter, key: "hi", isServerComponent: true });
    expect(r.code).toContain(`import { useTranslations } from "next-intl";`);
    expect(r.code).toContain(`const t = useTranslations("dashboard");`);
  });
  it("server component becomes async with getTranslations", () => {
    const r = run(`export default function P(){\n  return <b>Hello {name}</b>;\n}\n`, 0, "0", { adapter: nextIntlAdapter, key: "hi", isServerComponent: true });
    expect(r.code).toContain(`export default async function P()`);
    expect(r.code).toContain(`import { getTranslations } from "next-intl/server";`);
    expect(r.code).toContain(`const t = await getTranslations("dashboard");`);
    expect(r.template).toBe("Hello {name}");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detect, patchViteConfig, parseArgs } from "@localelens/cli";

const BIN = path.resolve(import.meta.dirname, "../packages/cli/dist/bin.js");
let root: string;
const put = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args, "--cwd", root], { encoding: "utf8" });
const pkg = (deps: Record<string, string>) => put("package.json", JSON.stringify({ name: "x", dependencies: deps }));

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-cli-")); });

describe("detect", () => {
  it("vite + react-i18next + multi-root", () => {
    pkg({ react: "^19.0.0", vite: "^6.0.0", "react-i18next": "^15.0.0", typescript: "5" });
    put("src/locales/en/common.json", "{}"); put("src/locales/th/common.json", "{}");
    put("src/features/auth/locales/en.json", "{}"); put("src/features/auth/locales/th.json", "{}");
    put("src/i18n.ts", `i18n.init({ defaultNS: "common" })`);
    const d = detect(root);
    expect(d).toMatchObject({ framework: "vite", provider: "i18next", language: "typescript", packageManager: "npm", reactVersion: "19.0.0" });
    expect(d.config.defaultNamespace).toBe("common");
    expect(d.config.workspaces.map((w) => [w.root, w.pattern, w.namespace])).toEqual([
      ["src/features/auth/locales", "{locale}.json", "auth"], ["src/locales", "{locale}/{ns}.json", undefined],
    ]);
  });
  it("next routers: pages / app / hybrid", () => {
    pkg({ next: "16.0.0", react: "19" });
    fs.mkdirSync(path.join(root, "pages")); expect(detect(root).framework).toBe("next-pages");
    fs.mkdirSync(path.join(root, "src/app"), { recursive: true }); expect(detect(root).framework).toBe("next-hybrid");
    fs.rmSync(path.join(root, "pages"), { recursive: true }); expect(detect(root).framework).toBe("next-app");
  });
  it("next-intl: messages/en.json holds namespaces as top-level keys", () => {
    pkg({ next: "16", "next-intl": "4" }); put("messages/en.json", "{}"); put("messages/th.json", "{}"); fs.mkdirSync(path.join(root, "app"));
    const d = detect(root);
    expect(d.provider).toBe("next-intl");
    expect(d.config.workspaces[0]).toMatchObject({ root: "messages", pattern: "{locale}.json", nsInKey: true });
  });
  it("next-i18next imports the hook from next-i18next", () => {
    pkg({ next: "16", "next-i18next": "15" }); put("public/locales/en/common.json", "{}"); fs.mkdirSync(path.join(root, "pages"));
    expect(detect(root).config.importSource).toBe("next-i18next");
  });
  it("reports when no locale folder exists instead of inventing one silently", () => {
    pkg({ react: "19", "react-i18next": "15" });
    expect(detect(root).notes.join(" ")).toMatch(/No locale folders/);
  });
  it("package manager from lockfile", () => { pkg({}); put("bun.lock", ""); expect(detect(root).packageManager).toBe("bun"); });
});

describe("patchViteConfig", () => {
  it("adds import + plugin to defineConfig({plugins})", () => {
    const out = patchViteConfig(`import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`, "vite.config.ts")!;
    expect(out).toBe(`import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport localelens from "@localelens/vite";\n\nexport default defineConfig({\n  plugins: [localelens(), react()],\n});\n`);
  });
  it("handles missing plugins, function form, empty array", () => {
    expect(patchViteConfig(`import { defineConfig } from "vite";\nexport default defineConfig({\n  server: { port: 1 },\n});\n`, "v.ts")).toContain("plugins: [localelens()],\n  server");
    expect(patchViteConfig(`import { defineConfig } from "vite";\nexport default defineConfig(({ mode }) => ({ plugins: [] }));\n`, "v.ts")).toContain("plugins: [localelens()]");
    expect(patchViteConfig(`export default { plugins: [a()] };\n`, "v.js")).toContain("[localelens(), a()]");
  });
  it("is idempotent and refuses what it cannot prove safe", () => {
    const once = patchViteConfig(`export default { plugins: [] };\n`, "v.js")!;
    expect(patchViteConfig(once, "v.js")).toBe(once);
    expect(patchViteConfig(`const c = {}; export default c;\n`, "v.js")).toBeNull();
    expect(patchViteConfig(`export default {{{`, "v.js")).toBeNull();
  });
});

describe("parseArgs", () => {
  it("flags, values, and passthrough command after --", () => {
    expect(parseArgs(["dev", "--port", "5000", "--", "npm", "run", "dev"])).toMatchObject({ _: ["dev", "npm", "run", "dev"], port: "5000" });
    expect(parseArgs(["init", "--dry-run", "--yes"])).toMatchObject({ _: ["init"], "dry-run": true, yes: true });
  });
});

describe("built CLI executable", () => {
  const setup = () => {
    pkg({ react: "19", vite: "6", "react-i18next": "15" });
    put("vite.config.ts", `import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });\n`);
    put("src/locales/en/common.json", `{\n  "hi": "Hello {{name}}"\n}\n`); put("src/locales/th/common.json", `{\n  "hi": "สวัสดี {{name}}"\n}\n`);
    put("src/App.tsx", `import { useTranslation } from "react-i18next";\nexport function App(){ const { t } = useTranslation(); return <div><h1>Plain</h1><p>{t("hi", { name: "x" })}</p><p>{t("nope")}</p></div>; }\n`);
  };
  it("--version/help works and unknown command fails", () => {
    expect(cli("help").stdout).toContain("localelens <command>");
    expect(cli("bogus").status).toBe(1);
  });
  it("init --dry-run changes nothing; init --yes applies, backs up, and is idempotent", () => {
    setup();
    const dry = cli("init", "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("localelens.config.json");
    expect(fs.existsSync(path.join(root, "localelens.config.json"))).toBe(false);
    expect(read("vite.config.ts")).not.toContain("localelens");

    const run = cli("init", "--yes");
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(read("localelens.config.json"))).toMatchObject({ framework: "vite", provider: "i18next", defaultNamespace: "common", sourceLocale: "en" });
    expect(read("vite.config.ts")).toContain("plugins: [localelens()]");
    expect(read(".gitignore")).toContain(".localelens/");
    expect(fs.readdirSync(path.join(root, ".localelens/backups/init")).some((f) => f.startsWith("vite.config.ts"))).toBe(true);

    const before = read("vite.config.ts");
    expect(cli("init", "--yes").stdout).toContain("Nothing to change");
    expect(read("vite.config.ts")).toBe(before);
  });
  it("doctor passes on a healthy project and fails with actionable output on broken JSON", () => {
    setup(); cli("init", "--yes");
    const good = cli("doctor");
    expect(good.status, good.stdout).toBe(0);
    expect(good.stdout).toContain("registers the LocaleLens plugin");
    put("src/locales/th/common.json", "{ broken");
    const bad = cli("doctor");
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("is not valid JSON");
  });
  it("scan and check find hardcoded text and missing keys; check exits non-zero", () => {
    setup(); cli("init", "--yes");
    const s = cli("scan", "--json");
    const j = JSON.parse(s.stdout);
    expect(j.hardcoded.map((h: any) => h.text)).toEqual(["Plain"]);
    expect(j.missingKeys.map((m: any) => m.key)).toEqual(["nope"]);
    const c = cli("check");
    expect(c.status).toBe(1);
    expect(c.stdout).toContain("missing key common:nope");
  });
  it("dev prints a token and writes a session file; agent answers; process exits cleanly", async () => {
    setup(); cli("init", "--yes");
    const { spawn } = await import("node:child_process");
    const p = spawn(process.execPath, [BIN, "dev", "--port", "0", "--cwd", root], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    const t0 = Date.now();
    while (!/Token\s+ll_/.test(buf) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100));
    const url = /URL\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(buf)![1];
    const token = /Token\s+(ll_\S+)/.exec(buf)![1];
    const r = await fetch(url + "/api/v1/status", { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, ".localelens/session.json"))).toBe(true);
    p.kill();
  });
});

describe("translator exchange via the built CLI", () => {
  it("export → translator edits in Excel → import --yes → undo", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const { unzipSync } = await import("fflate");
    pkg({ react: "19", vite: "6", "react-i18next": "15" });
    put("src/locales/en/common.json", `{\n  "hi": "Hello",\n  "bye": "Bye"\n}\n`);
    put("src/locales/th/common.json", `{\n  "hi": "สวัสดี"\n}\n`);
    put("src/App.tsx", "export const A = () => null;\n");
    expect(cli("init", "--yes").status).toBe(0);

    const out = path.join(root, "pkg.zip");
    const ex = cli("export", "--out", out);
    expect(ex.status, ex.stdout + ex.stderr).toBe(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(unzipSync(new Uint8Array(fs.readFileSync(out)))["translations.xlsx"] as any);
    const ws = wb.getWorksheet("Translations")!;
    const heads = (ws.getRow(1).values as any[]).map(String);
    for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(4).value === "bye") ws.getRow(r).getCell(heads.indexOf("th")).value = "ลาก่อน";
    const returned = path.join(root, "returned.xlsx");
    fs.writeFileSync(returned, new Uint8Array(await wb.xlsx.writeBuffer()));

    const imp = cli("import", returned, "--yes");
    expect(imp.status, imp.stdout + imp.stderr).toBe(0);
    expect(JSON.parse(read("src/locales/th/common.json"))).toEqual({ hi: "สวัสดี", bye: "ลาก่อน" });
    const id = /undo with: localelens undo (\S+)/.exec(imp.stdout)![1];
    expect(cli("undo", id).status).toBe(0);
    expect(JSON.parse(read("src/locales/th/common.json"))).toEqual({ hi: "สวัสดี" });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { patchNextConfig } from "@localelens/cli";

const BIN = path.resolve(import.meta.dirname, "../packages/cli/dist/bin.js");
let root: string;
const put = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args, "--cwd", root], { encoding: "utf8" });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-clin-")); });

describe("patchNextConfig", () => {
  it("wraps ESM default exports (identifier, HOC call, object) and adds the import", () => {
    expect(patchNextConfig("const nextConfig = {};\nexport default nextConfig;\n", "next.config.mjs")).toBe(
      'import { withLocaleLens } from "@localelens/next";\n\nconst nextConfig = {};\nexport default withLocaleLens(nextConfig);\n',
    );
    expect(patchNextConfig('import plugin from "next-intl/plugin";\nexport default plugin()({ reactStrictMode: true });\n', "next.config.ts"))
      .toContain("export default withLocaleLens(plugin()({ reactStrictMode: true }));");
    expect(patchNextConfig("export default {};\n", "next.config.js")).toContain("export default withLocaleLens({});");
  });
  it("wraps CommonJS module.exports", () => {
    const out = patchNextConfig('/** @type {import("next").NextConfig} */\nmodule.exports = { a: 1 };\n', "next.config.js")!;
    expect(out).toContain("module.exports = withLocaleLens({ a: 1 });");
    expect(out.startsWith('const { withLocaleLens } = require("@localelens/next");')).toBe(true);
  });
  it("is idempotent and refuses shapes it cannot prove safe", () => {
    const once = patchNextConfig("export default {};\n", "next.config.mjs")!;
    expect(patchNextConfig(once, "next.config.mjs")).toBe(once);
    expect(patchNextConfig("export default function config() { return {}; }\n", "next.config.mjs")).toBeNull();
    expect(patchNextConfig("const x = 1;\n", "next.config.mjs")).toBeNull();
  });
});

describe("init on a Next.js project", () => {
  it("patches next.config, detects app router + next-intl, and is idempotent", () => {
    put("package.json", JSON.stringify({ name: "x", dependencies: { next: "16.0.0", react: "19", "next-intl": "4" } }));
    put("next.config.mjs", "const nextConfig = {};\nexport default nextConfig;\n");
    put("messages/en.json", "{}"); put("messages/th.json", "{}"); put("app/page.tsx", "export default function P(){ return null; }\n");
    const r = cli("init", "--yes");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read("next.config.mjs")).toContain("export default withLocaleLens(nextConfig);");
    expect(JSON.parse(read("localelens.config.json"))).toMatchObject({ framework: "next-app", provider: "next-intl" });
    expect(r.stdout).toContain("@localelens/next");
    expect(cli("init", "--yes").stdout).toContain("Nothing to change");
  });
  it("creates next.config.mjs when none exists", () => {
    put("package.json", JSON.stringify({ name: "x", dependencies: { next: "16.0.0", react: "19", "react-i18next": "15" } }));
    put("pages/index.tsx", "export default function P(){ return null; }\n"); put("public/locales/en/common.json", "{}");
    expect(cli("init", "--yes").status).toBe(0);
    expect(read("next.config.mjs")).toBe('import { withLocaleLens } from "@localelens/next";\n\nexport default withLocaleLens({});\n');
  });
});

import fs from "node:fs";
import path from "node:path";
import { ConfigSchema, toPosix, type LocaleLensConfig } from "@localelens/core";

export interface Detection {
  root: string;
  packageManager: "bun" | "pnpm" | "yarn" | "npm";
  language: "typescript" | "javascript";
  framework: LocaleLensConfig["framework"];
  frameworkVersion?: string;
  reactVersion?: string;
  routers: { pages: boolean; app: boolean };
  provider: LocaleLensConfig["provider"] | null;
  importSource?: string;
  viteConfig?: string;
  nextConfig?: string;
  config: LocaleLensConfig;
  notes: string[];
}

const LOCALE_RE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".localelens", "coverage", ".turbo", ".vite", ".output", ".nuxt"]);
const LOCALE_DIRS = /^(locales?|messages|i18n|translations?|lang|languages)$/i;

const exists = (...p: string[]) => fs.existsSync(path.join(...p));
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const clean = (v?: string) => v?.replace(/^[\^~>=<\s]+/, "");

function walkDirs(root: string, depth: number, visit: (dir: string) => void) {
  const rec = (dir: string, d: number) => {
    if (!fs.existsSync(dir)) return;
    visit(dir);
    if (d >= depth) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.isSymbolicLink()) rec(path.join(dir, e.name), d + 1);
  };
  rec(root, 0);
}

function discoverWorkspaces(root: string, provider: string | null, notes: string[]): LocaleLensConfig["workspaces"] {
  const out: LocaleLensConfig["workspaces"] = [];
  const used = new Set<string>();
  walkDirs(root, 6, (dir) => {
    if (!LOCALE_DIRS.test(path.basename(dir)) && !dir.includes(`${path.sep}locales${path.sep}`)) return;
    if (!LOCALE_DIRS.test(path.basename(dir))) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const rel = toPosix(path.relative(root, dir));
    const localeDirs = entries.filter((e) => e.isDirectory() && LOCALE_RE.test(e.name) && fs.readdirSync(path.join(dir, e.name)).some((f) => /\.(json|jsonc)$/.test(f)));
    const localeFiles = entries.filter((e) => e.isFile() && /\.jsonc?$/.test(e.name) && LOCALE_RE.test(e.name.replace(/\.jsonc?$/, "")));
    const baseId = (rel.split("/").slice(-3, -1).filter((s) => !LOCALE_DIRS.test(s) && s !== "src").pop() ?? "app").replace(/[^\w-]/g, "-") || "app";
    let id = baseId; for (let i = 2; used.has(id); i++) id = baseId + i; used.add(id);
    const ext = (localeDirs[0] ? fs.readdirSync(path.join(dir, localeDirs[0].name)).find((f) => /\.jsonc?$/.test(f)) : localeFiles[0]?.name)?.match(/\.jsonc?$/)?.[0] ?? ".json";
    if (localeDirs.length) out.push({ id, root: rel, pattern: `{locale}/{ns}${ext}` });
    else if (localeFiles.length >= 1) {
      if (provider === "next-intl") out.push({ id, root: rel, pattern: `{locale}${ext}`, nsInKey: true });
      else out.push({ id, root: rel, pattern: `{locale}${ext}`, namespace: baseId === "app" ? "common" : baseId });
    }
  });
  // drop workspaces nested in another detected workspace root
  const filtered = out.filter((w) => !out.some((o) => o !== w && w.root.startsWith(o.root + "/")));
  if (!filtered.length) notes.push("No locale folders found. Create e.g. src/locales/en/common.json and re-run init.");
  return filtered;
}

function detectDefaultNs(root: string, sourceRoots: string[]): string | null {
  let found: string | null = null;
  let seen = 0;
  for (const sr of sourceRoots) walkDirs(path.join(root, sr), 4, (dir) => {
    if (found || seen > 400) return;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(tsx?|jsx?|mjs)$/.test(f) || ++seen > 400) continue;
      const m = /defaultNS\s*:\s*["']([\w.-]+)["']/.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      if (m) { found = m[1]; return; }
    }
  });
  return found;
}

export function detect(root: string): Detection {
  const notes: string[] = [];
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) throw new Error(`No package.json in ${root}. Run this from your project root.`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const packageManager = exists(root, "bun.lock") || exists(root, "bun.lockb") ? "bun" : exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : "npm";
  const language = exists(root, "tsconfig.json") || deps.typescript ? "typescript" : "javascript";

  const hasNext = !!deps.next;
  const pagesDir = exists(root, "pages") || exists(root, "src", "pages");
  const appDir = exists(root, "app") || exists(root, "src", "app");
  let framework: LocaleLensConfig["framework"] = deps.vite ? "vite" : "react";
  if (hasNext) framework = pagesDir && appDir ? "next-hybrid" : appDir ? "next-app" : "next-pages";
  if (!hasNext && !deps.vite && !deps.react) notes.push("No React, Vite or Next dependency found; LocaleLens targets React projects.");

  let provider: Detection["provider"] = null;
  let importSource: string | undefined;
  if (deps["next-intl"]) provider = "next-intl";
  else if (deps["next-i18next"]) { provider = "i18next"; importSource = "next-i18next"; }
  else if (deps["react-i18next"] || deps.i18next) provider = "i18next";
  else notes.push("No supported i18n library (react-i18next, next-i18next, next-intl) found; defaulting to react-i18next. Install it before extracting text.");

  const viteConfig = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find((f) => exists(root, f));
  const nextConfig = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"].find((f) => exists(root, f));

  const sourceRoots = ["src", "app", "pages", "components", "lib"].filter((d) => exists(root, d));
  if (!sourceRoots.length) { sourceRoots.push("src"); notes.push("No src/app/pages directory found."); }
  const workspaces = discoverWorkspaces(root, provider, notes);
  const locales = new Set<string>();
  for (const w of workspaces) {
    const dir = path.join(root, w.root);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const n = e.isFile() ? e.name.replace(/\.jsonc?$/, "") : e.name;
      if (LOCALE_RE.test(n)) locales.add(n);
    }
  }
  const sourceLocale = locales.has("en") ? "en" : [...locales][0] ?? "en";
  const defaultNs = detectDefaultNs(root, sourceRoots)
    ?? (workspaces.some((w) => w.pattern.includes("{ns}") && fs.existsSync(path.join(root, w.root, sourceLocale, "translation.json"))) ? "translation" : "common");

  const config = ConfigSchema.parse({
    framework, provider: provider ?? "i18next", defaultNamespace: defaultNs, sourceLocale, sourceRoots,
    workspaces: workspaces.length ? workspaces : [{ id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" }],
    devOrigins: [hasNext ? "http://localhost:3000" : "http://localhost:5173"],
    ...(importSource ? { importSource } : {}),
  });
  return {
    root, packageManager, language, framework, frameworkVersion: clean(hasNext ? deps.next : deps.vite), reactVersion: clean(deps.react),
    routers: { pages: pagesDir, app: appDir }, provider, importSource, viteConfig, nextConfig, config, notes,
  };
}

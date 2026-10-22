import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CONFIG_FILE } from "@localelens/core";

export interface LocaleLensNextOptions {
  /** Project root matching the agent root. Default: process.cwd(). */
  root?: string;
  enabled?: boolean;
}

const require_ = createRequire(import.meta.url);

function loaderPath(): string {
  // dist/loader.cjs sits next to dist/index.js; fall back to package resolution for src usage.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const p of [path.join(here, "loader.cjs"), path.join(here, "../dist/loader.cjs")]) if (fs.existsSync(p)) return p;
  return require_.resolve("@localelens/next/loader");
}

type Cfg = Record<string, any>;
type CfgInput = Cfg | ((phase: string, ctx: any) => Cfg | Promise<Cfg>);

const DEV_PHASE = "phase-development-server";

/**
 * Wrap next.config. Development server only: in `next build` / `next start` the config is returned untouched,
 * so production output contains no LocaleLens code or attributes.
 * Works for Turbopack (Next 16 default) and for `--webpack`.
 */
export function withLocaleLens(input: CfgInput = {}, options: LocaleLensNextOptions = {}): (phase: string, ctx: any) => Promise<Cfg> {
  return async (phase, ctx) => {
    const base = typeof input === "function" ? await input(phase, ctx) : input;
    const enabled = options.enabled ?? process.env.LOCALELENS !== "0";
    if (phase !== DEV_PHASE || !enabled) return base;

    const root = options.root ?? process.cwd();
    let hookNames: string[] = [], defaultNamespace = "common";
    try {
      const c = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
      hookNames = c.hookNames ?? [];
      defaultNamespace = c.defaultNamespace ?? defaultNamespace;
    } catch { /* agent reports a missing config */ }
    const loader = loaderPath();
    const loaderOptions = { root, hookNames, defaultNamespace };

    const turbopack = { ...(base.turbopack ?? {}) };
    const rules = { ...(turbopack.rules ?? {}) } as Record<string, unknown>;
    for (const ext of ["tsx", "jsx", "ts", "js"]) {
      const key = `*.${ext}`;
      const rule = { condition: { all: [{ not: "foreign" }, "development"] }, loaders: [{ loader, options: loaderOptions }] };
      const prev = rules[key];
      rules[key] = prev ? [...(Array.isArray(prev) ? prev : [prev]), rule] : rule;
    }
    turbopack.rules = rules;

    const userWebpack = base.webpack;
    return {
      ...base,
      turbopack,
      webpack(config: any, wctx: any) {
        const cfg = typeof userWebpack === "function" ? userWebpack(config, wctx) ?? config : config;
        cfg.module.rules.unshift({ test: /\.[jt]sx?$/, exclude: /node_modules/, enforce: "pre", use: [{ loader, options: loaderOptions }] });
        return cfg;
      },
    };
  };
}
export default withLocaleLens;

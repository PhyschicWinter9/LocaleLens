import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "vite";
import { instrument, DEFAULT_ENUM } from "@localelens/ast-engine";
import { CONFIG_FILE } from "@localelens/core";

export interface LocaleLensViteOptions {
  /** Force-disable (e.g. LOCALELENS=0). */
  enabled?: boolean;
  /** Project root that matches the agent's root. Defaults to Vite's root. */
  root?: string;
}

/** Dev-server only. `apply: "serve"` guarantees nothing is transformed in `vite build`. */
export function localelens(options: LocaleLensViteOptions = {}): Plugin {
  let root = options.root ?? process.cwd();
  let hookNames = new Set(DEFAULT_ENUM.hookNames);
  let defaultNamespace = DEFAULT_ENUM.defaultNamespace;
  const enabled = options.enabled ?? process.env.LOCALELENS !== "0";
  return {
    name: "localelens",
    apply: "serve",
    enforce: "pre",
    configResolved(cfg) {
      root = options.root ?? cfg.root;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
        for (const h of c.hookNames ?? []) hookNames.add(h);
        defaultNamespace = c.defaultNamespace ?? "common";
      } catch { /* agent reports missing config; instrumentation uses defaults */ }
    },
    transform(code, id) {
      if (!enabled) return null;
      const file = id.split("?")[0];
      if (!/\.[jt]sx?$/.test(file) || file.includes("/node_modules/") || file.includes("\\node_modules\\")) return null;
      const rel = path.relative(root, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
      const r = instrument(code, file, rel.split(path.sep).join("/"), { hookNames, defaultNamespace });
      return r ? { code: r.code, map: r.map } : null;
    },
  };
}
export default localelens;

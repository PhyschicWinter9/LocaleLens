import path from "node:path";
import { DEFAULT_ENUM, instrument } from "@localelens/ast-engine";

/**
 * Webpack-style loader. Runs unchanged under webpack and under Turbopack (loader-runner subset:
 * resourcePath, getOptions, async). Must never break the build: any failure returns the source untouched.
 */

const warned = new Set<string>();

function loader(this: any, source: string, map: unknown) {
  const done = this.async ? this.async() : null;
  const finish = (code: string, m: unknown) => (done ? done(null, code, m) : this.callback(null, code, m));
  try {
    const o = (this.getOptions ? this.getOptions() : this.query) ?? {};
    const root: string = o.root ?? process.cwd();
    const file: string = this.resourcePath;
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || /(^|\/)node_modules\//.test(rel)) return finish(source, map);
    const r = instrument(source, file, rel, {
      hookNames: new Set([...DEFAULT_ENUM.hookNames, ...(o.hookNames ?? [])]),
      defaultNamespace: o.defaultNamespace ?? DEFAULT_ENUM.defaultNamespace,
    });
    return r ? finish(r.code, r.map) : finish(source, map);
  } catch (e) {
    // Never break the build, but never fail silently either (once per file).
    if (!warned.has(this.resourcePath)) { warned.add(this.resourcePath); console.warn(`[localelens] could not instrument ${path.basename(this.resourcePath)}: ${(e as Error).message}. Text in this file will show "no source mapping".`); }
    return finish(source, map);
  }
}

module.exports = loader;

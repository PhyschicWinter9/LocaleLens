import fsp from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc, type FormattingOptions } from "jsonc-parser";
import { LlError, assertSegment, resolveInside, sha256, shortHash, toPosix, unifiedDiff, type I18nAdapter } from "@localelens/core";
import { normalizeEol, type PlannedFile } from "@localelens/file-writer";

export interface WorkspaceConfig {
  id: string;
  /** Project-relative root of this translation folder. */
  root: string;
  /** File pattern relative to root, tokens {locale} and {ns}. e.g. "{locale}/{ns}.json", "{locale}.json". */
  pattern: string;
  /** Used when pattern has no {ns}. */
  namespace?: string;
  /** Namespace is a top-level key inside the file (next-intl style single file per locale). */
  nsInKey?: boolean;
  nested?: boolean | "auto";
  writable?: boolean;
  /** Source globs routed to this workspace by default. */
  routes?: string[];
}
export interface ResolvedRef {
  workspaceId: string;
  /** File-level namespace and key inside it: exactly what `plan()` accepts. */
  namespace: string;
  key: string;
  jsonPath: string;
  values: Record<string, string>;
  locales: { locale: string; file: string; status: "found" | "no-file" | "missing-key" | "not-a-string" | "invalid-file"; value?: string }[];
  writable: boolean;
}
export interface LocaleFile { workspaceId: string; locale: string; namespace: string; rel: string; fileId: string }

const TOKEN = /\{(locale|ns)\}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function globToRe(g: string): RegExp {
  const src = escapeRe(g.replace(/\\/g, "/")).replace(/\\\*\\\*\/?/g, "(?:.*/)?").replace(/\\\*/g, "[^/]*");
  return new RegExp("^" + src + "$");
}

export function detectIndent(text: string): FormattingOptions {
  const m = /^\{\r?\n([ \t]+)"/.exec(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!m) return { insertSpaces: true, tabSize: 2, eol };
  return m[1][0] === "\t" ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: m[1].length, eol };
}

export function placeholdersOf(adapter: I18nAdapter, s: string): string[] {
  return [...new Set([...s.matchAll(new RegExp(adapter.placeholderRe.source, "g"))].map((m) => m[1]))].sort();
}

/** Accumulates chained edits across several keys so each sees the previous result; `before` is always the on-disk text. */
export type PlanState = Map<string, { before: string | null; after: string }>;

// ponytail: JSON/JSONC only (jsonc-parser path edits keep formatting). YAML needs a comment-preserving adapter (`yaml` Document API).
export class LocaleRegistry {
  constructor(private root: string, public workspaces: WorkspaceConfig[]) {
    const ids = new Set<string>();
    for (const w of workspaces) {
      if (ids.has(w.id)) throw new LlError("BAD_REQUEST", `Duplicate workspace id ${w.id}`);
      ids.add(w.id);
      resolveInside(root, w.root); // must stay inside project
      if (!/\{locale\}/.test(w.pattern)) throw new LlError("BAD_REQUEST", `Workspace ${w.id}: pattern needs {locale}`);
      if (w.pattern.includes("..")) throw new LlError("PATH_ESCAPE", `Workspace ${w.id}: bad pattern`);
    }
  }

  ws(id: string): WorkspaceConfig {
    const w = this.workspaces.find((x) => x.id === id);
    if (!w) throw new LlError("NOT_FOUND", `Unknown workspace ${id}`, undefined, 404);
    return w;
  }

  private fixedNs(w: WorkspaceConfig) { return w.namespace ?? "common"; }

  pathFor(w: WorkspaceConfig, locale: string, ns: string): { rel: string; abs: string } {
    assertSegment(locale, "locale");
    const hasNs = w.pattern.includes("{ns}");
    if (hasNs) assertSegment(ns, "namespace");
    const sub = w.pattern.replace(TOKEN, (_, t) => (t === "locale" ? locale : ns));
    const abs = resolveInside(this.root, w.root, sub);
    return { abs, rel: toPosix(path.relative(this.root, abs)) };
  }

  fileId(w: WorkspaceConfig, rel: string) { return shortHash(`${w.id}:${rel}`); }

  /** Discover existing locale files by walking the workspace root (bounded). */
  async discover(w: WorkspaceConfig): Promise<LocaleFile[]> {
    const rootAbs = resolveInside(this.root, w.root);
    const names = w.pattern.split("/");
    const re = new RegExp("^" + escapeRe(w.pattern).replace(/\\\{locale\\\}/g, "(?<locale>[\\w.-]+)").replace(/\\\{ns\\\}/g, "(?<ns>[\\w.-]+)") + "$");
    const out: LocaleFile[] = [];
    const maxDepth = names.length;
    const walk = async (dir: string, depth: number) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory() && depth < maxDepth) await walk(abs, depth + 1);
        else if (e.isFile()) {
          const sub = toPosix(path.relative(rootAbs, abs));
          const m = re.exec(sub);
          if (!m) continue;
          const rel = toPosix(path.relative(this.root, abs));
          out.push({ workspaceId: w.id, locale: m.groups!.locale, namespace: m.groups!.ns ?? this.fixedNs(w), rel, fileId: this.fileId(w, rel) });
        }
      }
    };
    await walk(rootAbs, 1);
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  async locales(w: WorkspaceConfig) { return [...new Set((await this.discover(w)).map((f) => f.locale))].sort(); }
  async namespaces(w: WorkspaceConfig) { return [...new Set((await this.discover(w)).map((f) => f.namespace))].sort(); }

  async read(w: WorkspaceConfig, locale: string, ns: string, overlay?: PlanState): Promise<{ rel: string; text: string | null; data: any }> {
    const { abs, rel } = this.pathFor(w, locale, ns);
    let text: string | null = null;
    if (overlay?.has(rel)) text = overlay.get(rel)!.after;
    else try { text = await fsp.readFile(abs, "utf8"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    let data: any = {};
    if (text !== null && text.trim()) {
      const errors: any[] = [];
      data = parseJsonc(text.replace(/^﻿/, ""), errors, { allowTrailingComma: true });
      if (errors.length) throw new LlError("PARSE_ERROR", `${rel} is not valid JSON`, { offset: errors[0].offset });
    }
    return { rel, text, data };
  }

  private isFlat(w: WorkspaceConfig, data: any): boolean {
    if (w.nested === true) return false;
    if (w.nested === false) return true;
    const top = w.nsInKey ? data : data;
    return top && typeof top === "object" && Object.keys(top).some((k) => k.includes("."));
  }

  private keyPath(w: WorkspaceConfig, ns: string, key: string, data: any): string[] {
    const body = w.nsInKey ? data?.[ns] : data;
    const base = this.isFlat(w, body) ? [key] : key.split(".");
    return w.nsInKey ? [ns, ...base] : base;
  }

  lookup(w: WorkspaceConfig, data: any, ns: string, key: string): { found: boolean; value?: string; shape?: "object" } {
    const p = this.keyPath(w, ns, key, data);
    let cur = data;
    for (const seg of p) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg]; else return { found: false };
    }
    if (typeof cur === "string") return { found: true, value: cur };
    return { found: true, shape: "object" };
  }

  /** Find (ns,key) across every workspace: used for collision detection and the Translations tab. */
  async findKey(ns: string, key: string, only?: string): Promise<{ workspaceId: string; values: Record<string, string> }[]> {
    const hits: { workspaceId: string; values: Record<string, string> }[] = [];
    for (const w of this.workspaces) {
      if (only && w.id !== only) continue;
      const values: Record<string, string> = {};
      for (const l of await this.locales(w)) {
        let r;
        try { r = await this.read(w, l, w.pattern.includes("{ns}") ? ns : this.fixedNs(w)); } catch { continue; }
        const v = this.lookup(w, r.data, ns, key);
        if (v.found && v.value !== undefined) values[l] = v.value;
      }
      if (Object.keys(values).length) hits.push({ workspaceId: w.id, values });
    }
    return hits;
  }

  /**
   * next-intl semantics: a namespace is a dotted path into the merged messages, so the logical path `landing.hero.body`
   * may live in `landing.json` as `hero.body`, in `landing.hero.json` as `body`, or at the root of a single file.
   * Returns every (workspace, file namespace, key) split where the entry exists, plus per-locale file status.
   * Never guesses: several hits are returned as-is for the caller to treat as ambiguous.
   */
  async resolveLogical(logical: string, only?: string): Promise<ResolvedRef[]> {
    const segs = logical.split(".").filter(Boolean);
    const hits: ResolvedRef[] = [];
    if (!segs.length) return hits;
    for (const w of this.workspaces) {
      if (only && w.id !== only) continue;
      const files = await this.discover(w);
      const locales = [...new Set(files.map((f) => f.locale))].sort();
      const hasNs = w.pattern.includes("{ns}");
      const splits: { ns: string; key: string }[] = [];
      if (!hasNs && !w.nsInKey) splits.push({ ns: this.fixedNs(w), key: logical });
      else for (let i = 1; i < segs.length; i++) splits.push({ ns: segs.slice(0, i).join("."), key: segs.slice(i).join(".") });
      for (const sp of splits) {
        const loc: ResolvedRef["locales"] = [];
        for (const l of locales) {
          const { rel } = this.pathFor(w, l, hasNs ? sp.ns : this.fixedNs(w));
          if (!files.some((f) => f.rel === rel)) { loc.push({ locale: l, file: rel, status: "no-file" }); continue; }
          try {
            const r = await this.read(w, l, hasNs ? sp.ns : this.fixedNs(w));
            const v = this.lookup(w, r.data, sp.ns, sp.key);
            loc.push(v.found && v.value !== undefined ? { locale: l, file: rel, status: "found", value: v.value } : { locale: l, file: rel, status: v.found ? "not-a-string" : "missing-key" });
          } catch { loc.push({ locale: l, file: rel, status: "invalid-file" }); }
        }
        if (!loc.some((x) => x.status === "found")) continue;
        const values = Object.fromEntries(loc.flatMap((x) => (x.value !== undefined ? [[x.locale, x.value]] : [])));
        hits.push({ workspaceId: w.id, namespace: sp.ns, key: sp.key, jsonPath: this.keyPath(w, sp.ns, sp.key, {}).join("."), values, locales: loc, writable: w.writable !== false });
      }
    }
    return hits;
  }

  /** Does any file the logical path could belong to exist at all? Separates LOCALE_FILE_NOT_FOUND from TRANSLATION_KEY_NOT_FOUND. */
  async anyFileFor(logical: string): Promise<boolean> {
    const segs = logical.split(".").filter(Boolean);
    for (const w of this.workspaces) {
      const files = await this.discover(w);
      if (!w.pattern.includes("{ns}")) { if (files.length) return true; continue; }
      for (let i = 1; i <= segs.length; i++) if (files.some((f) => f.namespace === segs.slice(0, i).join("."))) return true;
    }
    return false;
  }

  /**
   * Entries whose logical path ends with `suffix` and/or starts with `prefix` (dynamic keys, `t` received as a prop).
   * ponytail: reads every locale file per call; add an mtime-keyed cache for very large message sets.
   */
  async searchLogical(match: (logicalPath: string) => boolean, limit = 200): Promise<{ workspaceId: string; namespace: string; key: string; logical: string; values: Record<string, string> }[]> {
    const acc = new Map<string, { workspaceId: string; namespace: string; key: string; logical: string; values: Record<string, string> }>();
    for (const w of this.workspaces) {
      for (const fl of await this.discover(w)) {
        let data: any;
        try { data = (await this.read(w, fl.locale, fl.namespace)).data; } catch { continue; }
        const walk = (o: any, p: string[]) => {
          for (const [k, v] of Object.entries(o ?? {})) {
            if (acc.size >= limit) return;
            const pp = [...p, k];
            if (typeof v === "string") {
              const fileNs = w.nsInKey ? pp[0] : fl.namespace;
              const key = w.nsInKey ? pp.slice(1).join(".") : pp.join(".");
              const logical = w.pattern.includes("{ns}") ? `${fl.namespace}.${pp.join(".")}` : pp.join(".");
              if (!match(logical)) continue;
              const id = `${w.id}|${fileNs}|${key}`;
              const e = acc.get(id) ?? { workspaceId: w.id, namespace: fileNs, key, logical, values: {} };
              e.values[fl.locale] = v; acc.set(id, e);
            } else if (v && typeof v === "object") walk(v, pp);
          }
        };
        walk(data, []);
      }
    }
    return [...acc.values()];
  }

  /** Workspace to preselect for a source file: explicit route match, else nearest root, else first writable. */
  suggestWorkspace(sourceRel: string): WorkspaceConfig | undefined {
    const writable = this.workspaces.filter((w) => w.writable !== false);
    for (const w of writable) if (w.routes?.some((r) => globToRe(r).test(sourceRel))) return w;
    const score = (w: WorkspaceConfig) => {
      const a = w.root.split("/"), b = sourceRel.split("/");
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    return [...writable].sort((x, y) => score(y) - score(x))[0];
  }

  /**
   * Build file changes that set `key` in each given locale.
   * Never rewrites unrelated structure: edits go through jsonc-parser path edits.
   */
  async plan(opts: { workspaceId: string; namespace: string; key: string; values: Record<string, string>; allowOverwrite: boolean; reuseIfEqual?: string }, overlay?: PlanState): Promise<{ files: PlannedFile[]; created: Set<string>; warnings: string[] }> {
    const w = this.ws(opts.workspaceId);
    if (w.writable === false) throw new LlError("FORBIDDEN_ORIGIN", `Workspace ${w.id} is read-only`, undefined, 403);
    const ns = w.pattern.includes("{ns}") ? opts.namespace : this.fixedNs(w);
    if (w.pattern.includes("{ns}") === false && !w.nsInKey && opts.namespace !== this.fixedNs(w))
      throw new LlError("BAD_REQUEST", `Workspace ${w.id} holds only namespace "${this.fixedNs(w)}"`);
    const files: PlannedFile[] = [];
    const created = new Set<string>();
    const warnings: string[] = [];
    for (const [locale, value] of Object.entries(opts.values)) {
      const { rel, text, data } = await this.read(w, locale, ns, overlay);
      const trueBefore = overlay?.get(rel)?.before ?? text;
      const p = this.keyPath(w, opts.namespace, opts.key, data);
      const existing = this.lookup(w, data, opts.namespace, opts.key);
      if (existing.found && existing.shape === "object") throw new LlError("KEY_COLLISION", `"${opts.key}" is a group of keys in ${rel}; choose a different key.`, { file: rel });
      if (existing.found && existing.value !== value && !opts.allowOverwrite)
        throw new LlError("KEY_COLLISION", `"${opts.key}" already exists in ${rel} with a different value ("${existing.value}").`, { file: rel, existing: existing.value });
      // parent path must not be a string
      let cur = data;
      for (const seg of p.slice(0, -1)) {
        if (cur && typeof cur === "object" && seg in cur) {
          cur = cur[seg];
          if (typeof cur !== "object" || cur === null) throw new LlError("KEY_COLLISION", `Cannot nest "${opts.key}" under "${seg}" in ${rel}: it is a string.`, { file: rel });
        } else break;
      }
      if (existing.found && existing.value === value) continue;
      const base = text ?? "{}\n";
      const eol = base.includes("\r\n") ? "\r\n" : "\n";
      const fmt = text ? detectIndent(text) : { insertSpaces: true, tabSize: 2, eol };
      const bom = base.startsWith("﻿");
      const edits = modify(base.replace(/^﻿/, ""), p, value, { formattingOptions: fmt });
      let after = applyEdits(base.replace(/^﻿/, ""), edits);
      if (!after.endsWith("\n")) after += eol;
      after = (bom ? "﻿" : "") + normalizeEol(text, after);
      if (after === text) continue;
      // validate result parses and holds the value
      const errs: any[] = [];
      const reparsed = parseJsonc(after.replace(/^﻿/, ""), errs, { allowTrailingComma: true });
      const check = this.lookup(w, reparsed, opts.namespace, opts.key);
      if (errs.length || check.value !== value) throw new LlError("INTERNAL", `Generated invalid content for ${rel}; nothing written.`);
      if (trueBefore === null) created.add(rel);
      overlay?.set(rel, { before: trueBefore, after });
      files.push({ rel, before: trueBefore, after });
    }
    return { files, created, warnings };
  }
}

export function diffFor(f: PlannedFile): string {
  return unifiedDiff(f.before ?? "", f.after);
}

/** Placeholder consistency across locales (source locale defines the set unless `expected` is given). */
export function validatePlaceholders(adapter: I18nAdapter, values: Record<string, string>, expected?: string[]): string[] {
  const problems: string[] = [];
  const sets = Object.entries(values).map(([l, v]) => [l, placeholdersOf(adapter, v)] as const);
  const want = expected ? [...expected].sort() : sets[0]?.[1] ?? [];
  for (const [l, set] of sets) {
    const missing = want.filter((x) => !set.includes(x)), extra = set.filter((x) => !want.includes(x));
    if (missing.length || extra.length)
      problems.push(`${l}: ${[missing.length && `missing {${missing.join(", ")}}`, extra.length && `unexpected {${extra.join(", ")}}`].filter(Boolean).join("; ")}`);
  }
  return problems;
}
void sha256;

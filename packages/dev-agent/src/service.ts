import fsp from "node:fs/promises";
import path from "node:path";
import {
  LlError, Logger, randomId, shortHash, toPosix, unifiedDiff, resolveInside, isInside,
  type LocaleLensConfig, type TranslationInfo, type TranslationHit, type PreviewReq, type PreviewRes, type ResolveRes, type Candidate, type I18nAdapter,
} from "@localelens/core";
import { DEFAULT_ENUM, enumerateCandidates, extract, fileIdOf, findConfigDefs, fingerprint, load, normalizeWs, suggestKey, SUPPORTED_EXT, type EnumOpts, type RawCandidate } from "@localelens/ast-engine";
import { FileWriter, type PlannedFile } from "@localelens/file-writer";
import { LocaleRegistry, validatePlaceholders } from "@localelens/locale-registry";
import { createI18nextAdapter } from "@localelens/adapter-i18next";
import { nextIntlAdapter } from "@localelens/adapter-next-intl";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".localelens", "coverage", ".turbo", ".vite"]);
const OP_TTL_MS = 10 * 60_000;

interface Operation { plan: PlannedFile[]; expires: number; summary: { rel: string; kind: "source" | "locale" }[] }

export class AgentService {
  readonly registry: LocaleRegistry;
  readonly writer: FileWriter;
  readonly adapter: I18nAdapter;
  private enumOpts: EnumOpts;
  private fileIndex = new Map<string, string>(); // fileId -> rel
  private lastScan = 0;
  private ops = new Map<string, Operation>();
  lastWrite: { at: string; ok: boolean; transactionId?: string; error?: string } | null = null;

  constructor(readonly root: string, readonly cfg: LocaleLensConfig, readonly log: Logger) {
    this.registry = new LocaleRegistry(root, cfg.workspaces);
    this.writer = new FileWriter(root);
    this.adapter = cfg.provider === "next-intl" ? nextIntlAdapter : createI18nextAdapter(cfg.importSource);
    this.enumOpts = { hookNames: new Set([...DEFAULT_ENUM.hookNames, ...cfg.hookNames]), defaultNamespace: cfg.defaultNamespace };
  }

  // ---------------------------------------------------------------- source index
  async reindex(): Promise<number> {
    const t0 = Date.now();
    const next = new Map<string, string>();
    const walk = async (dir: string) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(abs); }
        else if (e.isFile() && SUPPORTED_EXT.test(e.name) && !/\.d\.ts$/.test(e.name)) next.set(fileIdOf(toPosix(path.relative(this.root, abs))), toPosix(path.relative(this.root, abs)));
      }
    };
    for (const r of this.cfg.sourceRoots) await walk(resolveInside(this.root, r));
    this.fileIndex = next;
    this.lastScan = Date.now();
    this.log.info("source.index.completed", { durationMs: Date.now() - t0, data: { files: next.size } });
    return next.size;
  }
  get indexedFiles() { return this.fileIndex.size; }

  private async relOf(fileId: string): Promise<string> {
    let rel = this.fileIndex.get(fileId);
    if (!rel && Date.now() - this.lastScan > 1000) { await this.reindex(); rel = this.fileIndex.get(fileId); }
    if (!rel) throw new LlError("NOT_FOUND", "Unknown source file id (not under sourceRoots). Reload the page after restarting the dev server.", undefined, 404);
    return rel;
  }

  private isServerFile(rel: string) {
    const fw = this.cfg.framework;
    return (fw === "next-app" || fw === "next-hybrid") && /(^|\/)app\//.test(rel);
  }

  // ---------------------------------------------------------------- resolve
  async resolve(req: { ref: { fileId: string; n: number; fp: string }; text: string; attr?: string }): Promise<ResolveRes> {
    const rel = await this.relOf(req.ref.fileId);
    const abs = resolveInside(this.root, rel);
    const code = await fsp.readFile(abs, "utf8");
    let file;
    try { file = load(code, rel); } catch (e) { throw new LlError("PARSE_ERROR", `${rel} does not parse: ${(e as Error).message.slice(0, 120)}`); }
    const el = file.elements[req.ref.n];
    if (!el) throw new LlError("SOURCE_STALE", "Element no longer exists; reload the page.", { file: rel }, 409);
    if (fingerprint(el.node, code) !== req.ref.fp) throw new LlError("SOURCE_STALE", "Source changed since this page was compiled; reload the page.", { file: rel }, 409);

    const text = normalizeWs(req.text);
    const raws = enumerateCandidates(el, code, this.enumOpts);
    const out: Candidate[] = [];
    for (const c of raws) {
      const base = await this.toCandidate(c, text);
      out.push(base);
    }
    // `x.label` defined in another file: keep only definitions whose value matches what is on screen
    for (const r of raws) {
      if (!r.lookupProp) continue;
      for (const d of await this.crossFileDefs(r.lookupProp, !!r.lookupAsKey, rel)) {
        const cand = await this.toCandidate({ ...d.c, id: `x${out.length}` }, text);
        if (cand.confidence !== "low") out.push({ ...cand, file: d.file, reason: `Defined in ${d.file}:${cand.line} (\`${r.lookupProp}\`), matched by on-screen text` });
      }
    }
    const attrWanted = req.attr;
    out.sort((a, b) => rank(b, attrWanted) - rank(a, attrWanted));
    const good = out.filter((c) => c.confidence !== "low" && (!attrWanted || c.attr === attrWanted));
    const ambiguous = good.length > 1;

    const ws = this.registry.suggestWorkspace(rel);
    const ns = this.suggestNamespace(ws, rel);
    const top = good[0] ?? out[0];
    const taken = async (k: string) => (await this.registry.findKey(ns, k)).length > 0;
    let suggestedKey: string | undefined;
    if (top && top.kind !== "i18n-call") {
      const used = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const k = suggestKey(top.template ?? top.text, (x) => used.has(x));
        if (!(await taken(k))) { suggestedKey = k; break; }
        used.add(k);
      }
    }
    let extractBlocked: string | undefined;
    if (this.isServerFile(rel) && !file.hasUseClient && this.adapter.id === "i18next")
      extractBlocked = "Server Component with react-i18next: automatic extraction unavailable (hooks cannot run on the server). Editing existing translations still works.";
    this.log.info("source.resolve.completed", { data: { file: rel, candidates: out.length, ambiguous } });
    return { file: rel, candidates: out, ambiguous, suggestedWorkspaceId: ws?.id, suggestedNamespace: ns, suggestedKey, extractBlocked };
  }

  /**
   * Config definitions of `prop` in every other source file. ponytail: re-reads files per click (no index);
   * add a mtime-keyed cache if sourceRoots reach thousands of files.
   */
  private async crossFileDefs(prop: string, asKey: boolean, except: string) {
    const out: { c: Omit<RawCandidate, "id">; file: string }[] = [];
    const re = new RegExp(`(^|[\\s{,"'])${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`);
    for (const rel of this.fileIndex.values()) {
      if (rel === except || out.length >= 100) continue;
      let code: string;
      try { code = await fsp.readFile(resolveInside(this.root, rel), "utf8"); } catch { continue; }
      if (!re.test(code)) continue;
      try { for (const c of findConfigDefs(code, rel, prop, asKey, this.enumOpts)) out.push({ c, file: rel }); } catch { /* unparsable file: skip */ }
    }
    return out;
  }

  private suggestNamespace(ws: ReturnType<LocaleRegistry["suggestWorkspace"]>, rel: string): string {
    if (ws && !ws.pattern.includes("{ns}") && !ws.nsInKey) return ws.namespace ?? "common";
    return this.cfg.defaultNamespace;
  }

  /** Logical lookup shared by resolve, scan, lookup and doctor. */
  async resolveRef(ns: string | undefined, key: string, nsExplicit = true, only?: string): Promise<{ hits: TranslationHit[]; logical: string }> {
    if (this.adapter.id === "next-intl") {
      const logical = nsExplicit && ns ? `${ns}.${key}` : key;
      return { hits: await this.registry.resolveLogical(logical, only), logical };
    }
    const n = ns ?? this.cfg.defaultNamespace;
    const hits = (await this.registry.findKey(n, key, only)).map((h) => this.hitOf(h, n, key));
    return { hits, logical: `${n}:${key}` };
  }
  private hitOf(h: { workspaceId: string; values: Record<string, string> }, namespace: string, key: string): TranslationHit {
    return { workspaceId: h.workspaceId, values: h.values, namespace, key, jsonPath: key, locales: Object.entries(h.values).map(([locale, value]) => ({ locale, file: "", status: "found", value })), writable: this.registry.ws(h.workspaceId).writable !== false };
  }

  /** Resolve an i18n-call to its owning file entries. Each failure carries the code of the stage that failed. */
  private async resolveTranslation(c: RawCandidate, text: string): Promise<TranslationInfo> {
    const provider = this.adapter.id;
    let hits: TranslationHit[] = [];
    let logical: string | undefined;
    let code: string | undefined;
    let message: string | undefined;
    if (c.key) {
      const r = await this.resolveRef(c.namespace, c.key, c.nsExplicit !== false);
      hits = r.hits; logical = r.logical;
      if (!hits.length) {
        const exists = provider === "next-intl" ? await this.registry.anyFileFor(logical) : (await Promise.all(this.registry.workspaces.map((w) => this.registry.namespaces(w)))).flat().includes(c.namespace ?? "");
        code = exists ? "TRANSLATION_KEY_NOT_FOUND" : "LOCALE_FILE_NOT_FOUND";
        message = exists ? `No locale file defines "${logical}"` : `No locale file found for "${logical}"`;
      }
    } else { code = "TRANSLATION_REFERENCE_UNRESOLVED"; message = c.reason; }

    // no static owner (props, dynamic keys): accept only entries whose value equals the on-screen text
    if (!hits.length && text && (c.viaParam || c.dynKey)) {
      const pre = c.dynKey?.prefix ?? "", suf = c.dynKey?.suffix ?? "";
      const want = normalizeWs(text);
      const found = await this.registry.searchLogical((p) => (c.key ? p === c.key || p.endsWith("." + c.key) : p.startsWith(pre) && p.endsWith(suf)));
      for (const e of found.filter((e) => Object.values(e.values).some((v) => normalizeWs(v) === want))) {
        // re-resolve for per-locale file status; next-intl logical paths round-trip through resolveLogical
        const full = provider === "next-intl" ? (await this.registry.resolveLogical(e.logical, e.workspaceId)).filter((h) => h.namespace === e.namespace && h.key === e.key) : [];
        hits.push(...(full.length ? full : [this.hitOf(e, e.namespace, e.key)]));
      }
      if (hits.length) { code = undefined; message = "Resolved by key and on-screen text (no static namespace)"; }
      else if (c.viaParam) { code = "NAMESPACE_UNRESOLVED"; message = "Translation function is a parameter: namespace unknown and no entry matches the on-screen text"; }
    }

    let runtimeMatch: TranslationInfo["runtimeMatch"] = "unknown";
    if (hits.length === 1 && text) {
        const asRe = (v: string) => new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\{[^}]*\\\}\\\}|\\\{[^}]*\\\}/g, ".+?") + "$");
      runtimeMatch = Object.values(hits[0].values).some((v) => asRe(normalizeWs(v)).test(text)) ? "match" : "mismatch";
      if (runtimeMatch === "mismatch") { code = "RUNTIME_FILE_MAPPING_MISMATCH"; message = "The resolved translation differs from the text on screen (rich text, runtime merge or another locale). Editing is still allowed."; }
    }
    if (hits.length > 1) { code = "TRANSLATION_FILE_AMBIGUOUS"; message = `${hits.length} locale entries define this reference; pick one`; }
    const lookup = hits.length === 1 ? "verified" : hits.length > 1 ? "ambiguous" : "unresolved";
    const canEdit = lookup === "verified" && hits[0].writable;
    if (lookup === "verified" && !hits[0].writable) { code = "TRANSLATION_EDIT_UNAVAILABLE"; message = "Workspace is read-only"; }
    this.log.info("translation.resolve", { correlationId: randomId(6), errorCode: code, data: { provider, logical, lookup, hits: hits.map((h) => `${h.workspaceId}:${h.namespace}:${h.jsonPath}`) } });
    return { provider, namespace: c.namespace, key: c.key, logicalPath: logical, lookup, runtimeMatch, hits, code, message, canEditTranslation: canEdit, canRewriteSource: false };
  }

  private async toCandidate(c: RawCandidate, text: string): Promise<Candidate> {
    const template = c.parts?.map((p) => ("text" in p ? p.text : this.adapter.placeholder(p.name))).join("");
    const vars = c.parts?.flatMap((p) => ("expr" in p ? [p.name] : []));
    let confidence: Candidate["confidence"] = "low";
    let values: Record<string, string> = {};
    let shown = c.text;
    let translation: TranslationInfo | undefined;
    if (c.kind === "i18n-call") {
      translation = await this.resolveTranslation(c, text);
      const only = translation.hits.length === 1 ? translation.hits[0] : undefined;
      values = only?.values ?? {};
      shown = values[this.cfg.sourceLocale] ?? Object.values(values)[0] ?? "";
      // translation lookup is independent of source confidence: an on-screen match raises it, a mismatch never blocks editing
      if (translation.runtimeMatch === "match") confidence = "exact";
    } else if (c.matcher?.test(text)) {
      confidence = c.parts?.some((p) => "expr" in p) ? "pattern" : "exact";
    }
    return {
      id: c.id, kind: c.kind, text: shown, attr: c.attr, key: c.key, namespace: c.namespace, line: c.line, column: c.column + 1,
      confidence, canExtract: c.canExtract, reason: translation?.message ?? c.reason, template, vars, values: c.kind === "i18n-call" ? values : undefined, translation,
    };
  }

  // ---------------------------------------------------------------- preview / commit / undo
  async preview(req: PreviewReq): Promise<PreviewRes> {
    const t0 = Date.now();
    const diagnostics: PreviewRes["diagnostics"] = [];
    const plan: PlannedFile[] = [];
    const summary: Operation["summary"] = [];
    let expectedVars: string[] | undefined;
    const ws = this.registry.ws(req.workspaceId);

    if (req.mode === "extract") {
      if (!req.source) throw new LlError("BAD_REQUEST", "extract needs a source selection");
      const rel = await this.relOf(req.source.ref.fileId);
      const code = await fsp.readFile(resolveInside(this.root, rel), "utf8");
      const r = extract({
        code, filename: rel, n: req.source.ref.n, fp: req.source.ref.fp, candidateId: req.source.candidateId,
        key: req.key, namespace: req.namespace, adapter: this.adapter, isServerComponent: this.isServerFile(rel), maybeServer: /^next-(app|hybrid)$/.test(this.cfg.framework) && !this.isServerFile(rel), enumOpts: this.enumOpts,
      });
      for (const d of r.diagnostics) diagnostics.push({ level: "warn", message: d });
      expectedVars = r.vars;
      plan.push({ rel, before: code, after: r.code });
      summary.push({ rel, kind: "source" });
      if (!(this.cfg.sourceLocale in req.values)) req.values[this.cfg.sourceLocale] = r.template;
    }

    const problems = validatePlaceholders(this.adapter, req.values, expectedVars);
    if (problems.length) throw new LlError("PLACEHOLDER_MISMATCH", `Placeholders differ between languages: ${problems.join(" | ")}`, { problems });

    const lp = await this.registry.plan({ workspaceId: ws.id, namespace: req.namespace, key: req.key, values: req.values, allowOverwrite: req.mode === "edit" || req.allowOverwrite });
    const created = lp.created;
    for (const f of lp.files) { plan.push(f); summary.push({ rel: f.rel, kind: "locale" }); }
    if (!lp.files.length && req.mode === "edit") diagnostics.push({ level: "info", message: "No translation values changed." });
    if (req.mode === "extract" && !lp.files.length) diagnostics.push({ level: "info", message: `Key "${req.key}" already exists with identical values; it will be reused.` });
    const dup = await this.registry.findKey(req.namespace, req.key);
    for (const h of dup) if (h.workspaceId !== ws.id) diagnostics.push({ level: "warn", message: `Key also exists in workspace "${h.workspaceId}" (shadowing risk).` });

    const opId = randomId(12);
    this.ops.set(opId, { plan, expires: Date.now() + OP_TTL_MS, summary });
    for (const [k, v] of this.ops) if (v.expires < Date.now()) this.ops.delete(k);
    this.log.info("changes.preview.completed", { operation: opId, durationMs: Date.now() - t0, data: { files: plan.length } });
    return {
      operationId: opId,
      expiresAt: new Date(Date.now() + OP_TTL_MS).toISOString(),
      diagnostics,
      changes: plan.map((f, i) => ({
        fileId: shortHash(f.rel), file: f.rel, kind: summary[i].kind, created: created.has(f.rel),
        diff: unifiedDiff(f.before ?? "", f.after),
      })),
    };
  }

  async commit(operationId: string) {
    const op = this.ops.get(operationId);
    if (!op || op.expires < Date.now()) { this.ops.delete(operationId); throw new LlError("OPERATION_EXPIRED", "Preview expired or unknown; preview again.", undefined, 410); }
    this.log.info("changes.commit.started", { operation: operationId });
    try {
      const j = await this.writer.commit(op.plan);
      this.ops.delete(operationId);
      // verify on disk
      const verified: { rel: string; ok: boolean }[] = [];
      for (const f of op.plan) verified.push({ rel: f.rel, ok: (await fsp.readFile(resolveInside(this.root, f.rel), "utf8")) === f.after });
      this.lastWrite = { at: new Date().toISOString(), ok: verified.every((v) => v.ok), transactionId: j.id };
      await this.reindex().catch(() => {});
      this.log.info("changes.commit.completed", { operation: operationId, data: { transactionId: j.id, files: verified.length } });
      return { transactionId: j.id, files: verified, verified: verified.every((v) => v.ok) };
    } catch (e) {
      this.lastWrite = { at: new Date().toISOString(), ok: false, error: (e as Error).message };
      this.log.error("changes.commit.failed", { operation: operationId, errorCode: (e as LlError).code, data: { message: (e as Error).message } });
      throw e;
    }
  }

  async undo(transactionId: string) {
    const j = await this.writer.undo(transactionId);
    await this.reindex().catch(() => {});
    this.log.info("changes.undo.completed", { data: { transactionId } });
    return { transactionId: j.id, state: j.state, files: j.files.map((f) => f.rel) };
  }

  async editorUrl(fileId: string, line: number) {
    const rel = await this.relOf(fileId);
    const abs = resolveInside(this.root, rel);
    if (!isInside(this.root, abs)) throw new LlError("PATH_ESCAPE", "outside project");
    return { url: `vscode://file/${abs.replace(/\\/g, "/")}:${Math.max(1, Math.floor(line))}` };
  }


  // ---------------------------------------------------------------- listing / scanning
  async listTranslations() {
    const entries: { workspaceId: string; namespace: string; key: string; values: Record<string, string>; missing: string[] }[] = [];
    for (const w of this.registry.workspaces) {
      const files = await this.registry.discover(w);
      const locales = [...new Set(files.map((x) => x.locale))].sort();
      const byNs = new Map<string, Map<string, Record<string, string>>>();
      for (const fl of files) {
        let data: any;
        try { data = (await this.registry.read(w, fl.locale, fl.namespace)).data; } catch { continue; }
        const flat: Record<string, string> = {};
        const walk = (o: any, p: string) => { for (const [k, v] of Object.entries(o ?? {})) { const kk = p ? p + "." + k : k; if (typeof v === "string") flat[kk] = v; else if (v && typeof v === "object") walk(v, kk); } };
        walk(w.nsInKey ? data?.[fl.namespace] : data, "");
        const m = byNs.get(fl.namespace) ?? new Map<string, Record<string, string>>();
        for (const [k, v] of Object.entries(flat)) m.set(k, { ...(m.get(k) ?? {}), [fl.locale]: v });
        byNs.set(fl.namespace, m);
      }
      for (const [ns, m] of byNs) for (const [key, values] of m) entries.push({ workspaceId: w.id, namespace: ns, key, values, missing: locales.filter((l) => !(l in values)) });
    }
    return { entries, locales: [...new Set(entries.flatMap((e) => Object.keys(e.values)))].sort() };
  }

  /** Walk all indexed source files: hardcoded text + i18n usages whose key is absent from every workspace. */
  async scan(limit = 500) {
    const hardcoded: { file: string; line: number; text: string; kind: string; attr?: string; canExtract: boolean; ref: { fileId: string; n: number; fp: string }; candidateId: string }[] = [];
    const missingKeys: { file: string; line: number; namespace: string; key: string }[] = [];
    const parseErrors: string[] = [];
    for (const [fileId, rel] of this.fileIndex) {
      let code: string, file;
      try { code = await fsp.readFile(resolveInside(this.root, rel), "utf8"); if (!code.includes("<")) continue; file = load(code, rel); }
      catch { parseErrors.push(rel); continue; }
      for (let n = 0; n < file.elements.length; n++) {
        const el = file.elements[n];
        const cands = enumerateCandidates(el, code, this.enumOpts);
        if (!cands.length) continue;
        const fp = fingerprint(el.node, code);
        for (const c of cands) {
          if (c.kind === "i18n-call") {
            if (c.key && c.namespace && hardcoded.length + missingKeys.length < limit * 2 && (await this.resolveRef(c.namespace, c.key, c.nsExplicit !== false)).hits.length === 0)
              missingKeys.push({ file: rel, line: c.line, namespace: c.namespace, key: c.key });
          } else if (hardcoded.length < limit) {
            hardcoded.push({ file: rel, line: c.line, text: this.templateOf(c), kind: c.kind, attr: c.attr, canExtract: c.canExtract, ref: { fileId, n, fp }, candidateId: c.id });
          }
        }
      }
    }
    return { hardcoded, missingKeys, parseErrors, truncated: hardcoded.length >= limit };
  }
  private templateOf(c: RawCandidate) { return c.parts?.map((p) => ("text" in p ? p.text : this.adapter.placeholder(p.name))).join("") ?? c.text; }

  /** Read-only translation health report for `localelens doctor --translations`. Never returns file contents beyond key paths. */
  async translationReport() {
    await this.reindex();
    const workspaces = await Promise.all(this.registry.workspaces.map(async (w) => {
      const files = await this.registry.discover(w);
      const invalid: string[] = [];
      for (const f of files) { try { await this.registry.read(w, f.locale, f.namespace); } catch { invalid.push(f.rel); } }
      return { id: w.id, root: w.root, pattern: w.pattern, locales: [...new Set(files.map((f) => f.locale))].sort(), namespaces: [...new Set(files.map((f) => f.namespace))].sort(), files: files.length, invalid };
    }));
    const entries = await this.registry.searchLogical(() => true, 100_000);
    const byLogical = new Map<string, Set<string>>();
    for (const e of entries) byLogical.set(e.logical, (byLogical.get(e.logical) ?? new Set()).add(e.workspaceId));
    const ambiguous = [...byLogical].filter(([, ws]) => ws.size > 1).map(([logical, ws]) => ({ logical, workspaces: [...ws] }));
    const localeGaps = entries.filter((e) => Object.keys(e.values).length < Math.max(...workspaces.map((w) => w.locales.length), 1)).map((e) => e.logical);
    const scan = await this.scan(500);
    return { provider: this.adapter.id, workspaces, ambiguous, missingKeys: scan.missingKeys, parseErrors: scan.parseErrors, localeGaps: [...new Set(localeGaps)] };
  }

  async workspacesInfo() {
    return Promise.all(this.registry.workspaces.map(async (w) => {
      const files = await this.registry.discover(w);
      return {
        id: w.id, root: w.root, pattern: w.pattern, writable: w.writable !== false, namespaces: [...new Set(files.map((f) => f.namespace))],
        locales: [...new Set(files.map((f) => f.locale))], files: files.map((f) => ({ fileId: f.fileId, file: f.rel, locale: f.locale, namespace: f.namespace })),
      };
    }));
  }

  async lookup(req: { workspaceId?: string; namespace?: string; key: string }) {
    const ns = req.namespace ?? this.cfg.defaultNamespace;
    return { namespace: ns, key: req.key, hits: (await this.resolveRef(req.namespace, req.key, req.namespace !== undefined, req.workspaceId)).hits };
  }

  async suggest(text: string, namespace?: string) {
    const ns = namespace ?? this.cfg.defaultNamespace;
    const used = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const k = suggestKey(text, (x) => used.has(x));
      if ((await this.registry.findKey(ns, k)).length === 0) return { key: k };
      used.add(k);
    }
    return { key: suggestKey(text) + shortHash(text, 4) };
  }
}

const rank = (c: Candidate, attr?: string) => (attr && c.attr === attr ? 4 : 0) + (c.confidence === "exact" ? 3 : c.confidence === "pattern" ? 2 : 0);

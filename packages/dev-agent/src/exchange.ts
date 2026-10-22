import { LlError, randomId, unifiedDiff, type PreviewRes } from "@localelens/core";
import { LocaleRegistry, placeholdersOf, type PlanState } from "@localelens/locale-registry";
import {
  buildPackage, buildWorkbook, entryId, mergeFingerprint, parseUpload, threeWayMerge, LIMITS,
  type MergeReport, type PackageManifest, type Resolution, type SnapshotEntry,
} from "@localelens/translation-excel";
import type { AgentService } from "./service.ts";

interface Held { rows: Awaited<ReturnType<typeof parseUpload>>["rows"]; manifest: PackageManifest | null; fingerprint: string; ids: string[]; expires: number }

export class Exchange {
  private held = new Map<string, Held>();
  constructor(private svc: AgentService) {}

  private async snapshot(filter?: { workspaceIds?: string[]; namespaces?: string[] }): Promise<SnapshotEntry[]> {
    const { entries } = await this.svc.listTranslations();
    return entries
      .filter((e) => (!filter?.workspaceIds?.length || filter.workspaceIds.includes(e.workspaceId)) && (!filter?.namespaces?.length || filter.namespaces.includes(e.namespace)))
      .map(({ workspaceId, namespace, key, values }) => ({ workspaceId, namespace, key, values }))
      .sort((a, b) => (a.workspaceId + a.namespace + a.key).localeCompare(b.workspaceId + b.namespace + b.key));
  }

  async export(opts: { workspaceIds?: string[]; namespaces?: string[]; locales?: string[]; format: "xlsx" | "zip" }) {
    const entries = await this.snapshot(opts);
    if (!entries.length) throw new LlError("NOT_FOUND", "Nothing to export for that selection");
    const src = this.svc.cfg.sourceLocale;
    const all = [...new Set(entries.flatMap((e) => Object.keys(e.values)))];
    const locales = [src, ...all.filter((l) => l !== src)].filter((l) => !opts.locales?.length || opts.locales.includes(l) || l === src);
    const manifest: PackageManifest = {
      format: "localelens-translation-package", version: 1, createdAt: new Date().toISOString(), project: require_basename(this.svc.root),
      sourceLocale: src, locales,
      entries: entries.map((e) => ({ ...e, id: entryId(e.workspaceId, e.namespace, e.key), values: Object.fromEntries(locales.map((l) => [l, e.values[l] ?? ""]).filter(([, v]) => v !== "")) })),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    const data = opts.format === "xlsx" ? await buildWorkbook(manifest) : await buildPackage(manifest);
    return { fileName: `translations-${stamp}.${opts.format}`, mime: opts.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/zip", data, count: entries.length };
  }

  private validator(current: Map<string, SnapshotEntry>, manifest: PackageManifest | null) {
    const src = this.svc.cfg.sourceLocale, adapter = this.svc.adapter;
    return (row: { workspaceId: string; namespace: string; key: string; values: Record<string, string> }, locale: string, value: string) => {
      const ws = this.svc.registry.workspaces.find((w) => w.id === row.workspaceId);
      if (!ws) return `Unknown workspace "${row.workspaceId}"`;
      if (ws.writable === false) return `Workspace "${row.workspaceId}" is read-only`;
      if (locale === src) return null;
      const id = entryId(row.workspaceId, row.namespace, row.key);
      const reference = row.values[src]?.trim() || current.get(id)?.values[src] || manifest?.entries.find((e) => e.id === id)?.values[src];
      if (!reference) return null;
      const want = placeholdersOf(adapter, reference), got = placeholdersOf(adapter, value);
      const missing = want.filter((x) => !got.includes(x)), extra = got.filter((x) => !want.includes(x));
      return missing.length || extra.length ? `placeholders differ from ${src}: ${[missing.length && `missing {${missing.join(", ")}}`, extra.length && `unexpected {${extra.join(", ")}}`].filter(Boolean).join("; ")}` : null;
    };
  }

  private async merge(held: { rows: Held["rows"]; manifest: PackageManifest | null }, resolutions?: Record<string, Resolution>) {
    const snap = await this.snapshot();
    const current = new Map(snap.map((e) => [entryId(e.workspaceId, e.namespace, e.key), e]));
    const report = threeWayMerge({ manifest: held.manifest, current, rows: held.rows, sourceLocale: this.svc.cfg.sourceLocale, validate: this.validator(current, held.manifest), resolutions });
    return { report, current };
  }

  private async buildPlan(report: MergeReport) {
    const groups = new Map<string, { workspaceId: string; namespace: string; key: string; values: Record<string, string> }>();
    for (const c of report.changes) {
      const g = groups.get(c.id) ?? { workspaceId: c.workspaceId, namespace: c.namespace, key: c.key, values: {} };
      g.values[c.locale] = c.to;
      groups.set(c.id, g);
    }
    const overlay: PlanState = new Map();
    for (const g of groups.values()) await this.svc.registry.plan({ ...g, allowOverwrite: true }, overlay);
    return [...overlay].map(([rel, v]) => ({ rel, before: v.before, after: v.after }));
  }

  async importPreview(bytes: Uint8Array) {
    const parsed = await parseUpload(bytes);
    const { report, current } = await this.merge(parsed);
    const ids = [...new Set([...report.changes.map((c) => c.id), ...report.conflicts.map((c) => c.id)])];
    const plan = await this.buildPlan(report);
    const importId = randomId(12);
    this.held.set(importId, { rows: parsed.rows, manifest: parsed.manifest, fingerprint: mergeFingerprint(current, ids), ids, expires: Date.now() + 15 * 60_000 });
    for (const [k, v] of this.held) if (v.expires < Date.now()) this.held.delete(k);
    return {
      importId, report, warnings: parsed.warnings, hasBase: !!parsed.manifest,
      changes: plan.map((f) => ({ file: f.rel, created: f.before === null, diff: unifiedDiff(f.before ?? "", f.after) })),
    } satisfies Record<string, unknown>;
  }

  async importCommit(importId: string, resolutions: Record<string, Resolution> = {}) {
    const held = this.held.get(importId);
    if (!held || held.expires < Date.now()) { this.held.delete(importId); throw new LlError("OPERATION_EXPIRED", "Import preview expired; preview again.", undefined, 410); }
    const { report, current } = await this.merge(held, resolutions);
    // everything the merge depends on must be as it was at preview time
    const ids = [...new Set([...held.ids, ...report.changes.map((c) => c.id)])];
    const now = mergeFingerprint(current, held.ids.slice());
    if (now !== held.fingerprint) throw new LlError("REVISION_CONFLICT", "Translations changed in the project after the preview. Preview the import again.", undefined, 409);
    const unresolved = report.conflicts;
    if (unresolved.length) throw new LlError("IMPORT_CONFLICT", `${unresolved.length} conflict(s) need a resolution (current / incoming / custom).`, { conflicts: unresolved.map((c) => c.conflictId) });
    if (!report.changes.length) { this.held.delete(importId); return { transactionId: null, files: [], applied: 0 }; }
    const plan = await this.buildPlan(report);
    const j = await this.svc.writer.commit(plan);
    this.held.delete(importId);
    await this.svc.reindex().catch(() => {});
    this.svc.log.info("import.commit.completed", { data: { transactionId: j.id, files: plan.length, applied: report.changes.length } });
    void ids;
    return { transactionId: j.id, files: plan.map((p) => p.rel), applied: report.changes.length };
  }
}

const require_basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? "project";
export { LIMITS };
export type { LocaleRegistry, PreviewRes };

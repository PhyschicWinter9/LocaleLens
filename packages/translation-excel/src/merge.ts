import { entryId, norm, type IncomingRow, type PackageManifest, type SnapshotEntry, type Values } from "./model.ts";

export interface MergeChange { id: string; workspaceId: string; namespace: string; key: string; locale: string; from: string | null; to: string; kind: "update" | "add-locale" | "new-key" }
export interface Conflict {
  conflictId: string; id: string; workspaceId: string; namespace: string; key: string; locale: string;
  base: string | null; current: string | null; incoming: string;
  reason: "both-changed" | "deleted-in-project" | "new-key-exists";
}
export interface MergeReport {
  changes: MergeChange[];
  conflicts: Conflict[];
  invalid: { id: string; key: string; locale: string; message: string }[];
  unchanged: number;
  alreadyApplied: number;
  ignored: { key: string; message: string }[];
  /** Keys present in the base but absent from the returned sheet (never deleted by import). */
  missingFromSheet: string[];
}

export type Resolution = "current" | "incoming" | { custom: string };

/**
 * Three-way merge per (entry, locale):
 *   base     = snapshot embedded at export
 *   current  = project now
 *   incoming = returned sheet
 * Never overwrites a value the project changed after export without an explicit resolution.
 */
export function threeWayMerge(opts: {
  manifest: PackageManifest | null;
  current: Map<string, SnapshotEntry>;
  rows: IncomingRow[];
  sourceLocale: string;
  validate: (row: IncomingRow, locale: string, value: string) => string | null;
  resolutions?: Record<string, Resolution>;
}): MergeReport {
  const base = new Map((opts.manifest?.entries ?? []).map((e) => [e.id, e]));
  const rep: MergeReport = { changes: [], conflicts: [], invalid: [], unchanged: 0, alreadyApplied: 0, ignored: [], missingFromSheet: [] };
  const rowIds = new Set<string>();

  for (const row of opts.rows) {
    const id = entryId(row.workspaceId, row.namespace, row.key);
    rowIds.add(id);
    const b = base.get(id);
    const cur = opts.current.get(id) ?? null;
    if (!b && !opts.manifest) rep.ignored.push({ key: row.key, message: "no base snapshot in file: treated as new/changed against current" });

    for (const [locale, rawIncoming] of Object.entries(row.values)) {
      const incoming = norm(rawIncoming);
      if (incoming === "") continue; // blank = translator did not translate; never erase
      const baseV = b ? (b.values[locale] ?? null) : null;
      const curV = cur ? (cur.values[locale] ?? null) : null;
      if (b && baseV !== null && norm(baseV) === incoming) { rep.unchanged++; continue; }
      if (curV !== null && norm(curV) === incoming) { rep.alreadyApplied++; continue; }

      const msg = opts.validate(row, locale, incoming);
      if (msg) { rep.invalid.push({ id, key: row.key, locale, message: msg }); continue; }

      const mk = (kind: MergeChange["kind"]): MergeChange => ({ id, workspaceId: row.workspaceId, namespace: row.namespace, key: row.key, locale, from: curV, to: rawIncoming, kind });
      const conflict = (reason: Conflict["reason"]) => {
        const conflictId = `${id}:${locale}`;
        const res = opts.resolutions?.[conflictId];
        if (res === "incoming") rep.changes.push(mk(cur ? "update" : "new-key"));
        else if (res && typeof res === "object") rep.changes.push({ ...mk(cur ? "update" : "new-key"), to: res.custom });
        else if (res === "current") rep.unchanged++;
        else rep.conflicts.push({ conflictId, id, workspaceId: row.workspaceId, namespace: row.namespace, key: row.key, locale, base: baseV, current: curV, incoming: rawIncoming, reason });
      };

      if (!b) { // new row from the translator
        if (!cur) rep.changes.push(mk("new-key"));
        else if (curV === null) rep.changes.push(mk("add-locale"));
        else conflict("new-key-exists");
        continue;
      }
      if (!cur) { conflict("deleted-in-project"); continue; }
      if (curV === null || (baseV !== null && norm(curV) === norm(baseV))) rep.changes.push(mk(curV === null ? "add-locale" : "update"));
      else conflict("both-changed");
    }
  }
  for (const [id, e] of base) if (!rowIds.has(id)) rep.missingFromSheet.push(e.key);
  return rep;
}

/** Stable digest of everything the merge decision depended on; commit refuses if the project moved after the preview. */
export function mergeFingerprint(current: Map<string, SnapshotEntry>, ids: string[]): string {
  return ids.sort().map((i) => `${i}=${JSON.stringify(current.get(i)?.values ?? null)}`).join("\n");
}
export type { Values };

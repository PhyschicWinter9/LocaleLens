import { shortHash } from "@localelens/core";

export type Values = Record<string, string>; // locale -> text

export interface SnapshotEntry { workspaceId: string; namespace: string; key: string; values: Values }
export const entryId = (workspaceId: string, namespace: string, key: string) => shortHash(`${workspaceId}\u0000${namespace}\u0000${key}`, 12);

export interface PackageManifest {
  format: "localelens-translation-package";
  version: 1;
  createdAt: string;
  project: string;
  sourceLocale: string;
  locales: string[];
  /** Base snapshot at export time: the left side of the three-way merge. */
  entries: (SnapshotEntry & { id: string })[];
}

export interface IncomingRow { id?: string; workspaceId: string; namespace: string; key: string; values: Values; rowNumber: number }

export const norm = (s: string | undefined) => (s ?? "").normalize("NFC").replace(/\r\n/g, "\n");

export function flatten(data: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data || typeof data !== "object") return out;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[full] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, full));
  }
  return out;
}

/** Added / removed / changed keys between two snapshots, with rename suggestions (same source text, different key). */
export function diffSnapshots(before: SnapshotEntry[], after: SnapshotEntry[], sourceLocale: string) {
  const id = (e: SnapshotEntry) => entryId(e.workspaceId, e.namespace, e.key);
  const b = new Map(before.map((e) => [id(e), e])), a = new Map(after.map((e) => [id(e), e]));
  const added = [...a].filter(([k]) => !b.has(k)).map(([, e]) => e);
  const removed = [...b].filter(([k]) => !a.has(k)).map(([, e]) => e);
  const changed: { entry: SnapshotEntry; locale: string; from: string; to: string }[] = [];
  for (const [k, e] of a) {
    const old = b.get(k);
    if (!old) continue;
    for (const [l, v] of Object.entries(e.values)) if (norm(old.values[l]) !== norm(v)) changed.push({ entry: e, locale: l, from: old.values[l] ?? "", to: v });
  }
  const renames: { from: SnapshotEntry; to: SnapshotEntry }[] = [];
  const used = new Set<SnapshotEntry>();
  for (const r of removed) {
    const t = added.find((x) => !used.has(x) && x.namespace === r.namespace && x.workspaceId === r.workspaceId && norm(x.values[sourceLocale]) !== "" && norm(x.values[sourceLocale]) === norm(r.values[sourceLocale]));
    if (t) { used.add(t); renames.push({ from: r, to: t }); }
  }
  return {
    added: added.filter((x) => !used.has(x)), removed: removed.filter((x) => !renames.some((r) => r.from === x)), changed, renames,
  };
}

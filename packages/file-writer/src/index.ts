import fsp from "node:fs/promises";
import path from "node:path";
import { LlError, sha256, randomId, resolveInside, toPosix } from "@localelens/core";

/**
 * Multi-file writes are NOT atomic across files. What this gives instead:
 *  - hash-checked preconditions (no silent overwrite of edits made after preview)
 *  - per-file atomic replace (temp file + rename)
 *  - a durable journal with pre-image backups, rollback on partial failure, and crash recovery
 *  - undo that refuses if files changed after the commit
 */

export interface PlannedFile {
  rel: string;                // project-relative, posix
  before: string | null;      // null => file must not exist
  after: string;
}
export interface FsLike {
  readFile(p: string, enc: "utf8"): Promise<string>;
  writeFile(p: string, data: string, enc: "utf8"): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  rm(p: string, o?: { force?: boolean }): Promise<void>;
  mkdir(p: string, o?: { recursive?: boolean }): Promise<unknown>;
}
export type TxState = "prepared" | "committing" | "committed" | "rolled-back" | "needs-recovery" | "undone";
export interface JournalFile { rel: string; existed: boolean; beforeHash: string | null; afterHash: string; backup: string | null }
export interface Journal { id: string; createdAt: string; state: TxState; files: JournalFile[]; error?: string }

export const normalizeEol = (before: string | null, after: string) =>
  before && before.includes("\r\n") ? after.replace(/\r?\n/g, "\r\n") : after;

export class FileWriter {
  // ponytail: in-process per-file locks; DevAgent enforces one agent per project. Add OS lock files if a second writer process is ever needed.
  private locks = new Map<string, Promise<void>>();
  readonly dir: string;
  constructor(private root: string, private fs: FsLike = fsp, stateDir = path.join(root, ".localelens")) {
    this.dir = stateDir;
  }

  private abs(rel: string) { return resolveInside(this.root, rel); }
  private jpath(id: string) { return path.join(this.dir, "journal", `${id}.json`); }
  private async saveJournal(j: Journal) {
    await this.fs.mkdir(path.dirname(this.jpath(j.id)), { recursive: true });
    await this.fs.writeFile(this.jpath(j.id), JSON.stringify(j, null, 2), "utf8");
  }
  async readJournal(id: string): Promise<Journal> {
    if (!/^[\w-]{6,64}$/.test(id)) throw new LlError("BAD_REQUEST", "Invalid transaction id");
    try { return JSON.parse(await this.fs.readFile(this.jpath(id), "utf8")); }
    catch { throw new LlError("NOT_FOUND", "Unknown transaction", undefined, 404); }
  }
  private async readOrNull(abs: string): Promise<string | null> {
    try { return await this.fs.readFile(abs, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
  }

  private async withLocks<T>(rels: string[], fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(rels)].sort();
    const releases: (() => void)[] = [];
    for (const k of keys) {
      const prev = this.locks.get(k) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      this.locks.set(k, prev.then(() => next));
      await prev;
      releases.push(() => { release(); if (this.locks.get(k) === undefined) return; });
    }
    try { return await fn(); } finally { releases.forEach((r) => r()); }
  }

  /** Read current content + hash for revision tracking. */
  async revision(rel: string): Promise<{ text: string | null; hash: string | null }> {
    const text = await this.readOrNull(this.abs(rel));
    return { text, hash: text === null ? null : sha256(text) };
  }

  async commit(plan: PlannedFile[]): Promise<Journal> {
    return this.withLocks(plan.map((p) => p.rel), async () => {
      const id = randomId(9);
      // 1. precondition check
      for (const f of plan) {
        const cur = await this.readOrNull(this.abs(f.rel));
        const ok = f.before === null ? cur === null : cur !== null && sha256(cur) === sha256(f.before);
        if (!ok) throw new LlError("REVISION_CONFLICT", `${f.rel} changed since the preview. Nothing was written; preview again.`, { file: f.rel }, 409);
      }
      // 2. backups + journal
      const j: Journal = { id, createdAt: new Date().toISOString(), state: "prepared", files: [] };
      for (let i = 0; i < plan.length; i++) {
        const f = plan[i];
        let backup: string | null = null;
        if (f.before !== null) {
          backup = toPosix(path.join("backups", id, String(i)));
          await this.fs.mkdir(path.join(this.dir, "backups", id), { recursive: true });
          await this.fs.writeFile(path.join(this.dir, backup), f.before, "utf8");
        }
        j.files.push({ rel: f.rel, existed: f.before !== null, beforeHash: f.before === null ? null : sha256(f.before), afterHash: sha256(f.after), backup });
      }
      await this.saveJournal(j);
      // 3. write
      j.state = "committing";
      await this.saveJournal(j);
      const done: number[] = [];
      try {
        for (let i = 0; i < plan.length; i++) {
          await this.atomicWrite(this.abs(plan[i].rel), plan[i].after, id);
          done.push(i);
        }
      } catch (e) {
        const failed = await this.rollback(j, done);
        j.state = failed.length ? "needs-recovery" : "rolled-back";
        j.error = (e as Error).message;
        await this.saveJournal(j).catch(() => {});
        throw new LlError("WRITE_FAILED", failed.length
          ? `Write failed and rollback of ${failed.join(", ")} also failed; run \`localelens undo --recover\`.`
          : `Write failed (${(e as Error).message}); all files were restored.`, { transactionId: id, rolledBack: !failed.length }, 500);
      }
      j.state = "committed";
      await this.saveJournal(j);
      return j;
    });
  }

  private async atomicWrite(abs: string, data: string, id: string) {
    await this.fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.ll-${id}.tmp`;
    try {
      await this.fs.writeFile(tmp, data, "utf8");
      await this.fs.rename(tmp, abs);
    } catch (e) { await this.fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
  }

  /** Restore pre-images for the given file indexes. Returns rels that failed to restore. */
  private async rollback(j: Journal, idx: number[]): Promise<string[]> {
    const failed: string[] = [];
    for (const i of idx.slice().reverse()) {
      const f = j.files[i];
      try {
        const abs = this.abs(f.rel);
        if (f.backup) await this.atomicWrite(abs, await this.fs.readFile(path.join(this.dir, f.backup), "utf8"), j.id);
        else await this.fs.rm(abs, { force: true });
      } catch { failed.push(f.rel); }
    }
    return failed;
  }

  /** Undo a committed transaction. Refuses if any file changed after the commit. */
  async undo(id: string): Promise<Journal> {
    const j = await this.readJournal(id);
    if (j.state !== "committed") throw new LlError("UNDO_CONFLICT", `Transaction is ${j.state}; only committed transactions can be undone.`, undefined, 409);
    return this.withLocks(j.files.map((f) => f.rel), async () => {
      const changed: string[] = [];
      for (const f of j.files) {
        const cur = await this.readOrNull(this.abs(f.rel));
        if (cur === null || sha256(cur) !== f.afterHash) changed.push(f.rel);
      }
      if (changed.length) throw new LlError("UNDO_CONFLICT", `Files changed after the commit: ${changed.join(", ")}. Undo refused to avoid losing newer edits.`, { files: changed }, 409);
      const failed = await this.rollback(j, j.files.map((_, i) => i));
      if (failed.length) throw new LlError("WRITE_FAILED", `Undo failed for ${failed.join(", ")}`, { files: failed }, 500);
      j.state = "undone";
      await this.saveJournal(j);
      return j;
    });
  }

  /** Crash recovery: finish rolling back transactions that never reached "committed". */
  async recover(): Promise<string[]> {
    const dir = path.join(this.dir, "journal");
    let names: string[] = [];
    try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json")); } catch { return []; }
    const recovered: string[] = [];
    for (const n of names) {
      const j: Journal = JSON.parse(await this.fs.readFile(path.join(dir, n), "utf8"));
      if (!["prepared", "committing", "needs-recovery"].includes(j.state)) continue;
      // only restore files that actually carry our post-image (or were created by us)
      const idx: number[] = [];
      for (let i = 0; i < j.files.length; i++) {
        const cur = await this.readOrNull(this.abs(j.files[i].rel));
        if (cur !== null && sha256(cur) === j.files[i].afterHash) idx.push(i);
      }
      const failed = await this.rollback(j, idx);
      j.state = failed.length ? "needs-recovery" : "rolled-back";
      await this.saveJournal(j);
      recovered.push(j.id);
    }
    return recovered;
  }

  async list(): Promise<Journal[]> {
    try {
      const dir = path.join(this.dir, "journal");
      const names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json"));
      const all = await Promise.all(names.map(async (n) => JSON.parse(await fsp.readFile(path.join(dir, n), "utf8")) as Journal));
      return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch { return []; }
  }
}

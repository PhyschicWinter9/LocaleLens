import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { LlError } from "./errors.ts";

const SAFE_SEGMENT = /^[\w][\w.-]*$/;

/** Locale / namespace tokens substituted into file patterns. No separators, no traversal. */
export function assertSegment(v: string, what: string): string {
  if (!SAFE_SEGMENT.test(v) || v.includes("..")) throw new LlError("PATH_ESCAPE", `Invalid ${what}: ${JSON.stringify(v)}`);
  return v;
}

/** realpath of the deepest existing ancestor + remaining tail (so not-yet-created files can be validated). */
function realWithTail(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync.native(cur), ...tail);
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

export function isInside(root: string, abs: string): boolean {
  const r = norm(realWithTail(path.resolve(root)));
  const a = norm(realWithTail(path.resolve(abs)));
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Canonical containment check including symlink resolution. Throws PATH_ESCAPE. */
export function resolveInside(root: string, ...parts: string[]): string {
  const abs = path.resolve(root, ...parts);
  if (!isInside(root, abs)) throw new LlError("PATH_ESCAPE", "Path escapes the permitted root", undefined, 403);
  return abs;
}

export const toPosix = (p: string) => p.split(path.sep).join("/");

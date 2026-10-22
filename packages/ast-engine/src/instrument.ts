import { MagicString } from "magic-string";
import { shortHash } from "@localelens/core";
import { load, SUPPORTED_EXT, type NodePath } from "./parse.ts";
import { enumerateCandidates, type EnumOpts } from "./candidates.ts";
import type * as t from "@babel/types";

export const ATTR = "data-ll";
export const fileIdOf = (relPath: string) => shortHash(relPath.replace(/\\/g, "/"));

/** Fingerprint of an element's own tag + direct (non-element) children. Used to detect stale mappings. */
export function fingerprint(el: t.JSXElement, code: string): string {
  const open = code.slice(el.openingElement.start!, el.openingElement.end!);
  const direct = el.children
    .filter((c) => c.type !== "JSXElement")
    .map((c) => code.slice(c.start!, c.end!))
    .join("\u0001");
  return shortHash(open + "\u0000" + direct);
}

export const DEFAULT_ENUM: EnumOpts = { hookNames: new Set(["useTranslation", "useTranslations", "getTranslations"]), defaultNamespace: "translation" };

export interface InstrumentResult { code: string; map: any; count: number }

/**
 * Dev-only: tag host/composite JSX elements that own translatable text with
 * `data-ll="<fileId>:<n>:<fp>"`. Returns null when the file cannot be (or need not be) instrumented.
 * Never throws: a file that fails to parse is left untouched.
 */
export function instrument(code: string, filename: string, relPath: string, opts: EnumOpts = DEFAULT_ENUM): InstrumentResult | null {
  if (!SUPPORTED_EXT.test(filename) || /\/node_modules\//.test(filename.replace(/\\/g, "/"))) return null;
  if (!code.includes("<")) return null;
  let parsed;
  try { parsed = load(code, filename); } catch { return null; }
  const fileId = fileIdOf(relPath);
  const s = new MagicString(code);
  let count = 0;
  parsed.elements.forEach((p: NodePath<t.JSXElement>, n: number) => {
    const open = p.node.openingElement;
    if (open.attributes.some((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === ATTR)) return;
    if (open.name.type === "JSXMemberExpression" && /^(React\.)?Fragment$/.test(code.slice(open.name.start!, open.name.end!))) return;
    if (!enumerateCandidates(p, code, opts).length) return;
    const at = (open as any).typeParameters?.end ?? (open as any).typeArguments?.end ?? open.name.end!;
    s.appendLeft(at, ` ${ATTR}="${fileId}:${n}:${fingerprint(p.node, code)}"`);
    count++;
  });
  if (!count) return null;
  return { code: s.toString(), map: s.generateMap({ hires: true, source: filename }), count };
}

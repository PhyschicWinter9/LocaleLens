import { MagicString } from "magic-string";
import { LlError, type I18nAdapter } from "@localelens/core";
import type * as t from "@babel/types";
import { eolOf, load, type NodePath } from "./parse.ts";
import { enumerateCandidates, findTBinding, partsToText, type EnumOpts, type RawCandidate, type TBinding } from "./candidates.ts";
import { fingerprint } from "./instrument.ts";

export interface ExtractInput {
  code: string;
  filename: string;
  n: number;
  fp: string;
  candidateId: string;
  key: string;
  namespace: string;
  adapter: I18nAdapter;
  isServerComponent: boolean;
  /** App Router file outside app/ with no way to know whether a Server Component renders it. */
  maybeServer?: boolean;
  enumOpts: EnumOpts;
}
export interface ExtractResult {
  code: string;
  tName: string;
  /** Source-locale template with adapter placeholders, e.g. `Welcome, {{name}}!` */
  template: string;
  vars: string[];
  diagnostics: string[];
}

const upper = (s: string) => /^[A-Z]/.test(s);
const MEMO_LIKE = /^(memo|forwardRef)$/;

function looksLikeComponent(fn: NodePath<t.Function>): boolean {
  const p = fn.parentPath!;
  if (fn.isFunctionDeclaration()) return (!!fn.node.id && upper(fn.node.id.name)) || p.isExportDefaultDeclaration();
  if (fn.isFunctionExpression() && fn.node.id && upper(fn.node.id.name)) return true;
  if (p.isExportDefaultDeclaration()) return true;
  if (p.isVariableDeclarator() && p.node.id.type === "Identifier" && upper(p.node.id.name)) return true;
  if (p.isCallExpression()) {
    const c = p.node.callee;
    const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && c.property.type === "Identifier" ? c.property.name : "";
    if (MEMO_LIKE.test(name)) return true;
  }
  return false;
}

function componentOf(p: NodePath): NodePath<t.Function> {
  for (let cur: NodePath | null = p.parentPath; cur; cur = cur.parentPath) {
    if (cur.isClassMethod() || cur.isClassPrivateMethod())
      throw new LlError("HOOK_CONTEXT_INVALID", "Text is inside a class component; hooks cannot be inserted. Convert to a function component or use the withTranslation HOC manually.");
    if (cur.isFunction() && looksLikeComponent(cur as NodePath<t.Function>)) return cur as NodePath<t.Function>;
  }
  throw new LlError("HOOK_CONTEXT_INVALID", "Text is not inside a React function component (module-level or plain helper function). Hooks cannot be inserted safely; move the JSX into a component or edit manually.");
}

function lineIndent(code: string, pos: number): string {
  const ls = code.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(code.slice(ls))![0];
}

function visibleTBindings(p: NodePath, opts: EnumOpts): TBinding[] {
  const out: TBinding[] = [];
  const seen = new Set<string>();
  for (let sc: any = p.scope; sc; sc = sc.parent) {
    for (const name of Object.keys(sc.bindings)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const b = findTBinding(p, name, opts);
      if (b) out.push(b);
    }
  }
  return out;
}

function uniqueName(p: NodePath, bases: string[]): string {
  const taken = (n: string) => p.scope.hasBinding(n) || p.scope.hasGlobal(n);
  for (const b of bases) if (!taken(b)) return b;
  for (let i = 2; ; i++) if (!taken(bases[bases.length - 1] + i)) return bases[bases.length - 1] + i;
}

export function renderCall(adapter: I18nAdapter, tName: string, key: string, vars: { name: string; expr: string }[]): string {
  return adapter.callExpr(tName, key, Object.fromEntries(vars.map((v) => [v.name, v.expr])));
}

export function extract(inp: ExtractInput): ExtractResult {
  const { code, adapter } = inp;
  const diagnostics: string[] = [];
  const file = load(code, inp.filename);
  const el = file.elements[inp.n];
  if (!el) throw new LlError("SOURCE_STALE", "Element index no longer exists in the file; reload the page.");
  if (fingerprint(el.node, code) !== inp.fp) throw new LlError("SOURCE_STALE", "Source changed since the page was compiled; reload the page and select again.");

  const cand = enumerateCandidates(el, code, inp.enumOpts).find((c) => c.id === inp.candidateId);
  if (!cand) throw new LlError("SOURCE_AMBIGUOUS", "Selected occurrence no longer exists in this element.");
  if (!cand.canExtract || !cand.range || !cand.replace) throw new LlError("SOURCE_UNSUPPORTED", cand.reason ?? "This occurrence cannot be extracted automatically.");
  if (cand.reason) diagnostics.push(cand.reason);

  const isServer = inp.isServerComponent && !file.hasUseClient;
  const comp = componentOf(el);
  const s = new MagicString(code);
  const eol = eolOf(code);

  // ---- choose / create the translation binding ------------------------------------------------
  const existing = visibleTBindings(el, inp.enumOpts);
  let tName: string;
  let keyForCall = inp.key;
  let needHook = false;
  const bound = existing.find((b) => (b.namespace ?? inp.enumOpts.defaultNamespace) === inp.namespace && !b.keyPrefix);
  if (bound) tName = bound.name;
  else if (existing.length && adapter.id === "i18next") {
    // Reuse the in-scope t and address our namespace explicitly: t("ns:key")
    tName = existing[0].name;
    keyForCall = `${inp.namespace}:${inp.key}`;
  } else {
    needHook = true;
    const nsCap = inp.namespace.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toUpperCase());
    tName = uniqueName(el, existing.length ? ["t" + nsCap, "tr"] : ["t"]);
  }

  // ---- hook + import ---------------------------------------------------------------------------
  let hookNeedsAsync = false;
  if (needHook) {
    // next-intl: `useTranslations` is valid in sync Server Components, so only async components and route files
    // (page/layout/...: Next supports async there) switch to `await getTranslations`; other components keep their signature.
    const routeFile = /(^|[\\/])(page|layout|template|default|not-found)\.[jt]sx?$/.test(inp.filename);
    const serverApi = adapter.id === "next-intl" ? isServer && (comp.node.async || routeFile) : isServer;
    if (adapter.id === "next-intl" && isServer && !serverApi) diagnostics.push("Server Component: using useTranslations (valid for non-async components); the component was not made async.");
    if (adapter.id === "i18next" && !isServer && inp.maybeServer && !file.hasUseClient)
      diagnostics.push("This file has no \"use client\" directive and lives outside app/. If a Server Component renders it, react-i18next hooks will fail: add \"use client\" or extract from a client component.");
    const plan = adapter.hook({ namespace: inp.namespace, isServerComponent: serverApi });
    if (!plan.ok) throw new LlError(isServer ? "SERVER_COMPONENT_UNSUPPORTED" : "HOOK_CONTEXT_INVALID", plan.reason ?? "Cannot generate a translation binding here.");
    const hookLocal = ensureImport(file.ast, code, s, eol, plan.importSource, plan.importName);
    const fn = comp.node;
    const stmt = plan.statement({ tName, ns: inp.namespace, hook: hookLocal });
    if (fn.body.type === "BlockStatement") {
      const dirs = fn.body.directives;
      const at = dirs.length ? dirs[dirs.length - 1].end! : fn.body.start! + 1;
      const first = fn.body.body[0];
      const indent = first ? lineIndent(code, first.start!) : lineIndent(code, fn.start!) + "  ";
      s.appendLeft(at, `${eol}${indent}${stmt}${eol}`);
    } else {
      const body = fn.body as t.Expression;
      const parenthesized = !!(body.extra as any)?.parenthesized;
      const bStart = parenthesized ? (body.extra as any).parenStart : body.start!;
      let bEnd = body.end!;
      if (parenthesized) { const m = /^\s*\)/.exec(code.slice(bEnd)); if (m) bEnd += m[0].length; }
      const base = lineIndent(code, fn.start!);
      s.appendLeft(bStart, `{${eol}${base}  ${stmt}${eol}${eol}${base}  return `);
      s.appendRight(bEnd, `;${eol}${base}}`);
    }
    if (plan.makeAsync) {
      hookNeedsAsync = true;
      if (!fn.async) s.appendLeft(fn.start!, "async ");
    }
  }
  void hookNeedsAsync;

  // ---- replace the text with a translation call ------------------------------------------------
  const vars = (cand.parts ?? []).flatMap((p) => ("expr" in p ? [{ name: p.name, expr: p.expr }] : []));
  const uniqVars = vars.filter((v, i) => vars.findIndex((w) => w.name === v.name) === i);
  const call = renderCall(adapter, tName, keyForCall, uniqVars);
  const [a, b] = cand.range;
  s.overwrite(a, b, cand.replace === "node" ? call : `{${call}}`);

  const out = s.toString();

  // ---- verify by re-parsing and re-resolving ---------------------------------------------------
  try {
    const re = load(out, inp.filename);
    const el2 = re.elements[inp.n];
    const found = el2 && enumerateCandidates(el2, out, inp.enumOpts).some((c) => c.kind === "i18n-call" && c.key === inp.key && c.namespace === inp.namespace);
    if (!found) throw new Error("translation call not found after transform");
  } catch (e) {
    throw new LlError("INTERNAL", `Post-transform verification failed: ${(e as Error).message}. No files were changed.`);
  }

  const template = (cand.parts ?? []).map((p) => ("text" in p ? p.text : adapter.placeholder(p.name))).join("");
  return { code: out, tName, template, vars: uniqVars.map((v) => v.name), diagnostics };
}

/** Ensure `import { name } from "source"`; returns the local binding name (respects aliases). */
function ensureImport(ast: t.File, code: string, s: MagicString, eol: string, source: string, name: string): string {
  const imports = ast.program.body.filter((n): n is t.ImportDeclaration => n.type === "ImportDeclaration");
  for (const d of imports) {
    if (d.source.value !== source || d.importKind === "type") continue;
    for (const sp of d.specifiers) {
      if (sp.type === "ImportSpecifier" && sp.importKind !== "type" && (sp.imported.type === "Identifier" ? sp.imported.name : sp.imported.value) === name) return sp.local.name;
    }
  }
  const host = imports.find((d) => d.source.value === source && d.importKind !== "type" && d.specifiers.some((x) => x.type === "ImportSpecifier"));
  if (host) {
    const lastSpec = [...host.specifiers].reverse().find((x) => x.type === "ImportSpecifier")!;
    s.appendLeft(lastSpec.end!, `, ${name}`);
    return name;
  }
  const sample = imports[0];
  const q = sample ? code[sample.source.start!] : '"';
  const semi = sample ? (code[sample.end! - 1] === ";" ? ";" : "") : ";";
  const line = `import { ${name} } from ${q}${source}${q}${semi}`;
  if (imports.length) s.appendLeft(imports[imports.length - 1].end!, `${eol}${line}`);
  else {
    const dirs = ast.program.directives;
    if (dirs.length) s.appendLeft(dirs[dirs.length - 1].end!, `${eol}${eol}${line}`);
    else s.prepend(`${line}${eol}${eol}`);
  }
  return name;
}

export { partsToText };
export type { RawCandidate };

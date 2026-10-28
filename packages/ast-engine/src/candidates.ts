import type * as t from "@babel/types";
import { parseSource, traverse, type NodePath } from "./parse.ts";

export const TRANSLATABLE_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-description", "aria-placeholder", "label"]);

export type Part = { text: string } | { expr: string; name: string };

export interface RawCandidate {
  id: string;
  kind: "jsx-text" | "attribute" | "string-expression" | "template" | "dynamic-text" | "i18n-call" | "unsupported";
  /** Human-readable text; dynamic parts shown as `{name}`. */
  text: string;
  attr?: string;
  key?: string;
  namespace?: string;
  line: number;
  column: number;
  canExtract: boolean;
  reason?: string;
  parts?: Part[];
  /** Source range to replace and how. */
  range?: [number, number];
  replace?: "child-run" | "attr-value" | "node";
  matcher: RegExp | null;
  /** Unresolved `x.<prop>` reference: the agent searches other files for `<prop>: ...` definitions. */
  lookupProp?: string;
  lookupAsKey?: boolean;
  /** Namespace came from the call site (`useTranslations("x")`, `ns:key`), not the configured default. */
  nsExplicit?: boolean;
  /** `t` is a function parameter (props): namespace unknown, the agent resolves by key + on-screen text. */
  viaParam?: boolean;
  /** Template key with expressions (`${mode}.cta`): literal prefix / suffix around them. */
  dynKey?: { prefix: string; suffix: string };
}

export interface TBinding { name: string; namespace: string | null; keyPrefix?: string; viaParam?: boolean }
const T_METHODS = new Set(["rich", "raw", "markup"]);
const T_LIKE = /^(t|tr|translate|t[A-Z]w*|w+T)$/;

export interface EnumOpts {
  /** Names of functions that produce a `t` (useTranslation, useTranslations, getTranslations, ...). */
  hookNames: Set<string>;
  defaultNamespace: string;
}

/** React's JSX whitespace semantics for one JSXText value. */
export function cleanJsxText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((l, i) => { if (/[^ \t]/.test(l)) lastNonEmpty = i; });
  let out = "";
  lines.forEach((line, i) => {
    let s = line.replace(/\t/g, " ");
    if (i !== 0) s = s.replace(/^ +/, "");
    if (i !== lines.length - 1) s = s.replace(/ +$/, "");
    if (s) { if (i !== lastNonEmpty) s += " "; out += s; }
  });
  return out;
}

export const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matcherFor(parts: Part[]): RegExp {
  const src = parts.map((p) => ("text" in p ? escRe(normalizeWs(p.text)).replace(/ /g, "\\s+") : "[\\s\\S]+?")).join("");
  return new RegExp("^\\s*" + src + "\\s*$");
}

function isSimpleExpr(n: t.Node): boolean {
  if (n.type === "Identifier" || n.type === "ThisExpression" || n.type === "NumericLiteral") return true;
  if ((n.type === "MemberExpression" || n.type === "OptionalMemberExpression") && !n.computed) return isSimpleExpr(n.object);
  return false;
}
function nameOf(n: t.Node): string {
  if (n.type === "Identifier") return n.name;
  if ((n.type === "MemberExpression" || n.type === "OptionalMemberExpression") && n.property.type === "Identifier") return n.property.name;
  return "value";
}

/** Assign unique variable names for expression parts. Same source text => same var. */
function namedParts(items: ({ text: string } | { exprNode: t.Node; src: string })[]): { parts: Part[]; ok: boolean } {
  const used = new Map<string, string>(); // src -> name
  const names = new Set<string>();
  let ok = true;
  const parts: Part[] = items.map((it) => {
    if ("text" in it) return it;
    if (!isSimpleExpr(it.exprNode)) ok = false;
    let name = used.get(it.src);
    if (!name) {
      let base = nameOf(it.exprNode);
      if (!/^[A-Za-z_$][\w$]*$/.test(base)) base = "value";
      name = base;
      for (let i = 2; names.has(name); i++) name = base + i;
      names.add(name);
      used.set(it.src, name);
    }
    return { expr: it.src, name };
  });
  return { parts, ok };
}

export function partsToText(parts: Part[]) {
  return parts.map((p) => ("text" in p ? p.text : `{${p.name}}`)).join("");
}

function literalString(n: t.Node): string | null {
  if (n.type === "StringLiteral") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0].value.cooked ?? null;
  return null;
}

/** Find the `t` binding (and namespace) that identifier `name` refers to at `path`. */
export function findTBinding(path: NodePath, name: string, opts: EnumOpts): TBinding | null {
  const binding = path.scope.getBinding(name);
  if (!binding) return null;
  const bp = binding.path;
  if (binding.kind === "param" && T_LIKE.test(name)) return { name, namespace: null, viaParam: true };
  if (bp.isVariableDeclarator() && bp.node.id.type === "Identifier" && bp.node.init?.type === "Identifier" && bp.node.init.name !== name) {
    const inner = findTBinding(bp, bp.node.init.name, opts); // const tt = t;
    return inner && { ...inner, name };
  }
  if (bp.isVariableDeclarator()) {
    let init: t.Node | null | undefined = bp.node.init;
    if (init?.type === "AwaitExpression") init = init.argument;
    // `const [t, tb] = await Promise.all([getTranslations("a"), getTranslations("b")])`: pick the call at t's index.
    let id: t.Node = bp.node.id;
    if (id.type === "ArrayPattern" && init?.type === "CallExpression" && init.callee.type === "MemberExpression"
      && init.callee.object.type === "Identifier" && init.callee.object.name === "Promise" && init.callee.property.type === "Identifier"
      && init.callee.property.name === "all" && init.arguments[0]?.type === "ArrayExpression") {
      const i = id.elements.findIndex((e) => e?.type === "Identifier" && e.name === name);
      let el = i < 0 ? null : init.arguments[0].elements[i];
      if (el?.type === "AwaitExpression") el = el.argument;
      if (!el || el.type !== "CallExpression") return null;
      init = el;
      id = id.elements[i] as t.Identifier;
    }
    if (init?.type !== "CallExpression" || init.callee.type !== "Identifier") return null;
    const cb = bp.scope.getBinding(init.callee.name);
    const calleeOrig = cb?.path.isImportSpecifier() ? ((cb.path.node.imported as t.Identifier).name ?? init.callee.name) : init.callee.name;
    if (!opts.hookNames.has(calleeOrig)) return null;
    if (id.type === "ObjectPattern") {
      const ok = id.properties.some((pr) => pr.type === "ObjectProperty" && pr.key.type === "Identifier" && pr.key.name === "t" && pr.value.type === "Identifier" && pr.value.name === name);
      if (!ok) return null;
    } else if (!(id.type === "Identifier" && id.name === name)) return null;
    const a0 = init.arguments[0];
    let ns: string | null = null;
    let keyPrefix: string | undefined;
    if (a0 && a0.type === "StringLiteral") ns = a0.value;
    else if (a0?.type === "ObjectExpression") { // getTranslations({ locale, namespace: "x" })
      for (const pr of a0.properties) if (pr.type === "ObjectProperty" && pr.key.type === "Identifier" && pr.key.name === "namespace" && pr.value.type === "StringLiteral") ns = pr.value.value;
    } else if (a0 && a0.type === "ArrayExpression" && a0.elements[0]?.type === "StringLiteral") ns = a0.elements[0].value;
    const a1 = init.arguments[1];
    if (a1?.type === "ObjectExpression") {
      for (const pr of a1.properties) if (pr.type === "ObjectProperty" && pr.key.type === "Identifier" && pr.key.name === "keyPrefix" && pr.value.type === "StringLiteral") keyPrefix = pr.value.value;
    }
    return { name, namespace: ns, keyPrefix };
  }
  if (binding.kind === "module" && bp.isImportSpecifier()) {
    const src = (bp.parent as t.ImportDeclaration).source.value;
    if (src === "i18next" && (bp.node.imported as t.Identifier).name === "t") return { name, namespace: null };
  }
  return null;
}

function addAttrCandidates(el: NodePath<t.JSXElement>, out: RawCandidate[], opts: EnumOpts, push: (c: Omit<RawCandidate, "id">) => void) {
  for (const a of el.node.openingElement.attributes) {
    if (a.type !== "JSXAttribute" || a.name.type !== "JSXIdentifier" || !a.value) continue;
    const attr = a.name.name;
    if (!TRANSLATABLE_ATTRS.has(attr)) continue;
    let valNode: t.Node = a.value;
    let wrapped = false;
    if (valNode.type === "JSXExpressionContainer") { valNode = valNode.expression; wrapped = true; }
    const s = literalString(valNode);
    if (s !== null && valNode.type !== "JSXEmptyExpression") {
      if (!s.trim()) continue;
      push({
        kind: wrapped ? "string-expression" : "attribute", text: s, attr,
        line: a.loc!.start.line, column: a.loc!.start.column, canExtract: true,
        parts: [{ text: s }], range: [a.value.start!, a.value.end!], replace: wrapped ? "node" : "attr-value",
        matcher: matcherFor([{ text: s }]),
      });
      if (wrapped) out[out.length - 1].range = [valNode.start!, valNode.end!];
      continue;
    }
    if (valNode.type === "CallExpression") {
      const c = i18nCall(el, valNode, opts);
      if (c) push({ ...c, attr });
    }
  }
}

/** `t(...)`, `t.rich(...)`, `t.raw(...)`, `t.markup(...)`: the identifier that holds `t`, or null. */
function tCallee(call: t.CallExpression): string | null {
  const c = call.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" && c.property.type === "Identifier" && T_METHODS.has(c.property.name)) return c.object.name;
  return null;
}

function i18nCall(path: NodePath, call: t.CallExpression, opts: EnumOpts): Omit<RawCandidate, "id"> | null {
  const calleeName = tCallee(call);
  if (!calleeName) return null;
  const tb = findTBinding(path, calleeName, opts);
  if (!tb) return null;
  const a0 = call.arguments[0];
  const loc = call.loc!.start;
  const base = { kind: "i18n-call" as const, text: "", line: loc.line, column: loc.column, canExtract: false, matcher: null, viaParam: tb.viaParam };
  if (!a0 || (a0.type !== "StringLiteral" && !(a0.type === "TemplateLiteral" && a0.expressions.length === 0))) {
    if (a0?.type === "TemplateLiteral") { // `${mode}.cta`: keep the literal edges so the agent can match by text
      const prefix = a0.quasis[0].value.cooked ?? "", suffix = a0.quasis[a0.quasis.length - 1].value.cooked ?? "";
      return { ...base, namespace: tb.namespace ?? opts.defaultNamespace, nsExplicit: tb.namespace !== null, dynKey: { prefix, suffix }, reason: "Dynamic translation key: resolved by on-screen text" };
    }
    return { ...base, reason: "Dynamic translation key cannot be resolved statically" };
  }
  let key = literalString(a0)!;
  let ns = tb.namespace ?? opts.defaultNamespace;
  let nsExplicit = tb.namespace !== null;
  const m = /^([^:]+):(.+)$/.exec(key);
  if (m) { ns = m[1]; key = m[2]; nsExplicit = true; }
  if (tb.keyPrefix) key = tb.keyPrefix + "." + key;
  return { ...base, key, namespace: ns, nsExplicit };
}


/**
 * Config provenance: `{column.label}` / `t(column.label)` renders text defined elsewhere in the same file as
 * `{ label: "..." }` or `{ label: t("ns:key") }`. Emit one candidate per definition; runtime text matching ranks them.
 * When none exist here the candidate carries `lookupProp` so the agent can search other files (see findConfigDefs).
 */
const memberProp = (e: t.Node) => (e.type === "MemberExpression" && !e.computed && e.property.type === "Identifier" ? e.property.name : null);
const outerFn = (q: NodePath) => { let f = q.getFunctionParent(); for (let g = f?.getFunctionParent(); g; g = f.getFunctionParent()) f = g; return f; };

function addProvenance(el: NodePath<t.JSXElement>, expr: t.Node, asKey: boolean, opts: EnumOpts, push: (c: Omit<RawCandidate, "id">) => void): boolean {
  const prop = memberProp(expr);
  return !!prop && configDefs(el.scope.getProgramParent().path, prop, asKey, opts, outerFn(el), push);
}

/** Emit a candidate per `prop: ...` object property under `program`. `elFn` (the element's outermost function) gates extractability; null = other file. */
function configDefs(program: NodePath, prop: string, asKey: boolean, opts: EnumOpts, elFn: NodePath | null, push: (c: Omit<RawCandidate, "id">) => void): boolean {
  let found = false;
  program.traverse({
    ObjectProperty(p) {
      const k = p.node.key;
      if (p.node.computed || !((k.type === "Identifier" && k.name === prop) || (k.type === "StringLiteral" && k.value === prop))) return;
      const v = p.node.value, loc = v.loc!.start;
      const where = `Defined in config at line ${loc.line} (\`${prop}\`)`;
      if (v.type === "CallExpression") {
        const c = i18nCall(p, v, opts);
        if (c?.key) { push({ ...c, reason: where }); found = true; }
        return;
      }
      const s = literalString(v);
      if (s === null || !s.trim()) return;
      if (asKey) { // t(column.label): the literal is the translation key
        let key = s, ns: string | undefined;
        const m = /^([^:]+):(.+)$/.exec(s);
        if (m) { ns = m[1]; key = m[2]; }
        push({ kind: "i18n-call", text: "", key, namespace: ns ?? opts.defaultNamespace, line: loc.line, column: loc.column, canExtract: false, reason: where, matcher: null });
      } else {
        const sameFn = !!elFn && outerFn(p) === elFn;
        push({
          kind: "string-expression", text: s, line: loc.line, column: loc.column, canExtract: sameFn,
          reason: sameFn ? where : `${where}; outside this component, edit manually`,
          parts: [{ text: s }], range: [v.start!, v.end!], replace: "node", matcher: matcherFor([{ text: s }]),
        });
      }
      found = true;
    },
  });
  return found;
}

/** Config definitions of `prop` in another file (no JSX element involved). Never extractable. */
export function findConfigDefs(code: string, filename: string, prop: string, asKey: boolean, opts: EnumOpts): Omit<RawCandidate, "id">[] {
  const out: Omit<RawCandidate, "id">[] = [];
  const ast = parseSource(code, filename);
  traverse(ast, { Program(p) { configDefs(p, prop, asKey, opts, null, (c) => out.push(c)); p.stop(); } });
  return out;
}

/** Collect JSX children, looking through fragments. */
function flatChildren(children: t.JSXElement["children"]): t.JSXElement["children"] {
  const out: t.JSXElement["children"] = [];
  for (const c of children) {
    if (c.type === "JSXFragment") out.push(...flatChildren(c.children));
    else out.push(c);
  }
  return out;
}

function addStringLeaves(n: t.Node, push: (c: Omit<RawCandidate, "id">) => void, call?: (c: t.CallExpression) => Omit<RawCandidate, "id"> | null) {
  // {cond ? "A" : "B"}, {x && "A"}, {x || "A"}
  if (n.type === "ConditionalExpression") { addStringLeaves(n.consequent, push, call); addStringLeaves(n.alternate, push, call); return; }
  if (n.type === "LogicalExpression") { addStringLeaves(n.right, push, call); if (n.operator !== "&&") addStringLeaves(n.left, push, call); return; }
  if (n.type === "ParenthesizedExpression") { addStringLeaves(n.expression, push, call); return; }
  if (n.type === "CallExpression") { const c = call?.(n); if (c) push(c); return; }
  const s = literalString(n);
  if (s !== null && s.trim()) {
    push({
      kind: "string-expression", text: s, line: n.loc!.start.line, column: n.loc!.start.column, canExtract: true,
      parts: [{ text: s }], range: [n.start!, n.end!], replace: "node", matcher: matcherFor([{ text: s }]),
    });
  }
}

/** Enumerate every translatable occurrence owned directly by this element. */
export function enumerateCandidates(el: NodePath<t.JSXElement>, code: string, opts: EnumOpts): RawCandidate[] {
  const out: RawCandidate[] = [];
  const push = (c: Omit<RawCandidate, "id">) => out.push({ ...c, id: String(out.length) });

  addAttrCandidates(el, out, opts, push);

  const children = flatChildren(el.node.children);
  let run: { node: t.Node; kind: "text" | "expr" | "static-expr" | "complex"; raw: string }[] = [];
  let hasElementSibling = children.some((c) => c.type === "JSXElement");

  const flush = () => {
    // trim whitespace-only text at both edges
    while (run.length && run[0].kind === "text" && !cleanJsxText((run[0].node as t.JSXText).value).trim()) run.shift();
    while (run.length && run[run.length - 1].kind === "text" && !cleanJsxText((run[run.length - 1].node as t.JSXText).value).trim()) run.pop();
    const cur = run;
    run = [];
    if (!cur.some((r) => r.kind === "text" || r.kind === "static-expr")) return;
    if (!cur.some((r) => (r.kind === "text" && cleanJsxText((r.node as t.JSXText).value).trim()) || r.kind === "static-expr")) return;

    const items: ({ text: string } | { exprNode: t.Node; src: string })[] = [];
    let complex = false;
    cur.forEach((r, i) => {
      if (r.kind === "text") {
        let s = cleanJsxText((r.node as t.JSXText).value);
        if (i === 0) s = s.replace(/^\s+/, "");
        if (i === cur.length - 1) s = s.replace(/\s+$/, "");
        if (s) items.push({ text: s });
      } else if (r.kind === "static-expr") {
        items.push({ text: r.raw });
      } else {
        if (r.kind === "complex") complex = true;
        items.push({ exprNode: (r.node as t.JSXExpressionContainer).expression, src: r.raw });
      }
    });
    // merge adjacent text
    const merged: typeof items = [];
    for (const it of items) {
      const last = merged[merged.length - 1];
      if (last && "text" in last && "text" in it) last.text += it.text; else merged.push({ ...it });
    }
    const { parts, ok } = namedParts(merged);
    if (!partsToText(parts).trim()) return;
    const first = cur[0].node, lastN = cur[cur.length - 1].node;
    const start = first.type === "JSXText" ? first.start! + (first.value.length - first.value.trimStart().length) : first.start!;
    const end = lastN.type === "JSXText" ? lastN.end! - (lastN.value.length - lastN.value.trimEnd().length) : lastN.end!;
    const dynamic = parts.some((p) => "expr" in p);
    const unsupportedExpr = complex || !ok;
    push({
      kind: dynamic ? "dynamic-text" : "jsx-text",
      text: partsToText(parts), line: first.loc!.start.line, column: first.loc!.start.column,
      canExtract: !unsupportedExpr,
      reason: unsupportedExpr
        ? "Contains a non-trivial expression. Assign it to a variable first, then extract (safe manual alternative)."
        : hasElementSibling ? "Rich text: this sentence is split around child elements; translators cannot reorder across them." : undefined,
      parts, range: [start, end], replace: "child-run", matcher: matcherFor(parts),
    });
  };

  for (const c of children) {
    if (c.type === "JSXText") { run.push({ node: c, kind: "text", raw: c.value }); continue; }
    if (c.type === "JSXExpressionContainer") {
      const e = c.expression;
      if (e.type === "JSXEmptyExpression") continue;
      const lit = literalString(e);
      if (lit !== null) { run.push({ node: c, kind: "static-expr", raw: lit }); continue; }
      if (e.type === "CallExpression") {
        const call = i18nCall(el, e, opts);
        if (call) {
          flush();
          const a0 = e.arguments[0];
          if (!call.key && a0 && addProvenance(el, a0, true, opts, push)) continue;
          push(!call.key && a0 && memberProp(a0) ? { ...call, lookupProp: memberProp(a0)!, lookupAsKey: true } : call);
          continue;
        }
      }
      if (e.type === "ConditionalExpression" || e.type === "LogicalExpression") {
        flush();
        addStringLeaves(e, push, (x) => i18nCall(el, x, opts));
        continue;
      }
      if (e.type === "MemberExpression" && children.every((x) => x === c || (x.type === "JSXText" && !x.value.trim()))) {
        const before = out.length;
        if (addProvenance(el, e, false, opts, push)) { flush(); continue; }
        out.length = before;
        flush();
        push({ kind: "unsupported", text: "", line: e.loc!.start.line, column: e.loc!.start.column, canExtract: false, reason: "Text comes from a value defined elsewhere", matcher: null, lookupProp: memberProp(e)! });
        continue;
      }
      run.push({ node: c, kind: isSimpleExpr(e) ? "expr" : "complex", raw: code.slice(e.start!, e.end!) });
      continue;
    }
    if (c.type === "JSXElement" || c.type === "JSXSpreadChild") { flush(); continue; }
  }
  flush();
  return out;
}

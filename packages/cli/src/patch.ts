import { MagicString } from "magic-string";
import { parseSource, type NodePath } from "@localelens/ast-engine";
import type * as t from "@babel/types";

export interface Patch { rel: string; before: string; after: string; note: string }

/** Add `localelens()` to a Vite config's plugins array (AST-based, formatting preserved). Returns null if it cannot be done safely. */
export function patchViteConfig(code: string, filename: string): string | null {
  if (code.includes("@localelens/vite")) return code;
  let ast: t.File;
  try { ast = parseSource(code, filename.endsWith(".ts") || filename.endsWith(".mts") ? "vite.config.ts" : "vite.config.js"); } catch { return null; }
  const s = new MagicString(code);

  let obj: t.ObjectExpression | null = null;
  const fromExpr = (e: t.Node | null | undefined): t.ObjectExpression | null => {
    if (!e) return null;
    if (e.type === "ObjectExpression") return e;
    if (e.type === "ParenthesizedExpression") return fromExpr(e.expression);
    if (e.type === "ArrowFunctionExpression" || e.type === "FunctionExpression") {
      if (e.body.type !== "BlockStatement") return fromExpr(e.body);
      const ret = e.body.body.find((x): x is t.ReturnStatement => x.type === "ReturnStatement");
      return fromExpr(ret?.argument);
    }
    if (e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "defineConfig") return fromExpr(e.arguments[0] as t.Node);
    if (e.type === "TSSatisfiesExpression" || e.type === "TSAsExpression") return fromExpr(e.expression);
    return null;
  };
  for (const n of ast.program.body) if (n.type === "ExportDefaultDeclaration") obj = fromExpr(n.declaration as t.Node);
  if (!obj) return null;

  const plugins = obj.properties.find((p): p is t.ObjectProperty => p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "plugins");
  if (plugins) {
    if (plugins.value.type !== "ArrayExpression") return null;
    const arr = plugins.value;
    const sep = arr.elements.length ? ", " : "";
    s.appendLeft(arr.start! + 1, `localelens()${sep}`);
  } else {
    const first = obj.properties[0];
    const indent = first ? /^[ \t]*/.exec(code.slice(code.lastIndexOf("\n", first.start! - 1) + 1))![0] : "  ";
    if (first) s.appendLeft(first.start!, `plugins: [localelens()],\n${indent}`);
    else s.appendLeft(obj.start! + 1, ` plugins: [localelens()] `);
  }
  const imports = ast.program.body.filter((n) => n.type === "ImportDeclaration");
  const eol = code.includes("\r\n") ? "\r\n" : "\n";
  const line = `import localelens from "@localelens/vite";`;
  if (imports.length) s.appendLeft(imports[imports.length - 1].end!, `${eol}${line}`); else s.prepend(line + eol);
  return s.toString();
}
export type { NodePath };

/** Wrap the default export of next.config.{js,mjs,ts,cjs} with withLocaleLens(...). Returns null when it cannot be done safely. */
export function patchNextConfig(code: string, filename: string): string | null {
  if (code.includes("@localelens/next")) return code;
  let ast: t.File;
  try { ast = parseSource(code, filename.endsWith(".ts") ? "next.config.ts" : "next.config.js"); } catch { return null; }
  const s = new MagicString(code);
  const eol = code.includes("\r\n") ? "\r\n" : "\n";

  const wrap = (expr: t.Node) => { s.appendLeft(expr.start!, "withLocaleLens("); s.appendRight(expr.end!, ")"); };

  const esm = ast.program.body.find((n): n is t.ExportDefaultDeclaration => n.type === "ExportDefaultDeclaration");
  if (esm) {
    const d = esm.declaration;
    if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration" || d.type === "TSDeclareFunction") return null;
    wrap(d);
    const imports = ast.program.body.filter((n) => n.type === "ImportDeclaration");
    const line = `import { withLocaleLens } from "@localelens/next";`;
    if (imports.length) s.appendLeft(imports[imports.length - 1].end!, `${eol}${line}`); else s.prepend(line + eol + eol);
    return s.toString();
  }
  for (const n of ast.program.body) {
    if (n.type !== "ExpressionStatement" || n.expression.type !== "AssignmentExpression") continue;
    const l = n.expression.left;
    if (l.type === "MemberExpression" && l.object.type === "Identifier" && l.object.name === "module" && l.property.type === "Identifier" && l.property.name === "exports") {
      wrap(n.expression.right);
      const strict = ast.program.directives.length ? ast.program.directives[ast.program.directives.length - 1].end! : 0;
      const line = `const { withLocaleLens } = require("@localelens/next");`;
      if (strict) s.appendLeft(strict, `${eol}${line}`); else s.prepend(line + eol);
      return s.toString();
    }
  }
  return null;
}

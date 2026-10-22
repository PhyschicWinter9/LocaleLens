import { parse as babelParse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

export const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;
export type { NodePath };

export const SUPPORTED_EXT = /\.(jsx?|tsx?)$/;

export function parseSource(code: string, filename: string): t.File {
  const ts = /\.tsx?$/.test(filename);
  return babelParse(code, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ts ? ["jsx", "typescript"] : ["jsx"],
    // .ts (non-tsx) files cannot contain JSX; Babel "jsx"+"typescript" is fine for .tsx/.ts here.
  });
}

export interface ParsedFile {
  ast: t.File;
  code: string;
  elements: NodePath<t.JSXElement>[];
  hasUseClient: boolean;
}

/** Parse and collect every JSXElement in document order (ordinal n == array index). */
export function load(code: string, filename: string): ParsedFile {
  const ast = parseSource(code, filename);
  const elements: NodePath<t.JSXElement>[] = [];
  traverse(ast, {
    JSXElement(p) {
      elements.push(p);
    },
  });
  const hasUseClient = ast.program.directives.some((d) => d.value.value === "use client");
  return { ast, code, elements, hasUseClient };
}

export const eolOf = (code: string) => (code.includes("\r\n") ? "\r\n" : "\n");

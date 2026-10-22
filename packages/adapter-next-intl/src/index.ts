import type { I18nAdapter } from "@localelens/core";

const q = (s: string) => JSON.stringify(s);

export const nextIntlAdapter: I18nAdapter = {
  id: "next-intl",
  placeholder: (name) => `{${name}}`,
  placeholderRe: /\{\s*([\w.$]+)\s*(?:,[^}]*)?\}/g,
  callExpr(tName, key, vars) {
    const v = vars && Object.keys(vars).length
      ? `, { ${Object.entries(vars).map(([n, e]) => (n === e ? n : `${n}: ${e}`)).join(", ")} }`
      : "";
    return `${tName}(${q(key)}${v})`;
  },
  hook(ctx) {
    if (ctx.isServerComponent)
      return {
        ok: true, importSource: "next-intl/server", importName: "getTranslations", makeAsync: true,
        statement: ({ tName, ns, hook }) => `const ${tName} = await ${hook}(${q(ns)});`,
      };
    return {
      ok: true, importSource: "next-intl", importName: "useTranslations",
      statement: ({ tName, ns, hook }) => `const ${tName} = ${hook}(${q(ns)});`,
    };
  },
  isHookName: (n) => n === "useTranslations" || n === "getTranslations",
};

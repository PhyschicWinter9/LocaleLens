import type { I18nAdapter } from "@localelens/core";

const q = (s: string) => JSON.stringify(s);

export const createI18nextAdapter = (importSource = "react-i18next"): I18nAdapter => ({
  id: "i18next",
  placeholder: (name) => `{{${name}}}`,
  placeholderRe: /\{\{\s*([\w.$]+)\s*\}\}/g,
  callExpr(tName, key, vars) {
    const v = vars && Object.keys(vars).length
      ? `, { ${Object.entries(vars).map(([n, e]) => (n === e ? n : `${n}: ${e}`)).join(", ")} }`
      : "";
    return `${tName}(${q(key)}${v})`;
  },
  hook(ctx) {
    const base = { importSource, importName: "useTranslation" };
    if (ctx.isServerComponent)
      return { ...base, ok: false, reason: "react-i18next hooks cannot run in a Next.js Server Component. Add \"use client\", or use your project's server translation helper manually (LocaleLens can edit existing server t() calls).", statement: () => "" };
    return {
      ...base, ok: true,
      statement: ({ tName, ns, hook }) => `const { ${tName === "t" ? "t" : `t: ${tName}`} } = ${hook}(${q(ns)});`,
    };
  },
  isHookName: (n) => n === "useTranslation",
});

export const i18nextAdapter = createI18nextAdapter();

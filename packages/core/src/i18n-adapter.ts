/** Provider-independent adapter contract. Implementations live in adapter-* packages. */
export interface AdapterContext {
  namespace: string;
  isServerComponent: boolean;
}
export interface HookPlan {
  ok: boolean;
  reason?: string;
  importSource: string;
  importName: string;
  /** Statement inserted at the top of the component body. */
  statement: (o: { tName: string; ns: string; hook: string }) => string;
  /** Whether the enclosing component must become async (server components). */
  makeAsync?: boolean;
}
export interface I18nAdapter {
  id: "i18next" | "next-intl";
  /** `{{name}}` for i18next, `{name}` for ICU. */
  placeholder(name: string): string;
  placeholderRe: RegExp;
  callExpr(tName: string, key: string, vars?: Record<string, string>): string;
  hook(ctx: AdapterContext): HookPlan;
  /** Does this callee name create a translation function (useTranslation / useTranslations / getTranslations)? */
  isHookName(name: string): boolean;
}

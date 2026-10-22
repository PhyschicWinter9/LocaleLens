import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  root: z.string().min(1),
  pattern: z.string().min(1),
  namespace: z.string().optional(),
  nsInKey: z.boolean().optional(),
  nested: z.union([z.boolean(), z.literal("auto")]).optional(),
  writable: z.boolean().optional(),
  routes: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  framework: z.enum(["vite", "next-pages", "next-app", "next-hybrid", "react"]).default("vite"),
  provider: z.enum(["i18next", "next-intl"]).default("i18next"),
  defaultNamespace: z.string().default("common"),
  sourceLocale: z.string().default("en"),
  sourceRoots: z.array(z.string()).default(["src"]),
  workspaces: z.array(WorkspaceSchema).min(1),
  /** Dev origins of the app under inspection (informational + extra allowlist for Origin checks). */
  devOrigins: z.array(z.string()).default([]),
  /** Extra extension ids (the bundled LocaleLens id is always allowed). */
  extensionIds: z.array(z.string()).default([]),
  /** Extra i18n hook names recognised as producing `t`. */
  hookNames: z.array(z.string()).default([]),
  /** Module the translation hook is imported from (e.g. "next-i18next" instead of "react-i18next"). */
  importSource: z.string().optional(),
  port: z.number().int().min(1024).max(65535).default(4378),
});
export type LocaleLensConfig = z.infer<typeof ConfigSchema>;
export const CONFIG_FILE = "localelens.config.json";
export const STATE_DIR = ".localelens";

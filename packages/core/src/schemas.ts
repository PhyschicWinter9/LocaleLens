import { z } from "zod";
import { ErrorCodes } from "./errors.ts";

export const API_PREFIX = "/api/v1";

/** Opaque reference to an instrumented JSX element, produced by the compiler plugin. */
export const SourceRef = z.object({
  fileId: z.string().regex(/^[a-f0-9]{8}$/),
  n: z.number().int().min(0),
  fp: z.string().regex(/^[a-f0-9]{8}$/),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const ResolveReq = z.object({
  ref: SourceRef,
  text: z.string().max(5000),
  attr: z.string().max(50).optional(),
});

export const TranslationHit = z.object({
  workspaceId: z.string(),
  namespace: z.string(),
  key: z.string(),
  jsonPath: z.string(),
  values: z.record(z.string(), z.string()),
  locales: z.array(z.object({ locale: z.string(), file: z.string(), status: z.string(), value: z.string().optional() })),
  writable: z.boolean(),
});
export type TranslationHit = z.infer<typeof TranslationHit>;

/** Translation-side facts about an i18n-call occurrence, independent of how well the AST mapping matched. */
export const TranslationInfo = z.object({
  provider: z.string(),
  /** As written at the call site. */
  namespace: z.string().optional(),
  key: z.string().optional(),
  logicalPath: z.string().optional(),
  /** verified: exactly one owning file entry; ambiguous: several (never guessed); unresolved: none. */
  lookup: z.enum(["verified", "ambiguous", "unresolved"]),
  /** Does the verified value match the on-screen text? "unknown" when no text was given. */
  runtimeMatch: z.enum(["match", "mismatch", "unknown"]),
  hits: z.array(TranslationHit),
  code: z.string().optional(),
  message: z.string().optional(),
  /** Independent capabilities: editing the JSON needs no source rewrite. */
  canEditTranslation: z.boolean(),
  canRewriteSource: z.boolean(),
});
export type TranslationInfo = z.infer<typeof TranslationInfo>;

export const Candidate = z.object({
  id: z.string(),
  kind: z.enum(["jsx-text", "attribute", "string-expression", "template", "dynamic-text", "i18n-call", "unsupported"]),
  text: z.string(),
  attr: z.string().optional(),
  key: z.string().optional(),
  namespace: z.string().optional(),
  line: z.number(),
  column: z.number(),
  /** Set when the definition lives in a different file than the selected element. */
  file: z.string().optional(),
  confidence: z.enum(["exact", "pattern", "low"]),
  canExtract: z.boolean(),
  reason: z.string().optional(),
  template: z.string().optional(),
  vars: z.array(z.string()).optional(),
  values: z.record(z.string(), z.string()).optional(),
  translation: TranslationInfo.optional(),
});
export type Candidate = z.infer<typeof Candidate>;

export const ResolveRes = z.object({
  file: z.string(), // project-relative display path only
  componentName: z.string().optional(),
  candidates: z.array(Candidate),
  ambiguous: z.boolean(),
  suggestedWorkspaceId: z.string().optional(),
  suggestedNamespace: z.string().optional(),
  suggestedKey: z.string().optional(),
  extractBlocked: z.string().optional(),
});
export type ResolveRes = z.infer<typeof ResolveRes>;

export const ValuesByLocale = z.record(z.string().max(32), z.string().max(10000));

export const PreviewReq = z.object({
  mode: z.enum(["edit", "extract"]),
  workspaceId: z.string(),
  namespace: z.string().default("common"),
  key: z.string().min(1).max(200).regex(/^[\w$-]+(\.[\w$-]+)*$/),
  values: ValuesByLocale,
  source: z.object({ ref: SourceRef, candidateId: z.string(), text: z.string(), attr: z.string().optional() }).optional(),
  allowOverwrite: z.boolean().default(false),
});
export type PreviewReq = z.infer<typeof PreviewReq>;

export const FileChange = z.object({
  fileId: z.string(), file: z.string(), kind: z.enum(["source", "locale"]), created: z.boolean(), diff: z.string(),
});
export const PreviewRes = z.object({
  operationId: z.string(),
  changes: z.array(FileChange),
  diagnostics: z.array(z.object({ level: z.enum(["info", "warn"]), message: z.string() })),
  expiresAt: z.string(),
});
export type PreviewRes = z.infer<typeof PreviewRes>;

export const CommitReq = z.object({ operationId: z.string() });
export const UndoReq = z.object({ transactionId: z.string() });
export const SuggestReq = z.object({ text: z.string().max(2000), namespace: z.string().optional() });
export const LookupReq = z.object({ workspaceId: z.string().optional(), namespace: z.string().optional(), key: z.string().max(200) });

export const ApiError = z.object({
  error: z.object({ code: z.enum(ErrorCodes), message: z.string(), details: z.unknown().optional() }),
  requestId: z.string(),
});

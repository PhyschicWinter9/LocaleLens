export const ErrorCodes = [
  "UNAUTHORIZED", "FORBIDDEN_ORIGIN", "FORBIDDEN_HOST", "RATE_LIMITED", "BAD_REQUEST", "NOT_FOUND",
  "SOURCE_STALE", "SOURCE_AMBIGUOUS", "SOURCE_UNSUPPORTED", "HOOK_CONTEXT_INVALID", "SERVER_COMPONENT_UNSUPPORTED",
  "KEY_COLLISION", "PLACEHOLDER_MISMATCH", "REVISION_CONFLICT", "WRITE_FAILED", "UNDO_CONFLICT",
  "OPERATION_EXPIRED", "IMPORT_CONFLICT", "PARSE_ERROR", "PATH_ESCAPE", "IMPORT_INVALID", "INTERNAL",
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

export class LlError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown, public status = 400) {
    super(message);
    this.name = "LlError";
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Stage-specific translation diagnostics (resolution / editability), distinct from request errors above. */
export const TranslationCodes = [
  "TRANSLATION_REFERENCE_UNRESOLVED", "NAMESPACE_UNRESOLVED", "LOCALE_FILE_NOT_FOUND", "TRANSLATION_KEY_NOT_FOUND",
  "TRANSLATION_FILE_AMBIGUOUS", "RUNTIME_FILE_MAPPING_MISMATCH", "SOURCE_MAPPING_LOW_CONFIDENCE", "TRANSLATION_EDIT_UNAVAILABLE",
] as const;
export type TranslationCode = (typeof TranslationCodes)[number];

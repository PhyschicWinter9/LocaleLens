# Local Agent API v1

Base: `http://127.0.0.1:<port>/api/v1` · JSON · `Authorization: Bearer <token>` (except `/health`) · optional `x-request-id` is echoed and logged.
Errors: `{ "error": { "code", "message", "details?" }, "requestId" }`. Schemas live in `packages/core/src/schemas.ts` (Zod, shared with the agent).

| Method & path | Body → result |
|---|---|
| `GET /health` | `{ ok, product, version, authRequired }` (no auth) |
| `GET /status` | project name, framework, provider, source locale, workspaces, uptime, indexed files |
| `GET /diagnostics` | counters, last write, recent agent + extension logs |
| `POST /diagnostics/log` | `{ entries[] }` (≤100, sanitised again server-side) |
| `POST /diagnostics/clear` | clears both rings |
| `GET /workspaces` · `GET /locales` | roots, patterns, namespaces, locales, opaque `fileId`s |
| `GET /translations/list` | every key with per-locale values and `missing[]` |
| `POST /translations/lookup` | `{ namespace?, key, workspaceId? }` → hits. next-intl: `namespace.key` is split across file and JSON path; each hit carries `namespace`/`key` (file level), `jsonPath`, `locales[]` status and `writable` |
| `POST /keys/suggest` | `{ text, namespace? }` → collision-free camelCase key |
| `POST /source/resolve` | `{ ref:{fileId,n,fp}, text, attr? }` → `{ file, candidates[], ambiguous, suggested* }`. An `i18n-call` candidate has `translation`: `{ provider, logicalPath, lookup: verified|ambiguous|unresolved, runtimeMatch, hits[], code?, message?, canEditTranslation, canRewriteSource }`. Codes: `TRANSLATION_REFERENCE_UNRESOLVED`, `NAMESPACE_UNRESOLVED`, `LOCALE_FILE_NOT_FOUND`, `TRANSLATION_KEY_NOT_FOUND`, `TRANSLATION_FILE_AMBIGUOUS`, `RUNTIME_FILE_MAPPING_MISMATCH`, `TRANSLATION_EDIT_UNAVAILABLE`. Translation-only edit needs `lookup: verified` and does not rewrite source |
| `POST /source/editor-url` | `{ fileId, line }` → `vscode://file/...` |
| `GET /scan` | hardcoded strings + undefined keys |
| `POST /changes/preview` | `{ mode: "edit"\|"extract", workspaceId, namespace, key, values{locale:text}, source?{ref,candidateId,text,attr?} }` → `{ operationId, changes[{file,kind,created,diff}], diagnostics[], expiresAt }` (nothing written; 10 min TTL) |
| `POST /changes/commit` | `{ operationId }` → `{ transactionId, files[{rel,ok}], verified }` (one-shot) |
| `POST /changes/undo` | `{ transactionId }` |
| `GET /changes/history` | recent transactions |
| `POST /translations/export` | `{ format: "zip"\|"xlsx", workspaceIds?, namespaces?, locales? }` → base64 file |
| `POST /translations/import/preview` | `{ dataBase64 }` → `{ importId, report{changes,conflicts,invalid,…}, changes[diffs] }` |
| `POST /translations/import/commit` | `{ importId, resolutions{conflictId: "current"\|"incoming"\|{custom}} }` |

## Error codes

`UNAUTHORIZED` 401 · `FORBIDDEN_ORIGIN`/`FORBIDDEN_HOST` 403 · `RATE_LIMITED` 429 · `BAD_REQUEST` 400/413 · `NOT_FOUND` 404 · `SOURCE_STALE` 409 (reload page) · `SOURCE_AMBIGUOUS` · `SOURCE_UNSUPPORTED` (reason in message) · `HOOK_CONTEXT_INVALID` · `SERVER_COMPONENT_UNSUPPORTED` · `KEY_COLLISION` · `PLACEHOLDER_MISMATCH` · `REVISION_CONFLICT` 409 (file changed since preview) · `WRITE_FAILED` (rolled back) · `UNDO_CONFLICT` 409 · `OPERATION_EXPIRED` 410 · `IMPORT_INVALID` · `IMPORT_CONFLICT` · `PARSE_ERROR` · `PATH_ESCAPE` 403 · `INTERNAL` 500.

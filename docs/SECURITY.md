# Security model

LocaleLens writes source code, so the agent is treated as a privileged local service.

| Control | Implementation | Test |
|---|---|---|
| Loopback only | binds `127.0.0.1` | `security.test.ts` |
| Session token | `ll_` + 24 random bytes, constant-time compare, required on every route except minimal `/health` | `agent.test.ts` |
| Brute force | 20 failures/minute → `429` | `agent.test.ts` |
| DNS rebinding | `Host` must be `127.0.0.1`/`localhost`/`[::1]` with a port | `security.test.ts` |
| Origin / CSRF | web-page origins are never allowed; extension origin must be the pinned id (or listed in config); custom `Authorization` header forces CORS preflight | `agent.test.ts`, E2E |
| MV3 worker without `Origin` | allowed **only** because the bearer token is mandatory; no origin → no CORS headers | `agent.test.ts` |
| No path input from the browser | schemas accept only `fileId` (8 hex), workspace ids, locale/namespace segments, dotted keys | `security.test.ts` |
| Containment | every write path is canonicalised (realpath of deepest existing ancestor) and must stay inside the project; symlinks/junctions are not followed by discovery or the source index | `security.test.ts` |
| Safe parsing | 1 MB body cap (40 MB for imports), strict JSON, Zod on every body | `security.test.ts` |
| Safe writes | hash precondition, journal, backups, rollback, undo conflict detection | `writer-registry.test.ts` |
| Single writer | one agent per project (live-pid check) because locks are in-process | `security.test.ts` |
| Dev only | Vite `apply: "serve"`; Next acts only in the dev-server phase; production output verified free of `data-ll` and LocaleLens strings | E2E, `verify-install.mjs` |
| Excel / zip | size, entry-count, expansion and ratio limits **before** inflating; names with `..`, absolute or backslash paths rejected; macro workbooks rejected; formula cells rejected; translation cells are text-typed strings; edited identity columns rejected | `exchange.test.ts` |
| Logs | tokens, `Authorization`, secret-named keys redacted; long strings truncated; source files never logged | `security.test.ts`, E2E |
| Token storage | extension `storage.session` only (cleared when the browser closes); never in URLs, HTML, logs or exported bundles | E2E |

## Known gaps

- The token is also written to `.localelens/session.json` (mode `0600`; ignored by git) so `doctor` can find the agent. Anyone who can read your project folder as your user can read it.
- The embedded base snapshot inside a translator workbook is not signed. A translator who edits it can only cause more conflicts, never bypass the conflict check, but it is not tamper-proof.
- `anyExtension` mode in `DevAgent` options exists for testing; do not expose it in tooling.
- Windows: file mode bits are not enforced by the OS.

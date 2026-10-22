# Implementation status

Last full verification: 2026-10-21, Windows 10, Node 24.11, Bun 1.4.3, Chromium 1248 (Playwright, headless, extension loaded), Next 16.4.2, Vite 8, TypeScript 7, all dependencies at latest majors.

| Check | Result |
|---|---|
| `bun run build` (all packages + extension) | pass |
| `bun run typecheck` (TS 7, strict) | pass |
| Unit + integration (`vitest`, 7 files) | **108 / 108 pass** |
| Browser E2E (`playwright`, real Chromium + extension + dev servers) | **30 / 30 pass** |
| `scripts/pack.mjs` + `scripts/verify-install.mjs` (fresh project, tarballs only) | **7 / 7 checks pass** |
| TODO/FIXME in source | 0 |
| Mutation spot-checks (disable Host check / token compare / path containment → tests fail) | detected; restored |

The CI workflow (`.github/workflows/ci.yml`) has **not been run** on a CI machine.

## Required scenarios (spec §18)

| # | Scenario | Evidence |
|---|---|---|
| 1-2 | Popup connects; invalid token rejected | E2E `vite.spec` |
| 3 | Unauthorized origin rejected | `agent.test`, `security.test`, E2E (page-origin fetch blocked) |
| 4 | Service-worker restart recovery | E2E (CDP `stopAllWorkers`, then reconnect) |
| 5 | Open DevTools panel | **Partial**: the panel runs as an extension page opened with `?inspectedTabId=`; Playwright cannot drive the real F12 DevTools UI. `chrome.devtools.*` calls are not exercised. |
| 6-9 | Inspect, highlight, select occurrence, resolve exact file/line | E2E (Vite, Next Pages/App, Turbopack, webpack) |
| 10 | Edit existing translation | E2E; app updates; undo restores |
| 11-12 | Extract JSX text / attribute | `ast-engine.test`, E2E |
| 13-15 | Imports, hooks, invalid-hook prevention | `ast-engine.test` (function/arrow/expression-bodied/memo, class and module-level refused, alias reuse, no duplicates, CRLF) |
| 16 | Duplicate strings | E2E (second of two identical buttons resolves to its own line) |
| 17 | Multiple translation roots | E2E (`auth` root routed by source path) |
| 18 | Key collision | `writer-registry.test`, `agent.test` |
| 19-21 | Preview all files, reject stale revision, save | `agent.test`, E2E |
| 22 | Application updates | E2E (Vite, Next Turbopack; Next webpack needs a manual reload, see limitations) |
| 23 | Safe undo (and refusal after later edits) | `writer-registry.test`, `security.test`, E2E |
| 24-26 | Excel export, safe import, three-way conflicts | `exchange.test` (17), CLI + panel E2E |
| 27 | Production build excludes dev code | E2E for Vite and Next (Pages + App), `verify-install` |
| 28-30 | Pages Router, App Router, hybrid, Next 16 Turbopack (and `--webpack`) | `next.spec` (16 tests) |
| - | Failure injection: filesystem (rename fails mid-commit, crash recovery); messaging (worker killed) | `writer-registry.test`, E2E |

## Implemented

- **Compiler instrumentation** (Vite plugin; Next config wrapper with Turbopack rules + webpack loader), dev-only.
- **Source resolution** by `fileId:n:fingerprint`, with candidates for JSX text runs, dynamic text with simple expressions, string attributes, ternary/logical string leaves, template literals, fragments, and existing `t()` calls (alias-aware, namespace/`keyPrefix`-aware).
- **AST extraction** (magic-string edits, formatting + EOL preserved, post-transform re-parse and re-resolve): import, hook, call, interpolation; next-intl Server Components become `async` + `getTranslations`.
- **Locale registry**: independent roots, patterns (`{locale}/{ns}.json`, `{locale}.json`, ns-in-key), nested/flat detection, collision + shape-conflict detection, format-preserving JSON/JSONC edits, source routing.
- **Safe writer**: hash preconditions, per-file locks, journal, backups, rollback, undo, crash recovery.
- **Agent**: authenticated loopback API (docs/API.md), structured logs, diagnostics, single-instance guard.
- **Extension**: popup, DevTools panel (Overview, Inspector, Translations, Hardcoded, Missing Keys, Changes/Diff, Diagnostics, Settings), end-to-end self-check, light/dark, narrow layouts.
- **Translator exchange**: Excel/zip export with embedded base snapshot, import with three-way merge and per-conflict resolution, rename suggestions (`diffSnapshots`), formula/zip-bomb/traversal/macro protections.
- **CLI**: `init` (diff + approval + backups; patches Vite and Next configs by AST), `dev`, `doctor`, `scan`, `check`, `diff`, `undo`, `export`, `import`.

## Not verified

- Real F12 DevTools hosting (see #5); Microsoft Edge; macOS/Linux; non-headless Chrome.
- `next-i18next` (hook import source) is covered by detection/unit tests only; no browser E2E.
- `init --interactive` only confirms the whole plan; it does not let you edit individual detected workspaces.
- Monorepo layouts are detected only for locale folders under the project root; per-package monorepo setup is untested.
- Large-repository performance: `scan` parses every file in `sourceRoots` each time (no incremental index).
- CI workflow not executed.

## Known limitations

- **Unsupported (reported, never guessed)**: class components, JSX outside function components, non-trivial expressions in text (`{fmt(a)}`: assign to a variable first), react-i18next in Server Components, dynamic translation keys.
- **Rich text** (`Hello <b>world</b>!`): the sentence is split around child elements; extraction works but warns that translators cannot reorder across them.
- **Plurals / ICU select** are not generated or validated beyond placeholder name consistency.
- **YAML** locale files are not supported (JSON/JSONC only).
- **Components that do not forward `data-ll` to the DOM** show "no source mapping" for text rendered inside them.
- **Next `--webpack`** does not reliably hot-reload dynamically imported server JSON (reproducible with a plain editor save, so not caused by LocaleLens); Turbopack and Vite do. The panel says so instead of claiming success.
- **Content script** is declared for `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`; other dev hosts need the popup's "Enable on this site".
- Multi-file writes are not atomic; journal + rollback + recovery is provided instead.
- The first-run Next dev compile can take 10-30 s before text is selectable.

## Deviations from the proposed layout

Packages `shared`, `react`, `source-indexer`, `editor-ui`, `apps/translator-studio` were not created as separate units: `shared`→`core`, `editor-ui`→`extension`, source indexing lives in `dev-agent`/`ast-engine`, no React runtime is needed. **`apps/translator-studio` was not built**; translators use the Excel file directly.

## Remaining risks

1. The pinned extension signing key lives only in the gitignored `.keys/`; losing it prevents shipping a signed CRX with the same id.
2. Next/Turbopack loader APIs are young; `next` is pinned only by `^16` in the playgrounds. Re-run `bun run test:e2e` on every Next upgrade.
3. Fingerprint-based staleness is conservative: editing an element's own text or tag while a page is open requires a reload before selecting it again.

# Architecture

## Packages (consolidated from the original proposal)

| Package | Responsibility |
|---|---|
| `core` | Zod request/response schemas, error codes, structured logger + redaction, path containment, diff, adapter contract, config schema, pinned extension id. Also plays the role of the proposed `shared`. |
| `ast-engine` | Babel parse; candidate enumeration; dev-time `instrument()`; `extract()` source transformation (magic-string edits on node ranges). Also plays the role of `source-indexer`'s per-file logic. |
| `adapter-i18next`, `adapter-next-intl` | Provider differences: placeholder syntax, call/hook generation, server/client rules. |
| `locale-registry` | Workspaces (independent roots, patterns), discovery, key lookup, collision detection, format-preserving JSON/JSONC edits. |
| `file-writer` | Hash-checked transactions, journal, backups, rollback, undo, crash recovery. |
| `dev-agent` | Loopback HTTP API, auth, source index, resolve/preview/commit/undo, translation exchange. |
| `translation-excel` | Excel package build/parse, three-way merge, zip/xlsx hardening. |
| `vite`, `next` | Dev-only compile-time instrumentation (Vite plugin; Next config wrapper + webpack-style loader for Turbopack and webpack). |
| `extension` | MV3 popup, DevTools panel (Preact), service worker, content script. Plays the role of `editor-ui`. |
| `cli` | `localelens` executable. |

Not built: `react` runtime adapter (not needed: instrumentation is attributes, the page loads no LocaleLens runtime code), `source-indexer` as a separate package, `apps/translator-studio` (translators use Excel; see STATUS).

## Source identity (the core design decision)

Naive text matching cannot distinguish two `<button>Save</button>`. Instead the compiler plugin adds `data-ll="fileId:n:fp"` to every JSX element that owns translatable text:

- `fileId` = hash of the project-relative path (no absolute paths reach the page),
- `n` = ordinal of the element in document order,
- `fp` = fingerprint of the element's own tag + direct non-element children.

On click the agent re-reads the **current** file, takes element `n`, recomputes `fp` (mismatch → `SOURCE_STALE`, "reload the page"), and enumerates the element's occurrences (JSX text runs, string attributes, string leaves of conditionals, template literals, existing `t()` calls, dynamic text with simple expressions). The clicked text selects among them; several equally good matches are returned as `ambiguous` and the user chooses. Nothing is rewritten on a guess.

## Write path

`preview` → agent builds all new file contents in memory (AST edit + locale patches), validates them (re-parse, placeholder consistency, collisions), stores an operation, returns diffs. `commit` → `FileWriter`: per-file lock → re-check each file's hash against the preview → write backups + journal (`prepared`) → temp-file + rename for each file → journal `committed`. A failure part-way restores every already-written file. `undo` refuses if any file changed after the commit. Multi-file writes are **not** atomic; the journal + rollback + recovery (`undo --recover`) is what is provided instead.

## Messaging (extension)

Typed `Req`/`Res`/`Evt` envelopes with ids and timeouts. The service worker is stateless: token in `storage.session`, agent URL in `storage.local`, last selection and log ring in `storage.session`. Content scripts are injected programmatically if absent. The panel receives element events directly via runtime broadcast and recovers its last selection from the worker after reload. Every hop logs a named event (`element.selected` → `background.selection_received` → `panel.selection_received` → `source.resolve.*` → `changes.preview.*` → `changes.commit.*` → `hmr.update.detected`), visible in Diagnostics.

## Frameworks

- **Vite**: plugin with `apply: "serve"`, `enforce: "pre"`.
- **Next**: `withLocaleLens()` returns a config function that only acts in `phase-development-server`. It registers `turbopack.rules` (`*.tsx|jsx|ts|js`, `condition: { all: [{ not: "foreign" }, "development"] }`) and a webpack pre-loader. Both use one CJS loader bundle with all dependencies inlined, because it runs inside Next's loader workers.
- **Server Components**: next-intl gets `await getTranslations(ns)` and the component becomes `async`; react-i18next cannot run on the server, so extraction is refused with an explanation (editing existing translations still works).

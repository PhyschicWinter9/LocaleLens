# Troubleshooting

Start with **DevTools → LocaleLens → Diagnostics → Run self-check**. It proves each hop and the first red step is the broken component. "Connected" only proves the token works. Also: `npx localelens doctor`; for translation problems `npx localelens doctor --translations` (read-only; never rewrites files).

| Self-check step fails | Cause → fix |
|---|---|
| Extension background | Reload the extension at `chrome://extensions`. |
| Agent reachable | `localelens dev` is not running, wrong URL/port (default `127.0.0.1:4378`). |
| Authenticated | Token is per agent run and cleared when the browser closes. Copy the new one from the terminal. |
| Workspaces | No locale files match `root` + `pattern` in `localelens.config.json`. `doctor` names the workspace. |
| Content script | The tab is not `localhost`/`127.0.0.1`. Use **Enable on this site** in the popup. `chrome://` and the Web Store cannot be inspected. |
| Runtime instrumentation (0 mapped nodes) | Plugin not registered (`localelens init`), dev server not restarted, page not reloaded, or you are looking at a production build (never instrumented, by design). |
| Source resolution | `SOURCE_STALE`: file changed since the page compiled, reload. `NOT_FOUND` file id: file is outside `sourceRoots`. |

## Common messages

- **"no source mapping"** on click: the text does not come from a JSX element in `sourceRoots` (third-party component, text passed via props from elsewhere, or content rendered by a library).
- **Several candidates / "will not guess"**: the element has more than one matching occurrence (e.g. both branches of a ternary). Pick the right one.
- **Extraction refused: Server Component with react-i18next**: add `"use client"` or edit existing server translations only. next-intl is supported in Server Components.
- **`HOOK_CONTEXT_INVALID`**: the text is not inside a function component (class component, module-level JSX, plain helper). Move it into a component.
- **`REVISION_CONFLICT`**: you (or git) changed a file after the preview. Nothing was written. Preview again.
- **`UNDO_CONFLICT`**: files changed after the transaction; undo refuses to destroy newer edits. Use `localelens diff <id>`.
- **Interrupted write**: `localelens undo --recover`.
- **"Files written, but no DOM change observed"**: the app was not hot-reloaded. Next `--webpack` does not reliably watch dynamically imported server JSON (reproducible with a plain editor save); reload manually. Turbopack and Vite hot-reload it.
- **Another agent is already running**: one agent per project. Stop the other or delete a stale `.localelens/session.json`.
- **Debug logs**: Diagnostics → *Copy sanitized logs* / *Export bundle* (tokens are redacted). Loader failures print `[localelens] could not instrument …` in the dev-server terminal.

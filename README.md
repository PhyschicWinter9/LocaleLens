# LocaleLens

Click text in your running React / Next.js / Vite app, edit its translations, or turn hardcoded strings into i18n calls. LocaleLens previews the exact diff and writes it to your local project files, safely and with undo. Internal developer tool: **development mode only, local-first, no cloud.**

> Verified status (what is tested, what is not): [docs/STATUS.md](docs/STATUS.md).

## How it works in one minute

```
 your app (dev) ──data-ll attributes──▶ DevTools "LocaleLens" tab ──▶ Local Agent ──▶ your source + locale files
   compiler plugin                       Chrome/Edge MV3 extension      loopback only    hash-checked, journaled writes
```

1. A dev-only compiler plugin (Vite / Next) tags JSX elements that own text with `data-ll="<fileId>:<n>:<fingerprint>"`.
2. You click text in the page; the extension sends that reference to the agent.
3. The agent re-parses the real file, checks the fingerprint, and lists every candidate occurrence. It never guesses: ambiguity is shown, stale mappings are refused.
4. You edit translations or extract a hardcoded string; you see the diff of every file; you apply; the app hot-reloads.

## Install into a project

Requires Node ≥ 22.18. From your private registry, or from the tarballs in `release/` (see [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)):

```bash
npm i -D localelens @localelens/vite          # Vite;  use @localelens/next for Next.js
npx localelens init                           # shows a diff, asks before changing anything
npx localelens dev                            # prints the agent URL + session token
```

`init` detects framework/router/language/i18n library/locale folders and (with your approval) writes `localelens.config.json`, registers the plugin in `vite.config.*` / `next.config.*`, and ignores `.localelens/`. Flags: `--dry-run`, `--yes`, `--force`, `--interactive`. Existing files are backed up to `.localelens/backups/init/`.

## Install the extension (Chrome / Edge)

1. `bun run build` (or unzip `release/localelens-extension.zip`).
2. `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/dist`.
3. Click the toolbar icon, paste the token printed by `localelens dev`, **Connect**.
4. Open your app, press **F12**, choose the **LocaleLens** tab, click **Inspect Text**.

The extension ID is pinned (`jppgenfhanihnnjhghjfoldgdjhklloa`) and is the only extension origin the agent accepts by default.

## Commands

| Command | Purpose |
|---|---|
| `localelens init` | Detect + configure (diff, approval, backup) |
| `localelens dev [-- cmd]` | Start the agent (optionally run your dev server alongside) |
| `localelens doctor` | Diagnose setup with actionable fixes |
| `localelens scan` | List hardcoded strings and keys used but undefined (`--json`) |
| `localelens check` | CI gate: missing keys/locales, placeholder mismatches (`--hardcoded`) |
| `localelens diff [id]` / `undo [id]` | Inspect / safely revert a transaction (`undo --recover` after a crash) |
| `localelens export` / `import <file>` | Translator package (Excel) with three-way merge |

## Supported

React + Vite, Next.js Pages Router, App Router and hybrid projects, Next 16 Turbopack and webpack; JS/TS/JSX/TSX; react-i18next, next-i18next (hook import), next-intl; JSON/JSONC locale files in any number of independent roots. Limits are listed honestly in [docs/STATUS.md](docs/STATUS.md).

## Develop LocaleLens

```bash
bun install
bun run verify          # typecheck + unit/integration + build
bun run test:e2e        # real Chromium + extension + Vite/Next dev servers (needs `bunx playwright install chromium`)
node scripts/pack.mjs && node scripts/verify-install.mjs   # tarballs + fresh-project install check
```

Docs: [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Agent API](docs/API.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Distribution](docs/DISTRIBUTION.md)
"# LocaleLens" 

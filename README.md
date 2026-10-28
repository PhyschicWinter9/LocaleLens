# LocaleLens

Click text in your running React / Next.js / Vite app, edit its translations, or turn hardcoded strings into i18n calls. LocaleLens previews the exact diff and writes it to your local project files, with hash checks and undo. A developer tool for **development mode only, local-first, no cloud.**

> **Please read first: set your expectations.**
> LocaleLens is a personal project, built to solve a problem I had in my own development workflow. It is shared as-is, in case it is useful to someone else. It is **not** a polished, commercially supported product.
>
> - Expect rough edges, missing features and bugs. It has been tested on a limited set of setups (see [docs/STATUS.md](docs/STATUS.md) for exactly which).
> - It **modifies your source and translation files**. Commit or back up your work first, and review every diff before applying. Undo exists, but treat it as a safety net, not a guarantee.
> - There is no warranty, no guaranteed support, and no promise of fixes, new features or compatibility with future Next.js / Vite / browser versions.
> - Bug reports and pull requests are welcome, but responses may be slow or never come.
>
> If it doesn't fit your project, that's expected. It was built around mine.

> Verified status (what is tested, what is not): [docs/STATUS.md](docs/STATUS.md).

## How it works in one minute

```
 your app (dev) ──data-ll attributes──▶ DevTools "LocaleLens" tab ──▶ Local Agent ──▶ your source + locale files
   compiler plugin                       Chrome/Edge MV3 extension      loopback only    hash-checked, journaled writes
```

1. A dev-only compiler plugin (Vite / Next) tags JSX elements that own text with `data-ll="<fileId>:<n>:<fingerprint>"`.
2. You click text in the page; the extension sends that reference to the agent.
3. The agent re-parses the real file, checks the fingerprint, and lists every candidate occurrence. It never guesses: ambiguity is shown, stale mappings are refused. Text that comes from config objects (`{ label: t("common:email") }` rendered as `{column.label}` / `t(column.label)`) is traced to its definition in the same file, or in another file when the definition's value matches what is on screen. Import graphs are not followed, and anything unresolved is reported as such.
4. You edit translations or extract a hardcoded string; you see the diff of every file; you apply; the app hot-reloads.

## Install into a project

Requires Node ≥ 22.18. Install from npm (to try an unreleased build from this repo, use the tarballs described in [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)):

Works with **npm, pnpm and bun** (yarn is detected and gets the right command, but is not in the automated install check). Use `@localelens/next` instead of `@localelens/vite` for Next.js.

| | install | run the CLI |
|---|---|---|
| npm | `npm i -D localelens @localelens/vite` | `npx localelens init` · `npx localelens dev` |
| pnpm | `pnpm add -D localelens @localelens/vite` | `pnpm exec localelens init` · `pnpm exec localelens dev` |
| bun | `bun add -d localelens @localelens/vite` | `bunx localelens init` · `bunx localelens dev` |

`init` shows a diff and asks before changing anything; `dev` prints the agent URL and session token. `init` picks your package manager from the lockfile (`bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) and prints the matching install command. To start the agent together with your dev server: `localelens dev -- bun run dev` (or `pnpm dev`, `npm run dev`).

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
| `localelens uninstall` | Remove what `init` added (config, plugin wiring, ignore entry); keeps translations and backups, prints the package-removal command (`--dry-run`, `--yes`) |
| `localelens doctor` | Diagnose setup with actionable fixes (`--mui` also reports MUI packages) |
| `localelens scan` | List hardcoded strings and keys used but undefined (`--json`) |
| `localelens check` | CI gate: missing keys/locales, placeholder mismatches (`--hardcoded`) |
| `localelens diff [id]` / `undo [id]` | Inspect / safely revert a transaction (`undo --recover` after a crash) |
| `localelens export` / `import <file>` | Translator package (Excel) with three-way merge |

## Supported

React + Vite, Next.js Pages Router, App Router and hybrid projects, Next 16 Turbopack and webpack; JS/TS/JSX/TSX; react-i18next, next-i18next (hook import), next-intl; JSON/JSONC locale files in any number of independent roots. With next-intl, extraction keeps Server Components valid: route files (`page`, `layout`, ...) and already-async components get `await getTranslations`, other sync components get `useTranslations` without becoming async or client components; react-i18next in a Server Component is refused with an explanation. Limits are listed honestly in [docs/STATUS.md](docs/STATUS.md).

## Develop LocaleLens

```bash
bun install
bun run verify          # typecheck + unit/integration + build
bun run test:e2e        # real Chromium + extension + Vite/Next dev servers (needs `bunx playwright install chromium`)
node scripts/pack.mjs && node scripts/verify-install.mjs   # tarballs + fresh-project install check
```

Docs: [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Agent API](docs/API.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Distribution](docs/DISTRIBUTION.md)

## License

[GPL-3.0-only](LICENSE). In short: you may use, study, modify and share LocaleLens; if you distribute a modified version, you must do so under the same license and provide the source. LocaleLens runs only in development and adds nothing to your production build, so using it on a project does not by itself put your application under the GPL. (This is a plain-language summary, not legal advice; the license text governs.)

# localelens

CLI for [LocaleLens](https://www.npmjs.com/package/localelens): click text in your running React / Vite / Next.js dev app, edit its translation, or turn a hardcoded string into an i18n call, with a diff preview and undo.

> **Personal project, provided as-is.** LocaleLens was built to solve a problem in my own development workflow. Expect rough edges and limited testing. It **edits your source and translation files**: commit or back up first and review every diff. No warranty; support and fixes are best-effort.

## Use

```bash
npm i -D localelens @localelens/vite     # or @localelens/next for Next.js
npx localelens init                       # shows a diff, asks before changing anything
npx localelens dev                        # prints the agent URL + session token
```

pnpm: `pnpm add -D …` then `pnpm exec localelens init` · bun: `bun add -d …` then `bunx localelens init`.

Then install the LocaleLens browser extension (Chrome / Edge, Manifest V3), paste the token in its popup, open DevTools and use the **LocaleLens** tab.

Commands: `init`, `dev [-- your dev command]`, `doctor`, `scan`, `check`, `diff`, `undo`, `export`, `import`. Run `npx localelens help`.

Works with react-i18next, next-i18next and next-intl; JSON/JSONC locale files; Vite and Next.js (Pages, App, hybrid; Turbopack and webpack). Development mode only: nothing is added to production builds. Requires Node ≥ 22.18.

## License

GPL-3.0-only. See the LICENSE file in this package.

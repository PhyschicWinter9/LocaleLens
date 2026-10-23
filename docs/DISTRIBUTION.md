# Distribution & release

Three packages are published to npm; everything else in `packages/` is `private` and bundled into them.

| npm name | What |
|---|---|
| `localelens` | CLI (`npx localelens …`) |
| `@localelens/vite` | Dev-only Vite plugin |
| `@localelens/next` | Dev-only Next.js integration (Turbopack + webpack) |

The browser extension is distributed separately (zip / store), see below.

## Build artefacts (also used for trying an unreleased build)

```bash
bun install
node scripts/pack.mjs             # builds everything, writes ./release/*.tgz + the extension zip
node scripts/verify-install.mjs   # installs the tarballs into throwaway projects with npm, pnpm and bun and checks init/doctor/dev/build
```

Install an unreleased build from tarballs:
```bash
npm  i   -D ./localelens-0.5.0.tgz ./localelens-vite-0.5.0.tgz
pnpm add -D ./localelens-0.5.0.tgz ./localelens-vite-0.5.0.tgz
bun  add -d ./localelens-0.5.0.tgz ./localelens-vite-0.5.0.tgz
```

## Publishing to npm

One-time setup:
1. Create the npm scope: `@localelens` must be an npm **organization** (or your username) that you own. The names `localelens`, `@localelens/vite`, `@localelens/next` were unclaimed on npm when last checked.
2. Add `repository`, `homepage` and `bugs` to the three `package.json` files once the repo URL exists (npm shows them on the package page).
3. License is GPL-3.0-only (`LICENSE`, `license` field in each published `package.json`). If you ever want a different license, change both and tell contributors first.

Each release:
```bash
bun run verify && bun run test:e2e          # all green
bunx changeset && bunx changeset version     # bump versions + changelog
node scripts/pack.mjs && node scripts/verify-install.mjs
cd packages/vite && npm publish --access public   # then packages/next, then packages/cli
```
Publish `vite` and `next` first, then `localelens` (the CLI's `init` suggests installing them). Use `npm publish --dry-run` first to inspect the file list. Consider `--provenance` when publishing from CI.

Only `dist/`, `README.md`, `LICENSE` and `package.json` go into each tarball. The bundled `@localelens/*` internals are inlined, so no other `@localelens/*` package needs publishing. Third-party runtime dependencies (Babel, magic-string, jsonc-parser, zod, exceljs, fflate) are normal `dependencies`.

## Extension

- Manual: unzip `localelens-extension.zip` (or use `packages/extension/dist`) and **Load unpacked** in Chrome / Edge.
- Store: see [STORE_LISTING.md](STORE_LISTING.md). The extension ID is pinned from the public key in `packages/extension/extension-id.json`; the agent only accepts that ID. The store assigns its own ID when you upload an item **without** a `key`, so for a store release either upload with the key kept (allowed on first upload) or add the store's ID to `extensionIds` in users' `localelens.config.json`. Decide this before publishing, because users would otherwise be refused with `FORBIDDEN_ORIGIN`.
- The private key is in `.keys/extension-private.pem` (gitignored): back it up. Losing it means the pinned ID can't be reproduced.

# Internal distribution & release

## Build artefacts

```bash
bun install
node scripts/pack.mjs          # builds all packages + extension, writes ./release
node scripts/verify-install.mjs   # installs release/*.tgz into a throwaway project and checks init/doctor/dev/build
```

`release/` contains `localelens-<v>.tgz` (CLI), `localelens-vite-<v>.tgz`, `localelens-next-<v>.tgz`, `localelens-extension.zip`. Each package bundles its `@localelens/*` dependencies; only third-party runtime deps (Babel, magic-string, jsonc-parser, zod, exceljs, fflate) are installed from your registry.

## Option A: local tarballs (no registry)
```bash
npm i -D ./localelens-0.5.0.tgz ./localelens-vite-0.5.0.tgz
```

## Option B: private registry
Packages are `UNLICENSED` with `publishConfig.access = restricted`. Example with Verdaccio / GitHub Packages / Artifactory:
```bash
npm config set @localelens:registry https://registry.internal.example/
npm publish release/localelens-vite-0.5.0.tgz
npm publish release/localelens-next-0.5.0.tgz
# the CLI is the unscoped `localelens`: publish to the same registry and set `registry=` for that name or scope it before publishing
```
Versioning uses Changesets (`.changeset/`): `bunx changeset` → `bunx changeset version` → `node scripts/pack.mjs`.

## Extension
- Developer/QA: unzip `localelens-extension.zip`, **Load unpacked**.
- Managed fleet: the pinned id is derived from the public key in `packages/extension/extension-id.json`. To ship a signed `.crx` (force-install policy) you need the private key. It was generated into `.keys/extension-private.pem` (gitignored): **back it up to your secret store**; if lost, regenerate with `scripts/gen-extension-key.mjs` after deleting the json, which changes the id (update `EXTENSION_ID` consumers via the script).
- Not published to the Chrome Web Store.

## Release checklist
1. `bun run verify` and `bun run test:e2e` green. 2. `node scripts/pack.mjs && node scripts/verify-install.mjs`. 3. Update `docs/STATUS.md` numbers. 4. Tag + publish tarballs. 5. Attach the extension zip.

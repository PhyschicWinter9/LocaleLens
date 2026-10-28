# CI/CD and releasing

Internal tool: packages go to **GitHub Packages** (private), assets to **GitHub Releases**. Nothing is published to public npm.

## Architecture

| File | Runs on | Does |
|---|---|---|
| `.github/workflows/ci.yml` | pull requests; called by `release.yml` for `main` | `verify` (frozen install, typecheck, build, vitest, `release-check`), `e2e` (Playwright + extension), `package` (pack, `verify-install` with npm/pnpm/bun, release assets + checksum verify) |
| `.github/workflows/release.yml` | push to `main`, manual | CI gate, then `version-pr` (Changesets) and `detect` -> `publish` (approval-gated) |
| `.github/workflows/security.yml` | PRs, `main`, weekly | secret-pattern + forbidden-file scan of tracked files, `bun audit --audit-level=high` |
| `.github/dependabot.yml` | weekly | grouped minor/patch PRs, separate major PRs, Actions updates |
| `scripts/release-check.mjs` | CI + release | versions in sync, MV3 manifest, only the 3 designated packages publishable, `publishConfig`, tracked-file and `npm pack` allowlists, secret scan of tarball files |
| `scripts/release-artifacts.mjs` | CI + release | extension zip scan, `localelens-extension-vX.zip`, `localelens-packages-vX.zip`, `checksums.sha256`, `release-manifest.json`; `--verify` re-checks hashes |
| `scripts/sync-versions.mjs` | `bun run version-packages` | copies the CLI version to every workspace package, `manifest.json` and both `VERSION` constants |

No linter is configured in this repo; strict TypeScript is the static check. Add ESLint/Biome as its own change if wanted.

## Lifecycle

PR -> `ci.yml` -> merge -> `release.yml` re-runs CI on `main` -> if changesets are pending, `version-pr` opens/updates the **"chore: version packages"** PR (version bump, `CHANGELOG.md`, lockfile, synced extension version) -> review and merge it -> `detect` sees no pending changesets and no `v<version>` tag -> `publish` waits for approval of the `release` environment -> builds, validates, publishes, tags, creates the GitHub Release.

Ordinary commits never reach `publish`. Published packages: `@localelens/cli` (bin `localelens`), `@localelens/vite`, `@localelens/next`, versioned together (`fixed` group). Everything else is `private: true` and bundled.

## Creating a changeset

```bash
bunx changeset          # pick packages + bump type, write the summary; commit the .changeset/*.md file
```

0.x rules: **patch** = fix, **minor** = feature or anything that can change the agent/extension protocol, **major** = breaking (post-1.0). Agent and extension must match on major.minor; the popup shows an "incompatible" error otherwise, and `release-manifest.json` records the expected range.

Prerelease: `bunx changeset pre enter beta`, commit, release as usual (`1.0.0-beta.0`, dist-tag `beta`, GitHub Release flagged prerelease); `bunx changeset pre exit` to leave.

## One-time setup (manual, not done by the repo)

1. **Scope = owner.** GitHub Packages only accepts `@<owner>/name` where owner is the repository's user/org. The packages are `@localelens/*`, so the repo must live in a GitHub **organization named `localelens`**. Today it is `PhyschicWinter9/LocaleLens`; `release-check.mjs --registry` (used by `publish`) fails until the owner matches. Alternative: rename the packages to `@physchicwinter9/*` (package names, `installHint`, docs, tests) and update `PUBLISHED` in `release-check.mjs`.
2. Settings -> Actions -> General: workflow permissions "Read repository contents" (jobs request more explicitly); tick **Allow GitHub Actions to create and approve pull requests**.
3. Settings -> Environments -> create **`release`**, add required reviewers, restrict to branch `main`.
4. Settings -> Branches -> protect `main`: require PR, require checks `typecheck · unit · build · release-check`, `browser e2e (Chromium + extension)`, `pack · install (npm/pnpm/bun) · release assets`, require review (Dependabot major PRs included).
5. Secret **`RELEASE_PR_TOKEN`** (fine-grained PAT or GitHub App token, contents + pull requests write). PRs created by `GITHUB_TOKEN` do not trigger CI, so without it required checks never run on the Version PR. Falls back to `GITHUB_TOKEN`.
6. Enable secret scanning/push protection and Dependabot alerts (private repos: requires GitHub Advanced Security for secret scanning).
7. Consumers need a read token: `.npmrc` with `@localelens:registry=https://npm.pkg.github.com` and `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (a PAT with `read:packages`). Never commit a token.

Publishing uses the job's short-lived `GITHUB_TOKEN` (`packages: write`). GitHub Packages has no npm OIDC trusted publishing, and build provenance attestations are not set up (private repos need GitHub Enterprise).

## Manual release / dry run

Actions -> **release** -> Run workflow on `main`. `publish: false` (default) builds, validates and uploads `release-out` as a workflow artifact without publishing. `publish: true` publishes and creates the release (still behind `release` approval). Locally:

```bash
bun install --frozen-lockfile
node scripts/pack.mjs && node scripts/verify-install.mjs
node scripts/release-check.mjs            # add --registry to test the scope rule
node scripts/release-artifacts.mjs && node scripts/release-artifacts.mjs --verify
```

## Retries and failures

- `changeset publish` skips versions already on the registry, so re-running after a partial publish only publishes what is missing.
- `detect` skips when tag `v<version>` exists; the tag is created last (by `gh release create`), so any failure before it leaves the run retryable. A retry of the release step uploads assets with `--clobber` instead of creating a duplicate.
- A package published but its tag not pushed: re-run; `git push origin --tags` is idempotent.
- Never overwrite a published version; bump with a new changeset instead. To withdraw: delete the package version in GitHub Packages UI and the Release/tag, then re-run.
- `release-check` failure = nothing was published (it runs before publish). Read the listed paths.

## Extension distribution

`localelens-extension-vX.zip` is for **manual** install only: unzip, `chrome://extensions` (or `edge://extensions`) -> Developer mode -> Load unpacked. To update: download the new zip, replace the folder, click reload. A GitHub Release does **not** give browsers automatic updates; that needs a store listing ([STORE_LISTING.md](STORE_LISTING.md)). The extension id is pinned by `packages/extension/extension-id.json`; the private key (`.keys/`) is never in git or any asset.

Verify downloads: `sha256sum -c checksums.sha256`.

## Dependency policy

Dependabot opens weekly grouped minor/patch PRs and one PR per major. Nothing auto-merges; CI must pass and a maintainer reviews. Lockfile is `bun.lock`; Dependabot updates it. `example/` is not a workspace and is gitignored.

## Known limitations

Workflows are validated for YAML and by running their scripts locally; they have not run on GitHub. Git history was checked for `.pem`, `.env`, `session.json`, `.keys/` and `example/` paths: none found.

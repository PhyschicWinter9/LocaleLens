// Release gate: version sync, MV3 manifest, publishable-package set, tracked-file and tarball allowlists.
// `--registry` additionally requires the npm scope to equal the GitHub repository owner (GitHub Packages rule).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };

export const PUBLISHED = { cli: "@localelens/cli", vite: "@localelens/vite", next: "@localelens/next" };
export const FORBIDDEN = [/(^|\/)\.env(\.|$)/, /(^|\/)\.localelens\//, /session\.json$/, /(^|\/)\.keys\//, /\.pem$/, /\.key$/, /(^|\/)example\//, /(^|\/)\.tmp\//, /\.map$/, /\.(bak|orig|journal)$/, /(^|\/)node_modules\//];
export const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_\w{40,}|npm_[A-Za-z0-9]{36}|_authToken\s*=\s*\S/;

// ponytail: only runs as a gate when invoked directly, so release-artifacts.mjs can import the constants
if (import.meta.filename === process.argv[1]) {
  // 1. versions
  const version = json("packages/cli/package.json").version;
  for (const d of Object.keys(PUBLISHED)) check(json(`packages/${d}/package.json`).version === version, `packages/${d} version out of sync`);
  const manifest = json("packages/extension/manifest.json");
  check(manifest.version === version, `manifest.json version ${manifest.version} != ${version}`);
  for (const p of ["packages/dev-agent/src/server.ts", "packages/extension/src/common.ts"]) check(read(p).includes(`VERSION = "${version}"`), `${p} VERSION out of sync`);
  check(/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version), `not SemVer: ${version}`);

  // 2. MV3 manifest (source) and, when built, the files it references
  check(manifest.manifest_version === 3, "manifest_version must be 3");
  for (const k of ["name", "version", "description", "background", "icons"]) check(manifest[k], `manifest missing ${k}`);
  check(!/unsafe-eval|unsafe-inline/.test(JSON.stringify(manifest.content_security_policy ?? {})), "CSP must not allow unsafe-eval/inline");
  check(!manifest.background?.scripts && !manifest.browser_action && !manifest.page_action, "MV2 keys present");
  const dist = "packages/extension/dist";
  if (fs.existsSync(path.join(root, dist))) {
    const refs = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.devtools_page, ...Object.values(manifest.icons ?? {}), ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? [])];
    for (const f of refs.filter(Boolean)) check(fs.existsSync(path.join(root, dist, f)), `built extension missing ${f}`);
    check(json(`${dist}/manifest.json`).version === version, "built extension manifest version differs");
  }

  // 3. publishable set
  const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? json("packages/cli/package.json").repository.url.match(/github\.com[/:]([^/]+)\//)?.[1] ?? "").toLowerCase();
  for (const d of fs.readdirSync(path.join(root, "packages"))) {
    const p = json(`packages/${d}/package.json`), pub = d in PUBLISHED;
    check(pub ? !p.private : p.private === true, `packages/${d}: ${pub ? "must be publishable" : "must be private:true"}`);
    if (!pub) continue;
    check(p.name === PUBLISHED[d], `packages/${d} name ${p.name} != ${PUBLISHED[d]}`);
    check(p.publishConfig?.registry === "https://npm.pkg.github.com" && p.publishConfig?.access === "restricted", `${p.name}: publishConfig must target GitHub Packages, restricted`);
    check(p.repository?.url, `${p.name}: repository required by GitHub Packages`);
    for (const [n, v] of Object.entries({ ...p.dependencies, ...p.peerDependencies })) check(!n.startsWith("@localelens/") && !String(v).startsWith("workspace:"), `${p.name}: runtime dep ${n}@${v} would not resolve (internals are bundled)`);
    if (process.argv.includes("--registry")) check(p.name.startsWith(`@${owner}/`), `${p.name}: GitHub Packages scope must equal repository owner "@${owner}"`);
  }
  check(json("packages/cli/package.json").bin?.localelens === "dist/bin.js", "CLI bin `localelens` missing");

  // 4. tracked files
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const f of tracked) if (FORBIDDEN.some((r) => r.test(f))) errors.push(`forbidden file tracked by git: ${f}`);

  // 5. tarball allowlist (what npm would publish)
  const ALLOW = /^(package\.json|README(\.md)?|LICENSE|CHANGELOG\.md|index\.d\.ts|dist\/.+)$/;
  for (const d of Object.keys(PUBLISHED)) {
    const dir = path.join(root, "packages", d);
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" });
    if (r.status) { errors.push(`npm pack failed in ${d}: ${r.stderr}`); continue; }
    const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
    check(files.some((f) => f.startsWith("dist/")), `${d}: no dist/ in tarball (run bun run build first)`);
    for (const f of files) {
      check(ALLOW.test(f), `${d}: file outside allowlist: ${f}`);
      check(!FORBIDDEN.some((x) => x.test(f)), `${d}: forbidden file in tarball: ${f}`);
      if (fs.statSync(path.join(dir, f)).size < 5e6 && SECRET.test(fs.readFileSync(path.join(dir, f), "utf8"))) errors.push(`${d}: secret-like content in ${f}`);
    }
  }

  if (errors.length) { console.error("release-check FAILED:\n" + errors.map((e) => "  - " + e).join("\n")); process.exit(1); }
  console.log(`release-check ok (v${version})`);
}

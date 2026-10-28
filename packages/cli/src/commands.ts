import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  CONFIG_FILE, ConfigSchema, LlError, Logger, STATE_DIR, sha256, unifiedDiff, type LocaleLensConfig,
} from "@localelens/core";
import { DevAgent, AgentService, Exchange, loadConfig, VERSION } from "@localelens/dev-agent";
import { FileWriter } from "@localelens/file-writer";
import { LocaleRegistry, validatePlaceholders } from "@localelens/locale-registry";
import { createI18nextAdapter } from "@localelens/adapter-i18next";
import { nextIntlAdapter } from "@localelens/adapter-next-intl";
import { detect, type Detection } from "./detect.ts";
import { patchNextConfig, patchViteConfig, unpatchNextConfig, unpatchViteConfig, type Patch } from "./patch.ts";

export interface Flags { _: string[]; [k: string]: string | boolean | string[] | undefined }
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
const out = (s = "") => process.stdout.write(s + "\n");
const rootOf = (f: Flags) => path.resolve(String(f.cwd ?? process.cwd()));

async function confirm(q: string, f: Flags): Promise<boolean> {
  if (f.yes) return true;
  if (!process.stdin.isTTY) { out(c.yellow(`${q} — skipped (non-interactive; pass --yes to apply).`)); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

// ---------------------------------------------------------------- init
export async function init(f: Flags) {
  const root = rootOf(f);
  const d = detect(root);
  printDetection(d);

  const patches: Patch[] = [];
  const cfgPath = path.join(root, CONFIG_FILE);
  const cfgText = JSON.stringify(d.config, null, 2) + "\n";
  const existingCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;
  if (existingCfg !== null && !f.force) out(c.yellow(`${CONFIG_FILE} already exists: keeping it (use --force to replace; a backup is made).`));
  else patches.push({ rel: CONFIG_FILE, before: existingCfg ?? "", after: cfgText, note: existingCfg ? "replace config (backup kept)" : "create config" });

  if (d.viteConfig) {
    const p = path.join(root, d.viteConfig);
    const before = fs.readFileSync(p, "utf8");
    const after = patchViteConfig(before, d.viteConfig);
    if (after === null) out(c.yellow(`Could not patch ${d.viteConfig} safely. Add manually:\n  import localelens from "@localelens/vite";\n  plugins: [localelens(), ...]`));
    else if (after !== before) patches.push({ rel: d.viteConfig, before, after, note: "register dev-only Vite plugin" });
    else out(c.dim(`${d.viteConfig}: plugin already registered.`));
  } else if (d.framework === "vite") out(c.yellow("Vite detected but no vite.config.* found: create one and add localelens() to plugins."));
  if (d.framework.startsWith("next")) {
    if (d.nextConfig) {
      const p = path.join(root, d.nextConfig);
      const before = fs.readFileSync(p, "utf8");
      const after = patchNextConfig(before, d.nextConfig);
      if (after === null) out(c.yellow(`Could not patch ${d.nextConfig} safely. Wrap your export manually:
  import { withLocaleLens } from "@localelens/next";
  export default withLocaleLens(yourConfig);`));
      else if (after !== before) patches.push({ rel: d.nextConfig, before, after, note: "wrap config with dev-only withLocaleLens()" });
      else out(c.dim(`${d.nextConfig}: already integrated.`));
    } else patches.push({ rel: "next.config.mjs", before: "", after: `import { withLocaleLens } from "@localelens/next";

export default withLocaleLens({});
`, note: "create config with dev-only withLocaleLens()" });
  }

  const gi = path.join(root, ".gitignore");
  const giBefore = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!/^\.localelens\/?$/m.test(giBefore)) patches.push({ rel: ".gitignore", before: giBefore, after: giBefore + (giBefore && !giBefore.endsWith("\n") ? "\n" : "") + `${STATE_DIR}/\n`, note: "ignore local state (session token, backups)" });

  if (!patches.length) { out(c.green("\nNothing to change. Run `localelens doctor` to verify.")); return 0; }
  const applied = await applyPatches(root, patches, f);
  if (applied !== -1) return applied;
  out(`\nInstall the plugin package, then start your app and the agent:\n  ${installHint(d)}\n  localelens dev            ${c.dim("(prints the session token for the browser extension)")}`);
  return 0;
}

/** Show diffs, confirm, back up originals, then write (or delete when `after` is null). Returns -1 once applied, else an exit code. */
async function applyPatches(root: string, patches: Patch[], f: Flags, label = "init"): Promise<number> {
  out(c.bold("\nProposed changes:"));
  for (const p of patches) { out(`\n${c.bold(p.rel)} ${c.dim("— " + p.note)}`); out(unifiedDiff(p.before, p.after ?? "").split("\n").map((l) => l.startsWith("+") ? c.green(l) : l.startsWith("-") ? c.red(l) : c.dim(l)).join("\n")); }
  if (f["dry-run"]) { out(c.dim("\n--dry-run: no files were changed.")); return 0; }
  if (!(await confirm("\nApply these changes?", f))) { out("Aborted. Nothing was changed."); return 1; }
  for (const p of patches) {
    const abs = path.join(root, p.rel);
    if (p.before && fs.existsSync(abs)) {
      if (fs.readFileSync(abs, "utf8") !== p.before) { out(c.red("✗ ") + `${p.rel} changed since the plan was made: skipped`); continue; }
      const bdir = path.join(root, STATE_DIR, "backups", label);
      fs.mkdirSync(bdir, { recursive: true });
      fs.copyFileSync(abs, path.join(bdir, p.rel.replace(/[\\/]/g, "_") + `.${Date.now()}.bak`));
    }
    if (p.after === null) fs.rmSync(abs, { force: true }); else fs.writeFileSync(abs, p.after);
    out(c.green("✓ ") + p.rel);
  }
  return -1;
}

// ---------------------------------------------------------------- uninstall
/** Remove only what `init` added. Translations, app code and dependencies are never touched. */
export async function uninstall(f: Flags) {
  const root = rootOf(f);
  const d = detect(root);
  const patches: Patch[] = [];
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  for (const [rel, fn, pkg] of [[d.viteConfig, unpatchViteConfig, "@localelens/vite"], [d.nextConfig, unpatchNextConfig, "@localelens/next"]] as const) {
    if (!rel) continue;
    const before = read(rel);
    if (!before.includes(pkg)) continue;
    const after = fn(before, rel);
    if (after === null) out(c.yellow(`Could not unpatch ${rel} safely: remove the ${pkg} import and usage by hand.`));
    else patches.push({ rel, before, after, note: "remove LocaleLens plugin/wrapper" });
  }
  if (fs.existsSync(path.join(root, CONFIG_FILE))) patches.push({ rel: CONFIG_FILE, before: read(CONFIG_FILE), after: null, note: "delete LocaleLens config" });
  const stateDir = path.join(root, STATE_DIR);
  const keepState = fs.existsSync(path.join(stateDir, "backups")) || !!f["dry-run"];
  if (fs.existsSync(path.join(root, ".gitignore")) && !keepState) {
    const before = read(".gitignore");
    const after = before.replace(/^\.localelens\/?\r?\n/m, "");
    if (after !== before) patches.push({ rel: ".gitignore", before, after, note: "remove state-dir ignore entry" });
  }
  if (!patches.length && !fs.existsSync(stateDir)) { out(c.green("Nothing to uninstall.")); return 0; }
  const code = await applyPatches(root, patches, f, "uninstall");
  if (code !== -1) return code;
  if (fs.existsSync(stateDir)) for (const e of fs.readdirSync(stateDir)) if (e !== "backups") fs.rmSync(path.join(stateDir, e), { recursive: true, force: true });
  const rm = fs.existsSync(path.join(root, "bun.lock")) ? "bun remove" : fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm remove" : "npm uninstall";
  out(`\nTranslations and app code were not touched. Backups are kept in ${STATE_DIR}/backups. Then remove the packages:\n  ${rm} localelens @localelens/next @localelens/vite`);
  return 0;
}

function installHint(d: Detection) {
  const add = { bun: "bun add -d", pnpm: "pnpm add -D", yarn: "yarn add -D", npm: "npm i -D" }[d.packageManager];
  return `${add} localelens ${d.framework.startsWith("next") ? "@localelens/next" : "@localelens/vite"}   ${c.dim("(from your private registry or a local tarball)")}`;
}

function printDetection(d: Detection) {
  out(c.bold("Detected"));
  const row = (k: string, v: string) => out(`  ${k.padEnd(16)}${v}`);
  row("Framework", `${d.framework}${d.frameworkVersion ? " " + d.frameworkVersion : ""}${d.reactVersion ? ` · React ${d.reactVersion}` : ""}`);
  row("Language", d.language);
  row("Package manager", d.packageManager);
  row("i18n provider", d.provider ? `${d.provider}${d.importSource ? " via " + d.importSource : ""}` : c.yellow("none found"));
  row("Source locale", d.config.sourceLocale);
  row("Default namespace", d.config.defaultNamespace);
  row("Source roots", d.config.sourceRoots.join(", "));
  for (const w of d.config.workspaces) row("Workspace", `${w.id}: ${w.root}/${w.pattern}`);
  for (const n of d.notes) out(c.yellow("  ! " + n));
}

// ---------------------------------------------------------------- dev
export async function dev(f: Flags) {
  const root = rootOf(f);
  const cfg = await loadConfig(root);
  const agent = new DevAgent({ root, cfg, port: f.port ? Number(f.port) : undefined, token: f.token ? String(f.token) : undefined });
  const { port, token } = await agent.start();
  out(c.bold(`LocaleLens agent ${VERSION}`) + `  ${c.dim(path.basename(root))}`);
  out(`  URL    http://127.0.0.1:${port}`);
  out(`  Token  ${token}   ${c.dim("(paste into the extension popup; valid until this process exits)")}`);
  out(c.dim("  Listening on loopback only. Writes are restricted to the configured source and locale roots.\n"));
  const rest = f._.slice(1);
  let child: ReturnType<typeof spawn> | null = null;
  if (rest.length) {
    // Arguments are passed through verbatim. Windows needs a shell for npm/pnpm .cmd shims, so quote each argument there.
    const win = process.platform === "win32";
    const q = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`);
    child = win
      ? spawn(rest.map(q).join(" "), { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, LOCALELENS_AGENT_URL: `http://127.0.0.1:${port}` } })
      : spawn(rest[0], rest.slice(1), { cwd: root, stdio: "inherit", env: { ...process.env, LOCALELENS_AGENT_URL: `http://127.0.0.1:${port}` } });
    child.on("exit", async (code) => { await agent.stop(); process.exit(code ?? 0); });
  }
  const bye = async () => { child?.kill(); await agent.stop(); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  await new Promise(() => {});
}

// ---------------------------------------------------------------- shared
async function service(root: string) {
  const cfg = await loadConfig(root);
  const svc = new AgentService(root, cfg, new Logger("cli"));
  await svc.reindex();
  return { cfg, svc };
}

// ---------------------------------------------------------------- scan / check
export async function scan(f: Flags) {
  const { svc } = await service(rootOf(f));
  const r = await svc.scan(Number(f.limit ?? 2000));
  if (f.json) { out(JSON.stringify(r, null, 2)); return 0; }
  out(c.bold(`${r.hardcoded.length} hardcoded string(s)`) + (r.truncated ? " (truncated)" : ""));
  for (const h of r.hardcoded) out(`  ${h.file}:${h.line}  ${h.kind}${h.attr ? ":" + h.attr : ""}  ${JSON.stringify(h.text)}${h.canExtract ? "" : c.yellow("  [manual]")}`);
  out(c.bold(`\n${r.missingKeys.length} key(s) used but not defined`));
  for (const m of r.missingKeys) out(`  ${m.file}:${m.line}  ${m.namespace}:${m.key}`);
  if (r.parseErrors.length) out(c.yellow(`\n${r.parseErrors.length} file(s) skipped (parse errors): ${r.parseErrors.slice(0, 5).join(", ")}`));
  return 0;
}

/** CI gate. Exit 1 on missing keys, incomplete locales, placeholder mismatches (and hardcoded text with --hardcoded). */
export async function check(f: Flags) {
  const { svc, cfg } = await service(rootOf(f));
  const adapter = cfg.provider === "next-intl" ? nextIntlAdapter : createI18nextAdapter(cfg.importSource);
  const problems: string[] = [];
  const s = await svc.scan(5000);
  for (const m of s.missingKeys) problems.push(`${m.file}:${m.line} missing key ${m.namespace}:${m.key}`);
  const list = await svc.listTranslations();
  for (const e of list.entries) {
    if (e.missing.length) problems.push(`${e.workspaceId}/${e.namespace}:${e.key} missing in ${e.missing.join(", ")}`);
    for (const p of validatePlaceholders(adapter, e.values)) problems.push(`${e.workspaceId}/${e.namespace}:${e.key} placeholder mismatch (${p})`);
  }
  if (f.hardcoded) for (const h of s.hardcoded) problems.push(`${h.file}:${h.line} hardcoded ${JSON.stringify(h.text)}`);
  if (f.json) out(JSON.stringify({ ok: !problems.length, problems }, null, 2));
  else if (problems.length) { out(c.red(`${problems.length} problem(s):`)); problems.forEach((p) => out("  " + p)); }
  else out(c.green(`✓ ${list.entries.length} translation(s), ${s.missingKeys.length} missing keys, placeholders consistent.`));
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------- doctor
export async function doctor(f: Flags) {
  const root = rootOf(f);
  let failed = 0;
  const ok = (m: string) => out(c.green("✓ ") + m);
  const bad = (m: string, fix: string) => { failed++; out(c.red("✗ ") + m); out(c.dim("    → " + fix)); };
  const warn = (m: string, fix: string) => { out(c.yellow("! ") + m); out(c.dim("    → " + fix)); };

  const major = Number(process.versions.node.split(".")[0]);
  major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node}`, "Use Node 22.18 or newer");
  let cfg: LocaleLensConfig | null = null;
  try { cfg = await loadConfig(root); ok(`${CONFIG_FILE} valid (${cfg.framework}, ${cfg.provider})`); } catch (e) { bad((e as Error).message, "Run `localelens init`"); }
  if (cfg) {
    const reg = new LocaleRegistry(root, cfg.workspaces);
    for (const w of cfg.workspaces) {
      const files = await reg.discover(w);
      if (!files.length) { bad(`workspace "${w.id}": no locale files under ${w.root} matching ${w.pattern}`, "Check root/pattern in localelens.config.json"); continue; }
      let parseFail = 0;
      for (const fl of files) { try { await reg.read(w, fl.locale, fl.namespace); } catch { parseFail++; bad(`${fl.rel} is not valid JSON`, "Fix the syntax error"); } }
      if (!parseFail) ok(`workspace "${w.id}": ${files.length} file(s), locales ${[...new Set(files.map((x) => x.locale))].join(", ")}`);
    }
    for (const sr of cfg.sourceRoots) fs.existsSync(path.join(root, sr)) ? ok(`source root ${sr}/`) : bad(`source root ${sr}/ missing`, "Edit sourceRoots");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const lib = cfg.provider === "next-intl" ? "next-intl" : cfg.importSource ?? "react-i18next";
    deps[lib] ? ok(`${lib} installed`) : bad(`${lib} not in package.json`, `Install ${lib}`);
    if (f.mui) {
      const mui = Object.keys(deps).filter((k) => k.startsWith("@mui/") && !/icons|styled-engine|system|utils|private/.test(k));
      mui.length ? ok(`MUI: ${mui.map((k) => `${k}@${deps[k]}`).join(", ")}`) : warn("no @mui/* packages in package.json", "--mui checks are not applicable");
      if (mui.length) out(c.dim("    LocaleLens maps MUI text through the JSX/props you write (children, label/placeholder/title props, `{col.label}` and `t(col.label)` config objects in the same file). Text built inside MUI itself, DataGrid localeText and props passed from another file are not mapped."));
    }
    if (cfg.framework === "vite") {
      const vc = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find((x) => fs.existsSync(path.join(root, x)));
      if (!vc) bad("vite.config.* not found", "Create one");
      else fs.readFileSync(path.join(root, vc), "utf8").includes("@localelens/vite") ? ok(`${vc} registers the LocaleLens plugin`) : bad(`${vc} does not register the plugin`, "Run `localelens init`");
    }
    if (f.translations) failed += await translationChecks(root, cfg, ok, bad, warn);
    const sess = path.join(root, STATE_DIR, "session.json");
    if (!fs.existsSync(sess)) warn("agent not running (no session file)", "Start it with `localelens dev`");
    else {
      try {
        const s = JSON.parse(fs.readFileSync(sess, "utf8"));
        const r = await fetch(`http://127.0.0.1:${s.port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
        const j: any = await r.json();
        j.product === "localelens-agent" ? ok(`agent reachable on :${s.port} (v${j.version})`) : bad("something else is listening on the agent port", "Restart `localelens dev`");
      } catch { warn("stale session file: agent not reachable", "Restart `localelens dev`"); }
    }
    const writer = new FileWriter(root);
    const stuck = (await writer.list()).filter((j) => ["prepared", "committing", "needs-recovery"].includes(j.state));
    stuck.length ? bad(`${stuck.length} interrupted transaction(s)`, "Run `localelens undo --recover`") : ok("no interrupted write transactions");
  }
  out(failed ? c.red(`\n${failed} problem(s) found.`) : c.green("\nAll checks passed."));
  return failed ? 1 : 0;
}

/** `doctor --translations`: read-only validation of workspaces, namespace ownership and referenced keys. */
async function translationChecks(root: string, cfg: LocaleLensConfig, ok: (m: string) => void, bad: (m: string, fix: string) => void, warn: (m: string, fix: string) => void): Promise<number> {
  let failed = 0;
  const fail = (m: string, fix: string) => { failed++; bad(m, fix); };
  const svc = new AgentService(root, cfg, new Logger("doctor"));
  const r = await svc.translationReport();
  out(c.bold(`
Translations (${r.provider})`));
  for (const w of r.workspaces) {
    ok(`workspace "${w.id}": ${w.files} file(s), locales [${w.locales.join(", ")}], namespaces [${w.namespaces.slice(0, 12).join(", ")}${w.namespaces.length > 12 ? ", …" : ""}]`);
    for (const f of w.invalid) fail(`${f}: invalid JSON structure`, "Fix the syntax error");
  }
  for (const a of r.ambiguous.slice(0, 20)) fail(`TRANSLATION_FILE_AMBIGUOUS: "${a.logical}" defined in workspaces ${a.workspaces.join(", ")}`, "Keep one owner; LocaleLens refuses to write ambiguous keys");
  if (r.ambiguous.length > 20) out(c.dim(`    … ${r.ambiguous.length - 20} more`));
  if (r.localeGaps.length) warn(`${r.localeGaps.length} key(s) missing in some locale (e.g. ${r.localeGaps.slice(0, 3).join(", ")})`, "Fill them in the Translations tab or export for translators");
  for (const m of r.missingKeys.slice(0, 20)) fail(`TRANSLATION_KEY_NOT_FOUND: ${m.namespace}:${m.key} used at ${m.file}:${m.line}`, "Add the key to a locale file, or fix the namespace/key in the source");
  if (r.missingKeys.length > 20) out(c.dim(`    … ${r.missingKeys.length - 20} more`));
  if (!r.missingKeys.length) ok("every statically referenced key resolves to a locale file");
  for (const e of r.parseErrors.slice(0, 5)) warn(`could not parse ${e}`, "Excluded from the key check");
  return failed;
}

// ---------------------------------------------------------------- diff / undo
export async function diff(f: Flags) {
  const root = rootOf(f);
  const w = new FileWriter(root);
  const list = await w.list();
  const j = f._[1] ? list.find((x) => x.id === f._[1]) : list[0];
  if (!j) { out("No transactions recorded."); return 0; }
  out(c.bold(`Transaction ${j.id}`) + `  ${j.state}  ${j.createdAt}`);
  for (const file of j.files) {
    const cur = await fsp.readFile(path.join(root, file.rel), "utf8").catch(() => "");
    const before = file.backup ? await fsp.readFile(path.join(root, STATE_DIR, file.backup), "utf8").catch(() => "") : "";
    out(`\n${c.bold(file.rel)} ${sha256(cur) === file.afterHash ? c.dim("(as written)") : c.yellow("(modified since)")}`);
    out(unifiedDiff(before, cur));
  }
  return 0;
}

export async function undo(f: Flags) {
  const root = rootOf(f);
  const w = new FileWriter(root);
  if (f.recover) { const r = await w.recover(); out(r.length ? c.green(`Recovered ${r.length} transaction(s): ${r.join(", ")}`) : "Nothing to recover."); return 0; }
  const list = await w.list();
  const target = f._[1] ? list.find((x) => x.id === f._[1]) : list.find((x) => x.state === "committed");
  if (!target) { out("No committed transaction to undo."); return 1; }
  try { await w.undo(target.id); out(c.green(`✓ Undid ${target.id}: ${target.files.map((x) => x.rel).join(", ")}`)); return 0; }
  catch (e) { if (e instanceof LlError) { out(c.red(e.message)); return 1; } throw e; }
}

// ---------------------------------------------------------------- export / import (translator exchange)
export async function exportCmd(f: Flags) {
  const { svc } = await service(rootOf(f));
  const format = f.format === "xlsx" ? "xlsx" : "zip";
  const r = await new Exchange(svc).export({ format });
  const out_ = path.resolve(String(f.out ?? r.fileName));
  fs.writeFileSync(out_, r.data);
  out(c.green("✓ ") + `${r.count} keys → ${out_}`);
  out(c.dim("  Send this file to translators. They only need Excel."));
  return 0;
}

export async function importCmd(f: Flags) {
  const file = f._[1];
  if (!file) { out(c.red("usage: localelens import <file.xlsx|zip> [--yes] [--resolve current|incoming]")); return 1; }
  const { svc } = await service(rootOf(f));
  const ex = new Exchange(svc);
  const p = await ex.importPreview(new Uint8Array(fs.readFileSync(path.resolve(file))));
  const r = p.report;
  out(c.bold("Import preview"));
  out(`  ${r.changes.length} change(s), ${r.conflicts.length} conflict(s), ${r.invalid.length} invalid, ${r.unchanged + r.alreadyApplied} unchanged`);
  for (const w of p.warnings) out(c.yellow("  ! " + w));
  for (const i of r.invalid) out(c.red(`  ✗ ${i.key} [${i.locale}] ${i.message}`));
  for (const x of r.conflicts) out(c.yellow(`  ⚠ ${x.key} [${x.locale}] ${x.reason}: base=${JSON.stringify(x.base)} current=${JSON.stringify(x.current)} incoming=${JSON.stringify(x.incoming)}`));
  for (const ch of p.changes) { out(`\n${c.bold(ch.file)}${ch.created ? c.green(" (new)") : ""}`); out(ch.diff); }
  const res = f.resolve === "incoming" || f.resolve === "current" ? Object.fromEntries(r.conflicts.map((x) => [x.conflictId, f.resolve as "current" | "incoming"])) : {};
  if (r.conflicts.length && !f.resolve) { out(c.red("\nConflicts need a decision: re-run with --resolve current (keep project) or --resolve incoming (take sheet).")); return 2; }
  if (!r.changes.length && !r.conflicts.length) { out("Nothing to apply."); return 0; }
  if (!(await confirm("\nApply?", f))) { out("Aborted. Nothing was changed."); return 1; }
  const c2 = await ex.importCommit(p.importId, res);
  out(c.green(`✓ applied ${c2.applied} change(s)`) + (c2.transactionId ? `  undo with: localelens undo ${c2.transactionId}` : ""));
  return 0;
}

void ConfigSchema;

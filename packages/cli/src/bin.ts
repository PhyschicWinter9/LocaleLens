import { parseArgs } from "./args.ts";
import { check, dev, exportCmd, importCmd, diff, doctor, init, scan, undo, uninstall, type Flags } from "./commands.ts";

const HELP = `localelens <command> [options]

  init      Detect the project, write localelens.config.json, register the dev plugin
            --dry-run  --yes  --interactive  --force
  uninstall Remove what init added (config, plugin wiring); keeps translations   --dry-run  --yes
  dev       Start the local agent (prints the session token)   [-- <your dev command>]
            --port <n>
  doctor    Diagnose setup problems
  scan      List hardcoded strings and undefined keys          --json
  check     CI gate: missing keys / locales / placeholders     --hardcoded --json
  diff      Show what the last transaction changed             [transaction-id]
  undo      Undo the last committed transaction                [transaction-id] --recover

  export    Write a translator package (xlsx inside zip)       --out <file> --format zip|xlsx
  import    Merge a returned xlsx/zip (three-way, safe)        <file> --resolve current|incoming --yes

Global: --cwd <dir>`;

async function main() {
  const f = parseArgs(process.argv.slice(2));
  const cmd = f._[0];
  const table: Record<string, (f: Flags) => Promise<number | void>> = { init, uninstall, dev, doctor, scan, check, diff, undo, export: exportCmd, import: importCmd };
  if (!cmd || cmd === "help" || f.help || !table[cmd]) { console.log(HELP); process.exit(cmd && !table[cmd] && cmd !== "help" ? 1 : 0); }
  try { process.exit((await table[cmd](f)) ?? 0); }
  catch (e: any) { console.error(`\x1b[31merror\x1b[0m ${e?.message ?? e}${e?.code ? ` (${e.code})` : ""}`); process.exit(1); }
}
void main();

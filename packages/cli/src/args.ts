import type { Flags } from "./commands.ts";

export function parseArgs(argv: string[]): Flags {
  const f: Flags = { _: [] };
  const dd = argv.indexOf("--");
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = head[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["port", "cwd", "token", "limit", "out", "format", "resolve"].includes(k)) { f[k] = next; i++; } else f[k] = true;
    } else f._.push(a);
  }
  if (dd >= 0) f._.push(...argv.slice(dd + 1));
  return f;
}
